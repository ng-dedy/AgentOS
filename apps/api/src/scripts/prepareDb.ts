/**
 * Prepare a disposable database for end-to-end tests:
 *   create it if missing → apply migrations → truncate all tables.
 * Refuses to run against a database whose name does not end in _e2e or _test.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createPrismaClient } from "@agentos/db";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const parsed = new URL(url);
const dbName = parsed.pathname.slice(1);
if (!/_(e2e|test)$/.test(dbName)) throw new Error(`Refusing to reset '${dbName}': name must end in _e2e or _test`);
if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error("Unexpected database name");

const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const admin = createPrismaClient(adminUrl.toString());
const exists = await admin.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`);
if (exists.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
await admin.$disconnect();

const dbPkg = path.resolve(import.meta.dirname, "../../../../packages/db");
execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd: dbPkg, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });

const prisma = createPrismaClient(url);
const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`,
);
await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
await prisma.$disconnect();
console.log(`Prepared ${dbName}`);
