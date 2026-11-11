import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDevKms } from "@agentos/platform";
import { db, makeApp, resetDb, signup, TEST_DB } from "./helpers";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runServer(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: API_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exited, output: () => out };
}

describe("readiness, liveness and metrics", () => {
  let built: Awaited<ReturnType<typeof makeApp>>;
  const token = "t".repeat(40);
  beforeAll(async () => {
    await resetDb();
    built = await makeApp({ AGENTOS_METRICS_TOKEN: token }, undefined, { kms: new LocalDevKms(`k1:${randomBytes(32).toString("base64")}`, { env: {} }) });
  });
  afterAll(async () => {
    await built.app.close();
  });

  it("/livez and /readyz need no session; readiness checks the database, listener and KMS", async () => {
    expect((await built.app.inject({ url: "/livez" })).statusCode).toBe(200);
    const r = await built.app.inject({ url: "/readyz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, draining: false, checks: { database: true, eventListener: true, kms: true } });
  });

  it("reports not-ready while draining and when a dependency is down", async () => {
    built.deps.lifecycle.draining = true;
    expect((await built.app.inject({ url: "/readyz" })).statusCode).toBe(503);
    built.deps.lifecycle.draining = false;
    await built.deps.listener!.close();
    const r = await built.app.inject({ url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json().checks).toMatchObject({ database: true, eventListener: false });
    // Unauthenticated callers get booleans only, never error text.
    expect(r.body).not.toMatch(/LISTEN connection|postgresql:|password/);
  });

  it("serves Prometheus metrics only with the bearer token", async () => {
    const s = await signup(built.app, "Metrics Org");
    await built.app.inject({ url: "/api/v1/agents", headers: { cookie: s.cookie } });
    expect((await built.app.inject({ url: "/metrics" })).statusCode).toBe(401);
    expect((await built.app.inject({ url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const m = await built.app.inject({ url: "/metrics", headers: { authorization: `Bearer ${token}` } });
    expect(m.statusCode).toBe(200);
    expect(m.headers["content-type"]).toMatch(/text\/plain/);
    expect(m.body).toMatch(/# TYPE agentos_http_requests_total counter/);
    expect(m.body).toMatch(/agentos_http_requests_total\{method="GET",route="\/api\/v1\/agents",status="2xx"\} \d+/);
    expect(m.body).toMatch(/agentos_event_listener_connected/);
    expect(m.body).not.toContain(s.cookie.split("=")[1]!);
  });

  it("/metrics is disabled (404) when no token is configured", async () => {
    const plain = await makeApp({}, undefined, { listen: false });
    expect((await plain.app.inject({ url: "/metrics" })).statusCode).toBe(404);
    await plain.app.close();
  });
});

describe("production startup refusal (real process)", () => {
  it("refuses to start with an unsafe production configuration and names every problem", async () => {
    const p = runServer({
      AGENTOS_ENV: "production",
      DATABASE_URL: TEST_DB,
      AGENTOS_WORKFLOW_ENGINE: "inprocess",
      AGENTOS_ENABLE_MOCK_PROVIDER: "true",
      AGENTOS_DEV_KMS_KEYS: `k1:${randomBytes(32).toString("base64")}`,
      SESSION_COOKIE_SECURE: "false",
      WEB_ORIGIN: "http://localhost:3000",
      API_PORT: "0",
    });
    const code = await Promise.race([p.exited, sleep(30_000).then(() => "timeout")]);
    expect(code).toBe(1);
    const out = p.output();
    expect(out).toContain("Refusing to start the api in production");
    for (const m of ["AGENTOS_WORKFLOW_ENGINE", "AGENTOS_KMS_PROVIDER", "AGENTOS_DEV_KMS_KEYS", "MOCK", "Temporal must use TLS", "SESSION_COOKIE_SECURE", "WEB_ORIGIN"]) expect(out).toContain(m);
    expect(out).not.toContain("API started");
  });

  it("refuses the removed development-KMS production override even outside production", async () => {
    const p = runServer({ DATABASE_URL: TEST_DB, AGENTOS_DEV_KMS_ALLOW_PRODUCTION: "true", API_PORT: "0" });
    expect(await Promise.race([p.exited, sleep(30_000).then(() => "timeout")])).toBe(1);
    expect(p.output()).toContain("AGENTOS_DEV_KMS_ALLOW_PRODUCTION was removed");
  });
});

describe("graceful shutdown (real process)", () => {
  it("withdraws readiness, ends SSE streams and exits 0 after the drain period", async () => {
    const port = 4900 + Math.floor(Math.random() * 90);
    const p = runServer({
      DATABASE_URL: TEST_DB,
      API_PORT: String(port),
      AGENTOS_ENABLE_MOCK_PROVIDER: "true",
      WEB_ORIGIN: "http://localhost:3000",
      SHUTDOWN_DRAIN_MS: "1500",
      RATE_LIMIT_MAX: "10000",
      AUTH_RATE_LIMIT_MAX: "10000",
    });
    const base = `http://127.0.0.1:${port}`;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if ((await fetch(`${base}/readyz`).catch(() => null))?.ok) break;
      await sleep(200);
    }
    const signupRes = await fetch(`${base}/api/v1/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `sd_${Date.now()}@example.com`, password: "correct horse battery", name: "SD", organizationName: "Shutdown" }),
    });
    const cookie = signupRes.headers.get("set-cookie")!.split(";")[0]!;
    const stream = await fetch(`${base}/api/v1/events/stream`, { headers: { cookie } });
    const reader = stream.body!.getReader();
    const streamEnded = (async () => {
      for (;;) if ((await reader.read()).done) return true;
    })();

    p.child.kill("SIGTERM");
    await sleep(300);
    const during = await fetch(`${base}/readyz`);
    expect(during.status).toBe(503);
    expect(((await during.json()) as { draining: boolean }).draining).toBe(true);
    expect(await Promise.race([streamEnded, sleep(10_000).then(() => false)])).toBe(true);
    expect(await Promise.race([p.exited, sleep(15_000).then(() => "timeout")])).toBe(0);
    expect(p.output()).toContain("api_draining");
  });
});

afterAll(async () => {
  await db().$disconnect();
});
