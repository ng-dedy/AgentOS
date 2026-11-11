import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Key-management seam for envelope encryption. AgentOS never stores a key-encryption
 * key (KEK) next to the data: it asks the KMS to wrap and unwrap per-credential data keys.
 *
 * Production implementations map 1:1 onto managed services:
 * - AWS KMS: `Encrypt` / `Decrypt` with `EncryptionContext = { aad: context }`
 * - GCP Cloud KMS: `encrypt` / `decrypt` with `additionalAuthenticatedData = context`
 * - HashiCorp Vault Transit: `transit/encrypt/:key` / `transit/decrypt/:key` with `context`
 * None of these was reachable from the build environment, so only `LocalDevKms` is verified.
 */
export interface KeyManagementService {
  /** Short label shown in diagnostics, e.g. "local-dev" or "aws-kms". */
  readonly name: string;
  /** True for implementations that must never protect production data. */
  readonly developmentOnly: boolean;
  /** Key id used for new wraps. Rotation = change the active key, then re-wrap. */
  activeKeyId(): string;
  /** Wrap a data key. `context` is bound as additional authenticated data. */
  wrap(dataKey: Buffer, context: string): Promise<{ wrapped: Buffer; keyId: string }>;
  /** Unwrap a data key; fails if the key id, context or ciphertext do not match. */
  unwrap(wrapped: Buffer, keyId: string, context: string): Promise<Buffer>;
}

export class KmsConfigError extends Error {}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * DEVELOPMENT ONLY. Wraps data keys with AES-256-GCM under KEKs supplied in the
 * `AGENTOS_DEV_KMS_KEYS` environment variable (`id:base64key,id:base64key`).
 * The KEKs live in process memory and in the environment, which is exactly what a
 * managed KMS exists to avoid. It refuses to start with NODE_ENV=production unless
 * `AGENTOS_DEV_KMS_ALLOW_PRODUCTION=true` is set deliberately.
 */
export class LocalDevKms implements KeyManagementService {
  readonly name = "local-dev";
  readonly developmentOnly = true;
  private readonly keys = new Map<string, Buffer>();
  private readonly active: string;

  constructor(spec: string, opts: { activeKeyId?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = opts.env ?? process.env;
    if (env.NODE_ENV === "production" && env.AGENTOS_DEV_KMS_ALLOW_PRODUCTION !== "true") {
      throw new KmsConfigError("LocalDevKms is for development only. Configure a managed KMS for production.");
    }
    for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
      const i = part.indexOf(":");
      const id = part.slice(0, i);
      const key = Buffer.from(part.slice(i + 1), "base64");
      if (i < 1 || !KEY_ID.test(id)) throw new KmsConfigError("AGENTOS_DEV_KMS_KEYS entries must look like id:base64key");
      if (key.length !== 32) throw new KmsConfigError(`Dev KMS key '${id}' must be 32 bytes (openssl rand -base64 32)`);
      this.keys.set(id, key);
    }
    if (this.keys.size === 0) throw new KmsConfigError("AGENTOS_DEV_KMS_KEYS is empty");
    this.active = opts.activeKeyId ?? [...this.keys.keys()].at(-1)!;
    if (!this.keys.has(this.active)) throw new KmsConfigError(`Active dev KMS key '${this.active}' is not configured`);
  }

  activeKeyId(): string {
    return this.active;
  }

  async wrap(dataKey: Buffer, context: string) {
    const kek = this.keys.get(this.active)!;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", kek, iv);
    c.setAAD(Buffer.from(`${this.active}|${context}`, "utf8"));
    const ct = Buffer.concat([c.update(dataKey), c.final()]);
    return { wrapped: Buffer.concat([iv, c.getAuthTag(), ct]), keyId: this.active };
  }

  async unwrap(wrapped: Buffer, keyId: string, context: string) {
    const kek = this.keys.get(keyId);
    if (!kek) throw new KmsConfigError(`Dev KMS key '${keyId}' is not configured (was it removed before re-wrapping?)`);
    const d = createDecipheriv("aes-256-gcm", kek, wrapped.subarray(0, 12));
    d.setAAD(Buffer.from(`${keyId}|${context}`, "utf8"));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

/** Build the configured KMS, or null when credential storage is not configured. */
export function createKms(env: NodeJS.ProcessEnv = process.env): KeyManagementService | null {
  const spec = env.AGENTOS_DEV_KMS_KEYS;
  if (!spec) return null;
  return new LocalDevKms(spec, { activeKeyId: env.AGENTOS_DEV_KMS_ACTIVE_KEY || undefined, env });
}
