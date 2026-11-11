import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import pino from "pino";
import { createPrismaClient } from "@agentos/db";
import { assertSafeConfiguration, createRuntime, metrics, RuntimeConfigSchema, UnsafeConfigurationError } from "@agentos/platform";
import { activityStats, createActivities, createAgentWorker, describeConnection, temporalConfigFrom, TemporalConnectionError } from "@agentos/workflows";
import { WorkerHeartbeat } from "./heartbeat";

/**
 * Dedicated execution process. Hosts the Temporal workflows and the activities
 * that call model providers and run tools. The API never does either in
 * temporal mode, so restarting the API cannot interrupt a run.
 */
const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "agentos-worker" },
  // Same rule as the API: anything that could carry a credential is redacted.
  redact: ["*.apiKey", "*.api_key", "*.authorization", "err.headers", "err.request", "err.config"],
});

function fatal(err: unknown): never {
  if (err instanceof UnsafeConfigurationError || err instanceof TemporalConnectionError) {
    logger.fatal({ event: "startup_refused", reason: err.message }, err.message);
    // Also to stderr unformatted, so it is readable in a crash loop.
    process.stderr.write(`${err.message}\n`);
  } else {
    logger.fatal({ event: "startup_failed", err: err instanceof Error ? err.message : String(err) }, "worker failed to start");
  }
  process.exit(1);
}

let report;
try {
  report = assertSafeConfiguration(process.env, "worker");
} catch (err) {
  fatal(err);
}
for (const w of report.warnings) logger.warn({ event: "config_warning" }, w);

