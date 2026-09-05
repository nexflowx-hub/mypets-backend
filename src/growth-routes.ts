import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const intentSchema = z.enum(["SUPPORT", "VOLUNTEER", "SPONSOR", "DONATE", "PROTECTOR", "ADOPT", "PROJECT", "FOUND_ANIMAL"]);
const countrySchema = z.enum(["PT", "BR"]);
const eventSchema = z.enum([
  "LANDING_VIEW",
  "LEAD_CREATED",
  "SIGNUP_STARTED",
  "SIGNUP_COMPLETED",
  "ROLE_SELECTED",
  "PROTECTOR_CREATED",
  "PET_CREATED",
  "SUPPORT_STARTED",
  "SPONSORSHIP_STARTED",
  "DONATION_STARTED",
  "DONATION_COMPLETED",
  "SHARE_CLICK",
]);

const optionalText = (max = 160) => z.string().trim().max(max).nullable().optional();
const trackingText = optionalText(120);

type CampaignRow = {
  id: string;
  slug: string;
  name: string;
  intent: string;
  headline: string;
  subheadline: string | null;
  cta_label: string;
  country: string | null;
  landing_variant: string;
};

type ShareRow = {
  id: string;
  code: string;
  destination_path: string;
  campaign_id: string | null;
  owner_user_id: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  active: boolean;
  expires_at: Date | null;
};

function normalized(value: string | null | undefined) {
  const text = value?.trim().toLowerCase();
  return text ? text.slice(0, 120) : null;
}

function scoreLead(input: { intent: string; email?: string | null; phone?: string | null; city?: string | null; message?: string | null; marketingConsent: boolean }) {
  let score = 20;
  if (input.email) score += 15;
  if (input.phone) score += 20;
  if (input.city) score += 10;
  if (input.message && input.message.length >= 20) score += 10;
  if (["PROTECTOR", "PROJECT", "SPONSOR"].includes(input.intent)) score += 15;
  if (input.marketingConsent) score += 10;
  return Math.min(100, score);
}

function safeMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 25));
}

async function findCampaign(prisma: PrismaClient, slug: string | null | undefined, activeOnly = true) {
  if (!slug) return null;
  const rows = activeOnly
    ? await prisma.$queryRaw<CampaignRow[]>`
        select id, slug, name, intent, headline, subheadline, cta_label, country, landing_variant
        from public.growth_campaigns where slug = ${slug} and status = 'ACTIVE' limit 1
      `
    : await prisma.$queryRaw<CampaignRow[]>`
        select id, slug, name, intent, headline, subheadline, cta_label, country, landing_variant
        from public.growth_campaigns where slug = ${slug} limit 1
      `;
  return rows[0] ?? null;
}

