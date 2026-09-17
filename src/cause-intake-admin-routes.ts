import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

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

async function requireAdmin(app: FastifyInstance, prisma: PrismaClient, req: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) {
  const user = await requireAuth(req, reply);
  if (!user) return null;
  const email = normalizeEmail(user.email);
  const allowedByEnv = envAdmins().has(email);
  const rows = await prisma.$queryRaw<Array<{ active: boolean }>>`
    select active from public.admin_users
    where user_id = ${user.id}::uuid or lower(email) = ${email}
    order by active desc limit 1
  `;
  if (!allowedByEnv && !rows[0]?.active) {
    await prisma.$executeRaw`
      insert into public.admin_audit_log (actor_user_id, actor_email, action, entity_type, metadata)
      values (${user.id}::uuid, ${email || null}, 'ADMIN_ACCESS_DENIED', 'cause_intake', ${JSON.stringify({ path: req.url })}::jsonb)
    `;
    reply.code(403).send({ error: { code: "FORBIDDEN", message: "Admin access required" } });
    return null;
  }
  return { id: user.id, email };
}

const moderationSchema = z.object({
  action: z.enum(["UNDER_REVIEW", "HIDE", "REJECT", "RESTORE", "REQUEST_VERIFICATION", "VERIFY_AND_LINK"]),
  protectorId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(3000).nullable().optional(),
});

