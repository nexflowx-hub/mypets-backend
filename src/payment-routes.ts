import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { verifyAccessToken } from "./auth.js";
import {
  checkoutBase,
  createXPaymentsNativePayment,
  createXPaymentsSession,
  getXPaymentsSession,
  getXPaymentsNativeTransaction,
  normalizeXPaymentsStatus,
  xpaymentsCurrencyEnabled,
  xpaymentsNativeMethodEnabled,
  type NativePaymentMethod,
  type PaymentCurrency,
} from "./payments/xpayments.js";

type CausePaymentRow = {
  id: string;
  protector_id: string;
  title: string;
  slug: string;
  support_mode: string;
  currency: PaymentCurrency | null;
  status: string;
  is_public: boolean;
  fund_code: string | null;
  campaign_meta: unknown;
};

type IntentRow = {
  id: string;
  cause_id: string | null;
  provider_session_id: string | null;
  provider_transaction_id: string | null;
  provider_reference: string;
  payment_method: string | null;
  amount_cents: number;
  currency: PaymentCurrency;
  status: string;
  checkout_url: string | null;
  metadata: unknown;
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

const trackingFields = {
  source: z.string().trim().max(120).nullable().optional(),
  medium: z.string().trim().max(120).nullable().optional(),
  campaign: z.string().trim().max(180).nullable().optional(),
  content: z.string().trim().max(180).nullable().optional(),
  refCode: z.string().trim().max(120).nullable().optional(),
  landingPath: z.string().trim().max(500).nullable().optional(),
};

const checkoutSchema = z.object({
  causeId: z.string().uuid(),
  amountCents: z.number().int().min(100).max(5_000_000),
  frequency: z.literal("ONE_TIME").default("ONE_TIME"),
  donorName: z.string().trim().max(120).nullable().optional(),
  donorEmail: z.string().email().max(254).nullable().optional(),
  ...trackingFields,
});

const nativeSchema = z.object({
  causeId: z.string().uuid(),
  amountCents: z.number().int().min(100).max(5_000_000),
  method: z.enum(["pix", "mb_way", "multibanco", "bizum"]),
  donorName: z.string().trim().max(120).nullable().optional(),
  donorEmail: z.string().email().max(254).nullable().optional(),
  donorPhone: z.string().trim().max(40).nullable().optional(),
  donorDocument: z.string().trim().max(32).nullable().optional(),
  ...trackingFields,
});

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicIntent(row: IntentRow) {
  const metadata = metadataRecord(row.metadata);
  return {
    id: row.id,
    causeId: row.cause_id,
    sessionId: row.provider_session_id,
    reference: row.provider_reference,
    amountCents: row.amount_cents,
    currency: row.currency,
    paymentMethod: row.payment_method,
    status: row.status,
    action: metadata.nativeAction ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizedPhone(value: string | null | undefined, countryPrefix: "351" | "34") {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (!digits) return null;
  if (digits.startsWith(countryPrefix)) return `+${digits}`;
  if (digits.length === 9) return `+${countryPrefix}${digits}`;
  return null;
}

function normalizedDocument(value: string | null | undefined) {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (![11, 14].includes(digits.length)) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  return digits;
}

function methodCurrency(method: NativePaymentMethod): PaymentCurrency {
  return method === "pix" ? "BRL" : "EUR";
}

function methodCustomer(input: z.infer<typeof nativeSchema>) {
  const name = input.donorName?.trim() || null;
  const email = input.donorEmail?.trim().toLowerCase() || null;
  if (input.method === "pix") {
    const document = normalizedDocument(input.donorDocument);
    if (!name || !document) return null;
    return { name, email, phone: null, document };
  }
  if (input.method === "mb_way") {
    const phone = normalizedPhone(input.donorPhone, "351");
    if (!name || !email || !phone) return null;
    return { name, email, phone, document: null };
  }
  if (input.method === "bizum") {
    const phone = normalizedPhone(input.donorPhone, "34");
    if (!name || !email || !phone) return null;
    return { name, email, phone, document: null };
  }
  if (!name || !email) return null;
  return { name, email, phone: null, document: null };
}

async function loadCause(prisma: PrismaClient, causeId: string) {
  const causes = await prisma.$queryRaw<CausePaymentRow[]>`
    select id, protector_id, title, slug, support_mode, currency, status, is_public, fund_code, campaign_meta
    from public.causes
    where id = ${causeId}::uuid
    limit 1
  `;
  return causes[0] ?? null;
}

function causePaymentError(cause: CausePaymentRow | null) {
  if (!cause || cause.status !== "ACTIVE" || !cause.is_public) {
    return { status: 404, code: "CAUSE_NOT_FOUND", message: "Cause not found" };
  }
  if (cause.support_mode === "NON_FINANCIAL" || !cause.currency) {
    return { status: 409, code: "CAUSE_NOT_FINANCIAL", message: "This cause does not accept financial support" };
  }
  if (!xpaymentsCurrencyEnabled(cause.currency)) {
    return { status: 503, code: "CURRENCY_NOT_CONFIGURED", message: `Payments in ${cause.currency} are not configured` };
  }
  return null;
}

function campaignUnitPrice(cause: CausePaymentRow) {
  if (cause.fund_code !== "EBOOK_RACAO") return null;
  const meta = metadataRecord(cause.campaign_meta);
  const value = Number(meta.unitPriceCents);
  return Number.isInteger(value) && value >= 100 ? value : null;
}

function campaignAmountError(cause: CausePaymentRow, amountCents: number) {
  const unitPrice = campaignUnitPrice(cause);
  if (!unitPrice) return null;
  if (amountCents < unitPrice || amountCents % unitPrice !== 0) {
    return {
      status: 409,
      code: "INVALID_CAMPAIGN_UNIT_AMOUNT",
      message: `This campaign requires exact units of ${unitPrice} cents`,
    };
  }
  return null;
}

async function ensureUser(prisma: PrismaClient, req: { headers: { authorization?: string } }) {
  const userId = await optionalUserId(req);
  if (userId) await prisma.profile.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  return userId;
}

function idempotencyKeyFrom(req: { headers: Record<string, unknown> }) {
  const requested = String(req.headers["idempotency-key"] ?? "").trim();
  return requested.slice(0, 180) || crypto.randomUUID();
}

async function findIntentByIdempotency(prisma: PrismaClient, idempotencyKey: string) {
  const rows = await prisma.$queryRaw<IntentRow[]>`
    select id, cause_id, provider_session_id, provider_transaction_id, provider_reference, payment_method,
           amount_cents, currency, status, checkout_url, metadata, created_at, updated_at
    from public.payment_intents where idempotency_key = ${idempotencyKey} limit 1
  `;
  return rows[0] ?? null;
}

function idempotencyMatches(row: IntentRow, causeId: string, amountCents: number, currency: PaymentCurrency, method: string) {
  return row.cause_id === causeId && row.amount_cents === amountCents && row.currency === currency && (row.payment_method ?? "checkout") === method;
}

async function markSucceeded(prisma: PrismaClient, intent: IntentRow) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.$queryRaw<IntentRow[]>`
      update public.payment_intents
      set status = 'SUCCEEDED', succeeded_at = coalesce(succeeded_at, now()), updated_at = now()
      where id = ${intent.id}::uuid and status <> 'SUCCEEDED'
      returning id, cause_id, provider_session_id, provider_transaction_id, provider_reference, payment_method,
                amount_cents, currency, status, checkout_url, metadata, created_at, updated_at
    `;
    const row = changed[0];
    if (row?.cause_id) {
      await tx.$executeRaw`
        update public.causes set raised_amount_cents = raised_amount_cents + ${row.amount_cents}, updated_at = now()
        where id = ${row.cause_id}::uuid
      `;
    }
    return row ?? null;
  });
}

