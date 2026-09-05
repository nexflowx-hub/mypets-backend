import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const platformSchema = z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK", "YOUTUBE", "THREADS", "WEBSITE"]);
const embedModeSchema = z.enum(["LINK", "OEMBED", "API"]);
const discoveryStatusSchema = z.enum(["DISCOVERED", "REVIEWED", "CONTACT_PENDING", "INVITED", "CLAIMED", "VERIFIED", "REJECTED", "DUPLICATE"]);

const HOSTS: Record<z.infer<typeof platformSchema>, string[]> = {
  INSTAGRAM: ["instagram.com", "www.instagram.com"],
  FACEBOOK: ["facebook.com", "www.facebook.com", "m.facebook.com"],
  TIKTOK: ["tiktok.com", "www.tiktok.com"],
  YOUTUBE: ["youtube.com", "www.youtube.com", "youtu.be"],
  THREADS: ["threads.com", "www.threads.com", "threads.net", "www.threads.net"],
  WEBSITE: [],
};

function normalizedPublicUrl(raw: string, platform: z.infer<typeof platformSchema>) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Unsupported URL protocol");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Local URLs are not allowed");
  if (platform !== "WEBSITE" && !HOSTS[platform].includes(hostname)) throw new Error(`URL does not match ${platform}`);
  url.hash = "";
  return url.toString();
}

function requireDiscoveryToken(req: FastifyRequest, reply: FastifyReply) {
  const expected = process.env.DISCOVERY_INGEST_TOKEN;
  const provided = String(req.headers["x-discovery-token"] ?? "");
  if (!expected || provided.length < 16 || provided !== expected) {
    reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Discovery ingest token required" } });
    return false;
  }
  return true;
}

type SocialRow = {
  id: string;
  platform: string;
  profile_url: string;
  handle: string | null;
  display_name: string | null;
  embed_mode: string;
  verification_status: string;
  sync_enabled: boolean;
  verified_at: Date | null;
};

function socialDto(row: SocialRow) {
  return {
    id: row.id,
    platform: row.platform,
    profileUrl: row.profile_url,
    handle: row.handle,
    displayName: row.display_name,
    embedMode: row.embed_mode,
    verificationStatus: row.verification_status,
    syncEnabled: row.sync_enabled,
    verifiedAt: row.verified_at,
  };
}

