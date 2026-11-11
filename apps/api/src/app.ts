import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@agentos/db";
import {
  createRuntime,
  PgEventListener,
  type CredentialService,
  type EventBus,
  type KeyManagementService,
  type PrismaEventSink,
  type PrismaRunStore,
} from "@agentos/platform";
import type { ProviderRegistry, SecretsProvider } from "@agentos/providers";
import { InProcessWorkflowEngine, type AgentEngine, type WorkflowEngine } from "@agentos/runtime";
import type { ToolRegistry } from "@agentos/tools";
import { TemporalWorkflowEngine } from "@agentos/workflows";
import { registerAuth } from "./auth/plugin";
import type { Config } from "./config";
import { registerErrorHandler } from "./http/errors";
import { agentRoutes } from "./routes/agents";
import { approvalRoutes } from "./routes/approvals";
import { authRoutes } from "./routes/auth";
import { conversationRoutes } from "./routes/conversations";
import { settingsRoutes } from "./routes/settings";
import { taskRoutes } from "./routes/tasks";
import { systemRoutes } from "./routes/system";
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
  workflow: WorkflowEngine;
  /** Set in temporal mode, for health and inspection. */
  temporal: TemporalWorkflowEngine | null;
  listener: PgEventListener | null;
  credentials: CredentialService;
  discovery: ModelDiscoveryService;
}

export interface BuildOptions {
  prisma: PrismaClient;
  config: Config;
  secrets?: SecretsProvider;
  providers?: ProviderRegistry;
  logger?: boolean | object;
  engineOverrides?: { retryBaseDelayMs?: number; providerTimeoutMs?: number };
  /** KMS override (tests). Undefined = from env. */
  kms?: KeyManagementService | null;
  env?: NodeJS.ProcessEnv;
  /** Cross-instance event fan-out via LISTEN/NOTIFY. Default true. */
  listen?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const { prisma, config } = opts;
  const app = Fastify({
    logger: opts.logger ?? { level: config.LOG_LEVEL, redact: LOG_REDACT_PATHS },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  const rt = createRuntime({
    prisma,
    config,
    logger: app.log,
    secrets: opts.secrets,
    providers: opts.providers,
    kms: opts.kms,
    env: opts.env,
    engineOverrides: opts.engineOverrides,
  });
  const { providers, tools, bus, sink, store, engine, credentials } = rt;

  let temporal: TemporalWorkflowEngine | null = null;
  let workflow: WorkflowEngine;
  if (config.AGENTOS_WORKFLOW_ENGINE === "temporal") {
    temporal = await TemporalWorkflowEngine.connect({
      address: config.TEMPORAL_ADDRESS,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      store,
      recordWorkflowId: async (orgId, taskId, workflowId) => {
        await prisma.task.updateMany({ where: { id: taskId, organizationId: orgId, workflowId: null }, data: { workflowId } });
      },
      finalizeCancel: async (orgId, taskId) => {
        await engine.cancelTask(orgId, taskId);
        const t = await store.getTask(orgId, taskId);
        if (t?.parentTaskId) await rt.pipelines.advance(orgId, t.parentTaskId);
      },
      logger: app.log,
      workflowOptions: { heartbeatTimeoutMs: config.AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS },
    });
    workflow = temporal;
  } else {
    workflow = new InProcessWorkflowEngine(engine, store, sink, app.log);
  }

  const listener = opts.listen === false ? null : new PgEventListener(config.DATABASE_URL, prisma, bus, app.log);
  if (listener) await listener.start();

  const discovery = new ModelDiscoveryService(providers, credentials);
  const deps: AppDeps = { prisma, config, providers, tools, bus, sink, store, engine, workflow, temporal, listener, credentials, discovery };

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
      await systemRoutes(api, deps);
    },
    { prefix: "/api/v1" },
  );

  // Durable mode: start workflows for top-level tasks that have none yet (for example
  // the workflow service was unreachable when the task was created). Idempotent.
  let dispatcher: NodeJS.Timeout | null = null;
  if (temporal && config.DISPATCH_RECONCILE_MS > 0) {
    dispatcher = setInterval(() => void dispatchPending(deps).catch((err: unknown) => app.log.warn({ err }, "dispatch reconcile failed")), config.DISPATCH_RECONCILE_MS);
    dispatcher.unref();
  }

  app.addHook("onClose", async () => {
    if (dispatcher) clearInterval(dispatcher);
    await workflow.idle?.();
    await listener?.close();
    await workflow.close?.();
  });

  return { app, deps };
}

/** Start workflows for top-level tasks that are not terminal and have no workflow id. */
export async function dispatchPending(deps: Pick<AppDeps, "prisma" | "workflow">, olderThanMs = 5_000): Promise<number> {
  const rows = await deps.prisma.task.findMany({
    where: { parentTaskId: null, workflowId: null, status: { in: ["queued", "running", "awaiting_approval"] }, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
    select: { id: true, organizationId: true },
    take: 100,
  });
  for (const t of rows) await deps.workflow.start(t.organizationId, t.id);
  return rows.length;
}

/**
 * In-process mode only. On boot, runs left `running`/`queued` by a previous
 * process cannot continue, so they are marked failed/interrupted (retryable).
 * Runs waiting for approval stay as they are. In temporal mode this is never
 * called: workflows survive API restarts.
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
