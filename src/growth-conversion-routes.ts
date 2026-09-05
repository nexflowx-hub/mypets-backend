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
}
