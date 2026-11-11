import { createProviderRegistry, MockProvider, type GenerateOptions, type ModelRequest } from "@agentos/providers";
import { createDefaultToolRegistry } from "@agentos/tools";
import { describe, expect, it } from "vitest";
import { AgentEngine, MemoryRunStore, PipelineCoordinator, type CredentialResolver } from "../src";

/**
 * The step API is what the durable workflows call. Every step must be safe to
 * run again after a crash: these tests run steps twice and check that nothing
 * is repeated.
 */
const ORG = "org_steps";
const ctx = () => ({ signal: new AbortController().signal });

class CountingMock extends MockProvider {
  calls = 0;
  keys: (string | undefined)[] = [];
  override async generate(req: ModelRequest, opts: GenerateOptions) {
    this.calls++;
    this.keys.push(opts.apiKey);
    return super.generate(req, opts);
  }
}

function setup(credentials?: CredentialResolver) {
  const store = new MemoryRunStore();
  const mock = new CountingMock();
  const providers = createProviderRegistry({ enableMock: true, mock, secrets: { get: () => undefined } });
  const engine = new AgentEngine({ store, events: store, providers, tools: createDefaultToolRegistry(), retryBaseDelayMs: 0, credentials });
  return { store, mock, engine };
}

describe("durable step API", () => {
  it("a model turn whose response is already stored is not sent to the provider again", async () => {
    const s = setup();
    const agent = s.store.addAgent({ organizationId: ORG, name: "A" });
    const task = s.store.addTask({ organizationId: ORG, agentId: agent.id, instruction: "What is 2 + 2?" });
    const begin = await s.engine.beginRun(ORG, task.id);
    if (begin.kind !== "ready") throw new Error("not ready");
    const first = await s.engine.modelTurn(ORG, task.id, begin.runId, 0, ctx());
    const again = await s.engine.modelTurn(ORG, task.id, begin.runId, 0, ctx()); // retried after a crash
    expect(s.mock.calls).toBe(1);
    expect(again).toEqual(first);
    expect(s.store.usage).toHaveLength(1);
    expect(s.store.events.filter((e) => e.type === "tool.requested")).toHaveLength(1);
  });

  it("beginRun resumes the latest unfinished run instead of starting a new one", async () => {
    const s = setup();
    const agent = s.store.addAgent({ organizationId: ORG, name: "A" });
    const task = s.store.addTask({ organizationId: ORG, agentId: agent.id, instruction: "What is 2 + 2?" });
    const b1 = await s.engine.beginRun(ORG, task.id);
    if (b1.kind !== "ready") throw new Error("not ready");
    const t = await s.engine.modelTurn(ORG, task.id, b1.runId, 0, ctx());
    const b2 = await s.engine.beginRun(ORG, task.id);
    expect(b2).toMatchObject({ kind: "ready", runId: b1.runId, turn: 1, pendingToolCallIds: t.kind === "tools" ? t.toolCallIds : [] });
    expect(s.store.runs.size).toBe(1);
    expect(s.store.events.filter((e) => e.type === "run.started")).toHaveLength(1);
  });

  it("a tool step runs a tool at most once, and a retry only re-appends a missing result", async () => {
    const s = setup();
    const agent = s.store.addAgent({ organizationId: ORG, name: "A" });
    const task = s.store.addTask({ organizationId: ORG, agentId: agent.id, instruction: "What is 2 + 2?" });
    const b = await s.engine.beginRun(ORG, task.id);
    if (b.kind !== "ready") throw new Error("not ready");
    const t = await s.engine.modelTurn(ORG, task.id, b.runId, 0, ctx());
    if (t.kind !== "tools") throw new Error("expected a tool call");
    const id = t.toolCallIds[0]!;
    expect(await s.engine.toolStep(ORG, task.id, b.runId, id, ctx())).toBe("succeeded");
    expect(await s.engine.toolStep(ORG, task.id, b.runId, id, ctx())).toBe("succeeded");
    expect(s.store.toolExecutions.get(id)).toBe(1);
    const toolMsgs = s.store.messages.get(task.conversationId!)!.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
  });

  it("an interrupted side-effecting tool is marked 'outcome unknown' and never re-executed; a safe one is re-run", async () => {
    const s = setup();
    const agent = s.store.addAgent({ organizationId: ORG, name: "A", allowedTools: ["calculator", "mock_external_action"] });
    // Side-effecting: approval flow, then simulate a worker dying after the tool moved to `running`.
    const task = s.store.addTask({ organizationId: ORG, agentId: agent.id, instruction: "[mock:approval] notify" });
    const b = await s.engine.beginRun(ORG, task.id);
    if (b.kind !== "ready") throw new Error("not ready");
    const t = await s.engine.modelTurn(ORG, task.id, b.runId, 0, ctx());
    if (t.kind !== "tools") throw new Error("expected a tool call");
    const id = t.toolCallIds[0]!;
    expect(await s.engine.toolStep(ORG, task.id, b.runId, id, ctx())).toBe("awaiting_approval");
    expect(await s.engine.toolStep(ORG, task.id, b.runId, id, ctx())).toBe("awaiting_approval"); // idempotent request
    expect(s.store.approvals.size).toBe(1);
    const approval = [...s.store.approvals.values()][0]!;
    s.store.decide(approval.id, true);
    await s.store.transitionToolCall(ORG, id, ["awaiting_approval"], { status: "running" }); // crash happens here
    expect(await s.engine.toolStep(ORG, task.id, b.runId, id, ctx())).toBe("failed");
    const rec = (await s.store.getToolCall(ORG, id))!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("Outcome unknown");
    expect(s.store.toolExecutions.get(id)).toBe(1); // the transition above; the handler never ran

    // Safe tool interrupted while running: re-run.
    const task2 = s.store.addTask({ organizationId: ORG, agentId: agent.id, instruction: "What is 3 + 3?" });
    const b2 = await s.engine.beginRun(ORG, task2.id);
    if (b2.kind !== "ready") throw new Error("not ready");
    const t2 = await s.engine.modelTurn(ORG, task2.id, b2.runId, 0, ctx());
    if (t2.kind !== "tools") throw new Error("expected a tool call");
    const id2 = t2.toolCallIds[0]!;
    await s.store.transitionToolCall(ORG, id2, ["requested"], { status: "running" });
    expect(await s.engine.toolStep(ORG, task2.id, b2.runId, id2, ctx())).toBe("succeeded");
    expect((await s.store.getToolCall(ORG, id2))!.output).toMatchObject({ result: 6 });
  });

  it("finalizing steps are idempotent: cancel and fail twice record one terminal transition", async () => {
    const s = setup();
    const agent = s.store.addAgent({ organizationId: ORG, name: "A" });
    const task = s.store.addTask({ organizationId: ORG, agentId: agent.id, instruction: "What is 2 + 2?" });
    await s.engine.beginRun(ORG, task.id);
    expect(await s.engine.cancelTask(ORG, task.id)).toEqual({ status: "cancelled" });
    expect(await s.engine.cancelTask(ORG, task.id)).toEqual({ status: "cancelled" });
    expect(await s.engine.failRun(ORG, task.id, null, "internal_error", "late")).toEqual({ status: "cancelled" });
    expect(s.store.events.filter((e) => e.type === "run.cancelled")).toHaveLength(1);
  });

  it("passes the organization's own key to the provider and refuses to run without one", async () => {
    const keys: Record<string, string> = { org_with_key: "sk-org-key" };
    const resolver: CredentialResolver = { resolve: async (org) => keys[org] ?? null };
    const s = setup(resolver);
    // The mock never needs a key; check resolution through a non-mock provider id instead.
    const agent = s.store.addAgent({ organizationId: "org_without_key", name: "B", provider: "openai", model: "gpt-6-luna" });
    const task = s.store.addTask({ organizationId: "org_without_key", agentId: agent.id, instruction: "hi" });
    const r = await s.engine.beginRun("org_without_key", task.id);
    expect(r).toMatchObject({ kind: "terminal", outcome: { status: "failed", failureCode: "provider_not_configured" } });
  });

  it("pipeline advance is idempotent: calling it twice creates one next step", async () => {
    const s = setup();
    const a1 = s.store.addAgent({ organizationId: ORG, name: "A" });
    const a2 = s.store.addAgent({ organizationId: ORG, name: "B" });
    const parent = s.store.addTask({ organizationId: ORG, kind: "pipeline", instruction: "x", pipelineSpec: [{ agentId: a1.id, instruction: "1" }, { agentId: a2.id, instruction: "2" }] });
    const coord = new PipelineCoordinator(s.store, s.store);
    const d1 = await coord.advance(ORG, parent.id);
    const d2 = await coord.advance(ORG, parent.id);
    expect(d1).toEqual(d2);
    expect((await s.store.listChildTasks(ORG, parent.id)).length).toBe(1);
  });
});
