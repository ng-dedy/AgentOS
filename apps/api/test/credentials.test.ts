import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { CredentialService, LocalDevKms, KmsConfigError } from "@agentos/platform";
import { createProviderRegistry } from "@agentos/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, LOG_REDACT_PATHS } from "../src/app";
import { ConfigSchema } from "../src/config";
import { api, atlasBody, db, resetDb, signup, TEST_DB, type Session } from "./helpers";

const big = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("latin1") : x));
const key32 = () => randomBytes(32).toString("base64");
const K1 = key32();
const K2 = key32();

// Distinct, recognizable keys per organization. "good" keys pass the fake Models API.
const KEY_A = `sk-proj-ORG-A-good-${randomBytes(12).toString("hex")}`;
const KEY_B = `sk-proj-ORG-B-good-${randomBytes(12).toString("hex")}`;
const KEY_BAD = `sk-proj-REJECTED-${randomBytes(12).toString("hex")}`;

/** Stand-in for the OpenAI API: records which key each request carried. */
let fake: Server;
let fakeUrl: string;
const seen: { path: string; auth: string }[] = [];

beforeAll(async () => {
  await resetDb();
  fake = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? "");
    seen.push({ path: req.url ?? "", auth });
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models") && auth.includes("-good-")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-6-luna", object: "model", created: 0, owned_by: "openai" }] }));
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth.slice(7)}`, type: "invalid_request_error", code: "invalid_api_key" } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  await new Promise((r) => fake.close(r));
  await db().$disconnect();
});

async function credentialApp(kmsSpec = `k1:${K1}`, extra: Record<string, string> = {}) {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _e, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const config = ConfigSchema.parse({ DATABASE_URL: TEST_DB, AGENTOS_ENABLE_MOCK_PROVIDER: "true", LOG_LEVEL: "debug", ...extra });
  const secrets = { get: (k: string) => (k === "OPENAI_API_KEY" ? "sk-proj-DEPLOYMENT-should-not-be-used" : undefined) };
  const built = await buildApp({
    prisma: db(),
    config,
    secrets,
    providers: createProviderRegistry({ secrets, enableMock: true, endpoints: { openai: fakeUrl } }),
    kms: new LocalDevKms(kmsSpec, { env: {} }),
    logger: { level: "debug", redact: LOG_REDACT_PATHS, stream },
    engineOverrides: { retryBaseDelayMs: 0 },
    listen: false,
  });
  return { ...built, logs };
}

describe("organization provider credentials", () => {
  let app: Awaited<ReturnType<typeof credentialApp>>;
  let a: Session;
  let b: Session;
  let c: Session;

  beforeAll(async () => {
    app = await credentialApp();
    a = await signup(app.app, "Org A");
    b = await signup(app.app, "Org B");
    c = await signup(app.app, "Org C");
  });
  afterAll(async () => app.app.close());

  it("stores a verified key encrypted, and only ever returns a hint", async () => {
    const r = await api(app.app, a).put("/credentials/openai", { apiKey: KEY_A });
    expect(r.status).toBe(200);
    expect(r.body.credential).toMatchObject({ provider: "openai", source: "organization", status: "valid", keyHint: KEY_A.slice(-4), kekId: "k1" });
    expect(JSON.stringify(r.body)).not.toContain(KEY_A);
    const row = await db().providerCredential.findFirstOrThrow({ where: { organizationId: a.orgId, provider: "openai" } });
    expect(big(row)).not.toContain(KEY_A); // ciphertext, not plaintext
    expect(Buffer.from(row.ciphertext).toString("latin1")).not.toContain(KEY_A.slice(10, 30));
    expect(row.iv.length).toBe(12);
    expect(row.authTag.length).toBe(16);
    const list = await api(app.app, a).get("/credentials");
    expect(list.body.storage).toEqual({ enabled: true, kms: "local-dev", developmentOnly: true });
    expect(JSON.stringify(list.body)).not.toContain(KEY_A);
  });

  it("rejects a key the provider refuses, without saving it", async () => {
    const r = await api(app.app, b).put("/credentials/openai", { apiKey: KEY_BAD });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("credential_rejected");
    expect(JSON.stringify(r.body)).not.toContain(KEY_BAD);
    expect(await db().providerCredential.count({ where: { organizationId: b.orgId } })).toBe(0);
  });

  it("uses each organization's own key and never another organization's or the deployment key", async () => {
    expect((await api(app.app, b).put("/credentials/openai", { apiKey: KEY_B })).status).toBe(200);
    seen.length = 0;
    for (const s of [a, b]) {
      const agent = await api(app.app, s).post("/agents", atlasBody({ provider: "openai", model: "gpt-6-luna" }));
      expect(agent.status).toBe(201);
      expect(agent.body.providerConfigured).toBe(true);
      const t = await api(app.app, s).post("/tasks", { kind: "single", agentId: agent.body.id, title: "t", instruction: "hi" });
      expect(t.status).toBe(201);
    }
    await app.deps.workflow.idle?.();
    const calls = seen.filter((x) => x.path.startsWith("/v1/responses"));
    expect(calls.map((x) => x.auth)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    expect(seen.some((x) => x.auth.includes("DEPLOYMENT"))).toBe(false);

    // Org C has no key and deployment keys are not allowed: refused up front, no provider call.
    const agentC = await api(app.app, c).post("/agents", atlasBody({ provider: "openai", model: "gpt-6-luna" }));
    expect(agentC.body.providerConfigured).toBe(false);
    const before = seen.length;
    const tc = await api(app.app, c).post("/tasks", { kind: "single", agentId: agentC.body.id, title: "t", instruction: "hi" });
    expect(tc.status).toBe(422);
    expect(tc.body.error.code).toBe("provider_not_configured");
    expect(seen.length).toBe(before);
    // Discovery for org C does not use anyone's key either.
    const disc = await api(app.app, c).get("/providers/openai/models?refresh=1");
    expect(disc.body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(seen.length).toBe(before);
  });

  it("binds ciphertext to its organization: a row copied to another org does not decrypt", async () => {
    const rowA = await db().providerCredential.findFirstOrThrow({ where: { organizationId: a.orgId, provider: "openai" } });
    await db().providerCredential.update({
      where: { organizationId_provider: { organizationId: b.orgId, provider: "openai" } },
      data: { ciphertext: rowA.ciphertext, iv: rowA.iv, authTag: rowA.authTag, wrappedKey: rowA.wrappedKey, kekId: rowA.kekId },
    });
    await expect(app.deps.credentials.resolve(b.orgId, "openai")).rejects.toThrow();
    expect(await app.deps.credentials.resolve(a.orgId, "openai")).toBe(KEY_A);
    expect((await api(app.app, b).put("/credentials/openai", { apiKey: KEY_B })).status).toBe(200); // repair
  });

  it("only owners can manage credentials", async () => {
    const m = await signup(app.app, "Member home");
    await db().membership.create({ data: { organizationId: a.orgId, userId: m.userId, role: "member" } });
    await db().session.updateMany({ where: { userId: m.userId }, data: { organizationId: a.orgId } });
    const member = { ...m, orgId: a.orgId };
    expect((await api(app.app, member).put("/credentials/openai", { apiKey: KEY_B })).status).toBe(403);
    expect((await api(app.app, member).post("/credentials/openai/verify", {})).status).toBe(403);
    expect((await app.app.inject({ method: "DELETE", url: "/api/v1/credentials/openai", headers: { cookie: member.cookie } })).statusCode).toBe(403);
    expect(await app.deps.credentials.resolve(a.orgId, "openai")).toBe(KEY_A);
  });

  it("rotates the key-encryption key by re-wrapping data keys, then works without the old KEK", async () => {
    const rotating = new CredentialService(db(), new LocalDevKms(`k1:${K1},k2:${K2}`, { env: {} }), { allowDeploymentKeys: false });
    const r = await rotating.rotate();
    expect(r.activeKeyId).toBe("k2");
    expect(r.rewrapped).toBeGreaterThanOrEqual(2);
    expect((await db().providerCredential.findMany()).every((x) => x.kekId === "k2")).toBe(true);
    const onlyNew = new CredentialService(db(), new LocalDevKms(`k2:${K2}`, { env: {} }), { allowDeploymentKeys: false });
    expect(await onlyNew.resolve(a.orgId, "openai")).toBe(KEY_A);
    expect(await onlyNew.resolve(b.orgId, "openai")).toBe(KEY_B);
    const onlyOld = new CredentialService(db(), new LocalDevKms(`k1:${K1}`, { env: {} }), { allowDeploymentKeys: false });
    await expect(onlyOld.resolve(a.orgId, "openai")).rejects.toThrow(KmsConfigError);
    expect((await db().auditLog.findMany({ where: { action: "credential.rotated" } })).length).toBeGreaterThanOrEqual(2);
  });

  it("deletes a credential; the org then has no key", async () => {
    const appK2 = await credentialApp(`k2:${K2}`);
    try {
      const del = await appK2.app.inject({ method: "DELETE", url: "/api/v1/credentials/openai", headers: { cookie: a.cookie } });
      expect(del.statusCode).toBe(204);
      expect(await appK2.deps.credentials.resolve(a.orgId, "openai")).toBeNull();
      const list = await api(appK2.app, a).get("/credentials");
      expect(list.body.items.find((x: { provider: string }) => x.provider === "openai").source).toBe("none");
    } finally {
      await appK2.app.close();
    }
  });

  it("never writes any key to logs, audit records or events", async () => {
    const audit = await db().auditLog.findMany();
    const events = await db().runEvent.findMany();
    const tasks = await db().task.findMany();
    const toolCalls = await db().toolCall.findMany();
    for (const k of [KEY_A, KEY_B, KEY_BAD]) {
      expect(app.logs.join("")).not.toContain(k);
      for (const rows of [audit, events, tasks, toolCalls]) expect(big(rows)).not.toContain(k);
    }
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["credential.created", "credential.updated", "credential.deleted"]));
  });

  it("the development KMS refuses to run in production", () => {
    expect(() => new LocalDevKms(`k1:${K1}`, { env: { NODE_ENV: "production" } })).toThrow(KmsConfigError);
    expect(() => new LocalDevKms("k1:short", { env: {} })).toThrow(/32 bytes/);
  });
});
