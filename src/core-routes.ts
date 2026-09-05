import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth, type AuthUser } from "./auth.js";

const countrySchema = z.enum(["PT", "BR"]);
const localeSchema = z.enum(["pt-PT", "pt-BR", "en"]);
const petStatusSchema = z.enum(["RESCUED", "TREATMENT", "RECOVERED", "ADOPTABLE", "ADOPTED"]);
const needTypeSchema = z.enum([
  "FOOD",
  "MEDICATION",
  "VET",
  "TRANSPORT",
  "FOSTER",
  "STERILIZATION",
  "SUPPLIES",
  "ADOPTION",
  "VOLUNTEER",
  "OTHER",
]);

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52) || "perfil";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function ensureProfile(prisma: PrismaClient, user: AuthUser) {
  return prisma.profile.upsert({
    where: { id: user.id },
    update: {},
    create: { id: user.id },
  });
}

async function nextFacePetsId(prisma: PrismaClient, country: "PT" | "BR") {
  const rows = country === "PT"
    ? await prisma.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('mypets_private.facepets_pt_seq') AS value`
    : await prisma.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('mypets_private.facepets_br_seq') AS value`;

  const value = Number(rows[0]?.value ?? 0n);
  if (!value) throw new Error("Unable to allocate FacePets ID");
  return `FP-${country}-${String(value).padStart(8, "0")}`;
}

function publicPet(pet: {
  id: string;
  facepetsId: string;
  slug: string;
  name: string;
  species: string;
  sex: string;
  country: string;
  city: string | null;
  rescueDate: Date | null;
  status: string;
  story: string | null;
  primaryImage: string | null;
  createdAt: Date;
}) {
  return {
    id: pet.id,
    facepetsId: pet.facepetsId,
    slug: pet.slug,
    name: pet.name,
    species: pet.species,
    sex: pet.sex,
    country: pet.country,
    city: pet.city,
    rescueDate: pet.rescueDate,
    status: pet.status,
    story: pet.story,
    primaryImage: pet.primaryImage,
    createdAt: pet.createdAt,
  };
}

function publicNeed(need: {
  id: string;
  protectorId: string;
  petId: string | null;
  type: string;
  title: string;
  description: string | null;
  supportMode: string;
  targetAmountCents: number | null;
  raisedAmountCents: number;
  currency: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: need.id,
    protectorId: need.protectorId,
    petId: need.petId,
    type: need.type,
    title: need.title,
    description: need.description,
    supportMode: need.supportMode,
    targetAmountCents: need.targetAmountCents,
    raisedAmountCents: need.raisedAmountCents,
    currency: need.currency,
    status: need.status,
    createdAt: need.createdAt,
    updatedAt: need.updatedAt,
  };
}

