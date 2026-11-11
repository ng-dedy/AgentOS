/* eslint-disable @typescript-eslint/no-explicit-any -- black-box HTTP tests read untyped JSON responses */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { Connection } from "@temporalio/client";
import { bundleWorkflowCode, NativeConnection, Worker } from "@temporalio/worker";
import { connectWithRetry, TemporalConnectionError, TemporalWorkflowEngine, WORKFLOWS_PATH, type TemporalConnectionConfig } from "@agentos/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_ENV, Client, db, resetDb, startApi, startWorker, TEMPORAL, waitFor } from "./harness";

const FIXTURES = fileURLToPath(new URL("./fixtures/histories-2b", import.meta.url));
const INCOMPATIBLE = fileURLToPath(new URL("../../../packages/workflows/test/fixtures/incompatible-workflows.ts", import.meta.url));
const [TEMPORAL_HOST, TEMPORAL_PORT] = TEMPORAL.split(":") as [string, string];
const noopStore = { getTask: async () => null } as any;

describe("workflow versioning compatibility", () => {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
  const histories = () => fixtures.map((f) => ({ workflowId: f, history: JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) }));

  it("replays every committed milestone 2B history against the current workflow code", async () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    let n = 0;
    for await (const r of Worker.runReplayHistories({ workflowsPath: WORKFLOWS_PATH }, histories())) {
      expect(r.error, `${r.workflowId}: ${String(r.error)}`).toBeUndefined();
      n++;
    }
    expect(n).toBe(fixtures.length);
  });

  it("the pre-built production workflow bundle replays them too", async () => {
    const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} } as never });
    const path = join(mkdtempSync(join(tmpdir(), "agentos-bundle-")), "workflow-bundle.js");
    writeFileSync(path, code);
    let n = 0;
    for await (const r of Worker.runReplayHistories({ workflowBundle: { codePath: path } }, histories())) {
      expect(r.error, `${r.workflowId}: ${String(r.error)}`).toBeUndefined();
      n++;
    }
    expect(n).toBe(fixtures.length);
  });

  it("the same check rejects an incompatible workflow change (the test has teeth)", async () => {
    let failures = 0;
    for await (const r of Worker.runReplayHistories({ workflowsPath: INCOMPATIBLE }, histories())) if (r.error) failures++;
    expect(failures).toBe(fixtures.length);
  });
});

