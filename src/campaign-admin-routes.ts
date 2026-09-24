import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const adminRoleSchema = z.enum(["SUPERADMIN", "REVIEWER", "OUTREACH"]);
const causeStatusSchema = z.enum(["DRAFT", "ACTIVE", "PAUSED", "FUNDED", "CLOSED"]);
const verticalSchema = z.enum(["GENERAL", "FOOD", "VET", "RESCUE", "SHELTER", "EMERGENCY"]);
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

function configuredAdminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function requireCampaignAdmin(req: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await requireAuth(req, reply);
  if (!user) return null;

  const rows = await prisma.$queryRaw<Array<{ role: string }>>`
    select role from public.admin_users where user_id = ${user.id}::uuid and active = true limit 1
  `;
  const storedRole = rows[0]?.role;
  if (storedRole && adminRoleSchema.safeParse(storedRole).success) return { user, role: storedRole };

  const email = user.email?.trim().toLowerCase() ?? "";
  if (email && configuredAdminEmails().has(email)) return { user, role: "SUPERADMIN" };

  reply.code(403).send({ error: { code: "ADMIN_REQUIRED", message: "Administrator access required" } });
  return null;
}

type AdminCauseRow = {
  id: string;
  protector_id: string;
  protector_name: string | null;
  protector_verification: string | null;
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
  status: string;
  is_public: boolean;
  vertical: string;
  campaign_key: string | null;
  campaign_meta: unknown;
  published_at: Date | null;
  updated_at: Date;
};

