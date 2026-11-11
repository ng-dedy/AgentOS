import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pino from "pino";
import { createPrismaClient } from "@agentos/db";
import { createRuntime, RuntimeConfigSchema } from "@agentos/platform";
import { createActivities, createAgentWorker } from "@agentos/workflows";
import { WorkerHeartbeat } from "./heartbeat";

/**
 * Dedicated execution process. Hosts the Temporal workflows and the activities
 * that call model providers and run tools. The API never does either in
 * temporal mode, so restarting the API cannot interrupt a run.
 */
const config = RuntimeConfigSchema.parse(process.env);
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "agentos-worker" },
  // Same rule as the API: anything that could carry a credential is redacted.
  redact: ["*.apiKey", "*.api_key", "*.authorization", "err.headers", "err.request", "err.config"],
});

const workerId = process.env.AGENTOS_WORKER_ID || `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const prisma = createPrismaClient(config.DATABASE_URL);
const rt = createRuntime({ prisma, config, logger, crossProcessEvents: true });
if (rt.credentials.kmsDevelopmentOnly) logger.warn("credential encryption uses the development-only local KMS");
if (config.AGENTOS_ENABLE_MOCK_PROVIDER) logger.warn("MOCK provider is enabled: it is a scripted test double, not an AI model");

const activities = createActivities({ engine: rt.engine, pipelines: rt.pipelines, events: rt.sink, logger });
const { worker, connection } = await createAgentWorker({
  address: config.TEMPORAL_ADDRESS,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  activities,
  identity: workerId,
  maxConcurrentActivityTaskExecutions: Number(process.env.WORKER_MAX_CONCURRENT_ACTIVITIES ?? 20),
});

const heartbeat = new WorkerHeartbeat(prisma, workerId, config.TEMPORAL_TASK_QUEUE, process.env.npm_package_version ?? "0.1.0", (err) =>
  logger.warn({ event: "heartbeat_failed", err: err instanceof Error ? err.message : String(err) }, "heartbeat write failed"),
);
await heartbeat.start();
logger.info({ event: "worker_started", workerId, taskQueue: config.TEMPORAL_TASK_QUEUE, temporal: config.TEMPORAL_ADDRESS }, "worker started");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: "worker_stopping", signal }, "worker stopping");
    worker.shutdown();
  });
}

try {
  await worker.run();
} finally {
  await heartbeat.stop();
  await rt.sink.flush();
  await connection.close();
  await prisma.$disconnect();
  logger.info({ event: "worker_stopped", workerId }, "worker stopped");
}
