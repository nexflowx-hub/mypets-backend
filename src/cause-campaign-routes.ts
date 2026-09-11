import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const verticalSchema = z.enum(["GENERAL", "FOOD", "VET", "RESCUE", "SHELTER", "EMERGENCY"]);
const countrySchema = z.enum(["PT", "BR"]);
const campaignKeySchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/);

const campaignMetaSchema = z.object({
  eyebrow: z.string().trim().max(100).nullable().optional(),
  headline: z.string().trim().max(180).nullable().optional(),
  subheadline: z.string().trim().max(500).nullable().optional(),
  urgencyLabel: z.string().trim().max(120).nullable().optional(),
  beneficiaryLabel: z.string().trim().max(160).nullable().optional(),
  trustNote: z.string().trim().max(240).nullable().optional(),
  primaryCtaLabel: z.string().trim().max(80).nullable().optional(),
  secondaryCtaLabel: z.string().trim().max(80).nullable().optional(),
  videoUrl: z.string().url().max(1000).nullable().optional(),
  galleryUrls: z.array(z.string().url().max(1000)).max(8).default([]),
}).strict();

type CauseCampaignRow = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  country: string;
  city: string | null;
  primary_image: string | null;
  support_mode: string;
  target_amount_cents: number | null;
  raised_amount_cents: number;
  currency: string | null;
  vertical: string;
  campaign_key: string | null;
  campaign_meta: unknown;
  published_at: Date | null;
};

function publicCampaign(row: CauseCampaignRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    country: row.country,
    city: row.city,
    primaryImage: row.primary_image,
    supportMode: row.support_mode,
    targetAmountCents: row.target_amount_cents,
    raisedAmountCents: row.raised_amount_cents,
    currency: row.currency,
    vertical: row.vertical,
    campaignKey: row.campaign_key,
    campaignMeta: row.campaign_meta ?? {},
    publishedAt: row.published_at,
  };
}

export async function registerCauseCampaignRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/causes/vertical/:vertical", async (req, reply) => {
    const params = z.object({ vertical: verticalSchema }).safeParse(req.params);
    const query = z.object({
      country: countrySchema.optional(),
      limit: z.coerce.number().int().min(1).max(50).default(24),
    }).safeParse(req.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid vertical query" } });
    }

    const rows = query.data.country
      ? await prisma.$queryRaw<CauseCampaignRow[]>`
          select id, slug, title, summary, country, city, primary_image, support_mode,
                 target_amount_cents, raised_amount_cents, currency, vertical, campaign_key, campaign_meta, published_at
          from public.causes
          where status = 'ACTIVE' and is_public = true and vertical = ${params.data.vertical} and country = ${query.data.country}
          order by published_at desc nulls last, created_at desc
          limit ${query.data.limit}
        `
      : await prisma.$queryRaw<CauseCampaignRow[]>`
          select id, slug, title, summary, country, city, primary_image, support_mode,
                 target_amount_cents, raised_amount_cents, currency, vertical, campaign_key, campaign_meta, published_at
          from public.causes
          where status = 'ACTIVE' and is_public = true and vertical = ${params.data.vertical}
          order by published_at desc nulls last, created_at desc
          limit ${query.data.limit}
        `;

    return { data: rows.map(publicCampaign) };
  });

  app.get("/v1/causes/:slug/marketing", async (req, reply) => {
    const params = z.object({ slug: z.string().trim().min(2).max(100) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_SLUG", message: "Invalid cause slug" } });

    const rows = await prisma.$queryRaw<CauseCampaignRow[]>`
      select id, slug, title, summary, country, city, primary_image, support_mode,
             target_amount_cents, raised_amount_cents, currency, vertical, campaign_key, campaign_meta, published_at
      from public.causes
      where slug = ${params.data.slug} and status = 'ACTIVE' and is_public = true
      limit 1
    `;
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
    return { data: publicCampaign(row) };
  });

  app.get("/v1/cause-campaigns/:campaignKey", async (req, reply) => {
    const params = z.object({ campaignKey: campaignKeySchema }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_CAMPAIGN", message: "Invalid campaign" } });

    const rows = await prisma.$queryRaw<CauseCampaignRow[]>`
      select id, slug, title, summary, country, city, primary_image, support_mode,
             target_amount_cents, raised_amount_cents, currency, vertical, campaign_key, campaign_meta, published_at
      from public.causes
      where campaign_key = ${params.data.campaignKey} and status = 'ACTIVE' and is_public = true
      limit 1
    `;
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found" } });
    return { data: publicCampaign(row) };
  });

  const updateSchema = z.object({
    vertical: verticalSchema,
    campaignKey: campaignKeySchema.nullable().optional(),
    campaignMeta: campaignMetaSchema.default({ galleryUrls: [] }),
  });

  app.patch("/v1/causes/:id/marketing", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const parsed = updateSchema.safeParse(req.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid campaign metadata" } });
    }

    const owned = await prisma.$queryRaw<Array<{ id: string }>>`
      select c.id
      from public.causes c
      join public.protectors p on p.id = c.protector_id
      where c.id = ${params.data.id}::uuid and p.user_id = ${user.id}::uuid
      limit 1
    `;
    if (!owned[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });

    const metadata = JSON.stringify(parsed.data.campaignMeta);
    const rows = await prisma.$queryRaw<CauseCampaignRow[]>`
      update public.causes
      set vertical = ${parsed.data.vertical},
          campaign_key = ${parsed.data.campaignKey ?? null},
          campaign_meta = ${metadata}::jsonb,
          updated_at = now()
      where id = ${params.data.id}::uuid
      returning id, slug, title, summary, country, city, primary_image, support_mode,
                target_amount_cents, raised_amount_cents, currency, vertical, campaign_key, campaign_meta, published_at
    `;
    return { data: publicCampaign(rows[0]!) };
  });
}