function adminCause(row: AdminCauseRow) {
  return {
    id: row.id,
    protectorId: row.protector_id,
    protectorName: row.protector_name,
    protectorVerification: row.protector_verification,
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
    status: row.status,
    isPublic: row.is_public,
    vertical: row.vertical,
    campaignKey: row.campaign_key,
    campaignMeta: row.campaign_meta ?? {},
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

export async function registerCampaignAdminRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/admin/campaigns/causes", async (req, reply) => {
    const admin = await requireCampaignAdmin(req, reply, prisma);
    if (!admin) return;

    const parsed = z.object({
      q: z.string().trim().max(160).optional(),
      vertical: verticalSchema.optional(),
      status: causeStatusSchema.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid campaign admin query" } });

    const search = parsed.data.q ? `%${parsed.data.q.toLowerCase()}%` : null;
    const vertical = parsed.data.vertical ?? null;
    const status = parsed.data.status ?? null;

    const rows = await prisma.$queryRaw<AdminCauseRow[]>`
      select c.id, c.protector_id, p.display_name as protector_name, p.verification as protector_verification,
             c.slug, c.title, c.summary, c.country, c.city, c.primary_image, c.support_mode,
             c.target_amount_cents, c.raised_amount_cents, c.currency, c.status, c.is_public,
             c.vertical, c.campaign_key, c.campaign_meta, c.published_at, c.updated_at
      from public.causes c
      left join public.protectors p on p.id = c.protector_id
      where (${search}::text is null or lower(c.title) like ${search} or lower(c.slug) like ${search} or lower(coalesce(p.display_name, '')) like ${search})
        and (${vertical}::text is null or c.vertical = ${vertical})
        and (${status}::text is null or c.status = ${status})
      order by
        case c.status when 'ACTIVE' then 1 when 'DRAFT' then 2 when 'PAUSED' then 3 else 4 end,
        c.updated_at desc
      limit ${parsed.data.limit}
    `;

    const counts = await prisma.$queryRaw<Array<{ vertical: string; count: number }>>`
      select vertical, count(*)::int as count
      from public.causes
      group by vertical
      order by vertical
    `;

    return {
      data: {
        causes: rows.map(adminCause),
        counts: Object.fromEntries(counts.map((row) => [row.vertical, row.count])),
      },
    };
  });


  app.get("/v1/admin/growth/overview", async (req, reply) => {
    const admin = await requireCampaignAdmin(req, reply, prisma);
    if (!admin) return;

    const parsed = z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
      path: z.string().trim().max(500).optional(),
    }).safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid growth overview query" } });
    }

    const days = parsed.data.days;
    const pathFilter = parsed.data.path ? parsed.data.path + "%" : null;

    type TotalsRow = {
      landing_views: number;
      support_started: number;
      donation_started: number;
      donation_completed: number;
      share_clicks: number;
    };
    type BreakdownRow = {
      source: string;
      medium: string;
      campaign: string;
      content: string;
      landing_path: string;
      landing_views: number;
      support_started: number;
      donation_started: number;
      donation_completed: number;
      share_clicks: number;
      donation_amount_cents: bigint;
    };
    type DailyRow = {
      day: Date;
      landing_views: number;
      support_started: number;
      donation_started: number;
      donation_completed: number;
      share_clicks: number;
      donation_amount_cents: bigint;
    };
    type CurrencyRow = {
      currency: string;
      donation_completed: number;
      donation_amount_cents: bigint;
    };

    const [totalsRows, breakdownRows, dailyRows, currencyRows] = await Promise.all([
      prisma.$queryRaw<TotalsRow[]>\`
        select
          count(*) filter (where event_name = 'LANDING_VIEW')::int as landing_views,
          count(*) filter (where event_name = 'SUPPORT_STARTED')::int as support_started,
          count(*) filter (where event_name = 'DONATION_STARTED')::int as donation_started,
          count(*) filter (where event_name = 'DONATION_COMPLETED')::int as donation_completed,
          count(*) filter (where event_name = 'SHARE_CLICK')::int as share_clicks
        from public.growth_events
        where created_at >= now() - make_interval(days => ${days})
          and (${pathFilter}::text is null or landing_path like ${pathFilter})
      \`,
      prisma.$queryRaw<BreakdownRow[]>\`
        select
          coalesce(source, '(direct)') as source,
          coalesce(medium, '(none)') as medium,
          coalesce(campaign, '(none)') as campaign,
          coalesce(content, '(none)') as content,
          coalesce(landing_path, '(unknown)') as landing_path,
          count(*) filter (where event_name = 'LANDING_VIEW')::int as landing_views,
          count(*) filter (where event_name = 'SUPPORT_STARTED')::int as support_started,
          count(*) filter (where event_name = 'DONATION_STARTED')::int as donation_started,
          count(*) filter (where event_name = 'DONATION_COMPLETED')::int as donation_completed,
          count(*) filter (where event_name = 'SHARE_CLICK')::int as share_clicks,
          coalesce(sum(
            case
              when event_name = 'DONATION_COMPLETED' and coalesce(metadata->>'amountCents', '') ~ '^[0-9]+
    const admin = await requireCampaignAdmin(req, reply, prisma);
    if (!admin) return;

    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({
      vertical: verticalSchema,
      campaignKey: campaignKeySchema.nullable().optional(),
      campaignMeta: campaignMetaSchema,
    }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid campaign configuration" } });
    }

    const metadata = JSON.stringify(body.data.campaignMeta);
    try {
      const rows = await prisma.$queryRaw<AdminCauseRow[]>`
        update public.causes c
        set vertical = ${body.data.vertical},
            campaign_key = ${body.data.campaignKey ?? null},
            campaign_meta = ${metadata}::jsonb,
            updated_at = now()
        from public.protectors p
        where c.id = ${params.data.id}::uuid and p.id = c.protector_id
        returning c.id, c.protector_id, p.display_name as protector_name, p.verification as protector_verification,
                  c.slug, c.title, c.summary, c.country, c.city, c.primary_image, c.support_mode,
                  c.target_amount_cents, c.raised_amount_cents, c.currency, c.status, c.is_public,
                  c.vertical, c.campaign_key, c.campaign_meta, c.published_at, c.updated_at
      `;
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
      return { data: adminCause(row) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("causes_campaign_key_unique")) {
        return reply.code(409).send({ error: { code: "CAMPAIGN_KEY_TAKEN", message: "Campaign key already in use" } });
      }
      throw error;
    }
  });
}

              then (metadata->>'amountCents')::bigint
              else 0
            end
          ), 0)::bigint as donation_amount_cents
        from public.growth_events
        where created_at >= now() - make_interval(days => ${days})
          and (${pathFilter}::text is null or landing_path like ${pathFilter})
        group by source, medium, campaign, content, landing_path
        having count(*) filter (where event_name in ('LANDING_VIEW','SUPPORT_STARTED','DONATION_STARTED','DONATION_COMPLETED','SHARE_CLICK')) > 0
        order by donation_completed desc, donation_amount_cents desc, support_started desc, landing_views desc
        limit 60
      \`,
      prisma.$queryRaw<DailyRow[]>\`
        select
          date_trunc('day', created_at)::date as day,
          count(*) filter (where event_name = 'LANDING_VIEW')::int as landing_views,
          count(*) filter (where event_name = 'SUPPORT_STARTED')::int as support_started,
          count(*) filter (where event_name = 'DONATION_STARTED')::int as donation_started,
          count(*) filter (where event_name = 'DONATION_COMPLETED')::int as donation_completed,
          count(*) filter (where event_name = 'SHARE_CLICK')::int as share_clicks,
          coalesce(sum(
            case
              when event_name = 'DONATION_COMPLETED' and coalesce(metadata->>'amountCents', '') ~ '^[0-9]+
    const admin = await requireCampaignAdmin(req, reply, prisma);
    if (!admin) return;

    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({
      vertical: verticalSchema,
      campaignKey: campaignKeySchema.nullable().optional(),
      campaignMeta: campaignMetaSchema,
    }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid campaign configuration" } });
    }

    const metadata = JSON.stringify(body.data.campaignMeta);
    try {
      const rows = await prisma.$queryRaw<AdminCauseRow[]>`
        update public.causes c
        set vertical = ${body.data.vertical},
            campaign_key = ${body.data.campaignKey ?? null},
            campaign_meta = ${metadata}::jsonb,
            updated_at = now()
        from public.protectors p
        where c.id = ${params.data.id}::uuid and p.id = c.protector_id
        returning c.id, c.protector_id, p.display_name as protector_name, p.verification as protector_verification,
                  c.slug, c.title, c.summary, c.country, c.city, c.primary_image, c.support_mode,
                  c.target_amount_cents, c.raised_amount_cents, c.currency, c.status, c.is_public,
                  c.vertical, c.campaign_key, c.campaign_meta, c.published_at, c.updated_at
      `;
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
      return { data: adminCause(row) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("causes_campaign_key_unique")) {
        return reply.code(409).send({ error: { code: "CAMPAIGN_KEY_TAKEN", message: "Campaign key already in use" } });
      }
      throw error;
    }
  });
}

              then (metadata->>'amountCents')::bigint
              else 0
            end
          ), 0)::bigint as donation_amount_cents
        from public.growth_events
        where created_at >= now() - make_interval(days => ${days})
          and (${pathFilter}::text is null or landing_path like ${pathFilter})
        group by date_trunc('day', created_at)::date
        order by day asc
      \`,
      prisma.$queryRaw<CurrencyRow[]>\`
        select
          coalesce(nullif(metadata->>'currency', ''), 'UNKNOWN') as currency,
          count(*)::int as donation_completed,
          coalesce(sum(
            case when coalesce(metadata->>'amountCents', '') ~ '^[0-9]+
    const admin = await requireCampaignAdmin(req, reply, prisma);
    if (!admin) return;

    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({
      vertical: verticalSchema,
      campaignKey: campaignKeySchema.nullable().optional(),
      campaignMeta: campaignMetaSchema,
    }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid campaign configuration" } });
    }

    const metadata = JSON.stringify(body.data.campaignMeta);
    try {
      const rows = await prisma.$queryRaw<AdminCauseRow[]>`
        update public.causes c
        set vertical = ${body.data.vertical},
            campaign_key = ${body.data.campaignKey ?? null},
            campaign_meta = ${metadata}::jsonb,
            updated_at = now()
        from public.protectors p
        where c.id = ${params.data.id}::uuid and p.id = c.protector_id
        returning c.id, c.protector_id, p.display_name as protector_name, p.verification as protector_verification,
                  c.slug, c.title, c.summary, c.country, c.city, c.primary_image, c.support_mode,
                  c.target_amount_cents, c.raised_amount_cents, c.currency, c.status, c.is_public,
                  c.vertical, c.campaign_key, c.campaign_meta, c.published_at, c.updated_at
      `;
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
      return { data: adminCause(row) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("causes_campaign_key_unique")) {
        return reply.code(409).send({ error: { code: "CAMPAIGN_KEY_TAKEN", message: "Campaign key already in use" } });
      }
      throw error;
    }
  });
}

              then (metadata->>'amountCents')::bigint else 0 end
          ), 0)::bigint as donation_amount_cents
        from public.growth_events
        where event_name = 'DONATION_COMPLETED'
          and created_at >= now() - make_interval(days => ${days})
          and (${pathFilter}::text is null or landing_path like ${pathFilter})
        group by coalesce(nullif(metadata->>'currency', ''), 'UNKNOWN')
        order by donation_amount_cents desc
      \`,
    ]);

    const totals = totalsRows[0] ?? {
      landing_views: 0,
      support_started: 0,
      donation_started: 0,
      donation_completed: 0,
      share_clicks: 0,
    };

    const ratio = (numerator: number, denominator: number) => denominator > 0
      ? Math.round((numerator / denominator) * 10_000) / 100
      : 0;

    return {
      data: {
        windowDays: days,
        path: parsed.data.path ?? null,
        totals: {
          landingViews: totals.landing_views,
          supportStarted: totals.support_started,
          donationStarted: totals.donation_started,
          donationCompleted: totals.donation_completed,
          shareClicks: totals.share_clicks,
          landingToSupportPct: ratio(totals.support_started, totals.landing_views),
          supportToDonationStartedPct: ratio(totals.donation_started, totals.support_started),
          donationCompletionPct: ratio(totals.donation_completed, totals.donation_started),
          landingToDonationPct: ratio(totals.donation_completed, totals.landing_views),
        },
        amounts: currencyRows.map((row) => ({
          currency: row.currency,
          donationCompleted: row.donation_completed,
          amountCents: Number(row.donation_amount_cents),
          averageCents: row.donation_completed > 0 ? Math.round(Number(row.donation_amount_cents) / row.donation_completed) : 0,
        })),
        breakdown: breakdownRows.map((row) => ({
          source: row.source,
          medium: row.medium,
          campaign: row.campaign,
          content: row.content,
          landingPath: row.landing_path,
          landingViews: row.landing_views,
          supportStarted: row.support_started,
          donationStarted: row.donation_started,
          donationCompleted: row.donation_completed,
          shareClicks: row.share_clicks,
          amountCents: Number(row.donation_amount_cents),
          landingToDonationPct: ratio(row.donation_completed, row.landing_views),
          donationCompletionPct: ratio(row.donation_completed, row.donation_started),
        })),
        daily: dailyRows.map((row) => ({
          day: row.day,
          landingViews: row.landing_views,
          supportStarted: row.support_started,
          donationStarted: row.donation_started,
          donationCompleted: row.donation_completed,
          shareClicks: row.share_clicks,
          amountCents: Number(row.donation_amount_cents),
        })),
      },
    };
  });

  app.patch("/v1/admin/campaigns/causes/:id", async (req, reply) => {
    const admin = await requireCampaignAdmin(req, reply, prisma);
    if (!admin) return;

    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({
      vertical: verticalSchema,
      campaignKey: campaignKeySchema.nullable().optional(),
      campaignMeta: campaignMetaSchema,
    }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid campaign configuration" } });
    }

    const metadata = JSON.stringify(body.data.campaignMeta);
    try {
      const rows = await prisma.$queryRaw<AdminCauseRow[]>`
        update public.causes c
        set vertical = ${body.data.vertical},
            campaign_key = ${body.data.campaignKey ?? null},
            campaign_meta = ${metadata}::jsonb,
            updated_at = now()
        from public.protectors p
        where c.id = ${params.data.id}::uuid and p.id = c.protector_id
        returning c.id, c.protector_id, p.display_name as protector_name, p.verification as protector_verification,
                  c.slug, c.title, c.summary, c.country, c.city, c.primary_image, c.support_mode,
                  c.target_amount_cents, c.raised_amount_cents, c.currency, c.status, c.is_public,
                  c.vertical, c.campaign_key, c.campaign_meta, c.published_at, c.updated_at
      `;
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause not found" } });
      return { data: adminCause(row) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("causes_campaign_key_unique")) {
        return reply.code(409).send({ error: { code: "CAMPAIGN_KEY_TAKEN", message: "Campaign key already in use" } });
      }
      throw error;
    }
  });
}
