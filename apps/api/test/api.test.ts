import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recoverInterruptedTasks, type AppDeps } from "../src/app";
import { api, atlasBody, db, makeApp, resetDb, signup, type Session } from "./helpers";

let app: FastifyInstance;
let deps: AppDeps;
let a: Session;
let b: Session;

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  ({ app, deps } = await makeApp());
  a = await signup(app, "Org A");
  b = await signup(app, "Org B");
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await db().$disconnect();
});

async function createAgent(s: Session, over: Record<string, unknown> = {}) {
  const r = await api(app, s).post("/agents", atlasBody(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; name: string };
}

describe("authentication", () => {
  it("requires a session for API routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in required" } });
  });

  it("logs in, reports the user, and logs out", async () => {
    const email = `login_${Date.now()}@example.com`;
    await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { email, password: "long enough pw", name: "L", organizationName: "L Org" } });
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "wrong password" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: email.toUpperCase(), password: "long enough pw" } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === "agentos_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    const s = { cookie: `agentos_session=${cookie.value}`, orgId: "", userId: "" };
    expect((await api(app, s).get("/auth/me")).body.user.email).toBe(email);
    await api(app, s).post("/auth/logout");
    expect((await api(app, s).get("/auth/me")).status).toBe(401);
  });

  it("stores only a hash of the session token", async () => {
    const token = a.cookie.split("=")[1]!;
    const rows = await db().session.findMany({ where: { userId: a.userId } });
    expect(rows.every((r) => r.tokenHash !== token && r.tokenHash.length === 64)).toBe(true);
  });

  it("rate limits login attempts", async () => {
    const limited = await makeApp({ AUTH_RATE_LIMIT_MAX: "3" });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limited.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "x@example.com", password: "nope" } });
      codes.push(r.statusCode);
    }
    await limited.app.close();
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});

describe("agents", () => {
  it("creates and updates an agent with validation", async () => {
    const agent = await createAgent(a);
    const get = await api(app, a).get(`/agents/${agent.id}`);
    expect(get.body).toMatchObject({ name: "Atlas", provider: "mock", isMock: true, providerConfigured: true, allowedTools: ["calculator", "current_datetime"] });

    const skills = (await api(app, a).get("/skills")).body as { id: string; name: string }[];
    const verification = skills.find((s) => s.name === "verification")!;
    const upd = await api(app, a).patch(`/agents/${agent.id}`, { maxIterations: 3, skillIds: [verification.id], allowedTools: ["calculator"] });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ maxIterations: 3, allowedTools: ["calculator"], skills: [{ name: "verification", version: 1 }] });

    expect((await api(app, a).post("/agents", atlasBody({ allowedTools: ["shell"] }))).body.error.code).toBe("invalid_tools");
    expect((await api(app, a).post("/agents", atlasBody({ name: "X", model: "gpt-99" }))).body.error.code).toBe("invalid_model");
    expect((await api(app, a).post("/agents", atlasBody({ maxIterations: 999 }))).status).toBe(400);
    expect((await api(app, a).post("/agents", atlasBody())).status).toBe(409);
    const audit = (await api(app, a).get("/audit")).body as { action: string }[];
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["agent.created", "agent.updated"]));
  });

  it("isolates agents between organizations", async () => {
    const agent = await createAgent(a);
    expect((await api(app, b).get(`/agents/${agent.id}`)).status).toBe(404);
    expect((await api(app, b).patch(`/agents/${agent.id}`, { name: "Hijacked" })).status).toBe(404);
    expect((await api(app, b).get("/agents")).body).toEqual([]);
    expect((await api(app, b).post("/tasks", { kind: "single", agentId: agent.id, title: "t", instruction: "1+1" })).status).toBe(404);
    // b cannot attach a's skill
    const aSkill = ((await api(app, a).get("/skills")).body as { id: string }[])[0]!;
    expect((await api(app, b).post("/agents", atlasBody({ skillIds: [aSkill.id] }))).body.error.code).toBe("invalid_skills");
  });
});

