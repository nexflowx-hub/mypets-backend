import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

export async function registerGrowthConversionRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post("/v1/growth/leads/:id/convert", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid lead id" } });

    const rows = await prisma.$queryRaw<Array<{ id: string; intent: string; status: string }>>`
      update public.growth_leads
      set user_id = ${user.id}::uuid, status = 'CONVERTED', updated_at = now()
      where id = ${params.data.id}::uuid and (user_id is null or user_id = ${user.id}::uuid)
      returning id, intent, status
    `;
    const lead = rows[0];
    if (!lead) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Lead not found" } });

    await prisma.$executeRaw`
      insert into public.growth_events (lead_id, user_id, event_name, landing_path, metadata)
      values (${lead.id}::uuid, ${user.id}::uuid, 'SIGNUP_COMPLETED', '/dashboard', ${JSON.stringify({ intent: lead.intent })}::jsonb)
    `;

    return { data: lead };
  });

  app.get("/v1/me/referrals", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const totals = await prisma.$queryRaw<Array<{ links: bigint; clicks: bigint }>>`
      select count(*)::bigint as links, coalesce(sum(clicks), 0)::bigint as clicks
      from public.share_links
      where owner_user_id = ${user.id}::uuid and active = true
    `;
    const top = await prisma.$queryRaw<Array<{
      code: string;
      destination_path: string;
      medium: string | null;
      campaign: string | null;
      clicks: number;
      created_at: Date;
    }>>`
      select code, destination_path, medium, campaign, clicks, created_at
      from public.share_links
      where owner_user_id = ${user.id}::uuid and active = true
      order by clicks desc, created_at desc
      limit 12
    `;

    return {
      data: {
        activeLinks: Number(totals[0]?.links ?? 0n),
        clicks: Number(totals[0]?.clicks ?? 0n),
        topLinks: top.map((row) => ({
          code: row.code,
          path: `/s/${row.code}`,
          destinationPath: row.destination_path,
          channel: row.medium,
          campaign: row.campaign,
          clicks: row.clicks,
          createdAt: row.created_at,
        })),
      },
    };
  });
}
