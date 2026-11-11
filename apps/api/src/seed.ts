import { createPrismaClient } from "@agentos/db";
import { loadConfig } from "./config";
import { seed } from "./seedData";

const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const result = await seed(prisma);
console.log(`Seeded demo workspace. Sign in with ${result.email} / ${result.password}`);
await prisma.$disconnect();