const config = RuntimeConfigSchema.parse(process.env);
const env = process.env;
const workerId = env.AGENTOS_WORKER_ID || `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const prisma = createPrismaClient(config.DATABASE_URL);
const rt = await createRuntime({ prisma, config, logger, crossProcessEvents: true }).catch(fatal);
if (rt.credentials.kmsDevelopmentOnly) logger.warn("credential encryption uses the development-only local KMS");
if (config.AGENTOS_ENABLE_MOCK_PROVIDER) logger.warn("MOCK provider is enabled: it is a scripted test double, not an AI model");

const temporalConnection = temporalConfigFrom(config);
const versioning = env.TEMPORAL_WORKER_VERSIONING === "true";
const buildId = env.TEMPORAL_WORKER_BUILD_ID || env.npm_package_version || "0.1.0";
const activities = createActivities({ engine: rt.engine, pipelines: rt.pipelines, events: rt.sink, logger });
const { worker, connection } = await createAgentWorker({
  connection: temporalConnection,
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  activities,
  identity: workerId,
  maxConcurrentActivityTaskExecutions: Number(env.WORKER_MAX_CONCURRENT_ACTIVITIES ?? 20),
  maxConcurrentWorkflowTaskExecutions: env.WORKER_MAX_CONCURRENT_WORKFLOW_TASKS ? Number(env.WORKER_MAX_CONCURRENT_WORKFLOW_TASKS) : undefined,
  // In-flight activities get this long to finish after SIGTERM before Temporal retries them elsewhere.
  shutdownGraceTime: Number(env.WORKER_SHUTDOWN_GRACE_MS ?? 30_000),
  workflowBundlePath: env.TEMPORAL_WORKFLOW_BUNDLE_PATH || undefined,
  deployment: {
    enabled: versioning,
    deploymentName: env.TEMPORAL_WORKER_DEPLOYMENT_NAME || "agentos-worker",
    buildId,
    defaultBehavior: env.TEMPORAL_WORKER_DEFAULT_VERSIONING === "AUTO_UPGRADE" ? "AUTO_UPGRADE" : "PINNED",
  },
  logger,
}).catch(fatal);

const heartbeat = new WorkerHeartbeat(prisma, workerId, config.TEMPORAL_TASK_QUEUE, buildId, (err) =>
  logger.warn({ event: "heartbeat_failed", err: err instanceof Error ? err.message : String(err) }, "heartbeat write failed"),
);
await heartbeat.start();
logger.info(
  { event: "worker_started", workerId, taskQueue: config.TEMPORAL_TASK_QUEUE, temporal: describeConnection(temporalConnection), buildId, versioning, kms: rt.credentials.kmsName },
  "worker started",
);

let draining = false;

async function dbOk(): Promise<boolean> {
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2_000))]);
    return true;
  } catch {
    return false;
  }
}

function tokenOk(header: string | undefined): boolean {
  const token = env.AGENTOS_METRICS_TOKEN;
  if (!token) return true;
  const got = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Probes for the process supervisor (Kubernetes, ECS, systemd):
 *   /livez   the process is up and the worker has not failed (restart if not)
 *   /readyz  polling Temporal, database reachable, not draining
 *   /health  milestone 2B compatibility (same as readyz without the DB check)
 *   /metrics Prometheus text (bearer AGENTOS_METRICS_TOKEN when set)
 */
const healthPort = Number(env.WORKER_HEALTH_PORT ?? 0);
const health = healthPort
  ? createServer((req, res) => {
      void (async () => {
        const state = worker.getState();
        const send = (code: number, body: unknown, type = "application/json") => {
          res.writeHead(code, { "content-type": type });
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        const url = req.url ?? "";
        if (url === "/livez") return send(state === "FAILED" ? 503 : 200, { ok: state !== "FAILED", state });
        if (url === "/health") {
          const ok = state === "RUNNING" && !draining;
          return send(ok ? 200 : 503, { ok, state, workerId, activeActivities: activityStats.active, draining });
        }
        if (url === "/readyz") {
          const db = await dbOk();
          const ok = state === "RUNNING" && !draining && db;
          return send(ok ? 200 : 503, { ok, state, draining, database: db, workerId, buildId, activeActivities: activityStats.active });
        }
        if (url === "/metrics") {
          if (!tokenOk(req.headers.authorization)) return send(401, { error: "unauthorized" });
          metrics.set("agentos_worker_active_activities", {}, activityStats.active);
          metrics.set("agentos_process_draining", { service: "worker" }, draining ? 1 : 0);
          return send(
            200,
            metrics.render([
              { name: "agentos_worker_activities_started_total", help: "Activities started by this worker.", value: activityStats.started },
              { name: "agentos_worker_activities_retried_total", help: "Activities that ran as a retry.", value: activityStats.retried },
              { name: "agentos_worker_activities_failed_total", help: "Activities that threw.", value: activityStats.failed },
            ]),
            "text/plain; version=0.0.4",
          );
        }
        send(404, { error: "not found" });
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    }).listen(healthPort, env.WORKER_HEALTH_HOST || "127.0.0.1")
  : null;

const forceMs = Number(env.WORKER_SHUTDOWN_FORCE_MS ?? 60_000);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (draining) return;
    draining = true;
    logger.info({ event: "worker_stopping", signal, activeActivities: activityStats.active }, "worker draining: no new tasks, finishing in-flight steps");
    // Tell the API right away that this worker is going (its health view and diagnostics).
    void heartbeat.markStopping();
    worker.shutdown();
    // If draining hangs (a stuck activity ignoring cancellation), exit anyway: Temporal
    // retries the step on another worker after the heartbeat timeout, and every step is idempotent.
    setTimeout(() => {
      logger.error({ event: "worker_shutdown_forced", afterMs: forceMs, activeActivities: activityStats.active }, "shutdown deadline passed; exiting");
      process.exit(1);
    }, forceMs).unref();
  });
}

try {
  // run() resolves after shutdown() has drained in-flight tasks.
  await worker.run();
} finally {
  health?.close();
  await heartbeat.stop();
  rt.credentials.clearCache();
  await rt.sink.flush();
  await connection.close();
  await prisma.$disconnect();
  logger.info({ event: "worker_stopped", workerId }, "worker stopped");
}
