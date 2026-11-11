import { randomBytes } from "node:crypto";
import { CreateKeyCommand, DecryptCommand, EncryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AwsKms,
  contextString,
  encryptionContext,
  KmsConfigError,
  KmsIntegrityError,
  KmsUnavailableError,
  LocalDevKms,
  metrics,
  openSecret,
  rewrapSecret,
  sealSecret,
  type KmsContext,
} from "../src";

const ctxA: KmsContext = { organizationId: "org_a", provider: "openai", credentialId: "cred_1", purpose: "provider-credential" };
const ctxB: KmsContext = { ...ctxA, organizationId: "org_b" };
const SECRET = "sk-test-" + "x".repeat(40);
const commands = { GenerateDataKeyCommand, EncryptCommand, DecryptCommand };

/**
 * In-memory stand-in for AWS KMS with the semantics that matter here: an encryption
 * context that must match on decrypt, key ids, and AWS-style error names.
 */
class FakeKms {
  sent: { name: string; input: Record<string, unknown> }[] = [];
  private readonly keys = new Map<string, Buffer>();
  failWith: string | null = null;
  constructor(keyIds: string[]) {
    for (const k of keyIds) this.keys.set(k, randomBytes(32));
  }
  async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
    this.sent.push({ name: cmd.constructor.name, input: cmd.input });
    if (this.failWith) throw Object.assign(new Error(`${this.failWith}: simulated (plaintext must never appear here)`), { name: this.failWith });
    const i = cmd.input as { KeyId: string; EncryptionContext: Record<string, string>; Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array };
    const kek = this.keys.get(i.KeyId);
    if (!kek) throw Object.assign(new Error("not found"), { name: "NotFoundException" });
    const { createCipheriv, createDecipheriv } = await import("node:crypto");
    const aad = Buffer.from(JSON.stringify(Object.entries(i.EncryptionContext).sort()));
    const enc = (pt: Buffer) => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", kek, iv);
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(pt), c.final()]);
      return Buffer.concat([Buffer.from(i.KeyId.padEnd(64)), iv, c.getAuthTag(), ct]);
    };
    if (cmd.constructor.name === "GenerateDataKeyCommand") {
      const pt = randomBytes(32);
      return { Plaintext: new Uint8Array(pt), CiphertextBlob: new Uint8Array(enc(pt)), KeyId: i.KeyId };
    }
    if (cmd.constructor.name === "EncryptCommand") return { CiphertextBlob: new Uint8Array(enc(Buffer.from(i.Plaintext!))) };
    const blob = Buffer.from(i.CiphertextBlob!);
    if (blob.subarray(0, 64).toString().trim() !== i.KeyId) throw Object.assign(new Error("wrong key"), { name: "IncorrectKeyException" });
    try {
      const d = createDecipheriv("aes-256-gcm", kek, blob.subarray(64, 76));
      d.setAAD(aad);
      d.setAuthTag(blob.subarray(76, 92));
      return { Plaintext: new Uint8Array(Buffer.concat([d.update(blob.subarray(92)), d.final()])) };
    } catch {
      throw Object.assign(new Error("invalid ciphertext"), { name: "InvalidCiphertextException" });
    }
  }
}

