import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export { PrismaClient, Prisma } from "../generated/prisma/client";
export type * from "../generated/prisma/models";

/** Create a Prisma client backed by the node-postgres driver adapter. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