export async function registerGrowthRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/growth/campaigns/:slug", async (req, reply) => {
    const params = z.object({ slug: z.string().trim().min(2).max(80) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_SLUG", message: "Invalid campaign" } });
    const campaign = await findCampaign(prisma, params.data.slug);
    if (!campaign) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found" } });
    return {
      data: {
        slug: campaign.slug,
        name: campaign.name,
        intent: campaign.intent,
        headline: campaign.headline,
        subheadline: campaign.subheadline,
        ctaLabel: campaign.cta_label,
        country: campaign.country,
        landingVariant: campaign.landing_variant,
      },
    };
  });

  const leadSchema = z.object({
    campaignSlug: z.string().trim().min(2).max(80).nullable().optional(),
    intent: intentSchema,
    name: optionalText(120),
    email: z.string().email().max(254).nullable().optional(),
    phone: optionalText(40),
    country: countrySchema.nullable().optional(),
    city: optionalText(120),
    message: optionalText(3000),
    source: trackingText,
    medium: trackingText,
    campaign: trackingText,
    content: trackingText,
    term: trackingText,
    refCode: optionalText(80),
    landingPath: optionalText(500),
    contactConsent: z.literal(true),
    marketingConsent: z.boolean().default(false),
    website: z.string().max(0).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).refine((value) => Boolean(value.email || value.phone), { message: "Email or phone is required" });

  app.post("/v1/growth/leads", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = leadSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid lead" } });

    const campaignRow = await findCampaign(prisma, parsed.data.campaignSlug);
    const email = parsed.data.email?.trim().toLowerCase() ?? null;
    const phone = parsed.data.phone?.replace(/[^+\d]/g, "") || null;
    const source = normalized(parsed.data.source);
    const medium = normalized(parsed.data.medium);
    const campaign = normalized(parsed.data.campaign ?? campaignRow?.slug);
    const content = normalized(parsed.data.content);
    const term = normalized(parsed.data.term);
    const score = scoreLead({ intent: parsed.data.intent, email, phone, city: parsed.data.city, message: parsed.data.message, marketingConsent: parsed.data.marketingConsent });
    const metadata = JSON.stringify(safeMetadata(parsed.data.metadata));

    const rows = await prisma.$queryRaw<Array<{ id: string; intent: string; score: number }>>`
      insert into public.growth_leads (
        campaign_id, intent, name, email, phone, country, city, message,
        source, medium, campaign, content, term, ref_code, landing_path,
        contact_consent, marketing_consent, score, metadata
      ) values (
        ${campaignRow?.id ?? null}::uuid, ${parsed.data.intent}, ${parsed.data.name ?? null}, ${email}, ${phone},
        ${parsed.data.country ?? null}, ${parsed.data.city ?? null}, ${parsed.data.message ?? null},
        ${source}, ${medium}, ${campaign}, ${content}, ${term}, ${parsed.data.refCode ?? null}, ${parsed.data.landingPath ?? null},
        true, ${parsed.data.marketingConsent}, ${score}, ${metadata}::jsonb
      ) returning id, intent, score
    `;
    const lead = rows[0];
    if (!lead) return reply.code(500).send({ error: { code: "LEAD_CREATE_FAILED", message: "Unable to create lead" } });

    await prisma.$executeRaw`
      insert into public.growth_events (campaign_id, lead_id, event_name, source, medium, campaign, content, landing_path, metadata)
      values (${campaignRow?.id ?? null}::uuid, ${lead.id}::uuid, 'LEAD_CREATED', ${source}, ${medium}, ${campaign}, ${content}, ${parsed.data.landingPath ?? null}, ${JSON.stringify({ intent: lead.intent, score: lead.score })}::jsonb)
    `;

    return reply.code(201).send({ data: lead });
  });

  const eventBody = z.object({
    campaignSlug: z.string().trim().min(2).max(80).nullable().optional(),
    leadId: z.string().uuid().nullable().optional(),
    eventName: eventSchema,
    source: trackingText,
    medium: trackingText,
    campaign: trackingText,
    content: trackingText,
    landingPath: optionalText(500),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  app.post("/v1/growth/events", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = eventBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid growth event" } });
    const campaignRow = await findCampaign(prisma, parsed.data.campaignSlug, false);
    const id = crypto.randomUUID();
    await prisma.$executeRaw`
      insert into public.growth_events (id, campaign_id, lead_id, event_name, source, medium, campaign, content, landing_path, metadata)
      values (
        ${id}::uuid, ${campaignRow?.id ?? null}::uuid, ${parsed.data.leadId ?? null}::uuid, ${parsed.data.eventName},
        ${normalized(parsed.data.source)}, ${normalized(parsed.data.medium)}, ${normalized(parsed.data.campaign ?? campaignRow?.slug)},
        ${normalized(parsed.data.content)}, ${parsed.data.landingPath ?? null}, ${JSON.stringify(safeMetadata(parsed.data.metadata))}::jsonb
      )
    `;
    return reply.code(201).send({ data: { id } });
  });

  const shareSchema = z.object({
    destinationPath: z.string().trim().min(1).max(500).refine((value) => value.startsWith("/"), "Destination must be an internal path"),
    campaignSlug: z.string().trim().min(2).max(80).nullable().optional(),
    source: trackingText,
    medium: trackingText,
    campaign: trackingText,
    content: trackingText,
  });

  app.post("/v1/growth/share-links", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = shareSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid share link" } });
    const campaignRow = await findCampaign(prisma, parsed.data.campaignSlug, false);
    const code = crypto.randomBytes(6).toString("base64url");
    await prisma.$executeRaw`
      insert into public.share_links (code, destination_path, campaign_id, owner_user_id, source, medium, campaign, content)
      values (
        ${code}, ${parsed.data.destinationPath}, ${campaignRow?.id ?? null}::uuid, ${user.id}::uuid,
        ${normalized(parsed.data.source ?? "mypets")}, ${normalized(parsed.data.medium ?? "share")},
        ${normalized(parsed.data.campaign ?? campaignRow?.slug)}, ${normalized(parsed.data.content)}
      )
    `;
    return reply.code(201).send({ data: { code, path: `/s/${code}` } });
  });

  app.get("/v1/growth/share/:code", async (req, reply) => {
    const params = z.object({ code: z.string().trim().min(4).max(40) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_CODE", message: "Invalid share code" } });
    const rows = await prisma.$queryRaw<ShareRow[]>`
      select id, code, destination_path, campaign_id, owner_user_id, source, medium, campaign, content, active, expires_at
      from public.share_links where code = ${params.data.code} limit 1
    `;
    const row = rows[0];
    if (!row || !row.active || (row.expires_at && row.expires_at < new Date())) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Share link not found" } });
    }

    await prisma.$transaction([
      prisma.$executeRaw`update public.share_links set clicks = clicks + 1 where id = ${row.id}::uuid`,
      prisma.$executeRaw`
        insert into public.growth_events (campaign_id, user_id, event_name, source, medium, campaign, content, landing_path, metadata)
        values (${row.campaign_id}::uuid, ${row.owner_user_id}::uuid, 'SHARE_CLICK', ${row.source}, ${row.medium}, ${row.campaign}, ${row.content}, ${row.destination_path}, ${JSON.stringify({ shareCode: row.code })}::jsonb)
      `,
    ]);

    const paramsOut = new URLSearchParams();
    if (row.source) paramsOut.set("utm_source", row.source);
    if (row.medium) paramsOut.set("utm_medium", row.medium);
    if (row.campaign) paramsOut.set("utm_campaign", row.campaign);
    if (row.content) paramsOut.set("utm_content", row.content);
    paramsOut.set("ref", row.code);
    const joiner = row.destination_path.includes("?") ? "&" : "?";
    return { data: { destination: `${row.destination_path}${paramsOut.size ? `${joiner}${paramsOut.toString()}` : ""}` } };
  });
}
