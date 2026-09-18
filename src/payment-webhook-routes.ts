import crypto from "node:crypto";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { emitInternalAlert } from "./internal-alerts.js";

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

type RawBodyRequest = FastifyRequest & { rawBody?: string };

type IntentRow = {
  id: string;
  cause_id: string | null;
  provider_transaction_id: string | null;
  provider_reference: string;
  payment_method: string | null;
  amount_cents: number;
  currency: "EUR" | "BRL";
  status: string;
};

type WebhookMode = "auto" | "sandbox";

const rawJsonRouteOptions = {
  preParsing(req, _reply, payload, done) {
    const chunks: Buffer[] = [];
    const capture = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buffer);
        (capture as Transform & { receivedEncodedLength?: number }).receivedEncodedLength =
          ((capture as Transform & { receivedEncodedLength?: number }).receivedEncodedLength ?? 0) + buffer.length;
        callback(null, chunk);
      },
      flush(callback) {
        (req as RawBodyRequest).rawBody = Buffer.concat(chunks).toString("utf8");
        callback();
      },
    });
    payload.on("error", (error) => capture.destroy(error));
    payload.pipe(capture);
    done(null, capture);
  },
} satisfies RouteShorthandOptions;

function isSandboxReference(reference: string) {
  return reference.startsWith("MYPETS-SANDBOX-") || reference.startsWith("MYPETS-PREFLIGHT-");
}

function webhookSecret(currency: string, sandbox: boolean) {
  if (sandbox) {
    const dedicated = process.env.XPAYMENTS_SANDBOX_WEBHOOK_SECRET ?? "";
    if (dedicated) return dedicated;
    return process.env.XPAYMENTS_WEBHOOK_SECRET_EUR ?? "";
  }
  const normalized = currency.toUpperCase();
  if (normalized === "EUR") return process.env.XPAYMENTS_WEBHOOK_SECRET_EUR ?? "";
  if (normalized === "BRL") return process.env.XPAYMENTS_WEBHOOK_SECRET_BRL ?? "";
  return "";
}

function validSignature(rawBody: string, signature: string, secret: string) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
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
      returning id, cause_id, provider_transaction_id, provider_reference, payment_method, amount_cents, currency, status
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

