import { z } from "zod";

export type PaymentCurrency = "EUR" | "BRL";
export type NativePaymentMethod = "pix" | "mb_way" | "multibanco" | "bizum";
export type PaymentFinalityMode = "webhook" | "checkout_reconciliation" | "disabled";

const checkoutCreateResponse = z.object({
  success: z.boolean().optional(),
  data: z.object({
    sessionId: z.string().uuid(),
    checkoutUrl: z.string().url(),
    storeCode: z.string().trim().min(2).max(120),
    expiresAt: z.string().nullable().optional(),
  }),
});

const nativePaymentResponse = z.object({
  success: z.boolean().optional(),
  transactionId: z.string().uuid(),
  reference: z.string().min(1).max(240).optional(),
  status: z.string().min(1).max(80).optional(),
  method: z.string().min(1).max(80).optional(),
  action: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();

const checkoutSessionResponse = z.object({
  success: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()),
});

const LIVE_STORE_CODES: Record<PaymentCurrency, string> = {
  EUR: "MYPETS-EUR",
  BRL: "MYPETS-BRL",
};

const ALLOWED_NATIVE_METHODS: Record<PaymentCurrency, NativePaymentMethod[]> = {
  BRL: ["pix"],
  EUR: ["mb_way", "multibanco", "bizum"],
};

export function apiBase() {
  return (process.env.XPAYMENTS_API_BASE ?? "https://api.xpayments.digital/api/v1").replace(/\/$/, "");
}

export function checkoutBase() {
  return (process.env.XPAYMENTS_CHECKOUT_BASE ?? "https://checkout.xpayments.digital").replace(/\/$/, "");
}

export function xpaymentsConfigForCurrency(currency: PaymentCurrency) {
  const apiKey = currency === "EUR" ? process.env.XPAYMENTS_API_KEY_EUR : process.env.XPAYMENTS_API_KEY_BRL;
  const storeCode = currency === "EUR" ? process.env.XPAYMENTS_STORE_CODE_EUR : process.env.XPAYMENTS_STORE_CODE_BRL;
  return { apiKey: apiKey?.trim() ?? "", storeCode: storeCode?.trim() ?? "" };
}

export function xpaymentsWebhookSecretForCurrency(currency: PaymentCurrency) {
  return (currency === "EUR" ? process.env.XPAYMENTS_WEBHOOK_SECRET_EUR : process.env.XPAYMENTS_WEBHOOK_SECRET_BRL)?.trim() ?? "";
}

export function xpaymentsAllowWebhooklessLive() {
  return process.env.XPAYMENTS_ALLOW_WEBHOOKLESS_LIVE === "true";
}

export function xpaymentsFinalityModeForCurrency(currency: PaymentCurrency): PaymentFinalityMode {
  if (xpaymentsWebhookSecretForCurrency(currency)) return "webhook";
  if (xpaymentsAllowWebhooklessLive()) return "checkout_reconciliation";
  return "disabled";
}

export function xpaymentsCurrencyEnabled(currency: PaymentCurrency) {
  const { apiKey, storeCode } = xpaymentsConfigForCurrency(currency);
  if (!apiKey || !storeCode) return false;

  if (process.env.PAYMENTS_LIVE === "true") {
    if (!apiKey.startsWith("xp_live_") || storeCode !== LIVE_STORE_CODES[currency]) return false;
  }

  return xpaymentsFinalityModeForCurrency(currency) !== "disabled";
}

export function xpaymentsNativeMethodsForCurrency(currency: PaymentCurrency): NativePaymentMethod[] {
  const raw = currency === "EUR" ? process.env.XPAYMENTS_NATIVE_METHODS_EUR : process.env.XPAYMENTS_NATIVE_METHODS_BRL;
  if (!raw?.trim()) return [];
  const allowed = new Set(ALLOWED_NATIVE_METHODS[currency]);
  return [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter((item): item is NativePaymentMethod => allowed.has(item as NativePaymentMethod)))];
}

export function xpaymentsNativeMethodEnabled(currency: PaymentCurrency, method: NativePaymentMethod) {
  // Native S2S payments do not have a merchant-side status lookup in the current
  // contract. Without a signing secret they would remain locally pending after
  // the payer completes the provider action, so keep Native disabled and force
  // the hosted XPay session path until Merchant webhooks are available.
  if (process.env.PAYMENTS_LIVE === "true" && !xpaymentsWebhookSecretForCurrency(currency)) return false;
  return xpaymentsNativeMethodsForCurrency(currency).includes(method);
}

function assertEnvironmentSafe(currency: PaymentCurrency, apiKey: string, storeCode: string) {
  if (process.env.PAYMENTS_LIVE !== "true") return;
  if (!apiKey.startsWith("xp_live_")) {
    throw new Error(`XPAYMENTS live mode requires a live ${currency} Store key`);
  }
  const expectedStore = LIVE_STORE_CODES[currency];
  if (storeCode !== expectedStore) {
    throw new Error(`XPAYMENTS live ${currency} checkout must be isolated to ${expectedStore}`);
  }
  if (!xpaymentsWebhookSecretForCurrency(currency) && !xpaymentsAllowWebhooklessLive()) {
    throw new Error(`XPAYMENTS live ${currency} checkout requires webhook verification`);
  }
}