export async function registerCoreRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/me", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    await ensureProfile(prisma, user);

    const profile = await prisma.profile.findUnique({
      where: { id: user.id },
      include: {
        protector: {
          include: {
            pets: { orderBy: { createdAt: "desc" } },
            needs: { orderBy: { createdAt: "desc" } },
          },
        },
        offers: { orderBy: { createdAt: "desc" }, take: 25 },
      },
    });

    return { data: { ...profile, email: user.email } };
  });

  const profileSchema = z.object({
    displayName: z.string().trim().min(2).max(120).nullable().optional(),
    locale: localeSchema.optional(),
    country: countrySchema.nullable().optional(),
    avatarUrl: z.string().url().max(1000).nullable().optional(),
  });

  app.put("/v1/me", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid profile" } });

    await ensureProfile(prisma, user);
    const profile = await prisma.profile.update({ where: { id: user.id }, data: parsed.data });
    return { data: { ...profile, email: user.email } };
  });

  const protectorCreateSchema = z.object({
    displayName: z.string().trim().min(2).max(120),
    country: countrySchema,
    city: z.string().trim().min(2).max(120),
    region: z.string().trim().max(120).nullable().optional(),
    bio: z.string().trim().max(3000).nullable().optional(),
    yearsActive: z.number().int().min(0).max(100).default(0),
    animalsCurrent: z.number().int().min(0).max(10000).default(0),
    activityTypes: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    socialLinks: z.record(z.string(), z.string().max(500)).default({}),
  });

  app.post("/v1/protectors", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = protectorCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid protector profile" } });

    await ensureProfile(prisma, user);
    const existing = await prisma.protector.findUnique({ where: { userId: user.id } });
    if (existing) return reply.code(409).send({ error: { code: "PROTECTOR_EXISTS", message: "Protector profile already exists" }, data: existing });

    const slug = `${slugify(parsed.data.displayName)}-${parsed.data.country.toLowerCase()}-${user.id.slice(0, 6)}`;
    const protector = await prisma.$transaction(async (tx) => {
      await tx.profile.update({
        where: { id: user.id },
        data: { displayName: parsed.data.displayName, country: parsed.data.country },
      });
      return tx.protector.create({ data: { userId: user.id, slug, ...parsed.data } });
    });

    return reply.code(201).send({ data: protector });
  });

  app.get("/v1/protectors/:slug", async (req, reply) => {
    const params = z.object({ slug: z.string().min(2).max(120) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_SLUG", message: "Invalid protector slug" } });

    const protector = await prisma.protector.findFirst({
      where: { slug: params.data.slug, isPublic: true, status: "ACTIVE" },
      include: {
        pets: { where: { isPublic: true }, orderBy: { createdAt: "desc" } },
        needs: { where: { isPublic: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!protector) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Protector not found" } });

    return {
      data: {
        id: protector.id,
        slug: protector.slug,
        displayName: protector.displayName,
        country: protector.country,
        city: protector.city,
        region: protector.region,
        bio: protector.bio,
        yearsActive: protector.yearsActive,
        animalsCurrent: protector.animalsCurrent,
        activityTypes: strings(protector.activityTypes),
        verification: protector.verification,
        pets: protector.pets.map(publicPet),
        needs: protector.needs.map(publicNeed),
      },
    };
  });

  const protectorPatchSchema = protectorCreateSchema.partial().omit({ country: true }).extend({
    country: countrySchema.optional(),
    isPublic: z.boolean().optional(),
  });

  app.patch("/v1/protectors/:id", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const parsed = protectorPatchSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid protector update" } });

    const protector = await prisma.protector.findUnique({ where: { id: params.data.id } });
    if (!protector || protector.userId !== user.id) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Protector not found" } });
    return { data: await prisma.protector.update({ where: { id: protector.id }, data: parsed.data }) };
  });

  const petCreateSchema = z.object({
    name: z.string().trim().min(1).max(120),
    species: z.enum(["DOG", "CAT", "OTHER"]),
    sex: z.enum(["MALE", "FEMALE", "UNKNOWN"]).default("UNKNOWN"),
    country: countrySchema,
    city: z.string().trim().max(120).nullable().optional(),
    rescueDate: z.coerce.date().nullable().optional(),
    status: petStatusSchema.default("RESCUED"),
    story: z.string().trim().max(5000).nullable().optional(),
    primaryImage: z.string().url().max(1000).nullable().optional(),
  });

  app.post("/v1/pets", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = petCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid pet" } });

    const protector = await prisma.protector.findUnique({ where: { userId: user.id } });
    if (!protector) return reply.code(409).send({ error: { code: "PROTECTOR_REQUIRED", message: "Create a protector profile first" } });

    const facepetsId = await nextFacePetsId(prisma, parsed.data.country);
    const slug = `${slugify(parsed.data.name)}-${facepetsId.toLowerCase()}`;
    const pet = await prisma.pet.create({
      data: { protectorId: protector.id, facepetsId, slug, ...parsed.data },
    });
    return reply.code(201).send({ data: publicPet(pet) });
  });

  app.get("/v1/pets/:facepetsId", async (req, reply) => {
    const params = z.object({ facepetsId: z.string().min(8).max(30) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid FacePets ID" } });

    const pet = await prisma.pet.findFirst({
      where: { facepetsId: params.data.facepetsId.toUpperCase(), isPublic: true },
      include: {
        protector: true,
        updates: { where: { isPublic: true }, orderBy: { createdAt: "desc" }, take: 50 },
        needs: { where: { isPublic: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!pet) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });

    return {
      data: {
        ...publicPet(pet),
        protector: {
          id: pet.protector.id,
          slug: pet.protector.slug,
          displayName: pet.protector.displayName,
          verification: pet.protector.verification,
        },
        updates: pet.updates,
        needs: pet.needs.map(publicNeed),
      },
    };
  });

  app.patch("/v1/pets/:id", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const parsed = petCreateSchema.partial().safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid pet update" } });

    const pet = await prisma.pet.findUnique({ where: { id: params.data.id }, include: { protector: true } });
    if (!pet || pet.protector.userId !== user.id) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });
    const updated = await prisma.pet.update({ where: { id: pet.id }, data: parsed.data });
    return { data: publicPet(updated) };
  });

  const updateSchema = z.object({
    title: z.string().trim().max(160).nullable().optional(),
    body: z.string().trim().min(2).max(5000),
    statusAfter: petStatusSchema.nullable().optional(),
    isPublic: z.boolean().default(true),
  });

  app.post("/v1/pets/:id/updates", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const parsed = updateSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid update" } });

    const pet = await prisma.pet.findUnique({ where: { id: params.data.id }, include: { protector: true } });
    if (!pet || pet.protector.userId !== user.id) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });

    const row = await prisma.$transaction(async (tx) => {
      if (parsed.data.statusAfter) await tx.pet.update({ where: { id: pet.id }, data: { status: parsed.data.statusAfter } });
      return tx.petUpdate.create({ data: { petId: pet.id, authorUserId: user.id, ...parsed.data } });
    });
    return reply.code(201).send({ data: row });
  });

  const needCreateSchema = z.object({
    petId: z.string().uuid().nullable().optional(),
    type: needTypeSchema,
    title: z.string().trim().min(2).max(180),
    description: z.string().trim().max(5000).nullable().optional(),
    supportMode: z.enum(["FINANCIAL", "NON_FINANCIAL", "BOTH"]).default("BOTH"),
    targetAmountCents: z.number().int().min(100).nullable().optional(),
    currency: z.enum(["EUR", "BRL"]).nullable().optional(),
    status: z.enum(["OPEN", "FUNDED", "RESOLVED", "CANCELLED"]).default("OPEN"),
    isPublic: z.boolean().default(true),
  }).superRefine((value, ctx) => {
    if (value.supportMode !== "NON_FINANCIAL" && (!value.targetAmountCents || !value.currency)) {
      ctx.addIssue({ code: "custom", message: "Financial needs require targetAmountCents and currency" });
    }
  });

  app.post("/v1/needs", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const parsed = needCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid need" } });

    const protector = await prisma.protector.findUnique({ where: { userId: user.id } });
    if (!protector) return reply.code(409).send({ error: { code: "PROTECTOR_REQUIRED", message: "Create a protector profile first" } });

    if (parsed.data.petId) {
      const pet = await prisma.pet.findUnique({ where: { id: parsed.data.petId } });
      if (!pet || pet.protectorId !== protector.id) return reply.code(400).send({ error: { code: "INVALID_PET", message: "Pet does not belong to protector" } });
    }

    const need = await prisma.need.create({ data: { protectorId: protector.id, ...parsed.data } });
    return reply.code(201).send({ data: publicNeed(need) });
  });

  app.get("/v1/needs", async (req, reply) => {
    const parsed = z.object({
      country: countrySchema.optional(),
      type: needTypeSchema.optional(),
      status: z.enum(["OPEN", "FUNDED", "RESOLVED", "CANCELLED"]).default("OPEN"),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "Invalid need query" } });

    const rows = await prisma.need.findMany({
      where: {
        isPublic: true,
        status: parsed.data.status,
        type: parsed.data.type,
        protector: parsed.data.country ? { country: parsed.data.country } : undefined,
      },
      include: { pet: true, protector: true },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
    });

    return {
      data: rows.map((need) => ({
        ...publicNeed(need),
        pet: need.pet ? { id: need.pet.id, facepetsId: need.pet.facepetsId, name: need.pet.name } : null,
        protector: { id: need.protector.id, slug: need.protector.slug, displayName: need.protector.displayName, city: need.protector.city, country: need.protector.country },
      })),
    };
  });

  app.get("/v1/needs/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid need id" } });
    const need = await prisma.need.findFirst({ where: { id: params.data.id, isPublic: true }, include: { pet: true, protector: true } });
    if (!need) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Need not found" } });
    return { data: { ...publicNeed(need), pet: need.pet ? publicPet(need.pet) : null, protector: need.protector } };
  });

  app.patch("/v1/needs/:id", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const parsed = needCreateSchema.partial().safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid need update" } });

    const need = await prisma.need.findUnique({ where: { id: params.data.id }, include: { protector: true } });
    if (!need || need.protector.userId !== user.id) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Need not found" } });
    const updated = await prisma.need.update({ where: { id: need.id }, data: parsed.data });
    return { data: publicNeed(updated) };
  });

  const offerSchema = z.object({
    kind: needTypeSchema,
    message: z.string().trim().max(2000).nullable().optional(),
  });

  app.post("/v1/needs/:id/offers", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const parsed = offerSchema.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid support offer" } });
    await ensureProfile(prisma, user);

    const need = await prisma.need.findFirst({ where: { id: params.data.id, isPublic: true, status: "OPEN" } });
    if (!need) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Need not found" } });

    const offer = await prisma.supportOffer.create({ data: { needId: need.id, userId: user.id, ...parsed.data } });
    return reply.code(201).send({ data: offer });
  });
}