describe("Temporal connection failures", () => {
  it("gives up after the configured attempts with a clear error", async () => {
    const started = Date.now();
    const err = await TemporalWorkflowEngine.connect({
      connection: { address: "127.0.0.1:1", namespace: "agentos-test", connectAttempts: 2, connectTimeoutMs: 1_000 },
      taskQueue: "x",
      store: noopStore,
      recordWorkflowId: async () => undefined,
      finalizeCancel: async () => undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemporalConnectionError);
    expect((err as Error).message).toMatch(/Cannot connect the API to Temporal at 127\.0\.0\.1:1 \(namespace agentos-test\) after 2 attempts/);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("retries with backoff and succeeds once Temporal answers", async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await connectWithRetry(
      "worker",
      { address: TEMPORAL, namespace: "default", connectAttempts: 4 },
      async () => {
        if (++calls < 3) throw new Error("connection refused");
        return "connected";
      },
      undefined,
      async (ms) => void waits.push(ms),
    );
    expect(out).toBe("connected");
    expect(waits).toEqual([500, 1000]);
  });

  it("a worker process that cannot reach Temporal exits non-zero with the reason", async () => {
    const p = startWorker({ TEMPORAL_ADDRESS: "127.0.0.1:1", TEMPORAL_CONNECT_ATTEMPTS: "2", TEMPORAL_CONNECT_TIMEOUT_MS: "1000" });
    const err = await p.catch((e: unknown) => e);
    expect(String(err)).toMatch(/Cannot connect the worker to Temporal at 127\.0\.0\.1:1/);
  });

  it("a worker refuses an unsafe production configuration", async () => {
    const err = await startWorker({ AGENTOS_ENV: "production", AGENTOS_WORKFLOW_ENGINE: "inprocess" }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/Refusing to start the worker in production/);
    expect(String(err)).toMatch(/AGENTOS_KMS_PROVIDER must be 'aws'/);
    expect(String(err)).toMatch(/MOCK provider/);
  });
});

/**
 * TLS and mTLS against a real Temporal server: a TLS-terminating proxy (Node `tls`, ALPN h2)
 * in front of the local dev server, with a throwaway CA. Exercises both the API's client
 * connection and the worker's native (Rust core) connection.
 */
describe("Temporal TLS and mTLS", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentos-tls-"));
  const f = (n: string) => join(dir, n);
  let tlsProxy: TlsServer;
  let mtlsProxy: TlsServer;
  let tlsAddr: string;
  let mtlsAddr: string;

  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const proxy = (mtls: boolean) =>
    new Promise<{ server: TlsServer; addr: string }>((resolve) => {
      const server = createTlsServer(
        {
          key: readFileSync(f("server.key")),
          cert: readFileSync(f("server.crt")),
          ca: readFileSync(f("ca.crt")),
          requestCert: mtls,
          rejectUnauthorized: mtls,
          ALPNProtocols: ["h2"],
        },
        (sock) => {
          const up = netConnect(Number(TEMPORAL_PORT), TEMPORAL_HOST);
          sock.pipe(up).pipe(sock);
          up.on("error", () => sock.destroy());
          sock.on("error", () => up.destroy());
        },
      );
      server.listen(0, "127.0.0.1", () => resolve({ server, addr: `127.0.0.1:${(server.address() as { port: number }).port}` }));
    });

  beforeAll(async () => {
    // X.509 v3 extensions on every certificate: the worker's Rust TLS stack (rustls) rejects v1 certificates.
    writeFileSync(f("server.cnf"), "subjectAltName=DNS:temporal.agentos.test\nextendedKeyUsage=serverAuth\n");
    writeFileSync(f("client.cnf"), "extendedKeyUsage=clientAuth\n");
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=AgentOS Test CA");
    for (const [name, cn] of [["server", "temporal.agentos.test"], ["client", "agentos-worker"]] as const) {
      openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`);
      openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", `${name}.cnf`);
    }
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "other.key", "-out", "other-ca.crt", "-days", "1", "-subj", "/CN=Unrelated CA");
    ({ server: tlsProxy, addr: tlsAddr } = await proxy(false));
    ({ server: mtlsProxy, addr: mtlsAddr } = await proxy(true));
  });
  afterAll(() => {
    tlsProxy?.close();
    mtlsProxy?.close();
  });

  const engine = (connection: TemporalConnectionConfig) =>
    TemporalWorkflowEngine.connect({ connection: { connectAttempts: 1, connectTimeoutMs: 5_000, ...connection }, taskQueue: "tls-check", store: noopStore, recordWorkflowId: async () => undefined, finalizeCancel: async () => undefined });

  it("API client connects over TLS with a custom CA and server name", async () => {
    const e = await engine({ address: tlsAddr, namespace: "default", tls: true, caPath: f("ca.crt"), serverName: "temporal.agentos.test" });
    await e.ping();
    expect(await e.hasPollers()).toEqual({ workflowPollers: 0, activityPollers: 0 });
    await e.close();
  });

  it("refuses a server whose certificate is not from the configured CA", async () => {
    await expect(engine({ address: tlsAddr, namespace: "default", tls: true, caPath: f("other-ca.crt"), serverName: "temporal.agentos.test" })).rejects.toThrow(TemporalConnectionError);
  });

  it("mTLS: without a client certificate the connection is refused; with one, client and worker connect", async () => {
    await expect(engine({ address: mtlsAddr, namespace: "default", tls: true, caPath: f("ca.crt"), serverName: "temporal.agentos.test" })).rejects.toThrow(TemporalConnectionError);
    const cfg: TemporalConnectionConfig = {
      address: mtlsAddr,
      namespace: "default",
      caPath: f("ca.crt"),
      certPath: f("client.crt"),
      keyPath: f("client.key"),
      serverName: "temporal.agentos.test",
      connectAttempts: 1,
    };
    const e = await engine(cfg);
    await e.ping();
    await e.close();
    // The worker's native connection (Rust core) with the same settings.
    const native = await connectWithRetry("worker", cfg, (o) => NativeConnection.connect(o));
    const info = await native.workflowService.getSystemInfo({});
    expect(info.serverVersion).toBeTruthy();
    await native.close();
  });
});

describe("worker deployment versioning", () => {
  it("a worker started with versioning registers its deployment version with Temporal", async () => {
    const deploymentName = `agentos-worker-test-${Date.now()}`;
    const w = await startWorker({
      TEMPORAL_WORKER_VERSIONING: "true",
      TEMPORAL_WORKER_DEPLOYMENT_NAME: deploymentName,
      TEMPORAL_WORKER_BUILD_ID: "build-2c-test",
      TEMPORAL_TASK_QUEUE: `versioned-${Date.now()}`,
    });
    try {
      expect(w.logs.join("")).toMatch(/"versioning":true/);
      const connection = await Connection.connect({ address: TEMPORAL });
      try {
        const d = await waitFor(
          "deployment registered",
          async () => {
            const r = await connection.workflowService.describeWorkerDeployment({ namespace: "default", deploymentName });
            return r.workerDeploymentInfo?.versionSummaries?.length ? r : null;
          },
          30_000,
          500,
        );
        const ids = (d.workerDeploymentInfo!.versionSummaries ?? []).map((v) => v.deploymentVersion?.buildId ?? v.version);
        expect(ids.join(",")).toContain("build-2c-test");
      } finally {
        await connection.close();
      }
    } finally {
      await w.kill("SIGTERM");
    }
  });
});

describe("worker shutdown and recovery (real processes)", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let a: Client;
  let agentId: string;
  beforeAll(async () => {
    await resetDb();
    api = await startApi();
    a = await new Client(api.url).signup("Shutdown Inc");
    agentId = (await a.agent()).id;
  });
  afterAll(async () => {
    await api?.kill("SIGTERM");
    await db().$disconnect();
  });

  it("SIGTERM drains: readiness drops at once, the in-flight step finishes, the process exits 0, a new worker completes the task", async () => {
    const port = 5200 + Math.floor(Math.random() * 200);
    const w1 = await startWorker({ WORKER_HEALTH_PORT: String(port), WORKER_SHUTDOWN_GRACE_MS: "20000", AGENTOS_METRICS_TOKEN: "w".repeat(40) });
    const health = (p: string, h: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers: h });
    await waitFor("worker ready", async () => (await health("/readyz")).ok);
    expect((await health("/livez")).status).toBe(200);
    expect((await health("/metrics")).status).toBe(401);
    expect(await (await health("/metrics", { authorization: `Bearer ${"w".repeat(40)}` })).text()).toMatch(/agentos_worker_active_activities/);

    const t = await a.task(agentId, "[mock:slow] What is 9 * 9?");
    await waitFor("model step in flight", async () => (await a.get(`/tasks/${t.id}/workflow`)).body.workflow?.pendingActivities?.some((x: any) => x.activityType === "modelTurn" && x.state === "STARTED"));

    w1.child.kill("SIGTERM");
    await waitFor("readiness withdrawn", async () => (await health("/readyz").catch(() => ({ status: 0 }) as Response)).status === 503, 5_000, 50);
    const hb = await waitFor("heartbeat says stopping", async () => db().workerHeartbeat.findFirst({ where: { status: "stopping" } }), 5_000);
    expect(hb.status).toBe("stopping");
    expect(await w1.exited).toBe(0);
    const logs = w1.logs.join("");
    expect(logs).toContain('"event":"worker_stopping"');
    expect(logs).toContain('"event":"model_call"'); // the in-flight model step finished during the drain
    expect(logs).not.toContain("worker_shutdown_forced");

    const w2 = await startWorker();
    try {
      const done = await a.waitStatus(t.id, "completed");
      expect(done.result).toContain("81");
      // The drained step was not repeated: one model call per turn.
      const usage = await db().modelCallAttempt.findMany({ where: { taskId: t.id } });
      expect(usage.filter((u) => u.status === "orphaned")).toHaveLength(0);
      expect(usage.every((u) => u.recorded)).toBe(true);
    } finally {
      await w2.kill("SIGTERM");
    }
  });

  it("a worker killed mid-call: the retry on another worker flags possible duplicate billing and the task still completes", async () => {
    const w1 = await startWorker();
    const t = await a.task(agentId, "[mock:slow] What is 7 * 6?");
    await waitFor("model step in flight", async () => (await db().modelCallAttempt.count({ where: { taskId: t.id, status: "reserved" } })) > 0);
    await w1.kill("SIGKILL");
    const w2 = await startWorker();
    try {
      const done = await a.waitStatus(t.id, "completed", 90_000);
      expect(done.result).toContain("42");
      const rows = await db().modelCallAttempt.findMany({ where: { taskId: t.id }, orderBy: [{ turn: "asc" }, { sequence: "asc" }] });
      expect(rows.some((r) => r.status === "orphaned")).toBe(true);
      expect(rows.some((r) => r.possibleDuplicate)).toBe(true);
      const events = await a.events(t.id);
      const dup = events.find((e) => e.type === "billing.possible_duplicate");
      expect(dup?.payload).toMatchObject({ reason: "unsettled_request" });
    } finally {
      await w2.kill("SIGTERM");
    }
  });
});

void BASE_ENV;
