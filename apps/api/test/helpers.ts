import type { FastifyInstance } from "fastify";
import { createPrismaClient, type PrismaClient } from "@agentos/db";
import type { KeyManagementService } from "@agentos/platform";
import type { ProviderRegistry, SecretsProvider } from "@agentos/providers";
import { buildApp, type AppDeps } from "../src/app";
import { ConfigSchema } from "../src/config";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agentos_test";

let prisma: PrismaClient | undefined;
export function db(): PrismaClient {
  prisma ??= createPrismaClient(TEST_DB);
  return prisma;
}

export async function resetDb() {
  const tables = await db().$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`,
  );
  await db().$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

export async function makeApp(
  overrides: Record<string, string> = {},
  secrets?: SecretsProvider,
  extra: { kms?: KeyManagementService | null; providers?: ProviderRegistry; listen?: boolean } = {},
): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const config = ConfigSchema.parse({
    DATABASE_URL: TEST_DB,
    AGENTOS_ENABLE_MOCK_PROVIDER: "true",
    WEB_ORIGIN: "http://localhost:3000",
    LOG_LEVEL: "silent",
    ...overrides,
  });
  return buildApp({
    prisma: db(),
    config,
    logger: false,
    secrets: secrets ?? { get: () => undefined },
    engineOverrides: { retryBaseDelayMs: 0 },
    kms: extra.kms === undefined ? null : extra.kms,
    providers: extra.providers,
    listen: extra.listen,
  });
}

export interface Session {
  cookie: string;
  orgId: string;
  userId: string;
}

let n = 0;
export async function signup(app: FastifyInstance, org = "Acme"): Promise<Session> {
  n++;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email: `user${n}_${Date.now()}@example.com`, password: "correct horse battery", name: `User ${n}`, organizationName: org },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "agentos_session");
  const body = res.json() as { user: { id: string }; organization: { id: string } };
  return { cookie: `agentos_session=${cookie!.value}`, orgId: body.organization.id, userId: body.user.id };
}

export function api(app: FastifyInstance, s: Session) {
  const call = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie: s.cookie, ...headers } });
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null, headers: res.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, payload?: unknown, headers?: Record<string, string>) => call("POST", url, payload ?? {}, headers),
    patch: (url: string, payload: unknown) => call("PATCH", url, payload),
    put: (url: string, payload: unknown) => call("PUT", url, payload),
  };
}

export const atlasBody = (over: Record<string, unknown> = {}) => ({
  name: "Atlas",
  role: "Analyst that verifies numbers with tools",
  instructions: "Use the calculator for arithmetic.",
  provider: "mock",
  model: "mock-scripted",
  allowedTools: ["calculator", "current_datetime"],
  maxIterations: 6,
  maxRunCostUsd: 1,
  ...over,
});