describe("AwsKms adapter (fake client: request shape and error handling)", () => {
  it("uses GenerateDataKey with the organization-bound encryption context, and pins KeyId on decrypt", async () => {
    const fake = new FakeKms(["key-1"]);
    const kms = new AwsKms({ keyId: "key-1", client: fake, commands });
    const env = await sealSecret(kms, SECRET, ctxA);
    expect(env.kekId).toBe("key-1");
    expect(await openSecret(kms, env, ctxA)).toBe(SECRET);
    expect(fake.sent.map((s) => s.name)).toEqual(["GenerateDataKeyCommand", "DecryptCommand"]);
    expect(fake.sent[0]!.input).toMatchObject({ KeyId: "key-1", KeySpec: "AES_256", EncryptionContext: encryptionContext(ctxA) });
    expect(encryptionContext(ctxA)).toEqual({ scheme: "agentos-envelope-v1", purpose: "provider-credential", organizationId: "org_a", provider: "openai", credentialId: "cred_1" });
    expect(fake.sent[1]!.input).toMatchObject({ KeyId: "key-1", EncryptionContext: encryptionContext(ctxA) });
    // The secret never goes to the KMS: only the 32-byte data key does (as plaintext out of GenerateDataKey).
    expect(JSON.stringify(fake.sent)).not.toContain(SECRET);
  });

  it("refuses to unwrap under another organization's context", async () => {
    const kms = new AwsKms({ keyId: "key-1", client: new FakeKms(["key-1"]), commands });
    const env = await sealSecret(kms, SECRET, ctxA);
    await expect(openSecret(kms, env, ctxB)).rejects.toThrow(KmsIntegrityError);
  });

  it("only unwraps under the active or an allow-listed previous key", async () => {
    const fake = new FakeKms(["old", "new", "other"]);
    const before = new AwsKms({ keyId: "old", client: fake, commands });
    const env = await sealSecret(before, SECRET, ctxA);
    const rotating = new AwsKms({ keyId: "new", previousKeyIds: ["old"], client: fake, commands });
    expect(await openSecret(rotating, env, ctxA)).toBe(SECRET);
    const next = await rewrapSecret(rotating, env, ctxA);
    expect(next.kekId).toBe("new");
    const after = new AwsKms({ keyId: "new", client: fake, commands });
    expect(await openSecret(after, { ...env, ...next }, ctxA)).toBe(SECRET);
    await expect(openSecret(after, env, ctxA)).rejects.toThrow(/not the active or a previous key/);
    // A row claiming some other key in the account is rejected before any KMS call.
    const sent = fake.sent.length;
    await expect(after.unwrap(Buffer.from(env.wrappedKey), "other", ctxA)).rejects.toThrow(KmsConfigError);
    expect(fake.sent.length).toBe(sent);
  });

  it("classifies AWS errors and never echoes payloads", async () => {
    const fake = new FakeKms(["key-1"]);
    const kms = new AwsKms({ keyId: "key-1", client: fake, commands });
    const env = await sealSecret(kms, SECRET, ctxA);
    const cases: [string, unknown][] = [
      ["AccessDeniedException", KmsConfigError],
      ["DisabledException", KmsConfigError],
      ["KMSInvalidStateException", KmsConfigError],
      ["InvalidCiphertextException", KmsIntegrityError],
      ["ThrottlingException", KmsUnavailableError],
      ["KMSInternalException", KmsUnavailableError],
      ["TimeoutError", KmsUnavailableError],
    ];
    for (const [name, type] of cases) {
      fake.failWith = name;
      const err = await openSecret(kms, env, ctxA).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(type as new () => Error);
      expect((err as Error).message).toContain(name);
      expect((err as Error).message).not.toContain("simulated");
      expect((err as Error).message).not.toContain(SECRET);
    }
    expect((await openSecret(kms, env, ctxA).catch((e: KmsUnavailableError) => e)) as KmsUnavailableError).toHaveProperty("retryable", true);
    expect(metrics.counter("agentos_kms_operations_total", { kms: "aws-kms", op: "decrypt", outcome: "unavailable" })).toBeGreaterThanOrEqual(3);
  });

  it("caches a successful self-test", async () => {
    const fake = new FakeKms(["key-1"]);
    const kms = new AwsKms({ keyId: "key-1", client: fake, commands, selfTestCacheMs: 60_000 });
    await kms.selfTest();
    await kms.selfTest();
    expect(fake.sent.filter((s) => s.name === "GenerateDataKeyCommand")).toHaveLength(1);
    expect(fake.sent[0]!.input.EncryptionContext).toMatchObject({ purpose: "kms-self-test" });
  });
});

describe("LocalDevKms stays compatible with milestone 2B ciphertexts", () => {
  it("uses the same AAD string as 2B, so credentials written then still decrypt", async () => {
    expect(contextString(ctxA)).toBe("agentos-credential|v1|org_a|openai|cred_1");
    const kms = new LocalDevKms(`k1:${randomBytes(32).toString("base64")}`, { env: {} });
    const env = await sealSecret(kms, SECRET, ctxA);
    expect(await openSecret(kms, env, ctxA)).toBe(SECRET);
    await expect(openSecret(kms, env, ctxB)).rejects.toThrow(KmsIntegrityError);
    await kms.selfTest();
  });
});

/**
 * Against a real KMS API implementation (moto's KMS emulator, or real AWS when pointed at
 * it). Set AGENTOS_TEST_KMS_ENDPOINT, e.g. http://127.0.0.1:5055 after `moto_server -p 5055`.
 */
const endpoint = process.env.AGENTOS_TEST_KMS_ENDPOINT;
describe.skipIf(!endpoint)("AwsKms against a KMS emulator", () => {
  let client: KMSClient;
  let key1: string;
  let key2: string;
  beforeAll(async () => {
    client = new KMSClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    key1 = (await client.send(new CreateKeyCommand({ Description: "agentos test 1" }))).KeyMetadata!.Arn!;
    key2 = (await client.send(new CreateKeyCommand({ Description: "agentos test 2" }))).KeyMetadata!.Arn!;
  });

  it("round-trips an envelope through GenerateDataKey and Decrypt", async () => {
    const kms = new AwsKms({ keyId: key1, client, commands });
    const env = await sealSecret(kms, SECRET, ctxA);
    expect(env.kekId).toBe(key1);
    expect(env.wrappedKey.length).toBeGreaterThan(32);
    expect(await openSecret(kms, env, ctxA)).toBe(SECRET);
    await kms.selfTest();
  });

  it("the KMS itself refuses a mismatched encryption context (organization isolation)", async () => {
    const kms = new AwsKms({ keyId: key1, client, commands });
    const env = await sealSecret(kms, SECRET, ctxA);
    await expect(openSecret(kms, env, ctxB)).rejects.toThrow(KmsIntegrityError);
    await expect(openSecret(kms, env, { ...ctxA, credentialId: "cred_2" })).rejects.toThrow(KmsIntegrityError);
  });

  it("re-wraps from one KMS key to another", async () => {
    const env = await sealSecret(new AwsKms({ keyId: key1, client, commands }), SECRET, ctxA);
    const rotating = new AwsKms({ keyId: key2, previousKeyIds: [key1], client, commands });
    const next = await rewrapSecret(rotating, env, ctxA);
    expect(next.kekId).toBe(key2);
    expect(await openSecret(new AwsKms({ keyId: key2, client, commands }), { ...env, ...next }, ctxA)).toBe(SECRET);
  });
});
