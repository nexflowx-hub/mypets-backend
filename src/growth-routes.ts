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

export async function registerGrowthRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/growth/campaigns/:slug", async (req, reply) => {
    const params = z.object({ slug: z.string().trim().min(2).max(80) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_SLUG", message: "Invalid campaign" } });

    const campaign = await prisma.growthCampaign.findFirst({
      where: { slug: params.data.slug, status: "ACTIVE" },
    });
    if (!campaign) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found" } });

    return {
      data: {
        slug: campaign.slug,
        name: campaign.name,
        intent: campaign.intent,
        headline: campaign.headline,
        subheadline: campaign.subheadline,
        ctaLabel: campaign.ctaLabel,
        country: campaign.country,
        landingVariant: campaign.landingVariant,
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

  app.post(
    "/v1/growth/leads",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = leadSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid lead" } });

      const campaign = parsed.data.campaignSlug
        ? await prisma.growthCampaign.findFirst({ where: { slug: parsed.data.campaignSlug, status: "ACTIVE" } })
        : null;

      const email = parsed.data.email?.trim().toLowerCase() ?? null;
      const phone = parsed.data.phone?.replace(/[^+\d]/g, "") || null;
      const score = scoreLead({
        intent: parsed.data.intent,
        email,
        phone,
        city: parsed.data.city,
        message: parsed.data.message,
        marketingConsent: parsed.data.marketingConsent,
      });

      const lead = await prisma.growthLead.create({
        data: {
          campaignId: campaign?.id ?? null,
          intent: parsed.data.intent,
          name: parsed.data.name ?? null,
          email,
          phone,
          country: parsed.data.country ?? null,
          city: parsed.data.city ?? null,
          message: parsed.data.message ?? null,
          source: normalized(parsed.data.source),
          medium: normalized(parsed.data.medium),
          campaign: normalized(parsed.data.campaign ?? campaign?.slug),
          content: normalized(parsed.data.content),
          term: normalized(parsed.data.term),
          refCode: parsed.data.refCode ?? null,
          landingPath: parsed.data.landingPath ?? null,
          contactConsent: true,
          marketingConsent: parsed.data.marketingConsent,
          score,
          metadata: safeMetadata(parsed.data.metadata),
        },
      });

      await prisma.growthEvent.create({
        data: {
          campaignId: campaign?.id ?? null,
          leadId: lead.id,
          eventName: "LEAD_CREATED",
          source: lead.source,
          medium: lead.medium,
          campaign: lead.campaign,
          content: lead.content,
          landingPath: lead.landingPath,
          metadata: { intent: lead.intent, score: lead.score },
        },
      });

      return reply.code(201).send({ data: { id: lead.id, intent: lead.intent, score: lead.score } });
    }
  );

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

  app.post(
    "/v1/growth/events",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = eventBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid growth event" } });
      const campaignRow = parsed.data.campaignSlug
        ? await prisma.growthCampaign.findUnique({ where: { slug: parsed.data.campaignSlug } })
        : null;
      const event = await prisma.growthEvent.create({
        data: {
          campaignId: campaignRow?.id ?? null,
          leadId: parsed.data.leadId ?? null,
          eventName: parsed.data.eventName,
          source: normalized(parsed.data.source),
          medium: normalized(parsed.data.medium),
          campaign: normalized(parsed.data.campaign ?? campaignRow?.slug),
          content: normalized(parsed.data.content),
          landingPath: parsed.data.landingPath ?? null,
          metadata: safeMetadata(parsed.data.metadata),
        },
      });
      return reply.code(201).send({ data: { id: event.id } });
    }
  );

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

    const campaignRow = parsed.data.campaignSlug
      ? await prisma.growthCampaign.findUnique({ where: { slug: parsed.data.campaignSlug } })
      : null;
    const code = crypto.randomBytes(6).toString("base64url");
    const row = await prisma.shareLink.create({
      data: {
        code,
        destinationPath: parsed.data.destinationPath,
        campaignId: campaignRow?.id ?? null,
        ownerUserId: user.id,
        source: normalized(parsed.data.source ?? "mypets"),
        medium: normalized(parsed.data.medium ?? "share"),
        campaign: normalized(parsed.data.campaign ?? campaignRow?.slug),
        content: normalized(parsed.data.content),
      },
    });
    return reply.code(201).send({ data: { code: row.code, path: `/s/${row.code}` } });
  });

  app.get("/v1/growth/share/:code", async (req, reply) => {
    const params = z.object({ code: z.string().trim().min(4).max(40) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_CODE", message: "Invalid share code" } });

    const row = await prisma.shareLink.findUnique({ where: { code: params.data.code } });
    if (!row || !row.active || (row.expiresAt && row.expiresAt < new Date())) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Share link not found" } });
    }

    await prisma.$transaction([
      prisma.shareLink.update({ where: { id: row.id }, data: { clicks: { increment: 1 } } }),
      prisma.growthEvent.create({
        data: {
          campaignId: row.campaignId,
          userId: row.ownerUserId,
          eventName: "SHARE_CLICK",
          source: row.source,
          medium: row.medium,
          campaign: row.campaign,
          content: row.content,
          landingPath: row.destinationPath,
          metadata: { shareCode: row.code },
        },
      }),
    ]);

    const paramsOut = new URLSearchParams();
    if (row.source) paramsOut.set("utm_source", row.source);
    if (row.medium) paramsOut.set("utm_medium", row.medium);
    if (row.campaign) paramsOut.set("utm_campaign", row.campaign);
    if (row.content) paramsOut.set("utm_content", row.content);
    paramsOut.set("ref", row.code);
    const joiner = row.destinationPath.includes("?") ? "&" : "?";
    return { data: { destination: `${row.destinationPath}${paramsOut.size ? `${joiner}${paramsOut.toString()}` : ""}` } };
  });
}
