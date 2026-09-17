import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

const causeTypeSchema = z.enum([
  "VET_HELP",
  "RESCUE",
  "SHELTER",
  "FEEDING",
  "ADOPTION",
  "EMERGENCY",
  "NGO_PROJECT",
  "OTHER",
]);

const isoCountrySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const trackingText = z.string().trim().max(180).nullable().optional();
const optionalUrl = z.string().trim().url().max(1200).nullable().optional();

const mediaSchema = z.object({
  type: z.enum(["IMAGE", "VIDEO", "LINK"]),
  url: z.string().trim().url().max(1500),
  caption: z.string().trim().max(300).nullable().optional(),
});

function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52) || "causa";
}

function normalizePhone(value: string) {
  const compact = value.trim().replace(/[^+\d]/g, "");
  return compact.slice(0, 40);
}

function normalizeSocialUrl(raw: string | null | undefined, hosts: string[]) {
  if (!raw) return null;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Unsupported URL protocol");
  const host = url.hostname.toLowerCase();
  if (!hosts.includes(host)) throw new Error("Social URL does not match the selected platform");
  url.hash = "";
  return url.toString();
}

const intakeSchema = z.object({
  projectName: z.string().trim().min(4).max(160),
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().email().max(254).nullable().optional(),
  whatsapp: z.string().trim().min(8).max(40),
  publicWhatsapp: z.boolean().default(false),
  country: isoCountrySchema,
  region: z.string().trim().min(2).max(120),
  city: z.string().trim().max(120).nullable().optional(),
  causeType: causeTypeSchema,
  details: z.string().trim().min(40).max(8000),
  publicMessage: z.string().trim().min(20).max(500),
  instagramUrl: optionalUrl,
  facebookUrl: optionalUrl,
  tiktokUrl: optionalUrl,
  primaryImageUrl: optionalUrl,
  mediaLinks: z.array(mediaSchema).max(8).default([]),
  source: trackingText,
  medium: trackingText,
  campaign: trackingText,
  content: trackingText,
  landingPath: z.string().trim().max(500).nullable().optional(),
  contactConsent: z.literal(true),
  publicationConsent: z.literal(true),
  accuracyConfirmed: z.literal(true),
  marketingConsent: z.boolean().default(false),
  website: z.string().max(0).optional(),
});

function verificationWhatsapp(slug: string) {
  const text = [
    "Olá MyPets, quero solicitar a verificação da minha causa.",
    `Causa: ${slug}`,
    "Gostaria de avançar com validação de identidade/documentos e habilitação para receber apoios.",
  ].join("\n");
  return `https://wa.me/5562996197224?text=${encodeURIComponent(text)}`;
}

