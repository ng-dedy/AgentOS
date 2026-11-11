import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@agentos/db";
import type { Config } from "../config";
import { AppError } from "../http/errors";
import { newSessionToken, sha256 } from "./password";

export const SESSION_COOKIE = "agentos_session";

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: "owner" | "member";
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export function registerAuth(app: FastifyInstance, prisma: PrismaClient) {
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS") return;
    if (req.routeOptions.config?.public) return;
    if (!req.routeOptions.url) return; // unknown route → 404 handler
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new AppError(401, "unauthenticated", "Sign in required");
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { memberships: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new AppError(401, "unauthenticated", "Session expired");
    }
    const membership = session.user.memberships.find((m) => m.organizationId === session.organizationId);
    if (!membership) throw new AppError(401, "unauthenticated", "No access to this workspace");
    req.auth = {
      userId: session.userId,
      organizationId: session.organizationId,
      role: membership.role === "owner" ? "owner" : "member",
      sessionId: session.id,
    };
  });
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new AppError(401, "unauthenticated", "Sign in required");
  return req.auth;
}

export function requireOwner(req: FastifyRequest): AuthContext {
  const auth = requireAuth(req);
  if (auth.role !== "owner") throw new AppError(403, "forbidden", "Only workspace owners can do this");
  return auth;
}

export async function startSession(
  prisma: PrismaClient,
  config: Config,
  reply: FastifyReply,
  userId: string,
  organizationId: string,
): Promise<void> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, organizationId, expiresAt } });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.SESSION_COOKIE_SECURE,
    path: "/",
    expires: expiresAt,
  });
}