export async function registerSocialRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/causes/:slug/social", async (req, reply) => {
    const params = z.object({ slug: z.string().trim().min(2).max(100) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_SLUG", message: "Invalid cause slug" } });

    const causeRows = await prisma.$queryRaw<Array<{ id: string; protector_id: string }>>`
      select id, protector_id from public.causes
      where slug = ${params.data.slug} and status = 'ACTIVE' and is_public = true
      limit 1
    `;
    const cause = causeRows[0];
    if (!cause) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });

    const profiles = await prisma.$queryRaw<Array<SocialRow & { scope: string }>>`
      select id, platform, profile_url, handle, display_name, embed_mode, verification_status, sync_enabled, verified_at,
             case when cause_id is not null then 'CAUSE' else 'PROTECTOR' end as scope
      from public.social_profiles
      where is_public = true
        and owner_confirmed = true
        and verification_status in ('OWNER_CONFIRMED', 'VERIFIED')
        and (cause_id = ${cause.id}::uuid or protector_id = ${cause.protector_id}::uuid)
      order by case platform
        when 'INSTAGRAM' then 1 when 'FACEBOOK' then 2 when 'TIKTOK' then 3
        when 'YOUTUBE' then 4 when 'THREADS' then 5 else 6 end, created_at asc
    `;

    const content = await prisma.$queryRaw<Array<{
      id: string; social_profile_id: string; platform: string; canonical_url: string; content_type: string;
      caption_excerpt: string | null; thumbnail_url: string | null; published_at: Date | null; is_featured: boolean;
    }>>`
      select sci.id, sci.social_profile_id, sp.platform, sci.canonical_url, sci.content_type,
             sci.caption_excerpt, sci.thumbnail_url, sci.published_at, sci.is_featured
      from public.social_content_items sci
      join public.social_profiles sp on sp.id = sci.social_profile_id
      where sci.is_public = true and sp.is_public = true and sp.owner_confirmed = true
        and sp.verification_status in ('OWNER_CONFIRMED','VERIFIED')
        and (sp.cause_id = ${cause.id}::uuid or sp.protector_id = ${cause.protector_id}::uuid)
      order by sci.is_featured desc, sci.published_at desc nulls last, sci.created_at desc
      limit 24
    `;

    return {
      data: {
        profiles: profiles.map((row) => ({ ...socialDto(row), scope: row.scope })),
        content: content.map((item) => ({
          id: item.id,
          socialProfileId: item.social_profile_id,
          platform: item.platform,
          canonicalUrl: item.canonical_url,
          contentType: item.content_type,
          captionExcerpt: item.caption_excerpt,
          thumbnailUrl: item.thumbnail_url,
          publishedAt: item.published_at,
          featured: item.is_featured,
        })),
      },
    };
  });

  const addSocialSchema = z.object({
    targetType: z.enum(["PROTECTOR", "CAUSE"]),
    causeId: z.string().uuid().nullable().optional(),
    platform: platformSchema,
    profileUrl: z.string().url().max(1000),
    handle: z.string().trim().max(120).nullable().optional(),
    displayName: z.string().trim().max(160).nullable().optional(),
    embedMode: embedModeSchema.default("LINK"),
    syncEnabled: z.boolean().default(false),
  });

  app.post("/v1/me/social-profiles", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = addSocialSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid social profile" } });

    let profileUrl: string;
    try {
      profileUrl = normalizedPublicUrl(parsed.data.profileUrl, parsed.data.platform);
    } catch (error) {
      return reply.code(400).send({ error: { code: "INVALID_URL", message: error instanceof Error ? error.message : "Invalid URL" } });
    }

    const protector = await prisma.protector.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (!protector) return reply.code(409).send({ error: { code: "PROTECTOR_REQUIRED", message: "Protector profile required" } });

    let causeId: string | null = null;
    if (parsed.data.targetType === "CAUSE") {
      if (!parsed.data.causeId) return reply.code(400).send({ error: { code: "CAUSE_REQUIRED", message: "Cause id required" } });
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        select id from public.causes where id = ${parsed.data.causeId}::uuid and protector_id = ${protector.id}::uuid limit 1
      `;
      if (!rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
      causeId = parsed.data.causeId;
    }

    const created = parsed.data.targetType === "CAUSE"
      ? await prisma.$queryRaw<SocialRow[]>`
          insert into public.social_profiles (
            cause_id, platform, profile_url, handle, display_name, embed_mode,
            verification_status, owner_confirmed, sync_enabled, is_public, created_by_user_id
          ) values (
            ${causeId}::uuid, ${parsed.data.platform}, ${profileUrl}, ${parsed.data.handle ?? null}, ${parsed.data.displayName ?? null},
            ${parsed.data.embedMode}, 'OWNER_CONFIRMED', true, ${parsed.data.syncEnabled}, true, ${user.id}::uuid
          ) on conflict do nothing
          returning id, platform, profile_url, handle, display_name, embed_mode, verification_status, sync_enabled, verified_at
        `
      : await prisma.$queryRaw<SocialRow[]>`
          insert into public.social_profiles (
            protector_id, platform, profile_url, handle, display_name, embed_mode,
            verification_status, owner_confirmed, sync_enabled, is_public, created_by_user_id
          ) values (
            ${protector.id}::uuid, ${parsed.data.platform}, ${profileUrl}, ${parsed.data.handle ?? null}, ${parsed.data.displayName ?? null},
            ${parsed.data.embedMode}, 'OWNER_CONFIRMED', true, ${parsed.data.syncEnabled}, true, ${user.id}::uuid
          ) on conflict do nothing
          returning id, platform, profile_url, handle, display_name, embed_mode, verification_status, sync_enabled, verified_at
        `;

    if (created[0]) return reply.code(201).send({ data: socialDto(created[0]) });

    const existing = parsed.data.targetType === "CAUSE"
      ? await prisma.$queryRaw<SocialRow[]>`
          select id, platform, profile_url, handle, display_name, embed_mode, verification_status, sync_enabled, verified_at
          from public.social_profiles where cause_id = ${causeId}::uuid and platform = ${parsed.data.platform} and profile_url = ${profileUrl} limit 1
        `
      : await prisma.$queryRaw<SocialRow[]>`
          select id, platform, profile_url, handle, display_name, embed_mode, verification_status, sync_enabled, verified_at
          from public.social_profiles where protector_id = ${protector.id}::uuid and platform = ${parsed.data.platform} and profile_url = ${profileUrl} limit 1
        `;
    return { data: socialDto(existing[0]!) };
  });

  app.delete("/v1/me/social-profiles/:id", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid social profile id" } });

    const rows = await prisma.$queryRaw<Array<{ id: string; protector_id: string | null; cause_id: string | null }>>`
      select id, protector_id, cause_id from public.social_profiles where id = ${params.data.id}::uuid limit 1
    `;
    const social = rows[0];
    if (!social) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Social profile not found" } });

    const protector = await prisma.protector.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (!protector) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Not allowed" } });
    if (social.protector_id && social.protector_id !== protector.id) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Not allowed" } });
    if (social.cause_id) {
      const owned = await prisma.$queryRaw<Array<{ id: string }>>`
        select id from public.causes where id = ${social.cause_id}::uuid and protector_id = ${protector.id}::uuid limit 1
      `;
      if (!owned[0]) return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Not allowed" } });
    }

    await prisma.$executeRaw`delete from public.social_profiles where id = ${params.data.id}::uuid`;
    return reply.code(204).send();
  });

  const discoverySchema = z.object({
    sourceUrl: z.string().url().max(1500),
    sourceType: z.enum(["WEBSITE", "DIRECTORY", "SOCIAL_LINK", "SEARCH_API", "MANUAL"]),
    title: z.string().trim().max(250).nullable().optional(),
    summary: z.string().trim().max(1500).nullable().optional(),
    country: z.enum(["PT", "BR"]).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    contactUrl: z.string().url().max(1500).nullable().optional(),
    contactEmail: z.string().email().max(320).nullable().optional(),
    sourceHash: z.string().max(128).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    evidence: z.array(z.object({
      sourceUrl: z.string().url().max(1500),
      evidenceType: z.enum(["PAGE_METADATA", "SOCIAL_LINK", "CONTACT", "SCREENSHOT_PRIVATE", "MANUAL_NOTE"]),
      title: z.string().trim().max(250).nullable().optional(),
      excerpt: z.string().trim().max(1200).nullable().optional(),
      snapshotUrl: z.string().url().max(1500).nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })).max(30).default([]),
    socialLinks: z.array(z.object({
      platform: platformSchema,
      profileUrl: z.string().url().max(1000),
      handle: z.string().trim().max(120).nullable().optional(),
    })).max(20).default([]),
  });

  app.post("/v1/internal/discovery/candidates", async (req, reply) => {
    if (!requireDiscoveryToken(req, reply)) return;
    const parsed = discoverySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid discovery candidate" } });

    const sourceUrl = normalizedPublicUrl(parsed.data.sourceUrl, "WEBSITE");
    const metadata = JSON.stringify(parsed.data.metadata);
    const rows = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      insert into public.discovery_candidates (
        source_url, source_type, title, summary, country, city, contact_url, contact_email,
        source_hash, last_crawled_at, metadata
      ) values (
        ${sourceUrl}, ${parsed.data.sourceType}, ${parsed.data.title ?? null}, ${parsed.data.summary ?? null},
        ${parsed.data.country ?? null}, ${parsed.data.city ?? null}, ${parsed.data.contactUrl ?? null}, ${parsed.data.contactEmail ?? null},
        ${parsed.data.sourceHash ?? null}, now(), ${metadata}::jsonb
      ) on conflict (source_url) do update set
        title = coalesce(excluded.title, public.discovery_candidates.title),
        summary = coalesce(excluded.summary, public.discovery_candidates.summary),
        country = coalesce(excluded.country, public.discovery_candidates.country),
        city = coalesce(excluded.city, public.discovery_candidates.city),
        contact_url = coalesce(excluded.contact_url, public.discovery_candidates.contact_url),
        contact_email = coalesce(excluded.contact_email, public.discovery_candidates.contact_email),
        source_hash = excluded.source_hash,
        last_crawled_at = now(),
        metadata = public.discovery_candidates.metadata || excluded.metadata,
        updated_at = now()
      returning id, status
    `;
    const candidate = rows[0]!;

    for (const evidence of parsed.data.evidence) {
      await prisma.$executeRaw`
        insert into public.discovery_evidence (candidate_id, source_url, evidence_type, title, excerpt, snapshot_url, metadata)
        values (${candidate.id}::uuid, ${evidence.sourceUrl}, ${evidence.evidenceType}, ${evidence.title ?? null}, ${evidence.excerpt ?? null}, ${evidence.snapshotUrl ?? null}, ${JSON.stringify(evidence.metadata)}::jsonb)
      `;
    }

    for (const social of parsed.data.socialLinks) {
      let socialUrl: string;
      try { socialUrl = normalizedPublicUrl(social.profileUrl, social.platform); } catch { continue; }
      await prisma.$executeRaw`
        insert into public.social_profiles (candidate_id, platform, profile_url, handle, embed_mode, verification_status, owner_confirmed, sync_enabled, is_public)
        values (${candidate.id}::uuid, ${social.platform}, ${socialUrl}, ${social.handle ?? null}, 'LINK', 'SOURCE_MATCHED', false, false, false)
        on conflict do nothing
      `;
    }

    return reply.code(201).send({ data: candidate });
  });

  app.get("/v1/internal/discovery/candidates", async (req, reply) => {
    if (!requireDiscoveryToken(req, reply)) return;
    const query = z.object({ status: discoveryStatusSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid discovery query" } });

    const rows = query.data.status
      ? await prisma.$queryRaw<Array<Record<string, unknown>>>`
          select id, source_url, source_type, title, summary, country, city, contact_url, contact_email, status,
                 matched_protector_id, matched_cause_id, discovered_at, last_crawled_at, metadata
          from public.discovery_candidates where status = ${query.data.status}
          order by discovered_at desc limit ${query.data.limit}
        `
      : await prisma.$queryRaw<Array<Record<string, unknown>>>`
          select id, source_url, source_type, title, summary, country, city, contact_url, contact_email, status,
                 matched_protector_id, matched_cause_id, discovered_at, last_crawled_at, metadata
          from public.discovery_candidates order by discovered_at desc limit ${query.data.limit}
        `;
    return { data: rows };
  });

  const claimSchema = z.object({
    contactEmail: z.string().email().max(320).nullable().optional(),
    proofUrl: z.string().url().max(1500).nullable().optional(),
    message: z.string().trim().max(2000).nullable().optional(),
  });

  app.post("/v1/discovery/candidates/:id/claim", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = claimSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid claim request" } });

    await prisma.profile.upsert({ where: { id: user.id }, update: {}, create: { id: user.id } });
    const candidate = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      select id, status from public.discovery_candidates where id = ${params.data.id}::uuid and status not in ('REJECTED','DUPLICATE') limit 1
    `;
    if (!candidate[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Candidate not found" } });

    const rows = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      insert into public.claim_requests (candidate_id, user_id, contact_email, proof_url, message)
      values (${params.data.id}::uuid, ${user.id}::uuid, ${body.data.contactEmail ?? null}, ${body.data.proofUrl ?? null}, ${body.data.message ?? null})
      returning id, status
    `;
    await prisma.$executeRaw`
      update public.discovery_candidates set status = 'CLAIMED', claimed_by_user_id = ${user.id}::uuid, updated_at = now()
      where id = ${params.data.id}::uuid and status in ('DISCOVERED','REVIEWED','CONTACT_PENDING','INVITED')
    `;
    return reply.code(201).send({ data: rows[0] });
  });
}
