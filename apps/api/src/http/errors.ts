import type { FastifyError, FastifyInstance } from "fastify";
import type { z } from "zod";

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);
export const conflict = (msg: string) => new AppError(409, "conflict", msg);
export const forbidden = (msg = "Forbidden") => new AppError(403, "forbidden", msg);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(
      400,
      "validation_error",
      "Request validation failed",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

/** Errors never include stack traces or upstream messages. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const fe = err as FastifyError;
    if (fe.statusCode === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests" } });
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? "bad_request", message: fe.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "Route not found" } }));
}
