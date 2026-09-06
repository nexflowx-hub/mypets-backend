import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

const webhookSchema = z.object({
  event: z.string().min(1).max(160),
  transaction_id: z.string().min(1).max(160),
  reference: z.string().min(1).max(240),
  amount: z.union([z.number(), z.string()]),
  currency: z.string().min(3).max(8),
  status: z.string().min(1).max(80),
  method: z.string().nullable().optional(),
  timestamp: z.string().min(1).max(80),
});

type IntentRow = {
  id: string;
  cause_id: string | null;
  provider_reference: string;
  amount_cents: number;
  currency: "EUR" | "BRL";
  status: string;
};

function webhookSecret(currency: string) {
  const normalized = currency.toUpperCase();
  if (normalized === "EUR") return process.env.XPAYMENTS_WEBHOOK_SECRET_EUR ?? "";
  if (normalized === "BRL") return process.env.XPAYMENTS_WEBHOOK_SECRET_BRL ?? "";
  return "";
}

function validSignature(payload: unknown, signature: string, secret: string) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  const actualBuffer = Buffer.from(signature.trim().toLowerCase(), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeStatus(status: string, event: string) {
  const value = `${status} ${event}`.toLowerCase();
  if (value.includes("succeeded") || value.includes("completed") || value.includes("paid")) return "SUCCEEDED" as const;
  if (value.includes("processing")) return "PROCESSING" as const;
  if (value.includes("cancel")) return "CANCELLED" as const;
  if (value.includes("expired")) return "EXPIRED" as const;
  if (value.includes("failed") || value.includes("declined")) return "FAILED" as const;
  return "PENDING" as const;
}

async function markSucceeded(prisma: PrismaClient, intent: IntentRow) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.$queryRaw<IntentRow[]>`
      update public.payment_intents
      set status = 'SUCCEEDED', succeeded_at = coalesce(succeeded_at, now()), updated_at = now()
      where id = ${intent.id}::uuid and status <> 'SUCCEEDED'
      returning id, cause_id, provider_reference, amount_cents, currency, status
    `;
    const row = changed[0];
    if (row?.cause_id) {
      await tx.$executeRaw`
        update public.causes
        set raised_amount_cents = raised_amount_cents + ${row.amount_cents}, updated_at = now()
        where id = ${row.cause_id}::uuid
      `;
    }
    return row ?? null;
  });
}

export async function registerPaymentWebhookRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post("/v1/payments/webhooks/xpayments", async (req, reply) => {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "INVALID_WEBHOOK", message: "Invalid XPAYMENTS webhook payload" } });
    }

    const currency = parsed.data.currency.toUpperCase();
    const secret = webhookSecret(currency);
    if (!secret) {
      app.log.error({ currency }, "XPAYMENTS webhook secret is not configured");
      return reply.code(503).send({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook verification is not configured" } });
    }

    const signature = String(req.headers["x-nexflowx-signature"] ?? "");
    if (!validSignature(req.body, signature, secret)) {
      app.log.warn({ currency }, "Rejected XPAYMENTS webhook with invalid signature");
      return reply.code(401).send({ error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature" } });
    }

    const providerEventId = `${parsed.data.transaction_id}:${parsed.data.event}`;
    await prisma.$executeRaw`
      insert into public.payment_provider_events (
        provider, provider_event_id, event_type, signature_valid, payload, processing_status
      ) values (
        'XPAYMENTS', ${providerEventId}, ${parsed.data.event}, true, ${JSON.stringify(parsed.data)}::jsonb, 'RECEIVED'
      ) on conflict (provider, provider_event_id) where provider_event_id is not null do nothing
    `;

    const intents = await prisma.$queryRaw<IntentRow[]>`
      select id, cause_id, provider_reference, amount_cents, currency, status
      from public.payment_intents
      where provider = 'XPAYMENTS' and provider_reference = ${parsed.data.reference}
      limit 1
    `;
    const intent = intents[0];
    if (!intent) {
      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'IGNORED', processed_at = now(), processing_error = 'reference_not_found'
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;
      return reply.code(200).send({ received: true, ignored: true });
    }

    const webhookAmountCents = Math.round(Number(parsed.data.amount) * 100);
    if (!Number.isFinite(webhookAmountCents) || webhookAmountCents !== intent.amount_cents || currency !== intent.currency) {
      app.log.error({ intentId: intent.id, webhookAmountCents, expectedAmountCents: intent.amount_cents, currency, expectedCurrency: intent.currency }, "XPAYMENTS webhook amount/currency mismatch");
      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'FAILED', processed_at = now(), processing_error = 'amount_or_currency_mismatch'
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;
      return reply.code(200).send({ received: true, ignored: true, reason: "amount_or_currency_mismatch" });
    }

    const nextStatus = normalizeStatus(parsed.data.status, parsed.data.event);
    try {
      if (nextStatus === "SUCCEEDED") {
        await markSucceeded(prisma, intent);
      } else if (intent.status !== "SUCCEEDED") {
        await prisma.$executeRaw`
          update public.payment_intents
          set status = ${nextStatus}, updated_at = now()
          where id = ${intent.id}::uuid and status <> 'SUCCEEDED'
        `;
      }

      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'PROCESSED', processed_at = now(), processing_error = null
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;

      return reply.code(200).send({ received: true, intentId: intent.id, status: nextStatus });
    } catch (error) {
      app.log.error({ err: error, intentId: intent.id }, "XPAYMENTS webhook processing failed");
      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'FAILED', processed_at = now(), processing_error = 'processing_error'
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;
      return reply.code(500).send({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: "Webhook processing failed" } });
    }
  });
}
