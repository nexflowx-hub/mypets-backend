import { z } from "zod";

const createSessionResponse = z.object({
  success: z.boolean(),
  data: z.object({
    sessionId: z.string().uuid(),
    checkoutUrl: z.string().url(),
  }).optional(),
  message: z.string().optional(),
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional(),
});

const sessionResponse = z.object({
  success: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  message: z.string().optional(),
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional(),
}).passthrough();

function apiBase() {
  return (process.env.XPAYMENTS_API_BASE ?? "https://api.xpayments.digital/api/v1").replace(/\/$/, "");
}

export function checkoutBase() {
  return (process.env.XPAYMENTS_CHECKOUT_BASE ?? "https://checkout.xpayments.digital").replace(/\/$/, "");
}

export function xpaymentsConfigForCurrency(currency: "EUR" | "BRL") {
  const suffix = currency === "EUR" ? "EUR" : "BRL";
  const apiKey = process.env[`XPAYMENTS_API_KEY_${suffix}`] ?? "";
  const storeCode = process.env[`XPAYMENTS_STORE_CODE_${suffix}`] ?? "";
  return { apiKey, storeCode };
}

export function xpaymentsCurrencyEnabled(currency: "EUR" | "BRL") {
  return Boolean(xpaymentsConfigForCurrency(currency).apiKey);
}

export async function createXPaymentsSession(input: {
  amountCents: number;
  currency: "EUR" | "BRL";
  reference: string;
  customerEmail?: string | null;
  metadata: Record<string, unknown>;
}) {
  const { apiKey, storeCode } = xpaymentsConfigForCurrency(input.currency);
  if (!apiKey) throw new Error(`XPAYMENTS_${input.currency}_NOT_CONFIGURED`);

  const response = await fetch(`${apiBase()}/checkout/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      amount: input.amountCents,
      currency: input.currency,
      reference: input.reference,
      customerEmail: input.customerEmail ?? undefined,
      metadata: input.metadata,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  const raw: unknown = await response.json().catch(() => ({}));
  const parsed = createSessionResponse.safeParse(raw);
  if (!response.ok || !parsed.success || !parsed.data.success || !parsed.data.data) {
    const message = parsed.success
      ? parsed.data.error?.message ?? parsed.data.message ?? `XPAYMENTS_HTTP_${response.status}`
      : `XPAYMENTS_INVALID_RESPONSE_${response.status}`;
    throw new Error(message);
  }

  return {
    sessionId: parsed.data.data.sessionId,
    checkoutUrl: parsed.data.data.checkoutUrl,
    embedUrl: `${checkoutBase()}/embed/${encodeURIComponent(parsed.data.data.sessionId)}`,
    storeCode: storeCode || null,
  };
}

export async function getXPaymentsSession(sessionId: string) {
  const response = await fetch(`${apiBase()}/checkout/session/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const raw: unknown = await response.json().catch(() => ({}));
  const parsed = sessionResponse.safeParse(raw);
  if (!response.ok || !parsed.success) throw new Error(`XPAYMENTS_SESSION_HTTP_${response.status}`);

  const envelope = (parsed.data.data ?? parsed.data) as Record<string, unknown>;
  return envelope;
}

export function normalizeXPaymentsStatus(value: unknown): "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED" | null {
  const status = String(value ?? "").trim().toLowerCase();
  if (["paid", "completed", "succeeded", "success"].includes(status)) return "SUCCEEDED";
  if (["failed", "declined", "error"].includes(status)) return "FAILED";
  if (["cancelled", "canceled"].includes(status)) return "CANCELLED";
  if (status === "expired") return "EXPIRED";
  if (["processing", "awaiting", "requires_action"].includes(status)) return "PROCESSING";
  if (["pending", "created", "open"].includes(status)) return "PENDING";
  return null;
}
