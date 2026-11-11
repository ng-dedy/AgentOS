import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { metrics } from "../observability/metrics";

/**
 * What a data key is bound to. Every field is part of the KMS encryption context (AWS),
 * or of the additional authenticated data (dev KMS), so a wrapped key copied to another
 * organization's row, provider or credential id cannot be unwrapped.
 */
export interface KmsContext {
  organizationId: string;
  provider: string;
  credentialId: string;
  purpose: "provider-credential" | "kms-self-test";
}

/**
 * The string form of a context. It is also the AES-GCM AAD of the credential ciphertext.
 * The format is frozen: credentials written by milestone 2B used exactly this string.
 */
export function contextString(c: KmsContext): string {
  return c.purpose === "provider-credential"
    ? `agentos-credential|v1|${c.organizationId}|${c.provider}|${c.credentialId}`
    : `agentos-${c.purpose}|v1|${c.organizationId}|${c.provider}|${c.credentialId}`;
}

/** AWS KMS encryption context (string map; usable in IAM conditions as kms:EncryptionContext:<key>). */
export function encryptionContext(c: KmsContext): Record<string, string> {
  return { scheme: "agentos-envelope-v1", purpose: c.purpose, organizationId: c.organizationId, provider: c.provider, credentialId: c.credentialId };
}

/**
 * Key-management seam for envelope encryption. AgentOS never stores a key-encryption
 * key (KEK) next to the data: the KMS generates and wraps per-credential data keys.
 */
export interface KeyManagementService {
  /** Short label shown in diagnostics, e.g. "local-dev" or "aws-kms". */
  readonly name: string;
  /** True for implementations that must never protect production data. */
  readonly developmentOnly: boolean;
  /** Key id used for new wraps. Rotation = change the active key, then re-wrap. */
  activeKeyId(): string;
  /** A fresh 256-bit data key: plaintext (caller must zero it) and its wrapped form. */
  generateDataKey(context: KmsContext): Promise<{ plaintext: Buffer; wrapped: Buffer; keyId: string }>;
  /** Wrap an existing data key under the active key (used for re-wrapping). */
  wrap(dataKey: Buffer, context: KmsContext): Promise<{ wrapped: Buffer; keyId: string }>;
  /** Unwrap a data key; fails if the key id, context or ciphertext do not match. */
  unwrap(wrapped: Buffer, keyId: string, context: KmsContext): Promise<Buffer>;
  /** Round-trip a throwaway data key. Used by readiness checks. */
  selfTest(): Promise<void>;
}

/** Misconfiguration or missing permission. Not retryable; an operator has to act. */
export class KmsConfigError extends Error {
  readonly code = "KMS_CONFIG";
}
/** The ciphertext, key id or context do not match: tampering, a copied row, or a wrong key. */
export class KmsIntegrityError extends Error {
  readonly code = "KMS_INTEGRITY";
}
/** The KMS is throttling or unreachable. Retryable. */
export class KmsUnavailableError extends Error {
  readonly code = "KMS_UNAVAILABLE";
  readonly retryable = true;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

const selfTestContext: KmsContext = { organizationId: "system", provider: "none", credentialId: "self-test", purpose: "kms-self-test" };

async function roundTrip(kms: KeyManagementService) {
  const { plaintext, wrapped, keyId } = await kms.generateDataKey(selfTestContext);
  try {
    const back = await kms.unwrap(wrapped, keyId, selfTestContext);
    const ok = back.equals(plaintext);
    back.fill(0);
    if (!ok) throw new KmsIntegrityError("KMS self-test returned a different data key");
  } finally {
    plaintext.fill(0);
  }
}

/**
 * DEVELOPMENT ONLY. Wraps data keys with AES-256-GCM under KEKs supplied in the
 * `AGENTOS_DEV_KMS_KEYS` environment variable (`id:base64key,id:base64key`).
 * The KEKs live in process memory and in the environment, which is exactly what a
 * managed KMS exists to avoid. It refuses to start in production; there is no override.
 */
export class LocalDevKms implements KeyManagementService {
  readonly name = "local-dev";
  readonly developmentOnly = true;
  private readonly keys = new Map<string, Buffer>();
  private readonly active: string;