export async function registerCauseIntakeRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post(
    "/v1/cause-intake",
    { config: { rateLimit: { max: 4, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const parsed = intakeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Revise os dados da causa e tente novamente." } });
      }

      let instagramUrl: string | null;
      let facebookUrl: string | null;
      let tiktokUrl: string | null;
      try {
        instagramUrl = normalizeSocialUrl(parsed.data.instagramUrl, ["instagram.com", "www.instagram.com"]);
        facebookUrl = normalizeSocialUrl(parsed.data.facebookUrl, ["facebook.com", "www.facebook.com", "m.facebook.com"]);
        tiktokUrl = normalizeSocialUrl(parsed.data.tiktokUrl, ["tiktok.com", "www.tiktok.com"]);
      } catch (error) {
        return reply.code(400).send({
          error: { code: "INVALID_SOCIAL_URL", message: error instanceof Error ? error.message : "Link de rede social inválido." },
        });
      }

      const causeId = crypto.randomUUID();
      const intakeId = crypto.randomUUID();
      const slug = `${slugify(parsed.data.projectName)}-${causeId.slice(0, 8)}`;
      const whatsapp = normalizePhone(parsed.data.whatsapp);
      const publicMessage = parsed.data.publicMessage.trim();
      const publicSite = (process.env.PUBLIC_SITE_URL ?? "https://mypets.lat").replace(/\/$/, "");
      const mediaLinks = parsed.data.mediaLinks.map((item) => ({
        type: item.type,
        url: item.url,
        caption: item.caption ?? null,
      }));

      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          insert into public.causes (
            id, protector_id, slug, title, summary, story, country, region, city, primary_image,
            support_mode, target_amount_cents, currency, status, is_public, published_at,
            beneficiary_kind, cause_type, verification_status, fundraising_status, intake_source
          ) values (
            ${causeId}::uuid, null, ${slug}, ${parsed.data.projectName}, ${publicMessage}, ${parsed.data.details},
            ${parsed.data.country}, ${parsed.data.region}, ${parsed.data.city ?? null}, ${parsed.data.primaryImageUrl ?? null},
            'NON_FINANCIAL', null, null, 'ACTIVE', true, now(),
            'COMMUNITY', ${parsed.data.causeType}, 'UNVERIFIED', 'DISABLED', 'SELF_SERVICE'
          )
        `;

        await tx.$executeRaw`
          insert into public.cause_intake_submissions (
            id, cause_id, contact_name, contact_email, whatsapp, public_whatsapp,
            country, region, city, cause_type, instagram_url, facebook_url, tiktok_url, media_links,
            source, medium, campaign, content, landing_path,
            contact_consent, publication_consent, accuracy_confirmed, marketing_consent
          ) values (
            ${intakeId}::uuid, ${causeId}::uuid, ${parsed.data.contactName}, ${parsed.data.contactEmail?.toLowerCase() ?? null},
            ${whatsapp}, ${parsed.data.publicWhatsapp}, ${parsed.data.country}, ${parsed.data.region}, ${parsed.data.city ?? null},
            ${parsed.data.causeType}, ${instagramUrl}, ${facebookUrl}, ${tiktokUrl}, ${JSON.stringify(mediaLinks)}::jsonb,
            ${parsed.data.source ?? null}, ${parsed.data.medium ?? null}, ${parsed.data.campaign ?? null},
            ${parsed.data.content ?? null}, ${parsed.data.landingPath ?? null}, true, true, true, ${parsed.data.marketingConsent}
          )
        `;

        const caption = `${parsed.data.projectName}\n\n${publicMessage}\n\nConheça e acompanhe em ${publicSite}/causas/${slug}`;
        await tx.$executeRaw`
          insert into public.cause_promotion_queue (cause_id, suggested_caption, metadata)
          values (
            ${causeId}::uuid,
            ${caption},
            ${JSON.stringify({ causeType: parsed.data.causeType, country: parsed.data.country, region: parsed.data.region, mediaLinks })}::jsonb
          )
          on conflict (cause_id) do nothing
        `;
      });

      return reply.code(201).send({
        data: {
          id: intakeId,
          causeId,
          slug,
          publicUrl: `${publicSite}/causas/${slug}`,
          verificationStatus: "UNVERIFIED",
          fundraisingStatus: "DISABLED",
          promotionStatus: "QUEUED",
          verificationWhatsappUrl: verificationWhatsapp(slug),
          message: "A causa foi publicada como conteúdo enviado pela comunidade. Apoios financeiros permanecem desativados até verificação.",
        },
      });
    },
  );

  app.get("/v1/cause-intake/:id/public-status", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid intake id" } });

    const rows = await prisma.$queryRaw<Array<{
      id: string;
      cause_id: string;
      status: string;
      slug: string;
      verification_status: string;
      fundraising_status: string;
      promotion_status: string | null;
    }>>`
      select ci.id, ci.cause_id, ci.status, c.slug, c.verification_status, c.fundraising_status,
             cpq.status as promotion_status
      from public.cause_intake_submissions ci
      join public.causes c on c.id = ci.cause_id
      left join public.cause_promotion_queue cpq on cpq.cause_id = c.id
      where ci.id = ${params.data.id}::uuid
      limit 1
    `;
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Submission not found" } });

    const publicSite = (process.env.PUBLIC_SITE_URL ?? "https://mypets.lat").replace(/\/$/, "");
    return {
      data: {
        id: row.id,
        causeId: row.cause_id,
        status: row.status,
        slug: row.slug,
        publicUrl: `${publicSite}/causas/${row.slug}`,
        verificationStatus: row.verification_status,
        fundraisingStatus: row.fundraising_status,
        promotionStatus: row.promotion_status,
        verificationWhatsappUrl: verificationWhatsapp(row.slug),
      },
    };
  });
}