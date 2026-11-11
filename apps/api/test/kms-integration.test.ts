import { CreateKeyCommand, DecryptCommand, EncryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AwsKms, CredentialDecryptError, CredentialService } from "@agentos/platform";
import { db, makeApp, resetDb, signup, type Session } from "./helpers";

/**
 * Production key management end to end: CredentialService on real Postgres with the AWS
 * KMS adapter talking to a KMS API emulator (moto). Real AWS is not used here.
 *   moto_server -p 5055 &  AGENTOS_TEST_KMS_ENDPOINT=http://127.0.0.1:5055 pnpm --filter @agentos/api test
 */
const endpoint = process.env.AGENTOS_TEST_KMS_ENDPOINT;
const KEY_A = "sk-proj-AAAA" + "a".repeat(40) + "tailA";
const KEY_B = "sk-proj-BBBB" + "b".repeat(40) + "tailB";
const commands = { GenerateDataKeyCommand, EncryptCommand, DecryptCommand };

describe.skipIf(!endpoint)("AWS KMS credential storage (emulator)", () => {
  let client: KMSClient;
  let key1: string;
  let key2: string;
  let a: Session;
  let b: Session;
  const actor = { userId: null };

  beforeAll(async () => {
    client = new KMSClient({ endpoint, region: "eu-west-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    key1 = (await client.send(new CreateKeyCommand({ Description: "agentos it 1" }))).KeyMetadata!.Arn!;
    key2 = (await client.send(new CreateKeyCommand({ Description: "agentos it 2" }))).KeyMetadata!.Arn!;
    await resetDb();
    const { app } = await makeApp({}, undefined, { listen: false });
    a = await signup(app, "Org A");
    b = await signup(app, "Org B");
    await app.close();
  });
  afterAll(async () => {
    await db().$disconnect();
  });

  const service = (kms: AwsKms) => new CredentialService(db(), kms, { allowDeploymentKeys: false, cacheTtlMs: 0 });

  it("encrypts per organization, decrypts only for that organization, and stores no plaintext", async () => {
    const svc = service(new AwsKms({ keyId: key1, client, commands }));
    await svc.put(a.orgId, "openai", KEY_A, actor);
    await svc.put(b.orgId, "openai", KEY_B, actor);
    expect(await svc.resolve(a.orgId, "openai")).toBe(KEY_A);
    expect(await svc.resolve(b.orgId, "openai")).toBe(KEY_B);
    const rows = await db().providerCredential.findMany({ where: { organizationId: { in: [a.orgId, b.orgId] } } });
    expect(rows.every((r) => r.kekId === key1)).toBe(true);
    const dump = JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    expect(dump).not.toContain(KEY_A);
    expect(dump).not.toContain("a".repeat(40));
  });

  it("a ciphertext copied into another organization's row is refused by the KMS and audited", async () => {
    const svc = service(new AwsKms({ keyId: key1, client, commands }));
    const src = await db().providerCredential.findFirstOrThrow({ where: { organizationId: a.orgId, provider: "openai" } });
    await db().providerCredential.update({
      where: { organizationId_provider: { organizationId: b.orgId, provider: "openai" } },
      data: { ciphertext: src.ciphertext, iv: src.iv, authTag: src.authTag, wrappedKey: src.wrappedKey, kekId: src.kekId },
    });
    const err = await svc.resolve(b.orgId, "openai").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialDecryptError);
    expect(err).toMatchObject({ code: "KMS_INTEGRITY", retryable: false });
    expect((err as Error).message).not.toContain(KEY_A);
    const audit = await db().auditLog.findFirst({ where: { organizationId: b.orgId, action: "credential.decrypt_failed" } });
    expect(audit?.metadata).toMatchObject({ code: "KMS_INTEGRITY", kms: "aws-kms" });
    expect(JSON.stringify(audit)).not.toContain(KEY_A);
    // Organization A is unaffected.
    expect(await svc.resolve(a.orgId, "openai")).toBe(KEY_A);
    await svc.put(b.orgId, "openai", KEY_B, actor); // repair B for the next tests
  });

  it("rotates the KMS key: re-wraps every credential, then works without the old key", async () => {
    const rotating = service(new AwsKms({ keyId: key2, previousKeyIds: [key1], client, commands }));
    const { rewrapped, activeKeyId } = await rotating.rotate({ userId: null });
    expect(activeKeyId).toBe(key2);
    expect(rewrapped).toBeGreaterThanOrEqual(2);
    expect(await db().providerCredential.count({ where: { kekId: key1 } })).toBe(0);
    const after = service(new AwsKms({ keyId: key2, client, commands }));
    expect(await after.resolve(a.orgId, "openai")).toBe(KEY_A);
    expect(await after.resolve(b.orgId, "openai")).toBe(KEY_B);
    const audits = await db().auditLog.findMany({ where: { action: "credential.rotated", organizationId: { in: [a.orgId, b.orgId] } } });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits[0]!.metadata).toMatchObject({ fromKekId: key1, toKekId: key2 });
  });

  it("replacing a key (credential rotation) uses a fresh data key and wrap", async () => {
    const svc = service(new AwsKms({ keyId: key2, client, commands }));
    const before = await db().providerCredential.findFirstOrThrow({ where: { organizationId: a.orgId, provider: "openai" } });
    await svc.put(a.orgId, "openai", KEY_A + "-v2", { userId: a.userId });
    const after = await db().providerCredential.findFirstOrThrow({ where: { organizationId: a.orgId, provider: "openai" } });
    expect(Buffer.from(after.wrappedKey).equals(Buffer.from(before.wrappedKey))).toBe(false);
    expect(Buffer.from(after.iv).equals(Buffer.from(before.iv))).toBe(false);
    expect(await svc.resolve(a.orgId, "openai")).toBe(KEY_A + "-v2");
    expect(await db().auditLog.count({ where: { organizationId: a.orgId, action: "credential.updated" } })).toBeGreaterThanOrEqual(1);
  });

  it("deletes a credential: the row is gone, the cache cannot serve it, and the deletion is audited", async () => {
    const svc = new CredentialService(db(), new AwsKms({ keyId: key2, client, commands }), { allowDeploymentKeys: false, cacheTtlMs: 60_000 });
    expect(await svc.resolve(a.orgId, "openai")).toBe(KEY_A + "-v2"); // now cached in this process
    expect(await svc.delete(a.orgId, "openai", { userId: a.userId })).toBe(true);
    expect(await svc.resolve(a.orgId, "openai")).toBeNull();
    expect(await db().providerCredential.count({ where: { organizationId: a.orgId } })).toBe(0);
    const audit = await db().auditLog.findFirst({ where: { organizationId: a.orgId, action: "credential.deleted" } });
    expect(audit?.metadata).toMatchObject({ kekId: key2 });
  });

  it("caches decrypted keys briefly (one KMS call for repeated turns) and drops the cache on update", async () => {
    let decrypts = 0;
    const counting = { send: (cmd: unknown) => ((decrypts += cmd instanceof DecryptCommand ? 1 : 0), client.send(cmd as never)) };
    const svc = new CredentialService(db(), new AwsKms({ keyId: key2, client: counting, commands }), { allowDeploymentKeys: false, cacheTtlMs: 60_000 });
    for (let i = 0; i < 5; i++) expect(await svc.resolve(b.orgId, "openai")).toBe(KEY_B);
    expect(decrypts).toBe(1);
    await svc.put(b.orgId, "openai", KEY_B + "-v2", actor);
    expect(await svc.resolve(b.orgId, "openai")).toBe(KEY_B + "-v2");
    expect(decrypts).toBe(2);
  });

  it("a KMS key that does not exist fails as a configuration error and fails the readiness self-test", async () => {
    // (moto does not enforce DisableKey on Decrypt, so the disabled-key case is covered with the fake client in packages/platform.)
    const missing = "arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-0000-0000-000000000000";
    const svc = service(new AwsKms({ keyId: missing, client, commands }));
    await expect(svc.put(b.orgId, "anthropic", KEY_B, actor)).rejects.toThrow(/AWS KMS generate_data_key failed: NotFoundException/);
    expect(await db().providerCredential.count({ where: { organizationId: b.orgId, provider: "anthropic" } })).toBe(0);
    expect(await svc.selfTest()).toMatchObject({ ok: false });
  });
});
