import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import {
  dispatchTelegramQueue,
  internalAlertsPublicConfig,
  retryTelegramDelivery,
} from "./internal-alerts.js";

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function envAdmins() {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((value) => normalizeEmail(value))
      .filter(Boolean),
  );
}

async function requireAdmin(prisma: PrismaClient, req: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) {
  const user = await requireAuth(req, reply);
  if (!user) return null;

  const email = normalizeEmail(user.email);
  const allowedByEnv = envAdmins().has(email);
  const rows = await prisma.$queryRaw<Array<{ active: boolean }>>`
    select active
    from public.admin_users
    where user_id = ${user.id}::uuid or lower(email) = ${email}
    order by active desc
    limit 1
  `;

  if (!allowedByEnv && !rows[0]?.active) {
    reply.code(403).send({ error: { code: "ADMIN_REQUIRED", message: "Administrator access required" } });
    return null;
  }

  return { id: user.id, email };
}

const statusSchema = z.enum(["LOGGED", "OPEN", "ACKNOWLEDGED", "RESOLVED", "IGNORED"]);
const severitySchema = z.enum(["INFO", "NOTICE", "WARNING", "CRITICAL"]);
const categorySchema = z.enum(["PAYMENT", "CAUSE", "SUPPORT", "MESSAGE", "LEAD", "REPORT", "SYSTEM"]);

