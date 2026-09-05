import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const countrySchema = z.enum(["PT", "BR"]);
const supportModeSchema = z.enum(["FINANCIAL", "NON_FINANCIAL", "BOTH"]);
const causeStatusSchema = z.enum(["DRAFT", "ACTIVE", "PAUSED", "FUNDED", "CLOSED"]);

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52) || "causa";
}

type CauseRow = {
  id: string;
  protector_id: string;
  slug: string;
  title: string;
  summary: string | null;
  story: string | null;
  country: string;
  city: string | null;
  primary_image: string | null;
  support_mode: string;
  target_amount_cents: number | null;
  raised_amount_cents: number;
  currency: string | null;
  status: string;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function publicCause(row: CauseRow) {
  return {
    id: row.id,
    protectorId: row.protector_id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    story: row.story,
    country: row.country,
    city: row.city,
    primaryImage: row.primary_image,
    supportMode: row.support_mode,
    targetAmountCents: row.target_amount_cents,
    raisedAmountCents: row.raised_amount_cents,
    currency: row.currency,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ensureProfile(prisma: PrismaClient, userId: string) {
  await prisma.profile.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
}

export async function registerCauseRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/causes", async (req, reply) => {
    const query = z.object({ country: countrySchema.optional(), limit: z.coerce.number().int().min(1).max(50).default(24) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid cause query" } });
    const rows = query.data.country
      ? await prisma.$queryRaw<CauseRow[]>`
          select id, protector_id, slug, title, summary, story, country, city, primary_image, support_mode,
                 target_amount_cents, raised_amount_cents, currency, status, published_at, created_at, updated_at
          from public.causes
          where status = 'ACTIVE' and is_public = true and country = ${query.data.country}
          order by published_at desc nulls last, created_at desc limit ${query.data.limit}
        `
      : await prisma.$queryRaw<CauseRow[]>`
          select id, protector_id, slug, title, summary, story, country, city, primary_image, support_mode,
                 target_amount_cents, raised_amount_cents, currency, status, published_at, created_at, updated_at
          from public.causes
          where status = 'ACTIVE' and is_public = true
          order by published_at desc nulls last, created_at desc limit ${query.data.limit}
        `;
    return { data: rows.map(publicCause) };
  });

  app.get("/v1/causes/:slug", async (req, reply) => {
    const params = z.object({ slug: z.string().trim().min(2).max(100) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_SLUG", message: "Invalid cause slug" } });
    const rows = await prisma.$queryRaw<CauseRow[]>`
      select id, protector_id, slug, title, summary, story, country, city, primary_image, support_mode,
             target_amount_cents, raised_amount_cents, currency, status, published_at, created_at, updated_at
      from public.causes where slug = ${params.data.slug} and status = 'ACTIVE' and is_public = true limit 1
    `;
    const cause = rows[0];
    if (!cause) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });

    const [protector, pets, needs, updates, counts] = await Promise.all([
      prisma.protector.findUnique({ where: { id: cause.protector_id }, select: { id: true, slug: true, displayName: true, verification: true, city: true, country: true } }),
      prisma.$queryRaw<Array<{ id: string; facepets_id: string; name: string; status: string; primary_image: string | null }>>`
        select p.id, p.facepets_id, p.name, p.status, p.primary_image
        from public.pets p join public.cause_pets cp on cp.pet_id = p.id
        where cp.cause_id = ${cause.id}::uuid and p.is_public = true order by p.created_at desc
      `,
      prisma.$queryRaw<Array<{ id: string; type: string; title: string; description: string | null; support_mode: string; target_amount_cents: number | null; raised_amount_cents: number; currency: string | null; status: string }>>`
        select n.id, n.type, n.title, n.description, n.support_mode, n.target_amount_cents, n.raised_amount_cents, n.currency, n.status
        from public.needs n join public.cause_needs cn on cn.need_id = n.id
        where cn.cause_id = ${cause.id}::uuid and n.is_public = true and n.status <> 'CANCELLED'
        order by n.created_at desc
      `,
      prisma.$queryRaw<Array<{ id: string; title: string | null; body: string; image_url: string | null; created_at: Date }>>`
        select id, title, body, image_url, created_at from public.cause_updates
        where cause_id = ${cause.id}::uuid and is_public = true order by created_at desc limit 25
      `,
      prisma.$queryRaw<Array<{ followers: bigint; sponsors: bigint }>>`
        select
          (select count(*) from public.cause_followers where cause_id = ${cause.id}::uuid)::bigint as followers,
          (select count(*) from public.sponsorships where cause_id = ${cause.id}::uuid and status in ('INTERESTED','PENDING','ACTIVE'))::bigint as sponsors
      `,
    ]);

    return {
      data: {
        ...publicCause(cause),
        protector,
        pets: pets.map((pet) => ({ id: pet.id, facepetsId: pet.facepets_id, name: pet.name, status: pet.status, primaryImage: pet.primary_image })),
        needs: needs.map((need) => ({ id: need.id, type: need.type, title: need.title, description: need.description, supportMode: need.support_mode, targetAmountCents: need.target_amount_cents, raisedAmountCents: need.raised_amount_cents, currency: need.currency, status: need.status })),
        updates: updates.map((update) => ({ id: update.id, title: update.title, body: update.body, imageUrl: update.image_url, createdAt: update.created_at })),
        followers: Number(counts[0]?.followers ?? 0n),
        sponsors: Number(counts[0]?.sponsors ?? 0n),
      },
    };
  });

  const createCauseSchema = z.object({
    title: z.string().trim().min(4).max(160),
    summary: z.string().trim().max(500).nullable().optional(),
    story: z.string().trim().max(8000).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    primaryImage: z.string().url().max(1000).nullable().optional(),
    supportMode: supportModeSchema.default("BOTH"),
    targetAmountCents: z.number().int().min(100).nullable().optional(),
    currency: z.enum(["EUR", "BRL"]).nullable().optional(),
    status: z.enum(["DRAFT", "ACTIVE"]).default("DRAFT"),
    petIds: z.array(z.string().uuid()).max(30).default([]),
    needIds: z.array(z.string().uuid()).max(30).default([]),
  }).superRefine((value, ctx) => {
    if (value.status === "ACTIVE" && value.supportMode !== "NON_FINANCIAL" && (!value.targetAmountCents || !value.currency)) {
      ctx.addIssue({ code: "custom", message: "Financial active causes require target and currency" });
    }
  });

  app.post("/v1/causes", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = createCauseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid cause" } });
    await ensureProfile(prisma, user.id);
    const protector = await prisma.protector.findUnique({ where: { userId: user.id } });
    if (!protector) return reply.code(409).send({ error: { code: "PROTECTOR_REQUIRED", message: "Protector profile required" } });

    const [ownedPets, ownedNeeds] = await Promise.all([
      parsed.data.petIds.length ? prisma.pet.findMany({ where: { id: { in: parsed.data.petIds }, protectorId: protector.id }, select: { id: true } }) : Promise.resolve([]),
      parsed.data.needIds.length ? prisma.need.findMany({ where: { id: { in: parsed.data.needIds }, protectorId: protector.id }, select: { id: true } }) : Promise.resolve([]),
    ]);
    if (ownedPets.length !== parsed.data.petIds.length || ownedNeeds.length !== parsed.data.needIds.length) {
      return reply.code(400).send({ error: { code: "INVALID_RELATION", message: "Cause can only reference your own pets and needs" } });
    }

    const id = crypto.randomUUID();
    const slug = `${slugify(parsed.data.title)}-${id.slice(0, 8)}`;
    const publishedAt = parsed.data.status === "ACTIVE" ? new Date() : null;
    const rows = await prisma.$transaction(async (tx) => {
      const created = await tx.$queryRaw<CauseRow[]>`
        insert into public.causes (
          id, protector_id, slug, title, summary, story, country, city, primary_image, support_mode,
          target_amount_cents, currency, status, is_public, published_at
        ) values (
          ${id}::uuid, ${protector.id}::uuid, ${slug}, ${parsed.data.title}, ${parsed.data.summary ?? null}, ${parsed.data.story ?? null},
          ${protector.country}, ${parsed.data.city ?? protector.city}, ${parsed.data.primaryImage ?? null}, ${parsed.data.supportMode},
          ${parsed.data.targetAmountCents ?? null}, ${parsed.data.currency ?? null}, ${parsed.data.status}, true, ${publishedAt}
        ) returning id, protector_id, slug, title, summary, story, country, city, primary_image, support_mode,
                    target_amount_cents, raised_amount_cents, currency, status, published_at, created_at, updated_at
      `;
      for (const petId of parsed.data.petIds) await tx.$executeRaw`insert into public.cause_pets (cause_id, pet_id) values (${id}::uuid, ${petId}::uuid) on conflict do nothing`;
      for (const needId of parsed.data.needIds) await tx.$executeRaw`insert into public.cause_needs (cause_id, need_id) values (${id}::uuid, ${needId}::uuid) on conflict do nothing`;
      return created;
    });
    return reply.code(201).send({ data: publicCause(rows[0]!) });
  });

  app.get("/v1/me/causes", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const protector = await prisma.protector.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (!protector) return { data: [] };
    const rows = await prisma.$queryRaw<CauseRow[]>`
      select id, protector_id, slug, title, summary, story, country, city, primary_image, support_mode,
             target_amount_cents, raised_amount_cents, currency, status, published_at, created_at, updated_at
      from public.causes where protector_id = ${protector.id}::uuid order by created_at desc limit 100
    `;
    return { data: rows.map(publicCause) };
  });

  app.post("/v1/causes/:id/follow", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid cause id" } });
    await ensureProfile(prisma, user.id);
    const exists = await prisma.$queryRaw<Array<{ id: string }>>`select id from public.causes where id = ${params.data.id}::uuid and status = 'ACTIVE' and is_public = true limit 1`;
    if (!exists[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
    await prisma.$transaction([
      prisma.$executeRaw`insert into public.cause_followers (cause_id, user_id) values (${params.data.id}::uuid, ${user.id}::uuid) on conflict do nothing`,
      prisma.profileRole.upsert({ where: { userId_role: { userId: user.id, role: "SUPPORTER" } }, update: {}, create: { userId: user.id, role: "SUPPORTER" } }),
    ]);
    return reply.code(201).send({ data: { following: true } });
  });

  const sponsorSchema = z.object({
    causeId: z.string().uuid().nullable().optional(),
    petId: z.string().uuid().nullable().optional(),
    isAnonymous: z.boolean().default(false),
    communicationPreferences: z.record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()])).default({}),
  }).refine((value) => Boolean(value.causeId) !== Boolean(value.petId), { message: "Choose exactly one sponsorship target" });

  app.post("/v1/sponsorships/interests", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = sponsorSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid sponsorship interest" } });
    await ensureProfile(prisma, user.id);

    if (parsed.data.causeId) {
      const found = await prisma.$queryRaw<Array<{ id: string }>>`select id from public.causes where id = ${parsed.data.causeId}::uuid and status = 'ACTIVE' and is_public = true limit 1`;
      if (!found[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
    } else if (parsed.data.petId) {
      const pet = await prisma.pet.findFirst({ where: { id: parsed.data.petId, isPublic: true }, select: { id: true } });
      if (!pet) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });
    }

    const prefs = JSON.stringify(parsed.data.communicationPreferences);
    const rows = parsed.data.causeId
      ? await prisma.$queryRaw<Array<{ id: string; status: string }>>`
          insert into public.sponsorships (user_id, cause_id, status, is_anonymous, communication_preferences)
          values (${user.id}::uuid, ${parsed.data.causeId}::uuid, 'INTERESTED', ${parsed.data.isAnonymous}, ${prefs}::jsonb)
          on conflict (user_id, cause_id) where cause_id is not null do update
          set status = case when public.sponsorships.status = 'ENDED' then 'INTERESTED' else public.sponsorships.status end,
              is_anonymous = excluded.is_anonymous, communication_preferences = excluded.communication_preferences, updated_at = now()
          returning id, status
        `
      : await prisma.$queryRaw<Array<{ id: string; status: string }>>`
          insert into public.sponsorships (user_id, pet_id, status, is_anonymous, communication_preferences)
          values (${user.id}::uuid, ${parsed.data.petId}::uuid, 'INTERESTED', ${parsed.data.isAnonymous}, ${prefs}::jsonb)
          on conflict (user_id, pet_id) where pet_id is not null do update
          set status = case when public.sponsorships.status = 'ENDED' then 'INTERESTED' else public.sponsorships.status end,
              is_anonymous = excluded.is_anonymous, communication_preferences = excluded.communication_preferences, updated_at = now()
          returning id, status
        `;

    await prisma.profileRole.upsert({ where: { userId_role: { userId: user.id, role: "SPONSOR" } }, update: {}, create: { userId: user.id, role: "SPONSOR" } });
    return reply.code(201).send({ data: rows[0] });
  });

  app.get("/v1/me/sponsorships", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const rows = await prisma.$queryRaw<Array<{ id: string; status: string; is_anonymous: boolean; cause_id: string | null; cause_slug: string | null; cause_title: string | null; pet_id: string | null; facepets_id: string | null; pet_name: string | null; created_at: Date }>>`
      select s.id, s.status, s.is_anonymous, s.cause_id, c.slug as cause_slug, c.title as cause_title,
             s.pet_id, p.facepets_id, p.name as pet_name, s.created_at
      from public.sponsorships s
      left join public.causes c on c.id = s.cause_id
      left join public.pets p on p.id = s.pet_id
      where s.user_id = ${user.id}::uuid order by s.created_at desc
    `;
    return { data: rows.map((row) => ({ id: row.id, status: row.status, isAnonymous: row.is_anonymous, causeId: row.cause_id, causeSlug: row.cause_slug, causeTitle: row.cause_title, petId: row.pet_id, facepetsId: row.facepets_id, petName: row.pet_name, createdAt: row.created_at })) };
  });
}
