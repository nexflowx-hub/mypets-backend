import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

export type InternalAlertCategory = "PAYMENT" | "CAUSE" | "SUPPORT" | "MESSAGE" | "LEAD" | "REPORT" | "SYSTEM";
export type InternalAlertSeverity = "INFO" | "NOTICE" | "WARNING" | "CRITICAL";
export type InternalAlertTicketStatus = "LOGGED" | "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "IGNORED";

export type InternalAlertInput = {
  eventType: string;
  category: InternalAlertCategory;
  severity?: InternalAlertSeverity;
  title: string;
  summary?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  publicUrl?: string | null;
  adminUrl?: string | null;
  ticketStatus?: InternalAlertTicketStatus;
  actionRequired?: boolean;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
};

type AlertRow = {
  id: string;
  event_type: string;
  category: InternalAlertCategory;
  severity: InternalAlertSeverity;
  title: string;
  summary: string | null;
  entity_type: string | null;
  entity_id: string | null;
  public_url: string | null;
  admin_url: string | null;
  ticket_status: InternalAlertTicketStatus;
  action_required: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

type DeliveryRow = {
  id: string;
  alert_id: string;
  attempt_count: number;
};

const DEFAULT_TELEGRAM_EVENTS = new Set([
  "CAUSE_INTAKE_CREATED",
  "NEED_CREATED",
  "SUPPORT_OFFER_CREATED",
  "GROWTH_LEAD_CREATED",
  "PAYMENT_SUCCEEDED",
  "REPORT_CREATED",
]);

const MAX_TELEGRAM_ATTEMPTS = 8;

function telegramEnabled() {
  return process.env.TELEGRAM_ALERT_ENABLED === "true"
    && Boolean(process.env.TELEGRAM_ALERT_BOT_TOKEN?.trim())
    && Boolean(process.env.TELEGRAM_ALERT_CHAT_ID?.trim());
}

function telegramEventAllowed(eventType: string) {
  const configured = (process.env.TELEGRAM_ALERT_EVENTS ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (configured.includes("*")) return true;
  if (configured.length > 0) return configured.includes(eventType.toUpperCase());
  return DEFAULT_TELEGRAM_EVENTS.has(eventType.toUpperCase());
}

function categoryEmoji(category: InternalAlertCategory) {
  switch (category) {
    case "PAYMENT": return "💚";
    case "CAUSE": return "🐾";
    case "SUPPORT": return "🤝";
    case "MESSAGE": return "💬";
    case "LEAD": return "📥";
    case "REPORT": return "🚩";
    case "SYSTEM": return "⚙️";
  }
}

function severityLabel(severity: InternalAlertSeverity) {
  switch (severity) {
    case "CRITICAL": return "CRÍTICO";
    case "WARNING": return "ATENÇÃO";
    case "NOTICE": return "NOVO EVENTO";
    case "INFO": return "INFO";
  }
}

function safeSnippet(value: string | null | undefined, max = 900) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function formatTelegramText(alert: AlertRow) {
  const lines = [
    `${categoryEmoji(alert.category)} MyPets • ${severityLabel(alert.severity)}`,
    alert.title,
  ];

  if (alert.summary) lines.push("", safeSnippet(alert.summary));
  lines.push("", `Evento: ${alert.event_type}`);
  lines.push(`Estado: ${alert.ticket_status}`);
  if (alert.action_required) lines.push("Ação interna: necessária");

  if (alert.entity_type && alert.entity_id) {
    lines.push(`Ref: ${alert.entity_type} · ${alert.entity_id}`);
  }

  lines.push(`Data: ${alert.created_at.toISOString()}`);
  return lines.join("\n").slice(0, 3900);
}

function retryDelayMs(attemptCount: number) {
  const seconds = Math.min(900, 15 * (2 ** Math.max(0, attemptCount - 1)));
  return seconds * 1000;
}

async function sendTelegram(alert: AlertRow) {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error("telegram_not_configured");

  const targetUrl = alert.admin_url || alert.public_url || null;
  const threadRaw = process.env.TELEGRAM_ALERT_THREAD_ID?.trim();
  const threadId = threadRaw && /^\d+$/.test(threadRaw) ? Number(threadRaw) : null;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: formatTelegramText(alert),
    link_preview_options: { is_disabled: true },
    disable_notification: alert.severity === "INFO",
  };
  if (threadId) body.message_thread_id = threadId;
  if (targetUrl) {
    body.reply_markup = {
      inline_keyboard: [[{ text: alert.admin_url ? "Abrir no painel" : "Abrir no MyPets", url: targetUrl }]],
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  const json = await response.json().catch(() => null) as
    | { ok?: boolean; description?: string; result?: { message_id?: number } }
    | null;

  if (!response.ok || !json?.ok) {
    throw new Error(`telegram_send_failed:${response.status}:${json?.description ?? "unknown"}`);
  }

  return json.result?.message_id ? String(json.result.message_id) : null;
}

async function claimNextTelegramDelivery(prisma: PrismaClient): Promise<DeliveryRow | null> {
  const rows = await prisma.$queryRaw<DeliveryRow[]>`
    with candidate as (
      select id
      from public.internal_alert_deliveries
      where channel = 'TELEGRAM'
        and status in ('PENDING','FAILED')
        and next_attempt_at <= now()
        and attempt_count < ${MAX_TELEGRAM_ATTEMPTS}
      order by next_attempt_at asc, created_at asc
      limit 1
      for update skip locked
    )
    update public.internal_alert_deliveries d
    set status = 'SENDING',
        attempt_count = d.attempt_count + 1,
        last_attempt_at = now(),
        updated_at = now()
    from candidate c
    where d.id = c.id
    returning d.id, d.alert_id, d.attempt_count
  `;
  return rows[0] ?? null;
}

async function loadAlert(prisma: PrismaClient, id: string): Promise<AlertRow | null> {
  const rows = await prisma.$queryRaw<AlertRow[]>`
    select id, event_type, category, severity, title, summary, entity_type, entity_id,
           public_url, admin_url, ticket_status, action_required, metadata, created_at
    from public.internal_alerts
    where id = ${id}::uuid
    limit 1
  `;
  return rows[0] ?? null;
}

async function dispatchOneTelegram(app: FastifyInstance, prisma: PrismaClient) {
  const delivery = await claimNextTelegramDelivery(prisma);
  if (!delivery) return false;

  const alert = await loadAlert(prisma, delivery.alert_id);
  if (!alert) {
    await prisma.$executeRaw`
      update public.internal_alert_deliveries
      set status = 'CANCELLED', last_error = 'alert_not_found', updated_at = now()
      where id = ${delivery.id}::uuid
    `;
    return true;
  }

  try {
    const messageId = await sendTelegram(alert);
    await prisma.$executeRaw`
      update public.internal_alert_deliveries
      set status = 'SENT',
          sent_at = now(),
          provider_message_id = ${messageId},
          last_error = null,
          updated_at = now()
      where id = ${delivery.id}::uuid
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "telegram_unknown_error";
    const exhausted = delivery.attempt_count >= MAX_TELEGRAM_ATTEMPTS;
    const nextAttempt = new Date(Date.now() + retryDelayMs(delivery.attempt_count));
    await prisma.$executeRaw`
      update public.internal_alert_deliveries
      set status = ${exhausted ? "CANCELLED" : "FAILED"},
          next_attempt_at = ${nextAttempt},
          last_error = ${message},
          updated_at = now()
      where id = ${delivery.id}::uuid
    `;
    app.log.warn({ alertId: alert.id, deliveryId: delivery.id, err: message }, "Telegram internal alert delivery failed");
  }

  return true;
}

export async function dispatchTelegramQueue(app: FastifyInstance, prisma: PrismaClient, maxItems = 5) {
  if (!telegramEnabled()) return;

  await prisma.$executeRaw`
    update public.internal_alert_deliveries
    set status = 'FAILED',
        next_attempt_at = now(),
        last_error = coalesce(last_error, 'stale_sending_claim'),
        updated_at = now()
    where channel = 'TELEGRAM'
      and status = 'SENDING'
      and last_attempt_at < now() - interval '5 minutes'
  `;

  for (let index = 0; index < maxItems; index += 1) {
    const processed = await dispatchOneTelegram(app, prisma);
    if (!processed) break;
  }
}

export function startInternalAlertDispatcher(app: FastifyInstance, prisma: PrismaClient) {
  if (!telegramEnabled()) {
    app.log.info("Telegram internal alerts are disabled or not configured");
    return;
  }

  app.log.info("Telegram internal alert dispatcher enabled");
  const timer = setInterval(() => {
    void dispatchTelegramQueue(app, prisma, 10).catch((error) => {
      app.log.error({ err: error }, "Telegram internal alert dispatcher failed");
    });
  }, 15_000);
  timer.unref();

  setTimeout(() => {
    void dispatchTelegramQueue(app, prisma, 10).catch((error) => {
      app.log.error({ err: error }, "Initial Telegram internal alert dispatch failed");
    });
  }, 1_500).unref();

  app.addHook("onClose", async () => clearInterval(timer));
}

export async function emitInternalAlert(
  app: FastifyInstance,
  prisma: PrismaClient,
  input: InternalAlertInput,
) {
  try {
    const actionRequired = input.actionRequired ?? false;
    const ticketStatus = input.ticketStatus ?? (actionRequired ? "OPEN" : "LOGGED");
    const metadata = JSON.stringify(input.metadata ?? {});

    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      insert into public.internal_alerts (
        event_type, category, severity, title, summary, entity_type, entity_id,
        public_url, admin_url, ticket_status, action_required, dedupe_key, metadata
      ) values (
        ${input.eventType.toUpperCase()}, ${input.category}, ${input.severity ?? "NOTICE"},
        ${input.title}, ${input.summary ?? null}, ${input.entityType ?? null}, ${input.entityId ?? null},
        ${input.publicUrl ?? null}, ${input.adminUrl ?? null}, ${ticketStatus}, ${actionRequired},
        ${input.dedupeKey ?? null}, ${metadata}::jsonb
      )
      on conflict (dedupe_key) where dedupe_key is not null do nothing
      returning id
    `;

    const alertId = rows[0]?.id;
    if (!alertId) return null;

    if (telegramEnabled() && telegramEventAllowed(input.eventType)) {
      await prisma.$executeRaw`
        insert into public.internal_alert_deliveries (alert_id, channel, status)
        values (${alertId}::uuid, 'TELEGRAM', 'PENDING')
        on conflict (alert_id, channel) do nothing
      `;

      void dispatchTelegramQueue(app, prisma, 1).catch((error) => {
        app.log.warn({ err: error, alertId }, "Immediate Telegram alert dispatch failed");
      });
    }

    return alertId;
  } catch (error) {
    // Alerting must never break a business transaction or customer-facing flow.
    app.log.error({ err: error, eventType: input.eventType }, "Internal alert persistence failed");
    return null;
  }
}

export async function retryTelegramDelivery(prisma: PrismaClient, alertId: string) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    insert into public.internal_alert_deliveries (alert_id, channel, status, next_attempt_at)
    values (${alertId}::uuid, 'TELEGRAM', 'PENDING', now())
    on conflict (alert_id, channel) do update
      set status = 'PENDING',
          attempt_count = 0,
          next_attempt_at = now(),
          last_error = null,
          updated_at = now()
    returning id
  `;
  return rows[0]?.id ?? null;
}

export function internalAlertsPublicConfig() {
  return {
    enabled: process.env.TELEGRAM_ALERT_ENABLED === "true",
    configured: telegramEnabled(),
    events: process.env.TELEGRAM_ALERT_EVENTS?.trim() || Array.from(DEFAULT_TELEGRAM_EVENTS).join(","),
  };
}
