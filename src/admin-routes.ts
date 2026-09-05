import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const discoveryStatusSchema = z.enum(["DISCOVERED", "REVIEWED", "CONTACT_PENDING", "INVITED", "CLAIMED", "VERIFIED", "REJECTED", "DUPLICATE"]);
const claimStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);
const adminRoleSchema = z.enum(["SUPERADMIN", "REVIEWER", "OUTREACH"]);

function configuredAdminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function requireAdmin(req: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await requireAuth(req, reply);
  if (!user) return null;

  const rows = await prisma.$queryRaw<Array<{ role: string }>>`
    select role from public.admin_users where user_id = ${user.id}::uuid and active = true limit 1
  `;
  const storedRole = rows[0]?.role;
  if (storedRole && adminRoleSchema.safeParse(storedRole).success) {
    return { user, role: storedRole as z.infer<typeof adminRoleSchema> };
  }

  const email = user.email?.trim().toLowerCase() ?? "";
  if (email && configuredAdminEmails().has(email)) {
    return { user, role: "SUPERADMIN" as const };
  }

  reply.code(403).send({ error: { code: "ADMIN_REQUIRED", message: "Administrator access required" } });
  return null;
}

function tokenHash(raw: string) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function candidateDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    title: row.title,
    summary: row.summary,
    country: row.country,
    city: row.city,
    contactUrl: row.contact_url,
    contactEmail: row.contact_email,
    status: row.status,
    leadScore: row.lead_score,
    reviewNotes: row.review_notes,
    matchedProtectorId: row.matched_protector_id,
    matchedCauseId: row.matched_cause_id,
    claimedByUserId: row.claimed_by_user_id,
    discoveredAt: row.discovered_at,
    lastCrawledAt: row.last_crawled_at,
    reviewedAt: row.reviewed_at,
    invitedAt: row.invited_at,
    verifiedAt: row.verified_at,
    metadata: row.metadata,
  };
}

