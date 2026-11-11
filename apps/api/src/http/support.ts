import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Prisma, type PrismaClient } from "@agentos/db";
import { jsonSafe } from "@agentos/platform";
import { AppError } from "./errors";

export async function audit(
  prisma: PrismaClient,
  organizationId: string,
  actor: { type: "user" | "system"; id?: string | null },
  action: string,
  target?: { type: string; id: string },
  metadata?: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      organizationId,
      actorType: actor.type,
      actorId: actor.id ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      metadata: metadata ? jsonSafe(metadata) : Prisma.DbNull,
    },
  });
}

/**
 * Idempotency for side-effecting POSTs. With an `Idempotency-Key` header the
 * first response is stored; a retry with the same body gets the same response,
 * a retry with a different body gets 409.
 */
export async function idempotent<T>(
  prisma: PrismaClient,
  req: FastifyRequest,
  reply: FastifyReply,
  orgId: string,
  route: string,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<T> {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) {
    const r = await handler();
    reply.status(r.status);
    return r.body;
  }
  if (key.length > 200) throw new AppError(400, "validation_error", "Idempotency-Key too long");
  const requestHash = createHash("sha256").update(JSON.stringify(req.body ?? null)).update(req.url).digest("hex");
  const where = { organizationId_route_key: { organizationId: orgId, route, key } };
  const existing = await prisma.idempotencyKey.findUnique({ where });
  if (existing) {
    if (existing.requestHash !== requestHash) throw new AppError(409, "idempotency_conflict", "Idempotency-Key reused with a different request");
    reply.header("idempotent-replay", "true");
    reply.status(existing.statusCode);
    return existing.response as T;
  }
  const r = await handler();
  try {
    await prisma.idempotencyKey.create({
      data: { organizationId: orgId, route, key, requestHash, statusCode: r.status, response: jsonSafe(r.body) },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
  reply.status(r.status);
  return r.body;
}

export const money = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d));
