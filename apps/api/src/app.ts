import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@agentos/db";
import { createProviderRegistry, type ProviderRegistry, type SecretsProvider } from "@agentos/providers";
import { AgentEngine, InProcessWorkflowEngine } from "@agentos/runtime";
import { createDefaultToolRegistry, type ToolRegistry } from "@agentos/tools";
import { registerAuth } from "./auth/plugin";
import type { Config } from "./config";
import { EventBus, PrismaEventSink } from "./events/bus";
import { registerErrorHandler } from "./http/errors";
import { agentRoutes } from "./routes/agents";
import { approvalRoutes } from "./routes/approvals";
import { authRoutes } from "./routes/auth";
import { conversationRoutes } from "./routes/conversations";
import { settingsRoutes } from "./routes/settings";
import { taskRoutes } from "./routes/tasks";
import { PrismaRunStore } from "./store/prismaStore";
import { ModelDiscoveryService } from "./providers/discovery";

/** Log fields that could carry credentials. Pino replaces them with "[Redacted]". */
export const LOG_REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "*.apiKey",
  "*.api_key",
  "*.authorization",
  "err.headers",
  "err.request",
  "err.config",
];

export interface AppDeps {
  prisma: PrismaClient;
  config: Config;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  bus: EventBus;
  sink: PrismaEventSink;
  store: PrismaRunStore;
  engine: AgentEngine;
  workflow: InProcessWorkflowEngine;
  discovery: ModelDiscoveryService;
}

export interface BuildOptions {
  prisma: PrismaClient;
  config: Config;
  secrets?: SecretsProvider;
  providers?: ProviderRegistry;
  logger?: boolean | object;
  engineOverrides?: { retryBaseDelayMs?: number; providerTimeoutMs?: number };
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const { prisma, config } = opts;
  const app = Fastify({
    logger: opts.logger ?? { level: config.LOG_LEVEL, redact: LOG_REDACT_PATHS },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  const providers =
    opts.providers ??
    createProviderRegistry({
      secrets: opts.secrets,
      enableMock: config.AGENTOS_ENABLE_MOCK_PROVIDER,
      catalogJson: config.AGENTOS_MODEL_CATALOG_JSON,
      endpoints: {
        openai: config.AGENTOS_OPENAI_BASE_URL,
        anthropic: config.AGENTOS_ANTHROPIC_BASE_URL,
        xai: config.AGENTOS_XAI_BASE_URL,
      },
    });
  const tools = createDefaultToolRegistry();
  const bus = new EventBus();
  const store = new PrismaRunStore(prisma);
  const sink = new PrismaEventSink(prisma, bus);
  const engine = new AgentEngine({
    store,
    events: sink,
    providers,
    tools,
    logger: app.log,
    retryBaseDelayMs: opts.engineOverrides?.retryBaseDelayMs,
    providerTimeoutMs: opts.engineOverrides?.providerTimeoutMs ?? config.PROVIDER_TIMEOUT_MS,
    providerRetries: config.PROVIDER_MAX_RETRIES,
  });
  const workflow = new InProcessWorkflowEngine(engine, store, sink, app.log);
  const discovery = new ModelDiscoveryService(providers);
  const deps: AppDeps = { prisma, config, providers, tools, bus, sink, store, engine, workflow, discovery };

  registerErrorHandler(app);
  await app.register(cookie);
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "idempotency-key", "last-event-id"],
  });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.cookies?.agentos_session?.slice(0, 16) ?? req.ip,
  });
  registerAuth(app, prisma);

  app.get("/health", { config: { public: true } }, async () => ({ ok: true }));

  await app.register(
    async (api) => {
      await authRoutes(api, deps);
      await agentRoutes(api, deps);
      await taskRoutes(api, deps);
      await conversationRoutes(api, deps);
      await approvalRoutes(api, deps);
      await settingsRoutes(api, deps);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onClose", async () => {
    await workflow.idle();
  });

  return { app, deps };
}

/**
 * On boot, runs left `running`/`queued` by a previous process cannot continue
 * (execution is in-process in M1). Mark them failed/interrupted so they are
 * retryable. Runs waiting for approval are durable and stay as they are.
 */
export async function recoverInterruptedTasks(prisma: PrismaClient): Promise<number> {
  const now = new Date();
  const stuck = await prisma.task.findMany({ where: { status: { in: ["running", "queued"] } }, select: { id: true } });
  if (stuck.length === 0) return 0;
  const ids = stuck.map((t) => t.id);
  await prisma.agentRun.updateMany({
    where: { taskId: { in: ids }, status: "running" },
    data: { status: "failed", failureCode: "interrupted", failureMessage: "API restarted during the run", completedAt: now },
  });
  await prisma.task.updateMany({
    where: { id: { in: ids } },
    data: { status: "failed", failureCode: "interrupted", failureMessage: "API restarted during the run", completedAt: now },
  });
  return ids.length;
}
