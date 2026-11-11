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
import { metrics } from "@agentos/platform";
import { budgetStats } from "@agentos/runtime";
import { TemporalWorkflowEngine, temporalConfigFrom } from "@agentos/workflows";
import { timingSafeEqual } from "node:crypto";
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
  /** Process lifecycle: draining flips readiness to 503; open SSE streams are closed on shutdown. */
  lifecycle: Lifecycle;
}

export class Lifecycle {
  draining = false;
  readonly streams = new Set<() => void>();
  /** End every open SSE stream (clients reconnect to another instance with their cursor). */
  closeStreams() {
    for (const close of [...this.streams]) close();
  }
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

  const rt = await createRuntime({
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
      connection: temporalConfigFrom(config),
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      workflowRunTimeoutMs: config.AGENTOS_WORKFLOW_RUN_TIMEOUT_MS || undefined,
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
      workflowOptions: {
        heartbeatTimeoutMs: config.AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS,
        // Only non-default values go into new histories; defaults match milestone 2B.
        ...(config.AGENTOS_STEP_TIMEOUT_MS !== 15 * 60_000 ? { stepTimeoutMs: config.AGENTOS_STEP_TIMEOUT_MS } : {}),
        ...(config.AGENTOS_STEP_MAX_ATTEMPTS !== 5 ? { stepMaxAttempts: config.AGENTOS_STEP_MAX_ATTEMPTS } : {}),
      },
    });
    workflow = temporal;
  } else {
    workflow = new InProcessWorkflowEngine(engine, store, sink, app.log);
  }

  const listener = opts.listen === false ? null : new PgEventListener(config.DATABASE_URL, prisma, bus, app.log, { reconcileMs: config.EVENT_RECONCILE_MS });
  if (listener) await listener.start();

  const discovery = new ModelDiscoveryService(providers, credentials);
  const lifecycle = new Lifecycle();
  const deps: AppDeps = { prisma, config, providers, tools, bus, sink, store, engine, workflow, temporal, listener, credentials, discovery, lifecycle };

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

  /** Liveness: the process is serving. Restart if this fails. Never touches dependencies. */
  app.get("/livez", { config: { public: true, rateLimit: false } }, async () => ({ ok: true }));

  /**
   * Readiness: route traffic here only when every dependency answers. Unauthenticated, so
   * it reports booleans only; details go to the log.
   */
  app.get("/readyz", { config: { public: true, rateLimit: false } }, async (_req, reply) => {
    const r = await readiness(deps);
    if (!r.ok) app.log.warn({ event: "not_ready", checks: r.details }, "readiness check failed");
    return reply.code(r.ok ? 200 : 503).send({ ok: r.ok, draining: lifecycle.draining, checks: r.checks });
  });

  /** Prometheus metrics for operators. Disabled unless AGENTOS_METRICS_TOKEN is set. */
  app.get("/metrics", { config: { public: true, rateLimit: false } }, async (req, reply) => {
    const token = config.AGENTOS_METRICS_TOKEN;
    if (!token) return reply.code(404).send({ error: { code: "not_found", message: "Metrics are disabled" } });
    const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const want = Buffer.from(token);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: { code: "unauthenticated", message: "Bad metrics token" } });
    metrics.set("agentos_sse_connections", {}, lifecycle.streams.size);
    metrics.set("agentos_process_draining", { service: "api" }, lifecycle.draining ? 1 : 0);
    const body = metrics.render([
      { name: "agentos_event_listener_connected", help: "1 when the LISTEN connection is up.", value: listener?.connected ? 1 : 0 },
      { name: "agentos_event_listener_passes_total", help: "Completed reconciliation passes.", value: listener?.passes ?? 0 },
      { name: "agentos_budget_stops_total", help: "Runs stopped by a spending limit in this process.", value: budgetStats.exceeded },
      { name: "agentos_possible_duplicate_billing_events_total", help: "Possible duplicate provider billing detected in this process.", value: budgetStats.possibleDuplicates },
    ]);
    return reply.type("text/plain; version=0.0.4").send(body);
  });

  app.addHook("onResponse", async (req, reply) => {
    metrics.inc("agentos_http_requests_total", { route: req.routeOptions.url ?? "unmatched", method: req.method, status: `${Math.floor(reply.statusCode / 100)}xx` });
  });

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

  app.addHook("preClose", async () => {
    // Open SSE responses are hijacked, so Fastify cannot close them itself.
    lifecycle.closeStreams();
  });

  app.addHook("onClose", async () => {
    if (dispatcher) clearInterval(dispatcher);
    credentials.clearCache();
    await workflow.idle?.();
    await listener?.close();
    await workflow.close?.();
  });

  return { app, deps };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/** Dependency checks behind /readyz. */
export async function readiness(deps: Pick<AppDeps, "prisma" | "temporal" | "listener" | "credentials" | "lifecycle">) {
  const checks: Record<string, boolean> = {};
  const details: Record<string, string> = {};
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await withTimeout(fn(), 3_000);
      checks[name] = true;
    } catch (err) {
      checks[name] = false;
      details[name] = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }
  };
  await Promise.all([
    run("database", () => deps.prisma.$queryRaw`SELECT 1`),
    deps.temporal ? run("temporal", () => deps.temporal!.ping()) : Promise.resolve(),
    deps.listener
      ? run("eventListener", async () => {
          if (!deps.listener!.connected) throw new Error("LISTEN connection is down");
        })
      : Promise.resolve(),
    deps.credentials.enabled
      ? run("kms", async () => {
          const r = await deps.credentials.selfTest();
          if (r && !r.ok) throw new Error(r.error);
        })
      : Promise.resolve(),
  ]);
  const ok = !deps.lifecycle.draining && Object.values(checks).every(Boolean);
  return { ok, checks, details };
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
