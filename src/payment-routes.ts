import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { verifyAccessToken } from "./auth.js";
import {
  checkoutBase,
  createXPaymentsSession,
  getXPaymentsSession,
  normalizeXPaymentsStatus,
  xpaymentsCurrencyEnabled,
} from "./payments/xpayments.js";

type CausePaymentRow = {
  id: string;
  protector_id: string;
  title: string;
  slug: string;
  support_mode: string;
  currency: "EUR" | "BRL" | null;
  status: string;
  is_public: boolean;
};

type IntentRow = {
  id: string;
  cause_id: string | null;
  provider_session_id: string | null;
  provider_reference: string;
  amount_cents: number;
  currency: "EUR" | "BRL";
  status: string;
  checkout_url: string | null;
  created_at: Date;
  updated_at: Date;
};

async function optionalUserId(req: { headers: { authorization?: string } }) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const user = await verifyAccessToken(token).catch(() => null);
  return user?.id ?? null;
}

const checkoutSchema = z.object({
  causeId: z.string().uuid(),
  amountCents: z.number().int().min(100).max(5_000_000),
  frequency: z.literal("ONE_TIME").default("ONE_TIME"),
  donorName: z.string().trim().max(120).nullable().optional(),
  donorEmail: z.string().email().max(254).nullable().optional(),
  source: z.string().trim().max(120).nullable().optional(),
  medium: z.string().trim().max(120).nullable().optional(),
  campaign: z.string().trim().max(180).nullable().optional(),
  content: z.string().trim().max(180).nullable().optional(),
  refCode: z.string().trim().max(120).nullable().optional(),
});