const promotionSchema = z.object({
  status: z.enum(["QUEUED", "DRAFTED", "APPROVED", "PUBLISHED", "FAILED", "CANCELLED"]),
  suggestedCaption: z.string().trim().max(4000).nullable().optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  publishedAt: z.coerce.date().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function registerCauseIntakeAdminRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/admin/cause-intake", async (req, reply) => {
    const admin = await requireAdmin(app, prisma, req, reply);
    if (!admin) return;
    const parsed = z.object({
      status: z.enum(["PUBLISHED_UNVERIFIED", "UNDER_REVIEW", "VERIFICATION_REQUESTED", "VERIFIED", "HIDDEN", "REJECTED"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid intake query" } });

    const rows = parsed.data.status
      ? await prisma.$queryRaw<Array<Record<string, unknown>>>`
          select ci.id, ci.cause_id, ci.contact_name, ci.contact_email, ci.whatsapp, ci.public_whatsapp,
                 ci.country, ci.region, ci.city, ci.cause_type, ci.instagram_url, ci.facebook_url, ci.tiktok_url,
                 ci.media_links, ci.status, ci.verification_requested_at, ci.verified_at, ci.review_notes_private,
                 ci.created_at, ci.updated_at,
                 c.slug, c.title, c.summary, c.verification_status, c.fundraising_status, c.is_public, c.protector_id,
                 pq.status as promotion_status, pq.suggested_caption
          from public.cause_intake_submissions ci
          join public.causes c on c.id = ci.cause_id
          left join public.cause_promotion_queue pq on pq.cause_id = c.id
          where ci.status = ${parsed.data.status}
          order by ci.created_at desc limit ${parsed.data.limit}
        `
      : await prisma.$queryRaw<Array<Record<string, unknown>>>`
          select ci.id, ci.cause_id, ci.contact_name, ci.contact_email, ci.whatsapp, ci.public_whatsapp,
                 ci.country, ci.region, ci.city, ci.cause_type, ci.instagram_url, ci.facebook_url, ci.tiktok_url,
                 ci.media_links, ci.status, ci.verification_requested_at, ci.verified_at, ci.review_notes_private,
                 ci.created_at, ci.updated_at,
                 c.slug, c.title, c.summary, c.verification_status, c.fundraising_status, c.is_public, c.protector_id,
                 pq.status as promotion_status, pq.suggested_caption
          from public.cause_intake_submissions ci
          join public.causes c on c.id = ci.cause_id
          left join public.cause_promotion_queue pq on pq.cause_id = c.id
          order by ci.created_at desc limit ${parsed.data.limit}
        `;
    return { data: rows };
  });

  app.patch("/v1/admin/cause-intake/:id/review", async (req, reply) => {
    const admin = await requireAdmin(app, prisma, req, reply);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = moderationSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid moderation request" } });

    const rows = await prisma.$queryRaw<Array<{ id: string; cause_id: string }>>`
      select id, cause_id from public.cause_intake_submissions where id = ${params.data.id}::uuid limit 1
    `;
    const intake = rows[0];
    if (!intake) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Cause intake not found" } });

    if (body.data.action === "VERIFY_AND_LINK") {
      if (!body.data.protectorId) return reply.code(400).send({ error: { code: "PROTECTOR_REQUIRED", message: "protectorId is required" } });
      const protector = await prisma.protector.findUnique({ where: { id: body.data.protectorId }, select: { id: true } });
      if (!protector) return reply.code(404).send({ error: { code: "PROTECTOR_NOT_FOUND", message: "Protector not found" } });
    }

    await prisma.$transaction(async (tx) => {
      const note = body.data.note ?? null;
      switch (body.data.action) {
        case "UNDER_REVIEW":
          await tx.$executeRaw`update public.cause_intake_submissions set status='UNDER_REVIEW', review_notes_private=${note}, updated_at=now() where id=${intake.id}::uuid`;
          await tx.$executeRaw`update public.causes set verification_status='REVIEWING', updated_at=now() where id=${intake.cause_id}::uuid`;
          break;
        case "HIDE":
          await tx.$executeRaw`update public.cause_intake_submissions set status='HIDDEN', review_notes_private=${note}, updated_at=now() where id=${intake.id}::uuid`;
          await tx.$executeRaw`update public.causes set is_public=false, updated_at=now() where id=${intake.cause_id}::uuid`;
          break;
        case "REJECT":
          await tx.$executeRaw`update public.cause_intake_submissions set status='REJECTED', review_notes_private=${note}, updated_at=now() where id=${intake.id}::uuid`;
          await tx.$executeRaw`update public.causes set is_public=false, verification_status='REJECTED', updated_at=now() where id=${intake.cause_id}::uuid`;
          await tx.$executeRaw`update public.cause_promotion_queue set status='CANCELLED', updated_at=now() where cause_id=${intake.cause_id}::uuid and status <> 'PUBLISHED'`;
          break;
        case "RESTORE":
          await tx.$executeRaw`update public.cause_intake_submissions set status='PUBLISHED_UNVERIFIED', review_notes_private=${note}, updated_at=now() where id=${intake.id}::uuid`;
          await tx.$executeRaw`update public.causes set is_public=true, status='ACTIVE', verification_status='UNVERIFIED', fundraising_status='DISABLED', support_mode='NON_FINANCIAL', currency=null, target_amount_cents=null, updated_at=now() where id=${intake.cause_id}::uuid`;
          await tx.$executeRaw`update public.cause_promotion_queue set status=case when status='PUBLISHED' then status else 'QUEUED' end, updated_at=now() where cause_id=${intake.cause_id}::uuid`;
          break;
        case "REQUEST_VERIFICATION":
          await tx.$executeRaw`update public.cause_intake_submissions set status='VERIFICATION_REQUESTED', verification_requested_at=coalesce(verification_requested_at, now()), review_notes_private=${note}, updated_at=now() where id=${intake.id}::uuid`;
          await tx.$executeRaw`update public.causes set verification_status='REVIEWING', updated_at=now() where id=${intake.cause_id}::uuid`;
          break;
        case "VERIFY_AND_LINK":
          await tx.$executeRaw`update public.cause_intake_submissions set status='VERIFIED', verified_at=coalesce(verified_at, now()), review_notes_private=${note}, updated_at=now() where id=${intake.id}::uuid`;
          await tx.$executeRaw`
            update public.causes
            set beneficiary_kind='PROTECTOR', protector_id=${body.data.protectorId}::uuid,
                verification_status='VERIFIED', fundraising_status='REVIEW_REQUIRED',
                support_mode='NON_FINANCIAL', currency=null, target_amount_cents=null, is_public=true, status='ACTIVE', updated_at=now()
            where id=${intake.cause_id}::uuid
          `;
          break;
      }

      await tx.$executeRaw`
        insert into public.admin_audit_log (actor_user_id, actor_email, action, entity_type, entity_id, metadata)
        values (
          ${admin.id}::uuid, ${admin.email || null}, ${`CAUSE_INTAKE_${body.data.action}`}, 'cause_intake', ${intake.id}::uuid,
          ${JSON.stringify({ causeId: intake.cause_id, protectorId: body.data.protectorId ?? null, note: body.data.note ?? null })}::jsonb
        )
      `;
    });

    return { data: { id: intake.id, causeId: intake.cause_id, action: body.data.action } };
  });

  app.get("/v1/admin/cause-promotion", async (req, reply) => {
    const admin = await requireAdmin(app, prisma, req, reply);
    if (!admin) return;
    const parsed = z.object({
      status: z.enum(["QUEUED", "DRAFTED", "APPROVED", "PUBLISHED", "FAILED", "CANCELLED"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid promotion query" } });

    const rows = parsed.data.status
      ? await prisma.$queryRaw<Array<Record<string, unknown>>>`
          select pq.*, c.slug, c.title, c.summary, c.country, c.region, c.primary_image
          from public.cause_promotion_queue pq join public.causes c on c.id=pq.cause_id
          where pq.status=${parsed.data.status}
          order by pq.created_at desc limit ${parsed.data.limit}
        `
      : await prisma.$queryRaw<Array<Record<string, unknown>>>`
          select pq.*, c.slug, c.title, c.summary, c.country, c.region, c.primary_image
          from public.cause_promotion_queue pq join public.causes c on c.id=pq.cause_id
          order by pq.created_at desc limit ${parsed.data.limit}
        `;
    return { data: rows };
  });

  app.patch("/v1/admin/cause-promotion/:id", async (req, reply) => {
    const admin = await requireAdmin(app, prisma, req, reply);
    if (!admin) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = promotionSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid promotion update" } });

    const metadata = body.data.metadata ? JSON.stringify(body.data.metadata) : null;
    const rows = await prisma.$queryRaw<Array<{ id: string; cause_id: string; status: string }>>`
      update public.cause_promotion_queue
      set status=${body.data.status},
          suggested_caption=coalesce(${body.data.suggestedCaption ?? null}, suggested_caption),
          scheduled_at=coalesce(${body.data.scheduledAt ?? null}, scheduled_at),
          published_at=case when ${body.data.status}='PUBLISHED' then coalesce(${body.data.publishedAt ?? null}, published_at, now()) else published_at end,
          metadata=case when ${metadata}::text is null then metadata else ${metadata}::jsonb end,
          updated_at=now()
      where id=${params.data.id}::uuid
      returning id, cause_id, status
    `;
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Promotion item not found" } });

    await prisma.$executeRaw`
      insert into public.admin_audit_log (actor_user_id, actor_email, action, entity_type, entity_id, metadata)
      values (${admin.id}::uuid, ${admin.email || null}, 'CAUSE_PROMOTION_UPDATE', 'cause_promotion', ${row.id}::uuid, ${JSON.stringify({ causeId: row.cause_id, status: row.status })}::jsonb)
    `;
    return { data: row };
  });
}