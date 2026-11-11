/* eslint-disable @typescript-eslint/no-explicit-any -- black-box HTTP tests read untyped JSON responses */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient, type PrismaClient } from "@agentos/db";

/**
 * Process-level harness: the API and the worker run as real OS processes against
 * real Postgres and a real Temporal server, so a test can SIGKILL either of them.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agentos_test";
export const TEMPORAL = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";

let prisma: PrismaClient | undefined;
export const db = () => (prisma ??= createPrismaClient(TEST_DB));

export async function resetDb() {
  const tables = await db().$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`);
  await db().$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

const dir = mkdtempSync(join(tmpdir(), "agentos-durability-"));
export const LEDGER = join(dir, "side-effects.jsonl");
export const ledgerLines = () => (existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean) : []);

/** Shared environment. A fresh task queue per run isolates this suite from any other worker. */
export const BASE_ENV: Record<string, string> = {
  DATABASE_URL: TEST_DB,
  AGENTOS_WORKFLOW_ENGINE: "temporal",
  TEMPORAL_ADDRESS: TEMPORAL,
  TEMPORAL_TASK_QUEUE: `durability-${Date.now()}-${randomBytes(3).toString("hex")}`,
  AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS: "3000",
  AGENTOS_ENABLE_MOCK_PROVIDER: "true",
  AGENTOS_MOCK_SLOW_MS: "4000",
  AGENTOS_DEV_KMS_KEYS: `test1:${randomBytes(32).toString("base64")}`,
  AGENTOS_MOCK_ACTION_LEDGER: LEDGER,
  DISPATCH_RECONCILE_MS: "1000",
  RATE_LIMIT_MAX: "10000",
  AUTH_RATE_LIMIT_MAX: "10000",
  LOG_LEVEL: "info",
  WEB_ORIGIN: "http://localhost:3000",
  NODE_ENV: "test",
};

export interface Proc {
  name: string;
  child: ChildProcess;
  logs: string[];
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

function spawnProc(name: string, cwd: string, entry: string, env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...BASE_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout!.on("data", (d: Buffer) => logs.push(d.toString()));
  child.stderr!.on("data", (d: Buffer) => logs.push(d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return {
    name,
    child,
    logs,
    exited,
    async kill(signal = "SIGKILL") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await exited;
    },
  };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, everyMs = 200): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

export async function startWorker(env: Record<string, string> = {}): Promise<Proc> {
  const p = spawnProc("worker", join(ROOT, "apps/worker"), "src/main.ts", env);
  await waitFor("worker to start", async () => p.logs.join("").includes("worker started") || (p.child.exitCode !== null && Promise.reject(new Error(p.logs.join("")))), 60_000);
  return p;
}

let nextPort = 4600 + Math.floor(Math.random() * 200);
export async function startApi(env: Record<string, string> = {}): Promise<Proc & { url: string; port: number }> {
  const port = nextPort++;
  const p = spawnProc(`api:${port}`, join(ROOT, "apps/api"), "src/server.ts", { API_PORT: String(port), ...env });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`API on ${port}`, async () => (p.child.exitCode !== null ? Promise.reject(new Error(p.logs.join(""))) : (await fetch(`${url}/health`)).ok), 60_000);
  return Object.assign(p, { url, port });
}

/** Minimal cookie-carrying JSON client for one signed-in user. */
export class Client {
  cookie = "";
  orgId = "";
  userId = "";
  constructor(public base: string) {}

  async signup(org = "Acme"): Promise<this> {
    const res = await fetch(`${this.base}/api/v1/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `u${randomBytes(4).toString("hex")}@example.com`, password: "correct horse battery", name: "Tester", organizationName: org }),
    });
    if (res.status !== 201) throw new Error(`signup ${res.status}: ${await res.text()}`);
    this.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const body = (await res.json()) as { user: { id: string }; organization: { id: string } };
    this.orgId = body.organization.id;
    this.userId = body.user.id;
    return this;
  }

  /** Same session against another API instance. */
  via(base: string): Client {
    const c = new Client(base);
    Object.assign(c, { cookie: this.cookie, orgId: this.orgId, userId: this.userId });
    return c;
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: { cookie: this.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
  get = <T = any>(p: string) => this.req<T>("GET", p);
  post = <T = any>(p: string, b: unknown = {}) => this.req<T>("POST", p, b);
  put = <T = any>(p: string, b: unknown) => this.req<T>("PUT", p, b);

  async agent(overrides: Record<string, unknown> = {}) {
    const r = await this.post("/agents", {
      name: `Agent ${randomBytes(3).toString("hex")}`,
      role: "Test agent",
      instructions: "Answer precisely.",
      provider: "mock",
      model: "mock-scripted",
      allowedTools: ["calculator", "mock_external_action"],
      maxIterations: 6,
      maxRunCostUsd: 1,
      ...overrides,
    });
    if (r.status !== 201) throw new Error(`agent ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body as { id: string };
  }

  async task(agentId: string, instruction: string, extra: Record<string, unknown> = {}) {
    const r = await this.post("/tasks", { kind: "single", agentId, title: "durability", instruction, ...extra });
    if (r.status !== 201) throw new Error(`task ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body as { id: string };
  }

  async waitStatus(taskId: string, status: string | string[], timeoutMs = 60_000) {
    const want = Array.isArray(status) ? status : [status];
    return waitFor(`task ${taskId} -> ${want.join("|")}`, async () => {
      const r = await this.get(`/tasks/${taskId}`);
      return r.status === 200 && want.includes(r.body.status) ? r.body : null;
    }, timeoutMs);
  }

  async events(taskId: string): Promise<{ seq: string; type: string; payload: Record<string, unknown> }[]> {
    return (await this.get(`/tasks/${taskId}/events`)).body;
  }
}

/** Server-Sent Events reader: collects events from a stream until closed. */
export function openStream(base: string, cookie: string, path: string, lastEventId?: string) {
  const ctl = new AbortController();
  const events: { id: string | null; event: string; data: any }[] = [];
  const done = (async () => {
    const res = await fetch(`${base}/api/v1${path}`, { headers: { cookie, ...(lastEventId ? { "last-event-id": lastEventId } : {}) }, signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id: string | null = null;
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) events.push({ id, event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    close: async () => {
      ctl.abort();
      await done;
    },
  };
}
