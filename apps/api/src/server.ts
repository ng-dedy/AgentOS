import { createPrismaClient } from "@agentos/db";
import { assertSafeConfiguration, UnsafeConfigurationError } from "@agentos/platform";
import { TemporalConnectionError } from "@agentos/workflows";
import { buildApp, dispatchPending, recoverInterruptedTasks } from "./app";
import { loadConfig } from "./config";

function refuse(err: unknown): never {
  if (err instanceof UnsafeConfigurationError || err instanceof TemporalConnectionError || (err instanceof Error && err.name.startsWith("Kms"))) {
    process.stderr.write(`${JSON.stringify({ level: 60, event: "startup_refused", msg: err.message })}\n${err.message}\n`);
  } else {
    process.stderr.write(`API failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exit(1);
}

// Refuse an unsafe production configuration before touching anything else.
let report;
try {
  report = assertSafeConfiguration(process.env, "api");
} catch (err) {
  refuse(err);
}
const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const { app, deps } = await buildApp({ prisma, config }).catch(refuse);
for (const w of report.warnings) app.log.warn({ event: "config_warning" }, w);

if (config.AGENTOS_WORKFLOW_ENGINE === "inprocess") {
  const recovered = await recoverInterruptedTasks(prisma);
  if (recovered > 0) app.log.warn({ recovered }, "marked interrupted tasks as failed (retryable)");
} else {
  const started = await dispatchPending(deps, 0);
  app.log.info({ engine: "temporal", taskQueue: config.TEMPORAL_TASK_QUEUE, dispatched: started }, "durable execution enabled; tasks run on worker processes");
}
if (config.AGENTOS_ENABLE_MOCK_PROVIDER) app.log.warn("MOCK provider is enabled: it is a scripted test double, not an AI model");
if (deps.credentials.kmsDevelopmentOnly) app.log.warn("credential encryption uses the development-only local KMS; configure a managed KMS for production");
app.log.info({ event: "api_started", env: config.AGENTOS_ENV, engine: config.AGENTOS_WORKFLOW_ENGINE, kms: deps.credentials.kmsName }, "API started");

await app.listen({ port: config.API_PORT, host: config.API_HOST });

/**
 * Graceful shutdown: report not-ready first so the load balancer stops sending traffic,
 * wait for the drain period, then close (SSE streams end; clients resume elsewhere from
 * their cursor), with a hard deadline in case something hangs.
 */
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    deps.lifecycle.draining = true;
    app.log.info({ event: "api_draining", signal, drainMs: config.SHUTDOWN_DRAIN_MS, openStreams: deps.lifecycle.streams.size }, "draining");
    setTimeout(() => {
      app.log.error({ event: "api_shutdown_forced", afterMs: config.SHUTDOWN_FORCE_MS }, "shutdown deadline passed; exiting");
      process.exit(1);
    }, config.SHUTDOWN_FORCE_MS).unref();
    void new Promise((r) => setTimeout(r, config.SHUTDOWN_DRAIN_MS))
      .then(() => app.close())
      .then(() => prisma.$disconnect())
      .then(() => {
        app.log.info({ event: "api_stopped" }, "stopped");
        process.exit(0);
      });
  });
}
