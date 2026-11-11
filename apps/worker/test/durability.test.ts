/* eslint-disable @typescript-eslint/no-explicit-any -- black-box HTTP tests read untyped JSON responses */
import { Client as TemporalClient, Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { WORKFLOWS_PATH } from "@agentos/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_ENV, Client, db, ledgerLines, openStream, resetDb, startApi, startWorker, waitFor, type Proc } from "./harness";

/**
 * Durability scenarios on real infrastructure (Postgres + Temporal + separate worker
 * and API processes). The model is the deterministic MOCK provider so every
 * recovery path is reproducible; nothing here is an AI-quality test.
 */
let worker: Proc;
let api: Awaited<ReturnType<typeof startApi>>;
let a: Client;
let agentId: string;

const toolCallsOf = (task: any) => (task.runs as any[]).flatMap((r) => r.toolCalls as any[]);

beforeAll(async () => {
  await resetDb();
  worker = await startWorker();
  api = await startApi();
  a = await new Client(api.url).signup("Durable Inc");
  agentId = (await a.agent()).id;
});

afterAll(async () => {
  await api?.kill("SIGTERM");
  await worker?.kill("SIGTERM");
  await db().$disconnect();
});

describe("durable execution", () => {
  it("runs a task on the worker, not in the API, and records the workflow id", async () => {
    const t = await a.task(agentId, "What is (17 * 23) + 4?");
    const done = await a.waitStatus(t.id, "completed");
    expect(done.result).toContain("395");
    expect(done.workflowId).toBe(`task-${t.id}`);
    const wf = await a.get(`/tasks/${t.id}/workflow`);
    expect(wf.body.workflow.engine).toBe("temporal");
    expect(wf.body.workflow.status).toBe("COMPLETED");
    expect(api.logs.join("")).not.toContain('"event":"model_call"'); // the API never called the model
    expect(worker.logs.join("")).toContain('"event":"model_call"');
  });

  it("1. API restart while a task is running: the task completes and is visible through the new API", async () => {
    const t = await a.task(agentId, "[mock:slow] What is 6 * 7?");
    await a.waitStatus(t.id, "running");
    await api.kill("SIGKILL");
    api = await startApi();
    a = a.via(api.url);
    const done = await a.waitStatus(t.id, "completed");
    expect(done.result).toContain("42");
    expect(done.failureCode).toBeNull();
  });

  it("2. worker killed mid model call: another worker picks the step up and the task completes", async () => {
    const t = await a.task(agentId, "[mock:slow] What is 2 + 3?");
    await waitFor("model call in flight", async () => (await a.get(`/tasks/${t.id}/workflow`)).body.workflow?.pendingActivities?.some((x: any) => x.activityType === "modelTurn"));
    await worker.kill("SIGKILL");
    worker = await startWorker();
    const done = await a.waitStatus(t.id, "completed", 90_000);
    expect(done.result).toContain("5");
    const retries = (await a.events(t.id)).filter((e) => e.type === "activity.retry");
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries[0]!.payload).toMatchObject({ activity: "modelTurn" });
    // The killed attempt never produced a response, so exactly one usage record and one assistant turn.
    const usage = await db().usageRecord.count({ where: { runId: done.runs[0].id } });
    expect(usage).toBe(2); // tool turn + final answer
  });

  it("3 + 4. an approval survives restarting both API and worker, then resumes on approve", async () => {
    const before = ledgerLines().length;
    const t = await a.task(agentId, "[mock:approval] Notify ops");
    await a.waitStatus(t.id, "awaiting_approval");
    await api.kill("SIGKILL");
    await worker.kill("SIGKILL");
    worker = await startWorker();
    api = await startApi();
    a = a.via(api.url);
    const pending = (await a.get("/approvals?status=pending")).body.find((x: any) => x.task.id === t.id);
    expect(pending).toBeTruthy();
    const d = await a.post(`/approvals/${pending.id}/decision`, { decision: "approve" });
    expect(d.status).toBe(200);
    const done = await a.waitStatus(t.id, "completed");
    expect(toolCallsOf(done).find((c) => c.toolName === "mock_external_action")?.status).toBe("succeeded");
    expect(ledgerLines().length - before).toBe(1);
  });

  it("5. rejection: the tool never runs and the model is told it was rejected", async () => {
    const before = ledgerLines().length;
    const t = await a.task(agentId, "[mock:approval] Notify ops");
    await a.waitStatus(t.id, "awaiting_approval");
    const pending = (await a.get("/approvals?status=pending")).body.find((x: any) => x.task.id === t.id);
    expect((await a.post(`/approvals/${pending.id}/decision`, { decision: "reject", note: "not now" })).status).toBe(200);
    const done = await a.waitStatus(t.id, "completed");
    const call = toolCallsOf(done).find((c) => c.toolName === "mock_external_action");
    expect(call.status).toBe("approval_rejected");
    expect(done.result).toContain("reported an error");
    expect(ledgerLines().length).toBe(before);
    // A second, different decision on the same approval is a conflict; a stale one too.
    expect((await a.post(`/approvals/${pending.id}/decision`, { decision: "approve" })).status).toBe(409);
  });

  it("6. sequential multi-agent pipeline runs each step as a child workflow with a handoff", async () => {
    const reviewer = await a.agent({ name: "Reviewer", allowedTools: ["current_datetime"] });
    const r = await a.post("/tasks", {
      kind: "pipeline",
      title: "pipeline",
      instruction: "What is 12 * 12?",
      steps: [
        { agentId, instruction: "Compute it." },
        { agentId: reviewer.id, instruction: "Review the result." },
      ],
    });
    expect(r.status).toBe(201);
    const done = await a.waitStatus(r.body.id, "completed");
    expect(done.children.map((c: any) => c.status)).toEqual(["completed", "completed"]);
    expect(done.result).toContain("Reviewed the handoff");
    expect((await a.events(r.body.id)).some((e) => e.type === "agent.handoff")).toBe(true);
    const wf = await a.get(`/tasks/${r.body.id}/workflow`);
    expect(wf.body.children.map((c: any) => c.workflow.status)).toEqual(["COMPLETED", "COMPLETED"]);
  });

  it("7. cancellation stops a running model call, a waiting approval and a running pipeline", async () => {
    const slow = await a.task(agentId, "[mock:slow] What is 1 + 1?");
    await a.waitStatus(slow.id, "running");
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    expect((await a.post(`/tasks/${slow.id}/cancel`)).status).toBe(202);
    const c1 = await a.waitStatus(slow.id, "cancelled", 15_000);
    expect(Date.now() - started).toBeLessThan(4_000); // did not wait for the 4 s model call
    expect(c1.runs[0].status).toBe("cancelled");

    const waiting = await a.task(agentId, "[mock:approval] Notify ops");
    await a.waitStatus(waiting.id, "awaiting_approval");
    await a.post(`/tasks/${waiting.id}/cancel`);
    await a.waitStatus(waiting.id, "cancelled");
    const appr = (await a.get("/approvals")).body.find((x: any) => x.task.id === waiting.id);
    expect(appr.status).toBe("rejected");
    // A decision on the cancelled task's approval is stale.
    expect((await a.post(`/approvals/${appr.id}/decision`, { decision: "approve" })).status).toBe(409);

    const reviewer = await a.agent({ name: "Reviewer2", allowedTools: ["current_datetime"] });
    const p = await a.post("/tasks", {
      kind: "pipeline",
      title: "pipeline",
      instruction: "[mock:slow] What is 3 * 3?",
      steps: [
        { agentId, instruction: "Compute." },
        { agentId: reviewer.id, instruction: "Review." },
      ],
    });
    await waitFor("first step running", async () => (await a.get(`/tasks/${p.body.id}`)).body.children?.[0]?.status === "running");
    await a.post(`/tasks/${p.body.id}/cancel`);
    const pc = await a.waitStatus(p.body.id, "cancelled", 20_000);
    expect(pc.children.map((c: any) => c.status)).toEqual(["cancelled", "skipped"]);
    const wf = await a.get(`/tasks/${p.body.id}/workflow`);
    expect(wf.body.workflow.status).not.toBe("RUNNING");
  });

  it("8. a recoverable provider failure is retried and the task completes", async () => {
    const t = await a.task(agentId, "[mock:flaky] What is 9 + 10?");
    const done = await a.waitStatus(t.id, "completed");
    expect(done.result).toContain("19");
    const retries = (await a.events(t.id)).filter((e) => e.type === "model.retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]!.payload).toMatchObject({ attempt: 1, error: { code: "PROVIDER_RATE_LIMIT" } });
  });

  it("9. a side-effecting tool interrupted by a worker crash is never executed twice", async () => {
    // This worker holds the action open for 8 s so it can be killed mid-execution.
    await worker.kill("SIGTERM");
    worker = await startWorker({ AGENTOS_MOCK_ACTION_DELAY_MS: "8000" });
    const before = ledgerLines().length;
    const t = await a.task(agentId, "[mock:approval] Notify ops");
    await a.waitStatus(t.id, "awaiting_approval");
    const pending = (await a.get("/approvals?status=pending")).body.find((x: any) => x.task.id === t.id);
    await a.post(`/approvals/${pending.id}/decision`, { decision: "approve" });
    await waitFor("side effect started", async () => ledgerLines().length > before);
    await worker.kill("SIGKILL");
    worker = await startWorker();
    const done = await a.waitStatus(t.id, "completed", 90_000);
    const call = toolCallsOf(done).find((c) => c.toolName === "mock_external_action");
    expect(call.status).toBe("failed");
    expect(call.error).toContain("Outcome unknown");
    expect(ledgerLines().length - before).toBe(1); // executed exactly once
    expect((await a.events(t.id)).some((e) => e.type === "activity.retry" && e.payload.activity === "toolStep")).toBe(true);
  });

  it("enforces a per-task spending limit across the whole run", async () => {
    const t = await a.task(agentId, "[mock:loop] count", { maxCostUsd: 0.000001 });
    const done = await a.waitStatus(t.id, "failed");
    expect(done.failureCode).toBe("budget_exceeded");
    expect(done.maxCostUsd).toBe(0.000001);
  });

  it("reports worker health, metrics and diagnostics", async () => {
    const h = await a.get("/system/health");
    expect(h.body.engine).toBe("temporal");
    expect(h.body.temporal.reachable).toBe(true);
    expect(h.body.temporal.workflowPollers).toBeGreaterThanOrEqual(1);
    expect(h.body.healthyWorkers).toBeGreaterThanOrEqual(1);
    expect(h.body.events.listenerConnected).toBe(true);
    const m = await a.get("/system/metrics");
    expect(m.body.modelLatencyMs.find((x: any) => x.provider === "mock").samples).toBeGreaterThan(0);
    expect(m.body.retries.activity).toBeGreaterThanOrEqual(1);
    const d = await a.get("/system/diagnostics");
    expect(d.status).toBe(200);
    expect(d.body.issues.filter((i: any) => i.kind === "no_healthy_worker")).toHaveLength(0);
  });
});

describe("multi-instance realtime events", () => {
  it("12 + 13. a second API instance streams live events produced by the worker, and replays after reconnect", async () => {
    const b = await startApi();
    try {
      const t = await a.task(agentId, "[mock:slow] What is 20 + 22?");
      const sb = openStream(b.url, a.cookie, `/tasks/${t.id}/events/stream`);
      await a.waitStatus(t.id, "completed");
      await waitFor("run.completed on instance B", async () => sb.events.some((e) => e.event === "run.completed"));
      await sb.close();
      // SSE ids are resume cursors "<watermark>.<seq>" since milestone 2C.
      const seqOf = (id: string) => id.split(".").at(-1)!;
      const persisted = sb.events.filter((e) => e.id !== null && e.event !== "replay.done");
      for (const e of persisted) expect(e.id).toMatch(/^\d+\.\d+$/);
      const seqs = persisted.map((e) => BigInt(seqOf(e.id!)));
      expect(new Set(seqs.map(String)).size).toBe(seqs.length); // no duplicates
      expect([...seqs].sort((x, y) => (x < y ? -1 : 1))).toEqual(seqs); // in order
      expect(sb.events.some((e) => e.event === "model.delta")).toBe(true); // live-only deltas crossed processes
      const all = await a.events(t.id);
      expect(persisted.map((e) => seqOf(e.id!))).toEqual(all.map((e) => e.seq));

      // Reconnect with a legacy numeric Last-Event-ID from the middle: only later events, once each.
      const mid = all[Math.floor(all.length / 2)]!.seq;
      const replay = openStream(b.url, a.cookie, `/tasks/${t.id}/events/stream`, mid);
      await waitFor("replay done", async () => replay.events.some((e) => e.event === "replay.done"));
      await replay.close();
      const replayed = replay.events.filter((e) => e.id && e.event !== "replay.done").map((e) => seqOf(e.id!));
      expect(replayed).toEqual(all.filter((e) => BigInt(e.seq) > BigInt(mid)).map((e) => e.seq));

      // Reconnect with the stream's own resume cursor: nothing committed is missing (repeats allowed, deduped by seq).
      const cursor = sb.events.filter((e) => e.id).at(-1)!.id!;
      const resumed = openStream(b.url, a.cookie, `/tasks/${t.id}/events/stream`, cursor);
      await waitFor("cursor replay done", async () => resumed.events.some((e) => e.event === "replay.done"));
      await resumed.close();
      const union = new Set([...persisted, ...resumed.events.filter((e) => e.id && e.event !== "replay.done")].map((e) => seqOf(e.id!)));
      expect([...union].sort()).toEqual(all.map((e) => e.seq).sort());

      // The LISTEN connection is dropped by the database: the instance reconnects and catches up.
      const live = openStream(b.url, a.cookie, "/events/stream");
      await new Promise((r) => setTimeout(r, 500));
      await db().$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
      const t2 = await a.task(agentId, "What is 5 * 5?");
      await a.waitStatus(t2.id, "completed");
      await waitFor("org stream sees the task after listener reconnect", async () => live.events.some((e) => e.event === "run.completed" && e.data.taskId === t2.id), 20_000);
      await live.close();
    } finally {
      await b.kill("SIGTERM");
    }
  });
});

describe("determinism", () => {
  it("every recorded workflow history (including crash and retry runs) replays against the current workflow code", async () => {
    const connection = await Connection.connect({ address: BASE_ENV.TEMPORAL_ADDRESS });
    try {
      const client = new TemporalClient({ connection });
      const ids = (await db().task.findMany({ where: { workflowId: { not: null } }, select: { workflowId: true } })).map((t) => t.workflowId!);
      const children = (await db().task.findMany({ where: { parentTaskId: { not: null } }, select: { id: true } })).map((t) => `task-${t.id}`);
      const histories = [];
      for (const workflowId of [...ids, ...children]) {
        try {
          histories.push({ workflowId, history: await client.workflow.getHandle(workflowId).fetchHistory() });
        } catch {
          // skipped steps never ran
        }
      }
      expect(histories.length).toBeGreaterThanOrEqual(10);
      let replayed = 0;
      for await (const r of Worker.runReplayHistories({ workflowsPath: WORKFLOWS_PATH }, histories)) {
        expect(r.error, `${r.workflowId}: ${String(r.error)}`).toBeUndefined();
        replayed++;
      }
      expect(replayed).toBe(histories.length);
    } finally {
      await connection.close();
    }
  });
});