describe("providers", () => {
  it("shows unconfigured providers and never returns keys", async () => {
    const list = (await api(app, a).get("/providers")).body as { id: string; configured: boolean; isMock: boolean }[];
    expect(list.map((p) => [p.id, p.configured, p.isMock])).toEqual([
      ["openai", false, false],
      ["anthropic", false, false],
      ["xai", false, false],
      ["mock", true, true],
    ]);
    const keyed = await makeApp({}, { get: (k) => (k === "XAI_API_KEY" ? "xai-super-secret" : undefined) });
    const s = await signup(keyed.app);
    const res = await keyed.app.inject({ method: "GET", url: "/api/v1/providers", headers: { cookie: s.cookie } });
    expect(res.body).not.toContain("xai-super-secret");
    expect((res.json() as { id: string; configured: boolean }[]).find((p) => p.id === "xai")?.configured).toBe(true);
    await keyed.app.close();
  });

  it("refuses to start tasks on unconfigured providers", async () => {
    const agent = await createAgent(a, { name: "Claude agent", provider: "anthropic", model: "claude-opus-5-5" });
    const r = await api(app, a).post("/tasks", { kind: "single", agentId: agent.id, title: "t", instruction: "hi" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("provider_not_configured");
  });
});

describe("task execution", () => {
  it("runs Atlas end to end and persists conversation, run, tool calls and events", async () => {
    const atlas = await createAgent(a);
    const created = await api(app, a).post("/tasks", { kind: "single", agentId: atlas.id, title: "Math", instruction: "What is (17 * 23) + 4?" });
    expect(created.status).toBe(201);
    await deps.workflow.idle();

    const task = (await api(app, a).get(`/tasks/${created.body.id}`)).body;
    expect(task).toMatchObject({ status: "completed", agent: { name: "Atlas" } });
    expect(task.result).toContain("Final answer: 395");
    expect(task.runs).toHaveLength(1);
    expect(task.runs[0]).toMatchObject({ status: "completed", iterations: 2, isMock: true });
    expect(task.runs[0].toolCalls).toEqual([expect.objectContaining({ toolName: "calculator", status: "succeeded", output: { expression: "(17 * 23) + 4", result: 395 } })]);

    const conv = (await api(app, a).get(`/conversations/${task.conversationId}`)).body;
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    const events = (await api(app, a).get(`/tasks/${task.id}/events`)).body as { type: string; seq: string }[];
    expect(events.map((e) => e.type)).toEqual([
      "task.created",
      "run.started",
      "task.status",
      "usage.recorded",
      "model.output",
      "tool.requested",
      "tool.completed",
      "usage.recorded",
      "model.output",
      "run.completed",
      "task.status",
    ]);
    const seqs = events.map((e) => BigInt(e.seq));
    expect([...seqs].sort((x, y) => (x < y ? -1 : 1))).toEqual(seqs);

    const usage = (await api(app, a).get("/usage/summary")).body;
    expect(usage.total.modelCalls).toBe(2);
    expect(usage.byModel[0]).toMatchObject({ provider: "mock", isMock: true, priceSource: "mock" });
    expect((await api(app, a).get("/dashboard")).body.tasks.completed).toBe(1);

    // Org B sees nothing.
    expect((await api(app, b).get(`/tasks/${task.id}`)).status).toBe(404);
    expect((await api(app, b).get(`/tasks/${task.id}/events`)).status).toBe(404);
    expect((await api(app, b).get(`/conversations/${task.conversationId}`)).status).toBe(404);
    expect((await api(app, b).get("/usage/summary")).body.total.modelCalls).toBe(0);
  });

  it("records unauthorized tool requests as rejected", async () => {
    const atlas = await createAgent(a);
    const t = await api(app, a).post("/tasks", { kind: "single", agentId: atlas.id, title: "t", instruction: "[mock:unknown_tool]" });
    await deps.workflow.idle();
    const task = (await api(app, a).get(`/tasks/${t.body.id}`)).body;
    expect(task.runs[0].toolCalls[0]).toMatchObject({ toolName: "shell_exec", status: "rejected" });
  });

  it("supports idempotent task creation", async () => {
    const atlas = await createAgent(a);
    const body = { kind: "single", agentId: atlas.id, title: "Once", instruction: "2 + 2" };
    const first = await api(app, a).post("/tasks", body, { "idempotency-key": "k-1" });
    const second = await api(app, a).post("/tasks", body, { "idempotency-key": "k-1" });
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body.id).toBe(first.body.id);
    expect((await api(app, a).post("/tasks", { ...body, title: "Different" }, { "idempotency-key": "k-1" })).status).toBe(409);
    await deps.workflow.idle();
    expect(await db().task.count({ where: { organizationId: a.orgId, title: "Once" } })).toBe(1);
  });

  it("cancels a running task", async () => {
    const atlas = await createAgent(a);
    const t = await api(app, a).post("/tasks", { kind: "single", agentId: atlas.id, title: "slow", instruction: "[mock:slow]" });
    await waitFor(() => deps.engine.isActive(t.body.id));
    const c = await api(app, a).post(`/tasks/${t.body.id}/cancel`);
    expect(c.status).toBe(202);
    await deps.workflow.idle();
    const task = (await api(app, a).get(`/tasks/${t.body.id}`)).body;
    expect(task.status).toBe("cancelled");
    expect(task.runs[0].status).toBe("cancelled");
    expect((await api(app, b).post(`/tasks/${t.body.id}/cancel`)).status).toBe(404);
  });

  it("retries a task that failed with a retryable error", async () => {
    const atlas = await createAgent(a);
    const t = await api(app, a).post("/tasks", { kind: "single", agentId: atlas.id, title: "flaky", instruction: "[mock:error=rate_limit]" });
    await deps.workflow.idle();
    const failed = (await api(app, a).get(`/tasks/${t.body.id}`)).body;
    expect(failed).toMatchObject({ status: "failed", failureCode: "provider_retryable_error", retryable: true });
    const retry = await api(app, a).post(`/tasks/${t.body.id}/retry`);
    expect(retry.status).toBe(201);
    expect(retry.body.retryOfId).toBe(t.body.id);
    await deps.workflow.idle();

    // Hitting an enforced limit is not retryable: the agent config must change first.
    const loop = await api(app, a).post("/tasks", { kind: "single", agentId: atlas.id, title: "loop", instruction: "[mock:loop]" });
    await deps.workflow.idle();
    expect((await api(app, a).get(`/tasks/${loop.body.id}`)).body).toMatchObject({ failureCode: "iteration_limit", retryable: false });
    expect((await api(app, a).post(`/tasks/${loop.body.id}/retry`)).status).toBe(409);
  });

  it("marks interrupted runs as failed and retryable on boot", async () => {
    const atlas = await createAgent(a);
    const task = await db().task.create({ data: { organizationId: a.orgId, kind: "single", title: "orphan", instruction: "x", status: "running", agentId: atlas.id } });
    expect(await recoverInterruptedTasks(db())).toBeGreaterThanOrEqual(1);
    const t = (await api(app, a).get(`/tasks/${task.id}`)).body;
    expect(t).toMatchObject({ status: "failed", failureCode: "interrupted", retryable: true });
  });
});

describe("approvals", () => {
  async function waitingTask() {
    const ops = await createAgent(a, { name: "Ops", allowedTools: ["mock_external_action"] });
    const t = await api(app, a).post("/tasks", { kind: "single", agentId: ops.id, title: "notify", instruction: "[mock:approval] tell ops" });
    await deps.workflow.idle();
    const approvals = (await api(app, a).get("/approvals?status=pending")).body;
    return { taskId: t.body.id as string, approval: approvals[0] };
  }

  it("pauses for approval, then executes after approval", async () => {
    const { taskId, approval } = await waitingTask();
    expect((await api(app, a).get(`/tasks/${taskId}`)).body.status).toBe("awaiting_approval");
    expect(approval).toMatchObject({ toolName: "mock_external_action", risk: "sensitive", agent: { name: "Ops" }, arguments: { target: "ops-channel" } });
    expect(approval.reason).toContain("notify the ops channel");

    expect((await api(app, b).post(`/approvals/${approval.id}/decision`, { decision: "approve" })).status).toBe(404);
    const d = await api(app, a).post(`/approvals/${approval.id}/decision`, { decision: "approve", note: "ok" });
    expect(d.body).toMatchObject({ status: "approved", idempotent: false });
    await deps.workflow.idle();
    const task = (await api(app, a).get(`/tasks/${taskId}`)).body;
    expect(task.status).toBe("completed");
    expect(task.runs[0].toolCalls[0]).toMatchObject({ status: "succeeded", output: { mock: true, status: "simulated" } });

    expect((await api(app, a).post(`/approvals/${approval.id}/decision`, { decision: "approve" })).body.idempotent).toBe(true);
    expect((await api(app, a).post(`/approvals/${approval.id}/decision`, { decision: "reject" })).status).toBe(409);
    const audit = (await api(app, a).get("/audit")).body as { action: string }[];
    expect(audit.map((x) => x.action)).toContain("approval.approved");
  });

  it("rejection is returned to the agent and the tool never runs", async () => {
    const { taskId, approval } = await waitingTask();
    await api(app, a).post(`/approvals/${approval.id}/decision`, { decision: "reject", note: "change freeze" });
    await deps.workflow.idle();
    const task = (await api(app, a).get(`/tasks/${taskId}`)).body;
    expect(task.status).toBe("completed");
    expect(task.runs[0].toolCalls[0]).toMatchObject({ status: "approval_rejected", output: null });
    expect(task.result).toContain("change freeze");
  });
});

describe("two-agent pipeline", () => {
  it("hands structured output from Atlas to Vega", async () => {
    const atlas = await createAgent(a);
    const vega = await createAgent(a, { name: "Vega", role: "Writer", allowedTools: [] });
    const r = await api(app, a).post("/tasks", {
      kind: "pipeline",
      title: "Report",
      instruction: "Prepare the revenue note",
      steps: [
        { agentId: atlas.id, instruction: "Compute 1250 * 12" },
        { agentId: vega.id, instruction: "Summarize the number for leadership" },
      ],
    });
    expect(r.status).toBe(201);
    await deps.workflow.idle();
    const task = (await api(app, a).get(`/tasks/${r.body.id}`)).body;
    expect(task.status).toBe("completed");
    expect(task.children.map((c: { agent: { name: string }; status: string }) => [c.agent.name, c.status])).toEqual([
      ["Atlas", "completed"],
      ["Vega", "completed"],
    ]);
    expect(task.children[1].handoffInput).toMatchObject({ fromAgentName: "Atlas" });
    expect(task.result).toContain("15000");
    const types = ((await api(app, a).get(`/tasks/${task.id}/events`)).body as { type: string }[]).map((e) => e.type);
    expect(types).toContain("agent.handoff");
    expect(types.filter((t) => t === "run.completed")).toHaveLength(3);
  });

  it("rejects pipelines with the wrong number of steps", async () => {
    const atlas = await createAgent(a);
    const r = await api(app, a).post("/tasks", { kind: "pipeline", title: "x", instruction: "x", steps: [{ agentId: atlas.id, instruction: "x" }] });
    expect(r.status).toBe(400);
  });
});

describe("chat", () => {
  it("streams a chat answer into the conversation", async () => {
    const atlas = await createAgent(a);
    const conv = (await api(app, a).post(`/agents/${atlas.id}/conversations`, {})).body;
    const sent = await api(app, a).post(`/conversations/${conv.id}/messages`, { content: "What is 9 * 9?" });
    expect(sent.status).toBe(202);
    await deps.workflow.idle();
    const c = (await api(app, a).get(`/conversations/${conv.id}`)).body;
    expect(c.messages.at(-1).content).toContain("Final answer: 81");
    const second = await api(app, a).post(`/conversations/${conv.id}/messages`, { content: "Thanks" });
    expect(second.status).toBe(202);
    await deps.workflow.idle();
    expect((await api(app, a).get(`/agents/${atlas.id}/conversations`)).body).toHaveLength(1);
  });
});

describe("server-sent events", () => {
  it("replays persisted events after Last-Event-ID and then streams live ones", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const atlas = await createAgent(a);
    const t = await api(app, a).post("/tasks", { kind: "single", agentId: atlas.id, title: "sse", instruction: "What is 3 * 3?" });
    await deps.workflow.idle();
    const all = (await api(app, a).get(`/tasks/${t.body.id}/events`)).body as { seq: string; type: string }[];
    const mid = all[4]!.seq;

    // Reconnect with Last-Event-ID: receive exactly the events after `mid`.
    const replayed = await readSse(`${base}/api/v1/tasks/${t.body.id}/events/stream`, { cookie: a.cookie, "last-event-id": mid }, (evs) => evs.some((e) => e.event === "replay.done"));
    const ids = replayed.filter((e) => e.id).map((e) => e.id);
    expect(ids).toEqual(all.slice(5).map((e) => e.seq));

    // Other organizations are refused.
    const denied = await fetch(`${base}/api/v1/tasks/${t.body.id}/events/stream`, { headers: { cookie: b.cookie } });
    expect(denied.status).toBe(404);

    // Live: subscribe to the org stream, then start a task and observe completion.
    const t2Promise = (async () => {
      await new Promise((r) => setTimeout(r, 150));
      return api(app, a).post("/tasks", { kind: "single", agentId: atlas.id, title: "live", instruction: "What is 4 * 4?" });
    })();
    const live = await readSse(`${base}/api/v1/events/stream?after=${all.at(-1)!.seq}`, { cookie: a.cookie }, (evs) =>
      evs.some((e) => e.event === "run.completed"),
    );
    const t2 = await t2Promise;
    // The org-wide feed carries persisted events only; token deltas go to task streams.
    expect(live.every((e) => e.event === "replay.done" || e.id)).toBe(true);
    const completed = live.find((e) => e.event === "run.completed")!;
    expect(JSON.parse(completed.data)).toMatchObject({ taskId: t2.body.id, payload: { result: expect.stringContaining("16") } });
    await deps.workflow.idle();
  });
});

interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

async function readSse(url: string, headers: Record<string, string>, until: (evs: SseEvent[]) => boolean, timeoutMs = 8000): Promise<SseEvent[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const res = await fetch(url, { headers, signal: ctl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: SseEvent[] = [];
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev: SseEvent = { data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) ev.id = line.slice(4);
          else if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data += line.slice(6);
        }
        if (ev.event) events.push(ev);
      }
    }
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return events;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
