import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { createProviderRegistry } from "@agentos/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, LOG_REDACT_PATHS } from "../src/app";
import { ConfigSchema } from "../src/config";
import { api, atlasBody, db, resetDb, signup, TEST_DB } from "./helpers";

const big = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
const CANARY = "sk-proj-CANARY-0123456789abcdefghijklmnopqrstuvwxyz";

/** Stand-in for api.openai.com that rejects the key and echoes it back, as real providers sometimes do. */
let fake: Server;
let fakeUrl: string;
const seenAuth: string[] = [];

beforeAll(async () => {
  await resetDb();
  fake = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    req.resume();
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json", "x-request-id": "req_fake_1" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${CANARY}`, type: "invalid_request_error", code: "invalid_api_key" } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  await new Promise((r) => fake.close(r));
  await db().$disconnect();
});

describe("credential handling", () => {
  it("never leaks a provider key into logs, events, task data or API responses", async () => {
    const logLines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logLines.push(chunk.toString());
        cb();
      },
    });
    const config = ConfigSchema.parse({ DATABASE_URL: TEST_DB, AGENTOS_ENABLE_MOCK_PROVIDER: "true", LOG_LEVEL: "debug" });
    const secrets = { get: (k: string) => (k === "OPENAI_API_KEY" ? CANARY : undefined) };
    const { app, deps } = await buildApp({
      prisma: db(),
      config,
      secrets,
      providers: createProviderRegistry({ secrets, enableMock: true, endpoints: { openai: fakeUrl } }),
      logger: { level: "debug", redact: LOG_REDACT_PATHS, stream },
      engineOverrides: { retryBaseDelayMs: 0 },
    });
    try {
      const s = await signup(app);
      const agent = await api(app, s).post("/agents", atlasBody({ provider: "openai", model: "gpt-6-luna" }));
      expect(agent.status).toBe(201);
      const created = await api(app, s).post("/tasks", { kind: "single", agentId: agent.body.id, title: "t", instruction: "What is 2 + 2?" });
      expect(created.status).toBe(201);
      await deps.workflow.idle();

      // The key was sent only to the configured endpoint…
      expect(seenAuth).toEqual([`Bearer ${CANARY}`]);
      // …and the run failed with a structured, non-retried auth error.
      const task = (await api(app, s).get(`/tasks/${created.body.id}`)).body;
      expect(task).toMatchObject({ status: "failed", failureCode: "provider_auth" });
      const events = (await api(app, s).get(`/tasks/${created.body.id}/events`)).body;
      const failed = events.find((e: { type: string }) => e.type === "run.failed");
      expect(failed.payload.error).toMatchObject({ code: "PROVIDER_AUTH", status: 401, providerCode: "invalid_api_key", requestId: "req_fake_1" });

      const everything = [
        JSON.stringify(task),
        JSON.stringify(events),
        JSON.stringify((await api(app, s).get("/providers")).body),
        JSON.stringify((await api(app, s).get("/dashboard")).body),
        big(await db().agentRun.findMany()),
        big(await db().message.findMany()),
        big(await db().runEvent.findMany()),
        big(await db().auditLog.findMany()),
        logLines.join(""),
      ].join("\n");
      expect(logLines.some((l) => l.includes('"event":"model_call_failed"'))).toBe(true);
      expect(everything).not.toContain(CANARY);
      expect(everything).not.toContain("CANARY");
    } finally {
      await app.close();
    }
  });

  it("does not offer credentials or environment access to agents", async () => {
    const { app, deps } = await buildApp({
      prisma: db(),
      config: ConfigSchema.parse({ DATABASE_URL: TEST_DB, AGENTOS_ENABLE_MOCK_PROVIDER: "true", LOG_LEVEL: "silent" }),
      logger: false,
      secrets: { get: () => CANARY },
    });
    try {
      // No registered tool can read env vars, files, the network or run commands.
      const names = deps.tools.list().map((t) => t.name).sort();
      expect(names).toEqual(["calculator", "current_datetime", "json_transform", "mock_external_action", "text_transform"]);
      // Agents cannot be given tools that do not exist.
      const s = await signup(app);
      const r = await api(app, s).post("/agents", atlasBody({ name: "Sneaky", allowedTools: ["shell_exec", "read_env"] }));
      expect(r.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("reports model availability from the provider's Models API without exposing keys", async () => {
    const { app } = await buildApp({
      prisma: db(),
      config: ConfigSchema.parse({ DATABASE_URL: TEST_DB, AGENTOS_ENABLE_MOCK_PROVIDER: "true", LOG_LEVEL: "silent" }),
      logger: false,
      secrets: { get: () => undefined },
    });
    try {
      const s = await signup(app);
      const openai = await api(app, s).get("/providers/openai/models");
      expect(openai.body).toMatchObject({ ok: false, error: { code: "PROVIDER_NOT_CONFIGURED" } });
      const mock = await api(app, s).get("/providers/mock/models");
      expect(mock.body.catalog.every((m: { availableOnAccount: boolean }) => m.availableOnAccount)).toBe(true);
      expect((await api(app, s).get("/providers/nope/models")).status).toBe(404);
      const list = (await api(app, s).get("/providers")).body as { id: string; endpoint: string | null; models: { priceSource: string }[] }[];
      expect(list.find((p) => p.id === "anthropic")!.endpoint).toBe("https://api.anthropic.com");
      expect(list.find((p) => p.id === "mock")!.endpoint).toBeNull();
      expect(list.filter((p) => p.id !== "mock").flatMap((p) => p.models).every((m) => m.priceSource === "published")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