function webhookHandler(app: FastifyInstance, prisma: PrismaClient, mode: WebhookMode) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "INVALID_WEBHOOK", message: "Invalid XPAYMENTS webhook payload" } });
    }

    const sandbox = isSandboxReference(parsed.data.reference);
    if (mode === "sandbox" && !sandbox) {
      app.log.warn({ reference: parsed.data.reference }, "Rejected non-sandbox XPAYMENTS webhook on sandbox route");
      return reply.code(400).send({ error: { code: "WEBHOOK_ENVIRONMENT_MISMATCH", message: "Webhook environment mismatch" } });
    }

    const currency = parsed.data.currency.toUpperCase();
    const secret = webhookSecret(currency, sandbox);
    if (!secret) {
      app.log.error({ currency, sandbox }, "XPAYMENTS webhook secret is not configured");
      return reply.code(503).send({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook verification is not configured" } });
    }

    const rawBody = (req as RawBodyRequest).rawBody ?? "";
    if (!rawBody) {
      app.log.error({ currency, sandbox }, "XPAYMENTS webhook raw body was not captured");
      return reply.code(400).send({ error: { code: "RAW_BODY_REQUIRED", message: "Webhook raw body is required" } });
    }
    const signature = String(req.headers["x-nexflowx-signature"] ?? "");
    if (!validSignature(rawBody, signature, secret)) {
      app.log.warn({ currency, sandbox }, "Rejected XPAYMENTS webhook with invalid signature");
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
      select id, cause_id, provider_transaction_id, provider_reference, payment_method, amount_cents, currency, status
      from public.payment_intents
      where provider = 'XPAYMENTS'
        and (
          provider_transaction_id = ${parsed.data.transaction_id}
          or (provider_transaction_id is null and provider_reference = ${parsed.data.reference})
        )
      order by case when provider_transaction_id = ${parsed.data.transaction_id} then 0 else 1 end
      limit 1
    `;
    let intent = intents[0];
    if (!intent) {
      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'IGNORED', processed_at = now(), processing_error = 'transaction_not_correlated'
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;
      app.log.warn({ transactionId: parsed.data.transaction_id, reference: parsed.data.reference }, "Signed XPAYMENTS event could not be correlated to a MyPets intent");
      return reply.code(200).send({ received: true, ignored: true });
    }

    if (!intent.provider_transaction_id) {
      const bound = await prisma.$queryRaw<IntentRow[]>`
        update public.payment_intents
        set provider_transaction_id = ${parsed.data.transaction_id},
            payment_method = coalesce(payment_method, ${parsed.data.method ?? null}),
            updated_at = now()
        where id = ${intent.id}::uuid and provider_transaction_id is null
        returning id, cause_id, provider_transaction_id, provider_reference, payment_method, amount_cents, currency, status
      `;
      if (bound[0]) intent = bound[0];
    }

    const webhookAmountCents = Math.round(Number(parsed.data.amount) * 100);
    if (!Number.isFinite(webhookAmountCents) || webhookAmountCents !== intent.amount_cents || currency !== intent.currency) {
      app.log.error({ intentId: intent.id, webhookAmountCents, expectedAmountCents: intent.amount_cents, currency, expectedCurrency: intent.currency, sandbox }, "XPAYMENTS webhook amount/currency mismatch");
      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'FAILED', processed_at = now(), processing_error = 'amount_or_currency_mismatch'
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;
      return reply.code(200).send({ received: true, ignored: true, reason: "amount_or_currency_mismatch" });
    }

    const nextStatus = normalizeStatus(parsed.data.status, parsed.data.event);
    try {
      let newlySucceeded: IntentRow | null = null;
      if (nextStatus === "SUCCEEDED") {
        newlySucceeded = await markSucceeded(prisma, intent);
      } else if (intent.status !== "SUCCEEDED") {
        await prisma.$executeRaw`
          update public.payment_intents
          set status = ${nextStatus}, payment_method = coalesce(payment_method, ${parsed.data.method ?? null}), updated_at = now()
          where id = ${intent.id}::uuid and status <> 'SUCCEEDED'
        `;
      }

      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'PROCESSED', processed_at = now(), processing_error = null
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;

      if (newlySucceeded) {
        await emitInternalAlert(app, prisma, {
          eventType: "PAYMENT_SUCCEEDED",
          category: "PAYMENT",
          severity: "NOTICE",
          title: `Apoio confirmado: ${newlySucceeded.currency} ${(newlySucceeded.amount_cents / 100).toFixed(2)}`,
          summary: [
            `Método: ${newlySucceeded.payment_method ?? parsed.data.method ?? "não informado"}`,
            newlySucceeded.cause_id ? `Causa: ${newlySucceeded.cause_id}` : "Destino: MyPets",
            `Referência: ${newlySucceeded.provider_reference}`,
          ].join("\n"),
          entityType: "payment_intent",
          entityId: newlySucceeded.id,
          ticketStatus: "LOGGED",
          actionRequired: false,
          dedupeKey: `payment-succeeded:${newlySucceeded.id}`,
          metadata: {
            causeId: newlySucceeded.cause_id,
            amountCents: newlySucceeded.amount_cents,
            currency: newlySucceeded.currency,
            paymentMethod: newlySucceeded.payment_method ?? parsed.data.method ?? null,
            providerTransactionId: parsed.data.transaction_id,
            providerReference: newlySucceeded.provider_reference,
          },
        });
      }

      return reply.code(200).send({ received: true, intentId: intent.id, status: nextStatus });
    } catch (error) {
      app.log.error({ err: error, intentId: intent.id, sandbox }, "XPAYMENTS webhook processing failed");
      await prisma.$executeRaw`
        update public.payment_provider_events
        set processing_status = 'FAILED', processed_at = now(), processing_error = 'processing_error'
        where provider = 'XPAYMENTS' and provider_event_id = ${providerEventId}
      `;
      return reply.code(500).send({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: "Webhook processing failed" } });
    }
  };
}

export async function registerPaymentWebhookRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post("/v1/payments/webhooks/xpayments", rawJsonRouteOptions, webhookHandler(app, prisma, "auto"));
  app.post("/v1/payments/webhooks/xpayments-sandbox", rawJsonRouteOptions, webhookHandler(app, prisma, "sandbox"));
}