  constructor(spec: string, opts: { activeKeyId?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = opts.env ?? process.env;
    if (isProductionEnv(env)) {
      throw new KmsConfigError("LocalDevKms is for development only and cannot run in production. Configure AGENTOS_KMS_PROVIDER=aws.");
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

  async generateDataKey(context: KmsContext) {
    const plaintext = randomBytes(32);
    const { wrapped, keyId } = await this.wrap(plaintext, context);
    return { plaintext, wrapped, keyId };
  }

  async wrap(dataKey: Buffer, context: KmsContext) {
    const kek = this.keys.get(this.active)!;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", kek, iv);
    c.setAAD(Buffer.from(`${this.active}|${contextString(context)}`, "utf8"));
    const ct = Buffer.concat([c.update(dataKey), c.final()]);
    return { wrapped: Buffer.concat([iv, c.getAuthTag(), ct]), keyId: this.active };
  }

  async unwrap(wrapped: Buffer, keyId: string, context: KmsContext) {
    const kek = this.keys.get(keyId);
    if (!kek) throw new KmsConfigError(`Dev KMS key '${keyId}' is not configured (was it removed before re-wrapping?)`);
    try {
      const d = createDecipheriv("aes-256-gcm", kek, wrapped.subarray(0, 12));
      d.setAAD(Buffer.from(`${keyId}|${contextString(context)}`, "utf8"));
      d.setAuthTag(wrapped.subarray(12, 28));
      return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
    } catch {
      throw new KmsIntegrityError("Wrapped data key does not match its key id or context");
    }
  }

  selfTest() {
    return roundTrip(this);
  }
}

/** The subset of `@aws-sdk/client-kms`'s KMSClient that the adapter uses (lets tests inject a fake). */
export interface AwsKmsClientLike {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
}

export interface AwsKmsOptions {
  /** Key used for new data keys. A full key ARN is required in production (aliases can be re-pointed). */
  keyId: string;
  /** Older keys that may still unwrap existing data keys during a rotation. Nothing else is accepted. */
  previousKeyIds?: string[];
  client: AwsKmsClientLike;
  /** Command constructors, injected so this file does not load the SDK unless AWS KMS is used. */
  commands: {
    GenerateDataKeyCommand: new (input: { KeyId: string; KeySpec: "AES_256"; EncryptionContext: Record<string, string> }) => unknown;
    EncryptCommand: new (input: { KeyId: string; Plaintext: Uint8Array; EncryptionContext: Record<string, string> }) => unknown;
    DecryptCommand: new (input: { KeyId: string; CiphertextBlob: Uint8Array; EncryptionContext: Record<string, string> }) => unknown;
  };
  /** Cache a successful self-test for this long (readiness probes run often). */
  selfTestCacheMs?: number;
}

const AWS_CONFIG_ERRORS = new Set([
  "AccessDeniedException",
  "NotFoundException",
  "DisabledException",
  "KMSInvalidStateException",
  "InvalidKeyUsageException",
  "IncorrectKeyException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ValidationException",
  "CredentialsProviderError",
]);
const AWS_INTEGRITY_ERRORS = new Set(["InvalidCiphertextException"]);

/**
 * AWS KMS adapter (symmetric KMS key, envelope encryption).
 *
 * - New data keys come from `GenerateDataKey` (AES_256): generated by the KMS's own RNG,
 *   returned once in plaintext and wrapped under the KMS key.
 * - Every call carries the organization-bound encryption context, so the KMS refuses to
 *   unwrap a data key under any other organization, provider or credential id, and
 *   CloudTrail records which organization each decrypt was for.
 * - `Decrypt` always pins `KeyId` to an allow-listed key, so a ciphertext crafted under
 *   some other key in the account is never accepted.
 * - Errors carry the AWS error name only; plaintext and ciphertext never reach a message.
 */
export class AwsKms implements KeyManagementService {
  readonly name = "aws-kms";
  readonly developmentOnly = false;
  private readonly allowed: Set<string>;
  private selfTestOkUntil = 0;

  constructor(private readonly opts: AwsKmsOptions) {
    if (!opts.keyId) throw new KmsConfigError("AGENTOS_AWS_KMS_KEY_ID is required for AWS KMS");
    this.allowed = new Set([opts.keyId, ...(opts.previousKeyIds ?? [])]);
  }

  activeKeyId(): string {
    return this.opts.keyId;
  }

  async generateDataKey(context: KmsContext) {
    const out = (await this.call("generate_data_key", new this.opts.commands.GenerateDataKeyCommand({
      KeyId: this.opts.keyId,
      KeySpec: "AES_256",
      EncryptionContext: encryptionContext(context),
    }))) as { Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array };
    if (!out.Plaintext || !out.CiphertextBlob || out.Plaintext.length !== 32) throw new KmsUnavailableError("KMS returned an incomplete data key");
    const plaintext = Buffer.from(out.Plaintext);
    out.Plaintext.fill(0);
    return { plaintext, wrapped: Buffer.from(out.CiphertextBlob), keyId: this.opts.keyId };
  }

  async wrap(dataKey: Buffer, context: KmsContext) {
    const out = (await this.call("encrypt", new this.opts.commands.EncryptCommand({
      KeyId: this.opts.keyId,
      Plaintext: dataKey,
      EncryptionContext: encryptionContext(context),
    }))) as { CiphertextBlob?: Uint8Array };
    if (!out.CiphertextBlob) throw new KmsUnavailableError("KMS returned no ciphertext");
    return { wrapped: Buffer.from(out.CiphertextBlob), keyId: this.opts.keyId };
  }

  async unwrap(wrapped: Buffer, keyId: string, context: KmsContext) {
    if (!this.allowed.has(keyId)) {
      throw new KmsConfigError(`KMS key '${keyId}' is not the active or a previous key (add it to AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS until re-wrapping finishes)`);
    }
    const out = (await this.call("decrypt", new this.opts.commands.DecryptCommand({
      KeyId: keyId,
      CiphertextBlob: wrapped,
      EncryptionContext: encryptionContext(context),
    }))) as { Plaintext?: Uint8Array };
    if (!out.Plaintext || out.Plaintext.length !== 32) throw new KmsIntegrityError("KMS returned an unexpected data key");
    const key = Buffer.from(out.Plaintext);
    out.Plaintext.fill(0);
    return key;
  }

  async selfTest() {
    if (Date.now() < this.selfTestOkUntil) return;
    await roundTrip(this);
    this.selfTestOkUntil = Date.now() + (this.opts.selfTestCacheMs ?? 60_000);
  }

  private async call(op: string, command: unknown): Promise<unknown> {
    const started = Date.now();
    try {
      const out = await this.opts.client.send(command);
      metrics.inc("agentos_kms_operations_total", { kms: this.name, op, outcome: "ok" });
      return out;
    } catch (err) {
      const name = (err as { name?: string } | null)?.name ?? "Error";
      const kind = AWS_INTEGRITY_ERRORS.has(name) ? "integrity" : AWS_CONFIG_ERRORS.has(name) ? "config" : "unavailable";
      metrics.inc("agentos_kms_operations_total", { kms: this.name, op, outcome: kind });
      const msg = `AWS KMS ${op} failed: ${name}`;
      if (kind === "integrity") throw new KmsIntegrityError(`${msg} (wrong context, key or tampered ciphertext)`);
      if (kind === "config") throw new KmsConfigError(`${msg} (check the key id, key state and the IAM policy)`);
      throw new KmsUnavailableError(msg);
    } finally {
      metrics.observe("agentos_kms_operation_seconds", { kms: this.name, op }, (Date.now() - started) / 1000);
    }
  }
}

/** True when the process runs as production (`AGENTOS_ENV=production`, or `NODE_ENV=production`). */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTOS_ENV === "production" || env.NODE_ENV === "production";
}

const splitList = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Build the configured KMS, or null when credential storage is not configured (development
 * only: production validation refuses to start without a managed KMS).
 *
 *   AGENTOS_KMS_PROVIDER=aws        AWS KMS (AGENTOS_AWS_KMS_KEY_ID, AWS_REGION, IAM role credentials)
 *   AGENTOS_KMS_PROVIDER=local-dev  LocalDevKms (AGENTOS_DEV_KMS_KEYS); refused in production
 *   unset                           local-dev if AGENTOS_DEV_KMS_KEYS is set, otherwise none
 */
export async function createKms(env: NodeJS.ProcessEnv = process.env): Promise<KeyManagementService | null> {
  if (env.AGENTOS_DEV_KMS_ALLOW_PRODUCTION) {
    throw new KmsConfigError("AGENTOS_DEV_KMS_ALLOW_PRODUCTION was removed in milestone 2C; the development KMS can no longer run in production. Unset it.");
  }
  const provider = env.AGENTOS_KMS_PROVIDER || (env.AGENTOS_DEV_KMS_KEYS ? "local-dev" : "");
  if (provider === "") {
    if (isProductionEnv(env)) throw new KmsConfigError("Production requires a managed KMS: set AGENTOS_KMS_PROVIDER=aws and AGENTOS_AWS_KMS_KEY_ID.");
    return null;
  }
  if (provider === "local-dev") {
    if (!env.AGENTOS_DEV_KMS_KEYS) throw new KmsConfigError("AGENTOS_KMS_PROVIDER=local-dev needs AGENTOS_DEV_KMS_KEYS");
    return new LocalDevKms(env.AGENTOS_DEV_KMS_KEYS, { activeKeyId: env.AGENTOS_DEV_KMS_ACTIVE_KEY || undefined, env });
  }
  if (provider === "aws") {
    const sdk = await import("@aws-sdk/client-kms");
    const endpoint = env.AGENTOS_AWS_KMS_ENDPOINT || undefined;
    const client = new sdk.KMSClient({
      region: env.AGENTOS_AWS_KMS_REGION || env.AWS_REGION || undefined,
      ...(endpoint ? { endpoint } : {}),
      maxAttempts: Number(env.AGENTOS_AWS_KMS_MAX_ATTEMPTS ?? 3),
    });
    return new AwsKms({
      keyId: env.AGENTOS_AWS_KMS_KEY_ID ?? "",
      previousKeyIds: splitList(env.AGENTOS_AWS_KMS_PREVIOUS_KEY_IDS),
      client,
      commands: sdk,
    });
  }
  throw new KmsConfigError(`Unknown AGENTOS_KMS_PROVIDER '${provider}' (expected aws or local-dev)`);
}