function baseMetadata(input: {
  intentId: string;
  cause: CausePaymentRow;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  refCode?: string | null;
  landingPath?: string | null;
  amountCents?: number;
}) {
  const unitPriceCents = campaignUnitPrice(input.cause);
  const unitCount = unitPriceCents && input.amountCents ? input.amountCents / unitPriceCents : null;
  return {
    mypetsIntentId: input.intentId,
    causeId: input.cause.id,
    causeSlug: input.cause.slug,
    protectorId: input.cause.protector_id,
    fundCode: input.cause.fund_code,
    campaignUnitPriceCents: unitPriceCents,
    campaignUnitCount: unitCount,
    foodKg: input.cause.fund_code === "EBOOK_RACAO" ? unitCount : null,
    targetType: "CAUSE",
    frequency: "ONE_TIME",
    source: input.source ?? null,
    medium: input.medium ?? null,
    campaign: input.campaign ?? null,
    content: input.content ?? null,
    refCode: input.refCode ?? null,
    landingPath: input.landingPath ?? null,
    returnUrl: `${process.env.PUBLIC_SITE_URL ?? "https://mypets.lat"}/causas/${input.cause.slug}`,
  };
}

export async function registerPaymentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post("/v1/payments/checkout", async (req, reply) => {
    if (process.env.PAYMENTS_LIVE !== "true" || (process.env.PAYMENT_PROVIDER ?? "").toLowerCase() !== "xpayments") {
      return reply.code(409).send({ error: { code: "PAYMENTS_NOT_LIVE", message: "Online payments are not active yet" } });
    }

    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid checkout request" } });

    const cause = await loadCause(prisma, parsed.data.causeId);
    const invalidCause = causePaymentError(cause);
    if (invalidCause || !cause?.currency) {
      const error = invalidCause!;
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const invalidAmount = campaignAmountError(cause, parsed.data.amountCents);
    if (invalidAmount) {
      return reply.code(invalidAmount.status).send({ error: { code: invalidAmount.code, message: invalidAmount.message } });
    }

    const userId = await ensureUser(prisma, req);
    const idempotencyKey = idempotencyKeyFrom(req);
    const existing = await findIntentByIdempotency(prisma, idempotencyKey);
    if (existing) {
      if (!idempotencyMatches(existing, cause.id, parsed.data.amountCents, cause.currency, "checkout")) {
        return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key belongs to a different payment attempt" } });
      }
      const embedUrl = existing.provider_session_id
        ? `${checkoutBase()}/embed/${encodeURIComponent(existing.provider_session_id)}?parent_origin=${encodeURIComponent(process.env.PUBLIC_SITE_URL ?? "https://mypets.lat")}`
        : null;
      return { data: { ...publicIntent(existing), checkoutUrl: existing.checkout_url, embedUrl } };
    }

    const intentId = crypto.randomUUID();
    const reference = `MYPETS-${intentId}`;
    const metadata = baseMetadata({ intentId, cause, ...parsed.data });

    await prisma.$executeRaw`
      insert into public.payment_intents (
        id, cause_id, protector_id, user_id, provider, provider_reference, payment_method,
        amount_cents, currency, frequency, donor_name, donor_email, status,
        idempotency_key, source, medium, campaign, content, ref_code, metadata
      ) values (
        ${intentId}::uuid, ${cause.id}::uuid, ${cause.protector_id}::uuid, ${userId}::uuid,
        'XPAYMENTS', ${reference}, 'checkout', ${parsed.data.amountCents}, ${cause.currency}, 'ONE_TIME',
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
        set provider_store_code = ${session.storeCode}, provider_session_id = ${session.sessionId},
            checkout_url = ${session.checkoutUrl}, status = 'PENDING', updated_at = now()
        where id = ${intentId}::uuid
        returning id, cause_id, provider_session_id, provider_transaction_id, provider_reference, payment_method,
                  amount_cents, currency, status, checkout_url, metadata, created_at, updated_at
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

  app.post("/v1/payments/native", async (req, reply) => {
    if (process.env.PAYMENTS_LIVE !== "true" || (process.env.PAYMENT_PROVIDER ?? "").toLowerCase() !== "xpayments") {
      return reply.code(409).send({ error: { code: "PAYMENTS_NOT_LIVE", message: "Online payments are not active yet" } });
    }
    const parsed = nativeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid Native payment request" } });

    const cause = await loadCause(prisma, parsed.data.causeId);
    const invalidCause = causePaymentError(cause);
    if (invalidCause || !cause?.currency) {
      const error = invalidCause!;
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const invalidAmount = campaignAmountError(cause, parsed.data.amountCents);
    if (invalidAmount) {
      return reply.code(invalidAmount.status).send({ error: { code: invalidAmount.code, message: invalidAmount.message } });
    }
    const requiredCurrency = methodCurrency(parsed.data.method);
    if (cause.currency !== requiredCurrency) {
      return reply.code(409).send({ error: { code: "METHOD_CURRENCY_MISMATCH", message: `${parsed.data.method} requires ${requiredCurrency}` } });
    }
    if (!xpaymentsNativeMethodEnabled(cause.currency, parsed.data.method)) {
      return reply.code(409).send({ error: { code: "METHOD_NOT_ENABLED", message: "This payment method is not enabled for the MyPets Store" } });
    }
    const customer = methodCustomer(parsed.data);
    if (!customer) {
      return reply.code(400).send({ error: { code: "PAYER_DETAILS_REQUIRED", message: "Required payer details are missing or invalid for this payment method" } });
    }

    const userId = await ensureUser(prisma, req);
    const idempotencyKey = idempotencyKeyFrom(req);
    const existing = await findIntentByIdempotency(prisma, idempotencyKey);
    if (existing) {
      if (!idempotencyMatches(existing, cause.id, parsed.data.amountCents, cause.currency, parsed.data.method)) {
        return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key belongs to a different payment attempt" } });
      }
      return { data: publicIntent(existing) };
    }

    const intentId = crypto.randomUUID();
    const reference = `MYPETS-${intentId}`;
    const metadata = baseMetadata({ intentId, cause, ...parsed.data });
    await prisma.$executeRaw`
      insert into public.payment_intents (
        id, cause_id, protector_id, user_id, provider, provider_reference, payment_method,
        amount_cents, currency, frequency, donor_name, donor_email, status,
        idempotency_key, source, medium, campaign, content, ref_code, metadata
      ) values (
        ${intentId}::uuid, ${cause.id}::uuid, ${cause.protector_id}::uuid, ${userId}::uuid,
        'XPAYMENTS', ${reference}, ${parsed.data.method}, ${parsed.data.amountCents}, ${cause.currency}, 'ONE_TIME',
        ${customer.name ?? null}, ${customer.email ?? null}, 'CREATED', ${idempotencyKey},
        ${parsed.data.source ?? null}, ${parsed.data.medium ?? null}, ${parsed.data.campaign ?? null},
        ${parsed.data.content ?? null}, ${parsed.data.refCode ?? null}, ${JSON.stringify(metadata)}::jsonb
      )
    `;

    try {
      const payment = await createXPaymentsNativePayment({
        amountCents: parsed.data.amountCents,
        currency: cause.currency,
        method: parsed.data.method,
        reference,
        customer,
        metadata,
        idempotencyKey,
      });
      const nextMetadata = {
        ...metadata,
        nativeAction: payment.action,
        xpaymentsReference: payment.reference,
        xpaymentsCreateStatus: payment.status,
      };
      const rows = await prisma.$queryRaw<IntentRow[]>`
        update public.payment_intents
        set provider_store_code = ${payment.storeCode}, provider_transaction_id = ${payment.transactionId},
            status = 'PENDING', metadata = ${JSON.stringify(nextMetadata)}::jsonb, updated_at = now()
        where id = ${intentId}::uuid
        returning id, cause_id, provider_session_id, provider_transaction_id, provider_reference, payment_method,
                  amount_cents, currency, status, checkout_url, metadata, created_at, updated_at
      `;
      return reply.code(201).send({ data: publicIntent(rows[0]!) });
    } catch (error) {
      app.log.error({ err: error, intentId, method: parsed.data.method }, "XPAYMENTS Native payment creation failed");
      await prisma.$executeRaw`update public.payment_intents set status = 'FAILED', updated_at = now() where id = ${intentId}::uuid`;
      return reply.code(502).send({ error: { code: "XPAYMENTS_NATIVE_FAILED", message: "Could not create the selected payment method" } });
    }
  });

  app.get("/v1/payments/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid payment intent id" } });

    const rows = await prisma.$queryRaw<IntentRow[]>`
      select id, cause_id, provider_session_id, provider_transaction_id, provider_reference, payment_method,
             amount_cents, currency, status, checkout_url, metadata, created_at, updated_at
      from public.payment_intents where id = ${params.data.id}::uuid limit 1
    `;
    let intent = rows[0];
    if (!intent) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Payment intent not found" } });

    if (intent.provider_session_id && ["PENDING", "PROCESSING"].includes(intent.status)) {
      try {
        const session = await getXPaymentsSession(intent.provider_session_id, intent.currency);
        const providerStatus = normalizeXPaymentsStatus(session.status ?? (session.metadata as Record<string, unknown> | undefined)?.checkoutStatus);
        if (providerStatus && providerStatus !== intent.status) {
          if (providerStatus === "SUCCEEDED") {
            const updated = await markSucceeded(prisma, intent);
            if (updated) intent = updated;
          } else {
            const updated = await prisma.$queryRaw<IntentRow[]>`
              update public.payment_intents set status = ${providerStatus}, updated_at = now()
              where id = ${intent.id}::uuid and status <> 'SUCCEEDED'
              returning id, cause_id, provider_session_id, provider_transaction_id, provider_reference, payment_method,
                        amount_cents, currency, status, checkout_url, metadata, created_at, updated_at
            `;
            if (updated[0]) intent = updated[0];
          }
        }
      } catch (error) {
        app.log.warn({ err: error, intentId: intent.id }, "XPAYMENTS status reconciliation unavailable");
      }
    }

    if (intent.provider_transaction_id && ["PENDING", "PROCESSING"].includes(intent.status)) {
      try {
        const transaction = await getXPaymentsNativeTransaction(intent.provider_transaction_id, intent.currency);
        const providerStatus = normalizeXPaymentsStatus(transaction.status);
        if (providerStatus && providerStatus !== intent.status) {
          if (providerStatus === "SUCCEEDED") {
            const updated = await markSucceeded(prisma, intent);
            if (updated) intent = updated;
          } else {
            const updated = await prisma.$queryRaw<IntentRow[]>`
              update public.payment_intents set status = ${providerStatus}, updated_at = now()
              where id = ${intent.id}::uuid and status <> 'SUCCEEDED'
              returning id, cause_id, provider_session_id, provider_transaction_id, provider_reference, payment_method,
                        amount_cents, currency, status, checkout_url, metadata, created_at, updated_at
            `;
            if (updated[0]) intent = updated[0];
          }
        }
      } catch (error) {
        app.log.warn({ err: error, intentId: intent.id, providerTransactionId: intent.provider_transaction_id }, "XPAYMENTS Native status reconciliation unavailable");
      }
    }

    return { data: publicIntent(intent) };
  });
}