export async function registerAdminRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/me/admin", async (req, reply) => {
    const admin = await requireAdmin(req, reply, prisma);
    if (!admin) return;
    return { data: { admin: true, role: admin.role, email: admin.user.email } };
  });

  app.get("/v1/admin/discovery/candidates", async (req, reply) => {
    const admin = await requireAdmin(req, reply, prisma);
    if (!admin) return;

    const parsed = z.object({
      status: discoveryStatusSchema.optional(),
      country: z.enum(["PT", "BR"]).optional(),
      q: z.string().trim().max(160).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid admin discovery query" } });

    const status = parsed.data.status ?? null;
    const country = parsed.data.country ?? null;
    const search = parsed.data.q ? `%${parsed.data.q.toLowerCase()}%` : null;

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      select dc.id, dc.source_url, dc.source_type, dc.title, dc.summary, dc.country, dc.city,
             dc.contact_url, dc.contact_email, dc.status, dc.lead_score, dc.review_notes,
             dc.matched_protector_id, dc.matched_cause_id, dc.claimed_by_user_id,
             dc.discovered_at, dc.last_crawled_at, dc.reviewed_at, dc.invited_at, dc.verified_at, dc.metadata,
             (select count(*)::int from public.discovery_evidence de where de.candidate_id = dc.id) as evidence_count,
             (select count(*)::int from public.social_profiles sp where sp.candidate_id = dc.id) as social_count,
             (select count(*)::int from public.claim_requests cr where cr.candidate_id = dc.id) as claim_count
      from public.discovery_candidates dc
      where (${status}::text is null or dc.status = ${status})
        and (${country}::text is null or dc.country = ${country})
        and (${search}::text is null or lower(coalesce(dc.title, '')) like ${search} or lower(dc.source_url) like ${search})
      order by
        case dc.status when 'CLAIMED' then 1 when 'CONTACT_PENDING' then 2 when 'REVIEWED' then 3 when 'DISCOVERED' then 4 else 5 end,
        dc.lead_score desc,
        dc.discovered_at desc
      limit ${parsed.data.limit}
    `;

    const counts = await prisma.$queryRaw<Array<{ status: string; count: number }>>`
      select status, count(*)::int as count from public.discovery_candidates group by status order by status
    `;

    return {
      data: {
        candidates: rows.map((row) => ({
          ...candidateDto(row),
          evidenceCount: row.evidence_count,
          socialCount: row.social_count,
          claimCount: row.claim_count,
        })),
        counts: Object.fromEntries(counts.map((row) => [row.status, row.count])),
      },
    };
  });

  app.get("/v1/admin/discovery/candidates/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply, prisma);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid candidate id" } });

    const candidates = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      select * from public.discovery_candidates where id = ${params.data.id}::uuid limit 1
    `;
    const candidate = candidates[0];
    if (!candidate) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Candidate not found" } });

    const [evidence, social, claims, invites] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        select id, source_url, evidence_type, title, excerpt, snapshot_url, captured_at, metadata
        from public.discovery_evidence where candidate_id = ${params.data.id}::uuid order by captured_at desc
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        select id, platform, profile_url, handle, display_name, embed_mode, verification_status,
               owner_confirmed, sync_enabled, is_public, verified_at, last_synced_at, created_at, metadata
        from public.social_profiles where candidate_id = ${params.data.id}::uuid order by created_at asc
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        select cr.id, cr.user_id, p.display_name, cr.contact_email, cr.proof_url, cr.message, cr.status,
               cr.review_notes, cr.created_at, cr.resolved_at
        from public.claim_requests cr
        left join public.profiles p on p.id = cr.user_id
        where cr.candidate_id = ${params.data.id}::uuid order by cr.created_at desc
      `,
      prisma.$queryRaw<Array<Record<string, unknown>>>`
        select id, contact_email, expires_at, used_at, revoked_at, created_at
        from public.claim_invites where candidate_id = ${params.data.id}::uuid order by created_at desc
      `,
    ]);

    return { data: { candidate: candidateDto(candidate), evidence, socialProfiles: social, claims, invites } };
  });

  app.patch("/v1/admin/discovery/candidates/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply, prisma);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({
      status: discoveryStatusSchema.optional(),
      leadScore: z.number().int().min(0).max(100).optional(),
      reviewNotes: z.string().trim().max(5000).nullable().optional(),
      contactEmail: z.string().email().max(320).nullable().optional(),
      contactUrl: z.string().url().max(1500).nullable().optional(),
      country: z.enum(["PT", "BR"]).nullable().optional(),
      city: z.string().trim().max(120).nullable().optional(),
    }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid candidate update" } });

    const currentRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      select * from public.discovery_candidates where id = ${params.data.id}::uuid limit 1
    `;
    const current = currentRows[0];
    if (!current) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Candidate not found" } });

    const nextStatus = body.data.status ?? String(current.status);
    const nextLeadScore = body.data.leadScore ?? Number(current.lead_score ?? 0);
    const nextReviewNotes = body.data.reviewNotes === undefined ? (current.review_notes as string | null) : body.data.reviewNotes;
    const nextContactEmail = body.data.contactEmail === undefined ? (current.contact_email as string | null) : body.data.contactEmail;
    const nextContactUrl = body.data.contactUrl === undefined ? (current.contact_url as string | null) : body.data.contactUrl;
    const nextCountry = body.data.country === undefined ? (current.country as string | null) : body.data.country;
    const nextCity = body.data.city === undefined ? (current.city as string | null) : body.data.city;

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      update public.discovery_candidates
      set status = ${nextStatus}, lead_score = ${nextLeadScore}, review_notes = ${nextReviewNotes},
          contact_email = ${nextContactEmail}, contact_url = ${nextContactUrl}, country = ${nextCountry}, city = ${nextCity},
          reviewed_by_user_id = ${admin.user.id}::uuid,
          reviewed_at = case when ${nextStatus} in ('REVIEWED','CONTACT_PENDING','INVITED','CLAIMED','VERIFIED') then coalesce(reviewed_at, now()) else reviewed_at end,
          updated_at = now()
      where id = ${params.data.id}::uuid
      returning *
    `;
    return { data: candidateDto(rows[0]!) };
  });

  app.post("/v1/admin/discovery/candidates/:id/invite", async (req, reply) => {
    const admin = await requireAdmin(req, reply, prisma);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({
      contactEmail: z.string().email().max(320).nullable().optional(),
      expiresInDays: z.number().int().min(1).max(30).default(14),
    }).safeParse(req.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid claim invite" } });

    const candidateRows = await prisma.$queryRaw<Array<{ id: string; status: string; contact_email: string | null }>>`
      select id, status, contact_email from public.discovery_candidates where id = ${params.data.id}::uuid limit 1
    `;
    const candidate = candidateRows[0];
    if (!candidate) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Candidate not found" } });
    if (["REJECTED", "DUPLICATE", "VERIFIED"].includes(candidate.status)) {
      return reply.code(409).send({ error: { code: "INVALID_STATE", message: "Candidate cannot be invited in its current state" } });
    }

    await prisma.profile.upsert({ where: { id: admin.user.id }, update: {}, create: { id: admin.user.id } });
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const hash = tokenHash(rawToken);
    const expiresAt = new Date(Date.now() + body.data.expiresInDays * 86_400_000);
    const contactEmail = body.data.contactEmail === undefined ? candidate.contact_email : body.data.contactEmail;

    const inviteRows = await prisma.$queryRaw<Array<{ id: string; expires_at: Date }>>`
      insert into public.claim_invites (candidate_id, token_hash, contact_email, expires_at, created_by_user_id)
      values (${candidate.id}::uuid, ${hash}, ${contactEmail ?? null}, ${expiresAt}, ${admin.user.id}::uuid)
      returning id, expires_at
    `;
    await prisma.$executeRaw`
      update public.discovery_candidates set status = 'INVITED', invited_at = now(), updated_at = now()
      where id = ${candidate.id}::uuid
    `;

    const site = (process.env.PUBLIC_SITE_URL ?? "https://mypets.lat").replace(/\/$/, "");
    return reply.code(201).send({
      data: {
        id: inviteRows[0]!.id,
        expiresAt: inviteRows[0]!.expires_at,
        claimUrl: `${site}/claim/${rawToken}`,
      },
    });
  });

  app.patch("/v1/admin/claims/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply, prisma);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ status: z.enum(["APPROVED", "REJECTED", "CANCELLED"]), reviewNotes: z.string().trim().max(5000).nullable().optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid claim review" } });

    const claimRows = await prisma.$queryRaw<Array<{ id: string; candidate_id: string; status: string }>>`
      select id, candidate_id, status from public.claim_requests where id = ${params.data.id}::uuid limit 1
    `;
    const claim = claimRows[0];
    if (!claim) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Claim not found" } });
    if (!claimStatusSchema.safeParse(claim.status).success) return reply.code(409).send({ error: { code: "INVALID_STATE", message: "Invalid claim state" } });

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        update public.claim_requests
        set status = ${body.data.status}, review_notes = ${body.data.reviewNotes ?? null}, resolved_at = now()
        where id = ${claim.id}::uuid
      `;
      if (body.data.status === "APPROVED") {
        await tx.$executeRaw`
          update public.discovery_candidates set status = 'CLAIMED', reviewed_by_user_id = ${admin.user.id}::uuid,
                 reviewed_at = coalesce(reviewed_at, now()), updated_at = now()
          where id = ${claim.candidate_id}::uuid
        `;
      } else {
        await tx.$executeRaw`
          update public.discovery_candidates set status = 'REVIEWED', reviewed_by_user_id = ${admin.user.id}::uuid,
                 reviewed_at = coalesce(reviewed_at, now()), updated_at = now()
          where id = ${claim.candidate_id}::uuid and status = 'CLAIMED'
        `;
      }
    });

    return { data: { id: claim.id, status: body.data.status } };
  });

  const verifySchema = z.object({
    protectorId: z.string().uuid().nullable().optional(),
    causeId: z.string().uuid().nullable().optional(),
  }).refine((value) => Boolean(value.protectorId) !== Boolean(value.causeId), { message: "Choose exactly one verified target" });

  app.post("/v1/admin/discovery/candidates/:id/verify", async (req, reply) => {
    const admin = await requireAdmin(req, reply, prisma);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = verifySchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid verification target" } });

    if (body.data.protectorId) {
      const found = await prisma.protector.findUnique({ where: { id: body.data.protectorId }, select: { id: true } });
      if (!found) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Protector not found" } });
    }
    if (body.data.causeId) {
      const found = await prisma.$queryRaw<Array<{ id: string }>>`select id from public.causes where id = ${body.data.causeId}::uuid limit 1`;
      if (!found[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
    }

    const targetProtector = body.data.protectorId ?? null;
    const targetCause = body.data.causeId ?? null;
    await prisma.$transaction(async (tx) => {
      if (targetProtector) {
        await tx.$executeRaw`
          insert into public.social_profiles (
            protector_id, platform, profile_url, handle, display_name, embed_mode, verification_status,
            owner_confirmed, sync_enabled, is_public, created_by_user_id, verified_at, metadata
          )
          select ${targetProtector}::uuid, platform, profile_url, handle, display_name, embed_mode, 'VERIFIED',
                 true, sync_enabled, true, created_by_user_id, now(), metadata
          from public.social_profiles where candidate_id = ${params.data.id}::uuid
          on conflict do nothing
        `;
      } else if (targetCause) {
        await tx.$executeRaw`
          insert into public.social_profiles (
            cause_id, platform, profile_url, handle, display_name, embed_mode, verification_status,
            owner_confirmed, sync_enabled, is_public, created_by_user_id, verified_at, metadata
          )
          select ${targetCause}::uuid, platform, profile_url, handle, display_name, embed_mode, 'VERIFIED',
                 true, sync_enabled, true, created_by_user_id, now(), metadata
          from public.social_profiles where candidate_id = ${params.data.id}::uuid
          on conflict do nothing
        `;
      }
      await tx.$executeRaw`delete from public.social_profiles where candidate_id = ${params.data.id}::uuid`;
      await tx.$executeRaw`
        update public.discovery_candidates
        set status = 'VERIFIED', matched_protector_id = ${targetProtector}::uuid, matched_cause_id = ${targetCause}::uuid,
            verified_at = now(), reviewed_by_user_id = ${admin.user.id}::uuid, updated_at = now()
        where id = ${params.data.id}::uuid
      `;
    });

    return { data: { id: params.data.id, status: "VERIFIED", protectorId: targetProtector, causeId: targetCause } };
  });

  const claimTokenParams = z.object({ token: z.string().min(32).max(180) });

  app.get("/v1/claim/:token", async (req, reply) => {
    const params = claimTokenParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: { code: "INVALID_CLAIM_LINK", message: "Claim link is invalid" } });
    const hash = tokenHash(params.data.token);
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      select dc.id, dc.title, dc.summary, dc.source_url, dc.country, dc.city, dc.status, ci.expires_at
      from public.claim_invites ci
      join public.discovery_candidates dc on dc.id = ci.candidate_id
      where ci.token_hash = ${hash} and ci.used_at is null and ci.revoked_at is null and ci.expires_at > now()
        and dc.status not in ('REJECTED','DUPLICATE','VERIFIED')
      limit 1
    `;
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: { code: "CLAIM_LINK_EXPIRED", message: "Claim link is invalid or expired" } });
    return { data: { title: row.title, summary: row.summary, sourceUrl: row.source_url, country: row.country, city: row.city, expiresAt: row.expires_at } };
  });

  const claimBody = z.object({
    contactEmail: z.string().email().max(320).nullable().optional(),
    proofUrl: z.string().url().max(1500).nullable().optional(),
    message: z.string().trim().max(2000).nullable().optional(),
  });

  app.post("/v1/claim/:token", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = claimTokenParams.safeParse(req.params);
    const body = claimBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid claim request" } });
    const hash = tokenHash(params.data.token);

    const result = await prisma.$transaction(async (tx) => {
      const invites = await tx.$queryRaw<Array<{ invite_id: string; candidate_id: string }>>`
        select ci.id as invite_id, ci.candidate_id
        from public.claim_invites ci
        join public.discovery_candidates dc on dc.id = ci.candidate_id
        where ci.token_hash = ${hash} and ci.used_at is null and ci.revoked_at is null and ci.expires_at > now()
          and dc.status not in ('REJECTED','DUPLICATE','VERIFIED')
        limit 1 for update
      `;
      const invite = invites[0];
      if (!invite) return null;

      await tx.profile.upsert({ where: { id: user.id }, update: {}, create: { id: user.id } });
      const claims = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        insert into public.claim_requests (candidate_id, user_id, contact_email, proof_url, message)
        values (${invite.candidate_id}::uuid, ${user.id}::uuid, ${body.data.contactEmail ?? user.email ?? null}, ${body.data.proofUrl ?? null}, ${body.data.message ?? null})
        returning id, status
      `;
      await tx.$executeRaw`update public.claim_invites set used_at = now() where id = ${invite.invite_id}::uuid`;
      await tx.$executeRaw`
        update public.discovery_candidates set status = 'CLAIMED', claimed_by_user_id = ${user.id}::uuid, updated_at = now()
        where id = ${invite.candidate_id}::uuid
      `;
      return claims[0]!;
    });

    if (!result) return reply.code(404).send({ error: { code: "CLAIM_LINK_EXPIRED", message: "Claim link is invalid or expired" } });
    return reply.code(201).send({ data: result });
  });
}
