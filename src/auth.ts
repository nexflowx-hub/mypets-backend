import type { FastifyReply, FastifyRequest } from "fastify";

export type AuthUser = {
  id: string;
  email: string | null;
};

function authConfig() {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  return { url, key };
}

export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  const { url, key } = authConfig();
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required for protected API routes");
  }

  const response = await fetch(`${url}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) return null;
  const user = (await response.json()) as { id?: unknown; email?: unknown };
  if (typeof user.id !== "string") return null;

  return {
    id: user.id,
    email: typeof user.email === "string" ? user.email : null,
  };
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
    return null;
  }

  const token = header.slice(7).trim();
  if (!token) {
    reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
    return null;
  }

  const user = await verifyAccessToken(token);
  if (!user) {
    reply.code(401).send({ error: { code: "INVALID_SESSION", message: "Session is invalid or expired" } });
    return null;
  }

  return user;
}
