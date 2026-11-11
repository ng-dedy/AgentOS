import { createPrismaClient } from "@agentos/db";
import { buildApp, recoverInterruptedTasks } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const { app } = await buildApp({ prisma, config });

const recovered = await recoverInterruptedTasks(prisma);
if (recovered > 0) app.log.warn({ recovered }, "marked interrupted tasks as failed (retryable)");
if (config.AGENTOS_ENABLE_MOCK_PROVIDER) app.log.warn("MOCK provider is enabled: it is a scripted test double, not an AI model");

await app.listen({ port: config.API_PORT, host: config.API_HOST });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => prisma.$disconnect()).then(() => process.exit(0));
  });
}
