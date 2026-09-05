import "dotenv/config";
import crypto from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { registerCoreRoutes } from "./core-routes.js";
import { registerIdentityRoutes } from "./identity-routes.js";
import { registerGrowthRoutes } from "./growth-routes.js";
import { registerGrowthConversionRoutes } from "./growth-conversion-routes.js";
import { registerCauseRoutes } from "./cause-routes.js";

const prisma = new PrismaClient();
const app = Fastify({ logger: true, trustProxy: true });

const origins = (process.env.CORS_ORIGINS ?? "https://mypets.lat,https://www.mypets.lat")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

await app.register(helmet, { global: true });
await app.register(cors, {
  origin(origin, cb) {
    if (!origin || origins.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed"), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
});
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

function tags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const publicDemoContent = process.env.PUBLIC_DEMO_CONTENT === "true";

app.get("/", async () => ({
  service: "mypets-api",
  status: "ok",
  version: process.env.APP_VERSION ?? "0.5.0",
}));

app.get("/health", async (_req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", database: "ok" };
  } catch (error) {
    app.log.error(error);
    return reply.code(503).send({ status: "degraded", database: "error" });
  }
});

app.get("/v1/health", async (_req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { data: { status: "ok", database: "ok" } };
  } catch (error) {
    app.log.error(error);
    return reply.code(503).send({ error: { code: "DB_UNAVAILABLE", message: "Database unavailable" } });
  }
});

app.get("/v1/stories", async () => {
  const rows = await prisma.story.findMany({
    where: { active: true, ...(publicDemoContent ? {} : { isDemo: false }) },
    orderBy: { sortOrder: "asc" },
    take: 50,
  });

  return {
    data: rows.map((story) => ({
      id: story.id,
      slug: story.slug,
      kind: story.kind,
      name: story.name,
      location: story.location,
      country: story.country,
      currency: story.currency,
      descPtPT: story.descPtPT,
      descPtBR: story.descPtBR,
      descEn: story.descEn,
      image: story.image,
      imageAlt: story.imageAlt,
      tags: tags(story.tags),
      targetCents: story.targetCents,
      raisedCents: story.raisedCents,
      progress: story.targetCents > 0 ? Math.min(100, Math.round((story.raisedCents / story.targetCents) * 100)) : 0,
      isDemo: story.isDemo,
    })),
  };
});

app.get("/v1/impact/public", async () => {
  const rows = await prisma.impactMetric.findMany({
    where: publicDemoContent ? {} : { isDemo: false },
    orderBy: { sortOrder: "asc" },
  });
  return { data: rows };
});

app.get("/v1/config", async () => ({
  data: {
    brand: "mypets",
    environment: process.env.APP_ENV ?? "production",
    paymentsLive: process.env.PAYMENTS_LIVE === "true",
    payoutsEnabled: process.env.PAYOUTS_ENABLED === "true",
    authEnabled: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)),
    growthEnabled: true,
    causesEnabled: true,
  },
}));

const newsletterSchema = z.object({
  email: z.string().email(),
  locale: z.enum(["pt-PT", "pt-BR", "en"]).default("pt-PT"),
  consent: z.literal(true),
});

app.post("/v1/newsletter", async (req, reply) => {
  const parsed = newsletterSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid newsletter request" } });

  const row = await prisma.newsletterSubscriber.upsert({
    where: { email: parsed.data.email.toLowerCase() },
    update: { locale: parsed.data.locale, consent: true },
    create: { email: parsed.data.email.toLowerCase(), locale: parsed.data.locale, consent: true },
  });

  return reply.code(201).send({ data: { id: row.id } });
});

const contributionSchema = z.object({
  targetType: z.enum(["ANIMAL", "PROTECTOR", "NETWORK", "GUARDIANS"]),
  storyId: z.string().uuid().nullable().optional(),
  amountCents: z.number().int().min(100),
  currency: z.enum(["EUR", "BRL"]),
  frequency: z.enum(["ONE_TIME", "MONTHLY"]),
  donorName: z.string().trim().max(120).nullable().optional(),
  donorEmail: z.string().email().nullable().optional(),
});

app.post("/v1/contributions/intents", async (req, reply) => {
  if (process.env.PAYMENTS_LIVE !== "true") {
    return reply.code(409).send({ error: { code: "PAYMENTS_NOT_LIVE", message: "Online contributions are not active yet" } });
  }

  const parsed = contributionSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid contribution request" } });

  const story = parsed.data.storyId ? await prisma.story.findUnique({ where: { id: parsed.data.storyId } }) : null;
  if (parsed.data.storyId && !story) {
    return reply.code(404).send({ error: { code: "STORY_NOT_FOUND", message: "Story not found" } });
  }

  const idempotencyKey = String(req.headers["idempotency-key"] ?? crypto.randomUUID());
  const targetLabel = story?.name ?? (parsed.data.targetType === "GUARDIANS" ? "MyPets Guardians" : "MyPets");
  const row = await prisma.contribution.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      storyId: parsed.data.storyId ?? null,
      targetType: parsed.data.targetType,
      targetLabel,
      amountCents: parsed.data.amountCents,
      currency: parsed.data.currency,
      frequency: parsed.data.frequency,
      donorName: parsed.data.donorName ?? null,
      donorEmail: parsed.data.donorEmail?.toLowerCase() ?? null,
      provider: process.env.PAYMENT_PROVIDER ?? "mock",
      status: "PENDING",
      idempotencyKey,
      isDemo: false,
    },
  });

  return reply.code(201).send({ data: row });
});

app.post("/v1/contributions/:id/confirm", async (req, reply) => {
  if (process.env.PAYMENTS_LIVE !== "true") {
    return reply.code(409).send({ error: { code: "PAYMENTS_NOT_LIVE", message: "Online contributions are not active yet" } });
  }

  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid contribution id" } });
  if ((process.env.PAYMENT_PROVIDER ?? "mock") === "mock") {
    return reply.code(409).send({ error: { code: "LIVE_PROVIDER_REQUIRED", message: "A live payment provider is required" } });
  }

  return reply.code(409).send({ error: { code: "WEBHOOK_CONFIRM_REQUIRED", message: "Payment confirmation is handled by the provider webhook" } });
});

const reportSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  entityUrl: z.string().trim().max(500).nullable().optional(),
  email: z.string().email().nullable().optional(),
});

app.post("/v1/reports", async (req, reply) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Invalid report" } });

  const row = await prisma.report.create({
    data: {
      reason: parsed.data.reason,
      entityUrl: parsed.data.entityUrl ?? null,
      email: parsed.data.email?.toLowerCase() ?? null,
    },
  });

  return reply.code(201).send({ data: { id: row.id, status: row.status } });
});

await registerCoreRoutes(app, prisma);
await registerIdentityRoutes(app, prisma);
await registerGrowthRoutes(app, prisma);
await registerGrowthConversionRoutes(app, prisma);
await registerCauseRoutes(app, prisma);

app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  if (!reply.sent) reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
});

const port = Number(process.env.PORT ?? 8081);
const host = process.env.HOST ?? "0.0.0.0";
await app.listen({ port, host });
