import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { contextString, type KeyManagementService, type KmsContext } from "./kms";

/**
 * Envelope encryption with standard primitives only (Node `crypto`, AES-256-GCM).
 * The KMS generates a fresh 256-bit data key for each secret and wraps it; the data key
 * encrypts the secret locally and is zeroed straight after. The context is bound twice:
 * as the KMS encryption context (the KMS refuses a mismatched unwrap) and as the AES-GCM
 * AAD (a mismatched decrypt fails authentication), so a row moved to another org fails.
 */
export interface Envelope {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  wrappedKey: Uint8Array<ArrayBuffer>;
  kekId: string;
}

/** Copy into a plain ArrayBuffer-backed array (the shape Prisma `Bytes` columns use). */
const own = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export async function sealSecret(kms: KeyManagementService, plaintext: string, context: KmsContext): Promise<Envelope> {
  const { plaintext: dataKey, wrapped, keyId } = await kms.generateDataKey(context);
  try {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", dataKey, iv);
    c.setAAD(Buffer.from(contextString(context), "utf8"));
    const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return { ciphertext: own(ciphertext), iv: own(iv), authTag: own(c.getAuthTag()), wrappedKey: own(wrapped), kekId: keyId };
  } finally {
    dataKey.fill(0);
  }
}

export async function openSecret(kms: KeyManagementService, env: Envelope, context: KmsContext): Promise<string> {
  const dataKey = await kms.unwrap(Buffer.from(env.wrappedKey), env.kekId, context);
  try {
    const d = createDecipheriv("aes-256-gcm", dataKey, env.iv);
    d.setAAD(Buffer.from(contextString(context), "utf8"));
    d.setAuthTag(env.authTag);
    return Buffer.concat([d.update(env.ciphertext), d.final()]).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/** Re-wrap the data key under the KMS's active key. The ciphertext is unchanged. */
export async function rewrapSecret(kms: KeyManagementService, env: Envelope, context: KmsContext): Promise<Pick<Envelope, "wrappedKey" | "kekId">> {
  const dataKey = await kms.unwrap(Buffer.from(env.wrappedKey), env.kekId, context);
  try {
    const { wrapped, keyId } = await kms.wrap(dataKey, context);
    return { wrappedKey: own(wrapped), kekId: keyId };
  } finally {
    dataKey.fill(0);
  }
}
