import { createPrismaClient } from "@agentos/db";
import { buildApp, dispatchPending, recoverInterruptedTasks } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const { app, deps } = await buildApp({ prisma, config });

if (config.AGENTOS_WORKFLOW_ENGINE === "inprocess") {
  const recovered = await recoverInterruptedTasks(prisma);
  if (recovered > 0) app.log.warn({ recovered }, "marked interrupted tasks as failed (retryable)");
} else {
  const started = await dispatchPending(deps, 0);
  app.log.info({ engine: "temporal", taskQueue: config.TEMPORAL_TASK_QUEUE, dispatched: started }, "durable execution enabled; tasks run on worker processes");
}
if (config.AGENTOS_ENABLE_MOCK_PROVIDER) app.log.warn("MOCK provider is enabled: it is a scripted test double, not an AI model");
if (deps.credentials.kmsDevelopmentOnly) app.log.warn("credential encryption uses the development-only local KMS; configure a managed KMS for production");

await app.listen({ port: config.API_PORT, host: config.API_HOST });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => prisma.$disconnect()).then(() => process.exit(0));
  });
}