function publicIntent(row: IntentRow) {
  return {
    id: row.id,
    causeId: row.cause_id,
    sessionId: row.provider_session_id,
    reference: row.provider_reference,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function registerPaymentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post("/v1/payments/checkout", async (req, reply) => {
    if (process.env.PAYMENTS_LIVE !== "true" || (process.env.PAYMENT_PROVIDER ?? "").toLowerCase() !== "xpayments") {
      return reply.code(409).send({ error: { code: "PAYMENTS_NOT_LIVE", message: "Online payments are not active yet" } });
    }

    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid checkout request" } });

    const causes = await prisma.$queryRaw<CausePaymentRow[]>`
      select id, protector_id, title, slug, support_mode, currency, status, is_public
      from public.causes
      where id = ${parsed.data.causeId}::uuid
      limit 1
    `;
    const cause = causes[0];
    if (!cause || cause.status !== "ACTIVE" || !cause.is_public) {
      return reply.code(404).send({ error: { code: "CAUSE_NOT_FOUND", message: "Cause not found" } });
    }
    if (cause.support_mode === "NON_FINANCIAL" || !cause.currency) {
      return reply.code(409).send({ error: { code: "CAUSE_NOT_FINANCIAL", message: "This cause does not accept financial support" } });
    }
    if (!xpaymentsCurrencyEnabled(cause.currency)) {
      return reply.code(503).send({ error: { code: "CURRENCY_NOT_CONFIGURED", message: `Payments in ${cause.currency} are not configured` } });
    }

    const userId = await optionalUserId(req);
    if (userId) {
      await prisma.profile.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    }

    const requestedIdempotency = String(req.headers["idempotency-key"] ?? "").trim();
    const idempotencyKey = requestedIdempotency.slice(0, 180) || crypto.randomUUID();

    const existing = await prisma.$queryRaw<IntentRow[]>`
      select id, cause_id, provider_session_id, provider_reference, amount_cents, currency, status, checkout_url, created_at, updated_at
      from public.payment_intents where idempotency_key = ${idempotencyKey} limit 1
    `;
    if (existing[0]) {
      const row = existing[0];
      const embedUrl = row.provider_session_id
        ? `${checkoutBase()}/embed/${encodeURIComponent(row.provider_session_id)}?parent_origin=${encodeURIComponent(process.env.PUBLIC_SITE_URL ?? "https://mypets.lat")}`
        : null;
      return { data: { ...publicIntent(row), checkoutUrl: row.checkout_url, embedUrl } };
    }

    const intentId = crypto.randomUUID();
    const reference = `MYPETS-${intentId}`;
    const metadata = {
      mypetsIntentId: intentId,
      causeId: cause.id,
      causeSlug: cause.slug,
      protectorId: cause.protector_id,
      targetType: "CAUSE",
      frequency: "ONE_TIME",
      source: parsed.data.source ?? null,
      medium: parsed.data.medium ?? null,
      campaign: parsed.data.campaign ?? null,
      content: parsed.data.content ?? null,
      refCode: parsed.data.refCode ?? null,
      returnUrl: `${process.env.PUBLIC_SITE_URL ?? "https://mypets.lat"}/causas/${cause.slug}`,
    };

    await prisma.$executeRaw`
      insert into public.payment_intents (
        id, cause_id, protector_id, user_id, provider, provider_reference,
        amount_cents, currency, frequency, donor_name, donor_email, status,
        idempotency_key, source, medium, campaign, content, ref_code, metadata
      ) values (
        ${intentId}::uuid, ${cause.id}::uuid, ${cause.protector_id}::uuid, ${userId}::uuid,
        'XPAYMENTS', ${reference}, ${parsed.data.amountCents}, ${cause.currency}, 'ONE_TIME',
        ${parsed.data.donorName ?? null}, ${parsed.data.donorEmail?.toLowerCase() ?? null}, 'CREATED',
        ${idempotencyKey}, ${parsed.data.source ?? null}, ${parsed.data.medium ?? null},
        ${parsed.data.campaign ?? null}, ${parsed.data.content ?? null}, ${parsed.data.refCode ?? null},
        ${JSON.stringify(metadata)}::jsonb
      )
    `;

    try {
      const session = await createXPaymentsSession({
        amountCents: parsed.data.amountCents,
        currency: cause.currency,
        reference,
        customerEmail: parsed.data.donorEmail?.toLowerCase() ?? null,
        metadata,
      });

      const rows = await prisma.$queryRaw<IntentRow[]>`
        update public.payment_intents
        set provider_store_code = ${session.storeCode},
            provider_session_id = ${session.sessionId},
            checkout_url = ${session.checkoutUrl},
            status = 'PENDING', updated_at = now()
        where id = ${intentId}::uuid
        returning id, cause_id, provider_session_id, provider_reference, amount_cents, currency, status, checkout_url, created_at, updated_at
      `;
      const row = rows[0]!;
      const embedUrl = `${session.embedUrl}?parent_origin=${encodeURIComponent(process.env.PUBLIC_SITE_URL ?? "https://mypets.lat")}&theme=light`;
      return reply.code(201).send({ data: { ...publicIntent(row), checkoutUrl: session.checkoutUrl, embedUrl } });
    } catch (error) {
      app.log.error({ err: error, intentId }, "XPAYMENTS checkout session creation failed");
      await prisma.$executeRaw`update public.payment_intents set status = 'FAILED', updated_at = now() where id = ${intentId}::uuid`;
      return reply.code(502).send({ error: { code: "XPAYMENTS_SESSION_FAILED", message: "Could not open the secure payment checkout" } });
    }
  });

  app.get("/v1/payments/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid payment intent id" } });

    const rows = await prisma.$queryRaw<IntentRow[]>`
      select id, cause_id, provider_session_id, provider_reference, amount_cents, currency, status, checkout_url, created_at, updated_at
      from public.payment_intents where id = ${params.data.id}::uuid limit 1
    `;
    let intent = rows[0];
    if (!intent) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Payment intent not found" } });

    if (intent.provider_session_id && ["PENDING", "PROCESSING"].includes(intent.status)) {
      try {
        const session = await getXPaymentsSession(intent.provider_session_id);
        const providerStatus = normalizeXPaymentsStatus(session.status ?? (session.metadata as Record<string, unknown> | undefined)?.checkoutStatus);
        if (providerStatus && providerStatus !== intent.status) {
          if (providerStatus === "SUCCEEDED") {
            const updated = await prisma.$transaction(async (tx) => {
              const changed = await tx.$queryRaw<IntentRow[]>`
                update public.payment_intents
                set status = 'SUCCEEDED', succeeded_at = coalesce(succeeded_at, now()), updated_at = now()
                where id = ${intent!.id}::uuid and status <> 'SUCCEEDED'
                returning id, cause_id, provider_session_id, provider_reference, amount_cents, currency, status, checkout_url, created_at, updated_at
              `;
              if (changed[0]?.cause_id) {
                await tx.$executeRaw`
                  update public.causes set raised_amount_cents = raised_amount_cents + ${changed[0].amount_cents}, updated_at = now()
                  where id = ${changed[0].cause_id}::uuid
                `;
              }
              return changed[0] ?? null;
            });
            if (updated) intent = updated;
          } else {
            const updated = await prisma.$queryRaw<IntentRow[]>`
              update public.payment_intents set status = ${providerStatus}, updated_at = now()
              where id = ${intent.id}::uuid and status <> 'SUCCEEDED'
              returning id, cause_id, provider_session_id, provider_reference, amount_cents, currency, status, checkout_url, created_at, updated_at
            `;
            if (updated[0]) intent = updated[0];
          }
        }
      } catch (error) {
        app.log.warn({ err: error, intentId: intent.id }, "XPAYMENTS status reconciliation unavailable");
      }
    }

    return { data: publicIntent(intent) };
  });
}
