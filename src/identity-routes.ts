import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const roleSchema = z.enum(["PROTECTOR", "VOLUNTEER", "DONOR", "SPONSOR", "ADOPTER", "SUPPORTER"]);
const countrySchema = z.enum(["PT", "BR"]);

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function publicSocialLinks(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, url]) => typeof url === "string" && /^https?:\/\//i.test(url)) as Array<[string, string]>
  );
}

export async function registerIdentityRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/me/participation", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    await prisma.profile.upsert({ where: { id: user.id }, update: {}, create: { id: user.id } });
    const [roles, volunteer] = await Promise.all([
      prisma.profileRole.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
      prisma.volunteerProfile.findUnique({ where: { userId: user.id } }),
    ]);

    return {
      data: {
        roles: roles.map((item) => item.role),
        volunteer: volunteer
          ? {
              ...volunteer,
              participation: strings(volunteer.participation),
              skills: strings(volunteer.skills),
            }
          : null,
      },
    };
  });

  app.put("/v1/me/roles", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = z.object({ roles: z.array(roleSchema).max(6) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid participation roles" } });

    await prisma.profile.upsert({ where: { id: user.id }, update: {}, create: { id: user.id } });
    const protector = await prisma.protector.findUnique({ where: { userId: user.id }, select: { id: true } });
    const roles = Array.from(new Set([...parsed.data.roles, ...(protector ? ["PROTECTOR" as const] : [])]));

    await prisma.$transaction(async (tx) => {
      await tx.profileRole.deleteMany({ where: { userId: user.id } });
      if (roles.length) {
        await tx.profileRole.createMany({ data: roles.map((role) => ({ userId: user.id, role })) });
      }
      if (!roles.includes("VOLUNTEER")) {
        await tx.volunteerProfile.updateMany({ where: { userId: user.id }, data: { isActive: false } });
      }
    });

    return { data: { roles } };
  });

  const volunteerSchema = z.object({
    country: countrySchema.nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    region: z.string().trim().max(120).nullable().optional(),
    availability: z.string().trim().max(240).nullable().optional(),
    participation: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    skills: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    radiusKm: z.number().int().min(0).max(500).nullable().optional(),
    notes: z.string().trim().max(3000).nullable().optional(),
    isActive: z.boolean().default(true),
  });

  app.put("/v1/me/volunteer", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = volunteerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid volunteer profile" } });

    await prisma.profile.upsert({ where: { id: user.id }, update: {}, create: { id: user.id } });
    const volunteer = await prisma.$transaction(async (tx) => {
      await tx.profileRole.upsert({
        where: { userId_role: { userId: user.id, role: "VOLUNTEER" } },
        update: {},
        create: { userId: user.id, role: "VOLUNTEER" },
      });
      return tx.volunteerProfile.upsert({
        where: { userId: user.id },
        update: parsed.data,
        create: { userId: user.id, ...parsed.data },
      });
    });

    return {
      data: {
        ...volunteer,
        participation: strings(volunteer.participation),
        skills: strings(volunteer.skills),
      },
    };
  });

  app.get("/v1/protectors/:slug/social-links", async (req, reply) => {
    const params = z.object({ slug: z.string().min(2).max(120) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_SLUG", message: "Invalid protector slug" } });

    const protector = await prisma.protector.findFirst({
      where: { slug: params.data.slug, isPublic: true, status: "ACTIVE" },
      select: { socialLinks: true },
    });
    if (!protector) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Protector not found" } });
    return { data: publicSocialLinks(protector.socialLinks) };
  });
}
