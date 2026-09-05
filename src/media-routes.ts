import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const BUCKET = "pet-media";
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function publicStorageUrl(bucket: string, path: string) {
  const base = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("SUPABASE_URL is required for media URLs");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encoded}`;
}

function extension(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function mediaDto(row: {
  id: string;
  petId: string;
  mediaType: string;
  storageBucket: string | null;
  storagePath: string | null;
  externalUrl: string | null;
  provenance: string;
  caption: string | null;
  sortOrder: number;
  isPublic: boolean;
  createdAt: Date;
}) {
  const publicUrl = row.storageBucket && row.storagePath
    ? publicStorageUrl(row.storageBucket, row.storagePath)
    : row.externalUrl;
  return {
    id: row.id,
    petId: row.petId,
    mediaType: row.mediaType,
    storageBucket: row.storageBucket,
    storagePath: row.storagePath,
    externalUrl: row.externalUrl,
    publicUrl,
    provenance: row.provenance,
    caption: row.caption,
    sortOrder: row.sortOrder,
    isPublic: row.isPublic,
    createdAt: row.createdAt,
  };
}

async function ownedPet(prisma: PrismaClient, petId: string, userId: string) {
  return prisma.pet.findFirst({
    where: { id: petId, protector: { userId } },
    select: { id: true, facepetsId: true, primaryImage: true },
  });
}

export async function registerMediaRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/v1/me/pets/:id/media", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid pet id" } });

    const pet = await ownedPet(prisma, params.data.id, user.id);
    if (!pet) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });

    const rows = await prisma.petMedia.findMany({ where: { petId: pet.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return { data: rows.map(mediaDto) };
  });

  app.get("/v1/pets/:facepetsId/media", async (req, reply) => {
    const params = z.object({ facepetsId: z.string().min(8).max(30) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid FacePets ID" } });

    const pet = await prisma.pet.findFirst({
      where: { facepetsId: params.data.facepetsId.toUpperCase(), isPublic: true },
      select: { id: true },
    });
    if (!pet) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });
    const rows = await prisma.petMedia.findMany({
      where: { petId: pet.id, isPublic: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return { data: rows.map(mediaDto) };
  });

  const registerSchema = z.object({
    storageBucket: z.literal(BUCKET),
    storagePath: z.string().trim().min(10).max(700),
    caption: z.string().trim().max(500).nullable().optional(),
    provenance: z.enum(["REAL_CASE", "AI_GENERATED", "LICENSED_STOCK"]).default("REAL_CASE"),
    sortOrder: z.number().int().min(0).max(1000).default(0),
    isPublic: z.boolean().default(true),
    makePrimary: z.boolean().default(false),
  });

  app.post("/v1/pets/:id/media", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = registerSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid media registration" } });

    const pet = await ownedPet(prisma, params.data.id, user.id);
    if (!pet) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });

    const expectedPrefix = `${user.id}/${pet.id}/`;
    if (!body.data.storagePath.startsWith(expectedPrefix) || !ALLOWED_EXTENSIONS.has(extension(body.data.storagePath))) {
      return reply.code(400).send({ error: { code: "INVALID_STORAGE_PATH", message: "Media path is not allowed" } });
    }

    const publicUrl = publicStorageUrl(BUCKET, body.data.storagePath);
    const row = await prisma.$transaction(async (tx) => {
      const media = await tx.petMedia.create({
        data: {
          petId: pet.id,
          mediaType: "IMAGE",
          storageBucket: BUCKET,
          storagePath: body.data.storagePath,
          provenance: body.data.provenance,
          caption: body.data.caption ?? null,
          sortOrder: body.data.sortOrder,
          isPublic: body.data.isPublic,
        },
      });
      if (body.data.makePrimary || !pet.primaryImage) {
        await tx.pet.update({ where: { id: pet.id }, data: { primaryImage: publicUrl } });
      }
      return media;
    });

    return reply.code(201).send({ data: mediaDto(row) });
  });

  const patchSchema = z.object({
    caption: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    isPublic: z.boolean().optional(),
    makePrimary: z.boolean().optional(),
  });

  app.patch("/v1/pets/:id/media/:mediaId", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid(), mediaId: z.string().uuid() }).safeParse(req.params);
    const body = patchSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid media update" } });

    const pet = await ownedPet(prisma, params.data.id, user.id);
    if (!pet) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });
    const existing = await prisma.petMedia.findFirst({ where: { id: params.data.mediaId, petId: pet.id } });
    if (!existing) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Media not found" } });

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.petMedia.update({
        where: { id: existing.id },
        data: {
          caption: body.data.caption,
          sortOrder: body.data.sortOrder,
          isPublic: body.data.isPublic,
        },
      });
      if (body.data.makePrimary && updated.storageBucket && updated.storagePath) {
        await tx.pet.update({ where: { id: pet.id }, data: { primaryImage: publicStorageUrl(updated.storageBucket, updated.storagePath) } });
      }
      return updated;
    });
    return { data: mediaDto(row) };
  });

  app.delete("/v1/pets/:id/media/:mediaId", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const params = z.object({ id: z.string().uuid(), mediaId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid media id" } });

    const pet = await ownedPet(prisma, params.data.id, user.id);
    if (!pet) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Pet not found" } });
    const media = await prisma.petMedia.findFirst({ where: { id: params.data.mediaId, petId: pet.id } });
    if (!media) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Media not found" } });

    await prisma.$transaction(async (tx) => {
      await tx.petMedia.delete({ where: { id: media.id } });
      if (media.storageBucket && media.storagePath && pet.primaryImage === publicStorageUrl(media.storageBucket, media.storagePath)) {
        const next = await tx.petMedia.findFirst({ where: { petId: pet.id, id: { not: media.id }, isPublic: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
        await tx.pet.update({ where: { id: pet.id }, data: { primaryImage: next?.storageBucket && next.storagePath ? publicStorageUrl(next.storageBucket, next.storagePath) : null } });
      }
    });

    return reply.code(200).send({ data: { storageBucket: media.storageBucket, storagePath: media.storagePath } });
  });
}