function authHeaders(apiKey: string, idempotencyKey?: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

async function responsePayload(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export async function createXPaymentsSession(input: {
  amountCents: number;
  currency: PaymentCurrency;
  reference: string;
  customerEmail?: string | null;
  metadata: Record<string, unknown>;
}) {
  const { apiKey, storeCode } = xpaymentsConfigForCurrency(input.currency);
  if (!apiKey || !storeCode) throw new Error(`XPAYMENTS ${input.currency} Store is not configured`);
  assertEnvironmentSafe(input.currency, apiKey, storeCode);

  const response = await fetch(`${apiBase()}/checkout/session`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      amount: input.amountCents,
      currency: input.currency,
      reference: input.reference,
      customerEmail: input.customerEmail ?? undefined,
      metadata: {
        ...input.metadata,
        expectedStoreCode: storeCode,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(`XPAYMENTS checkout session failed (${response.status})`);
  }
  const parsed = checkoutCreateResponse.safeParse(payload);
  if (!parsed.success) throw new Error("XPAYMENTS returned an invalid checkout session");
  if (parsed.data.success === false) throw new Error("XPAYMENTS rejected the checkout session");
  if (parsed.data.data.storeCode !== storeCode) {
    throw new Error(`XPAYMENTS Store mismatch: expected ${storeCode}`);
  }

  return {
    sessionId: parsed.data.data.sessionId,
    checkoutUrl: parsed.data.data.checkoutUrl,
    storeCode: parsed.data.data.storeCode,
    expiresAt: parsed.data.data.expiresAt ?? null,
    embedUrl: `${checkoutBase()}/embed/${encodeURIComponent(parsed.data.data.sessionId)}`,
  };
}

export async function createXPaymentsNativePayment(input: {
  amountCents: number;
  currency: PaymentCurrency;
  method: NativePaymentMethod;
  reference: string;
  customer: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    document?: string | null;
  };
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const { apiKey, storeCode } = xpaymentsConfigForCurrency(input.currency);
  if (!apiKey || !storeCode) throw new Error(`XPAYMENTS ${input.currency} Store is not configured`);
  assertEnvironmentSafe(input.currency, apiKey, storeCode);
  if (!xpaymentsNativeMethodEnabled(input.currency, input.method)) {
    throw new Error(`XPAYMENTS Native method ${input.method} is not enabled for ${input.currency}`);
  }

  const response = await fetch(`${apiBase()}/payments/charge`, {
    method: "POST",
    headers: authHeaders(apiKey, input.idempotencyKey),
    body: JSON.stringify({
      amount: input.amountCents,
      currency: input.currency,
      payment_method_types: [input.method],
      reference: input.reference,
      customer: Object.fromEntries(Object.entries(input.customer).filter(([, value]) => value)),
      metadata: {
        ...input.metadata,
        expectedStoreCode: storeCode,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await responsePayload(response);
  if (!response.ok) throw new Error(`XPAYMENTS Native payment failed (${response.status})`);
  const parsed = nativePaymentResponse.safeParse(payload);
  if (!parsed.success) throw new Error("XPAYMENTS returned an invalid Native payment response");
  if (parsed.data.success === false) throw new Error("XPAYMENTS rejected the Native payment");

  const returnedMethod = parsed.data.method?.toLowerCase().replace(/-/g, "_") ?? input.method;
  if (returnedMethod !== input.method) {
    throw new Error(`XPAYMENTS method mismatch: expected ${input.method}`);
  }

  return {
    transactionId: parsed.data.transactionId,
    reference: parsed.data.reference ?? input.reference,
    status: parsed.data.status ?? "pending",
    method: input.method,
    action: parsed.data.action ?? {},
    storeCode,
  };
}

export async function getXPaymentsSession(sessionId: string, currency?: PaymentCurrency) {
  const candidates: PaymentCurrency[] = currency ? [currency] : ["EUR", "BRL"];
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    const { apiKey, storeCode } = xpaymentsConfigForCurrency(candidate);
    if (!apiKey || !storeCode) continue;
    try {
      assertEnvironmentSafe(candidate, apiKey, storeCode);
      const response = await fetch(`${apiBase()}/checkout/session/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`XPAYMENTS session lookup failed (${response.status})`);
      const parsed = checkoutSessionResponse.safeParse(await responsePayload(response));
      if (!parsed.success || parsed.data.success === false) throw new Error("XPAYMENTS returned an invalid checkout status");
      const responseStoreCode = typeof parsed.data.data.storeCode === "string" ? parsed.data.data.storeCode : null;
      if (responseStoreCode && responseStoreCode !== storeCode) throw new Error(`XPAYMENTS Store mismatch: expected ${storeCode}`);
      return parsed.data.data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("XPAYMENTS session lookup failed");
    }
  }
  throw lastError ?? new Error("No XPAYMENTS Store is configured for session lookup");
}

export function normalizeXPaymentsStatus(value: unknown) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!status) return null;
  if (["paid", "succeeded", "success", "completed"].includes(status)) return "SUCCEEDED" as const;
  if (["processing", "requires_action", "awaiting", "pending_action"].includes(status)) return "PROCESSING" as const;
  if (["failed", "declined", "error"].includes(status)) return "FAILED" as const;
  if (["cancelled", "canceled"].includes(status)) return "CANCELLED" as const;
  if (["expired"].includes(status)) return "EXPIRED" as const;
  if (["pending", "open", "created"].includes(status)) return "PENDING" as const;
  return null;
}
