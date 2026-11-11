import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyManagementService } from "./kms";

/**
 * Envelope encryption with standard primitives only (Node `crypto`, AES-256-GCM).
 * A fresh random 256-bit data key encrypts each secret; the KMS wraps the data key.
 * `aad` binds the ciphertext to its owner so a row moved to another org fails to decrypt.
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

export async function sealSecret(kms: KeyManagementService, plaintext: string, aad: string): Promise<Envelope> {
  const dataKey = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", dataKey, iv);
    c.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const { wrapped, keyId } = await kms.wrap(dataKey, aad);
    return { ciphertext: own(ciphertext), iv: own(iv), authTag: own(c.getAuthTag()), wrappedKey: own(wrapped), kekId: keyId };
  } finally {
    dataKey.fill(0);
  }
}

export async function openSecret(kms: KeyManagementService, env: Envelope, aad: string): Promise<string> {
  const dataKey = await kms.unwrap(Buffer.from(env.wrappedKey), env.kekId, aad);
  try {
    const d = createDecipheriv("aes-256-gcm", dataKey, env.iv);
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(env.authTag);
    return Buffer.concat([d.update(env.ciphertext), d.final()]).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/** Re-wrap the data key under the KMS's active key. The ciphertext is unchanged. */
export async function rewrapSecret(kms: KeyManagementService, env: Envelope, aad: string): Promise<Pick<Envelope, "wrappedKey" | "kekId">> {
  const dataKey = await kms.unwrap(Buffer.from(env.wrappedKey), env.kekId, aad);
  try {
    const { wrapped, keyId } = await kms.wrap(dataKey, aad);
    return { wrappedKey: own(wrapped), kekId: keyId };
  } finally {
    dataKey.fill(0);
  }
}