export async function registerInternalAlertAdminRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/admin/internal-alerts/config", async (req, reply) => {
    const admin = await requireAdmin(prisma, req, reply);
    if (!admin) return;
    return { data: internalAlertsPublicConfig() };
  });

  app.get("/v1/admin/internal-alerts/summary", async (req, reply) => {
    const admin = await requireAdmin(prisma, req, reply);
    if (!admin) return;

    const rows = await prisma.$queryRaw<Array<{
      total: number;
      open: number;
      acknowledged: number;
      today: number;
      telegram_failed: number;
    }>>`
      select
        count(*)::int as total,
        count(*) filter (where a.ticket_status = 'OPEN')::int as open,
        count(*) filter (where a.ticket_status = 'ACKNOWLEDGED')::int as acknowledged,
        count(*) filter (where a.created_at >= date_trunc('day', now()))::int as today,
        count(*) filter (
          where exists (
            select 1 from public.internal_alert_deliveries d
            where d.alert_id = a.id and d.channel = 'TELEGRAM' and d.status in ('FAILED','CANCELLED')
          )
        )::int as telegram_failed
      from public.internal_alerts a
    `;

    return { data: rows[0] ?? { total: 0, open: 0, acknowledged: 0, today: 0, telegram_failed: 0 } };
  });

  app.get("/v1/admin/internal-alerts", async (req, reply) => {
    const admin = await requireAdmin(prisma, req, reply);
    if (!admin) return;

    const parsed = z.object({
      status: statusSchema.optional(),
      severity: severitySchema.optional(),
      category: categorySchema.optional(),
      eventType: z.string().trim().min(2).max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(req.query);

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid internal alert query" } });
    }

    const status = parsed.data.status ?? null;
    const severity = parsed.data.severity ?? null;
    const category = parsed.data.category ?? null;
    const eventType = parsed.data.eventType?.toUpperCase() ?? null;

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      select
        a.id, a.event_type, a.category, a.severity, a.title, a.summary,
        a.entity_type, a.entity_id, a.public_url, a.admin_url,
        a.ticket_status, a.action_required, a.metadata,
        a.acknowledged_by, a.acknowledged_at, a.resolved_by, a.resolved_at,
        a.created_at, a.updated_at,
        d.status as telegram_status,
        d.attempt_count as telegram_attempts,
        d.sent_at as telegram_sent_at,
        d.last_error as telegram_last_error
      from public.internal_alerts a
      left join public.internal_alert_deliveries d
        on d.alert_id = a.id and d.channel = 'TELEGRAM'
      where (${status}::text is null or a.ticket_status = ${status})
        and (${severity}::text is null or a.severity = ${severity})
        and (${category}::text is null or a.category = ${category})
        and (${eventType}::text is null or a.event_type = ${eventType})
      order by
        case a.severity when 'CRITICAL' then 0 when 'WARNING' then 1 when 'NOTICE' then 2 else 3 end,
        a.created_at desc
      limit ${parsed.data.limit}
    `;

    return { data: rows };
  });

  app.patch("/v1/admin/internal-alerts/:id", async (req, reply) => {
    const admin = await requireAdmin(prisma, req, reply);
    if (!admin) return;

    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({
      action: z.enum(["ACKNOWLEDGE", "RESOLVE", "IGNORE", "REOPEN"]),
      note: z.string().trim().max(2000).nullable().optional(),
    }).safeParse(req.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid alert update" } });
    }

    const rows = body.data.action === "ACKNOWLEDGE"
      ? await prisma.$queryRaw<Array<{ id: string; ticket_status: string }>>`
          update public.internal_alerts
          set ticket_status = 'ACKNOWLEDGED',
              acknowledged_by = ${admin.id}::uuid,
              acknowledged_at = now(),
              updated_at = now(),
              metadata = metadata || ${JSON.stringify({ adminNote: body.data.note ?? null })}::jsonb
          where id = ${params.data.id}::uuid
          returning id, ticket_status
        `
      : body.data.action === "RESOLVE"
        ? await prisma.$queryRaw<Array<{ id: string; ticket_status: string }>>`
            update public.internal_alerts
            set ticket_status = 'RESOLVED',
                resolved_by = ${admin.id}::uuid,
                resolved_at = now(),
                updated_at = now(),
                metadata = metadata || ${JSON.stringify({ adminNote: body.data.note ?? null })}::jsonb
            where id = ${params.data.id}::uuid
            returning id, ticket_status
          `
        : body.data.action === "IGNORE"
          ? await prisma.$queryRaw<Array<{ id: string; ticket_status: string }>>`
              update public.internal_alerts
              set ticket_status = 'IGNORED',
                  resolved_by = ${admin.id}::uuid,
                  resolved_at = now(),
                  updated_at = now(),
                  metadata = metadata || ${JSON.stringify({ adminNote: body.data.note ?? null })}::jsonb
              where id = ${params.data.id}::uuid
              returning id, ticket_status
            `
          : await prisma.$queryRaw<Array<{ id: string; ticket_status: string }>>`
              update public.internal_alerts
              set ticket_status = 'OPEN',
                  acknowledged_by = null,
                  acknowledged_at = null,
                  resolved_by = null,
                  resolved_at = null,
                  updated_at = now(),
                  metadata = metadata || ${JSON.stringify({ adminNote: body.data.note ?? null })}::jsonb
              where id = ${params.data.id}::uuid
              returning id, ticket_status
            `;

    const row = rows[0];
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Internal alert not found" } });

    await prisma.$executeRaw`
      insert into public.admin_audit_log (actor_user_id, actor_email, action, entity_type, entity_id, metadata)
      values (
        ${admin.id}::uuid, ${admin.email || null}, ${`INTERNAL_ALERT_${body.data.action}`},
        'internal_alert', ${row.id}::uuid,
        ${JSON.stringify({ status: row.ticket_status, note: body.data.note ?? null })}::jsonb
      )
    `;

    return { data: row };
  });

  app.post("/v1/admin/internal-alerts/:id/retry-telegram", async (req, reply) => {
    const admin = await requireAdmin(prisma, req, reply);
    if (!admin) return;

    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid alert id" } });

    const exists = await prisma.$queryRaw<Array<{ id: string }>>`
      select id from public.internal_alerts where id = ${params.data.id}::uuid limit 1
    `;
    if (!exists[0]) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Internal alert not found" } });

    const deliveryId = await retryTelegramDelivery(prisma, params.data.id);
    void dispatchTelegramQueue(app, prisma, 1).catch((error) => {
      app.log.warn({ err: error, alertId: params.data.id }, "Manual Telegram alert retry failed");
    });

    await prisma.$executeRaw`
      insert into public.admin_audit_log (actor_user_id, actor_email, action, entity_type, entity_id, metadata)
      values (
        ${admin.id}::uuid, ${admin.email || null}, 'INTERNAL_ALERT_TELEGRAM_RETRY',
        'internal_alert', ${params.data.id}::uuid,
        ${JSON.stringify({ deliveryId })}::jsonb
      )
    `;

    return reply.code(202).send({ data: { alertId: params.data.id, deliveryId, queued: true } });
  });
}
