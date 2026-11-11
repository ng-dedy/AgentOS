/**
 * Re-wrap every stored provider credential under the KMS's active key-encryption key.
 *
 *   1. Add the new KEK and make it active:  AGENTOS_DEV_KMS_KEYS="old:...,new:..."  (last one is active,
 *      or set AGENTOS_DEV_KMS_ACTIVE_KEY=new)
 *   2. Restart API and workers with that configuration (they can still read old wraps).
 *   3. Run: pnpm --filter @agentos/api credentials:rotate
 *   4. Once it reports 0 remaining, remove the old KEK from the configuration.
 *
 * Ciphertexts are not touched (only data-key wraps change), so this is safe while tasks run.
 */
import { createPrismaClient } from "@agentos/db";
import { CredentialService, createKms } from "@agentos/platform";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const kms = createKms(process.env);
if (!kms) throw new Error("No KMS configured (AGENTOS_DEV_KMS_KEYS)");
const prisma = createPrismaClient(url);
try {
  const service = new CredentialService(prisma, kms, { allowDeploymentKeys: false });
  const { rewrapped, activeKeyId } = await service.rotate();
  const remaining = await prisma.providerCredential.count({ where: { kekId: { not: activeKeyId } } });
  console.log(JSON.stringify({ activeKeyId, rewrapped, remaining }));
  if (remaining > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
