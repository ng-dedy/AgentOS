import { createProviderRegistry, MockProvider, providerError, type ModelRequest } from "@agentos/providers";
import { createDefaultToolRegistry } from "@agentos/tools";
import { describe, expect, it } from "vitest";
import { AgentEngine, estimateMaxRequestCost, MemoryRunStore, type CredentialResolver } from "../src";
import { unaccountedUsd } from "../src/memoryStore";

const ORG = "org_budget";

function setup(opts: { mock?: MockProvider; credentials?: CredentialResolver } = {}) {
  const store = new MemoryRunStore();
  const providers = createProviderRegistry({ enableMock: true, mock: opts.mock ?? new MockProvider({ slowMs: 50 }), secrets: { get: () => undefined } });
  const engine = new AgentEngine({ store, events: store, providers, tools: createDefaultToolRegistry(), providerRetries: 2, retryBaseDelayMs: 0, credentials: opts.credentials });
  return { store, engine, providers };
}

/** Counts provider requests. */
class CountingMock extends MockProvider {
  calls = 0;
  override async generate(req: ModelRequest, o: Parameters<MockProvider["generate"]>[1]) {
    this.calls++;
    return super.generate(req, o);
  }
}

const ctx = (attempt = 1) => ({ signal: new AbortController().signal, attempt });

describe("pre-call budget reservation (milestone 2C)", () => {
  it("bounds a request by maxOutputTokens and a conservative input estimate", () => {
    const s = setup();
    const req = { system: "s".repeat(300), messages: [{ role: "user", content: "x".repeat(3000) }], tools: [], maxOutputTokens: 4096 };
    const est = estimateMaxRequestCost(s.providers.catalog, "mock", "mock-scripted", req);
    expect(est.priced).toBe(true);
    expect(est.maxOutputTokens).toBe(4096);
    // 4096 output tokens at $2/MTok is already $0.008; the input estimate adds to it.
    expect(est.usd).toBeGreaterThan(0.008);
    // Over-estimates the input on purpose (3 chars/token + 20%).
    expect(est.estimatedInputTokens).toBeGreaterThan(3300 / 4);
    const unpriced = estimateMaxRequestCost(s.providers.catalog, "mock", "no-such-model", req, 0.25);
    expect(unpriced).toMatchObject({ priced: false, usd: 0.25 });
  });

  it("refuses a call that would push the task tree over its limit, without calling the provider", async () => {
    const mock = new CountingMock();
    const s = setup({ mock });
    const a = s.store.addAgent({ organizationId: ORG, name: "A", maxRunCostUsd: 5 });
    // One mock-scripted request reserves about $0.0083; the task limit is below that.
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is 2 + 2?", maxCostUsd: 0.005 });
    expect(await s.engine.execute(ORG, t.id)).toMatchObject({ status: "failed", failureCode: "budget_exceeded" });
    expect(mock.calls).toBe(0);
    const ev = s.store.events.find((e) => e.type === "budget.exceeded")!;
    expect(ev.payload).toMatchObject({ scope: "task", phase: "before_call", limitUsd: 0.005, costIsEstimate: true });
    expect((await s.store.getTask(ORG, t.id))!.failureMessage).toMatch(/could cost up to \$0\.00\d+/);
  });

  it("keeps one ledger row per provider request, settled and marked recorded", async () => {
    const s = setup();
    const a = s.store.addAgent({ organizationId: ORG, name: "A" });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is (17 * 23) + 4?" });
    expect(await s.engine.execute(ORG, t.id)).toMatchObject({ status: "completed" });
    expect(s.store.attempts).toHaveLength(2); // two model turns
    for (const at of s.store.attempts) {
      expect(at).toMatchObject({ status: "succeeded", recorded: true, possibleDuplicate: false });
      expect(at.actualUsd!).toBeLessThanOrEqual(at.reservedUsd); // the reservation really is an upper bound here
      expect(unaccountedUsd(at)).toBe(0);
    }
    const run = [...s.store.runs.values()][0]!;
    expect(s.store.attempts.reduce((n, x) => n + x.actualUsd!, 0)).toBeCloseTo(run.costUsd, 9);
    expect(s.store.attempts.map((x) => x.turn)).toEqual([0, 1]);
  });

  it("records each engine-level retry as its own request and does not count non-billed failures", async () => {
    const s = setup();
    const a = s.store.addAgent({ organizationId: ORG, name: "A" });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "[mock:flaky] What is 2 + 2?" });
    expect(await s.engine.execute(ORG, t.id)).toMatchObject({ status: "completed" });
    const turn0 = s.store.attempts.filter((x) => x.turn === 0);
    expect(turn0.map((x) => [x.sequence, x.status, x.billingUnknown])).toEqual([
      [1, "failed", false], // HTTP 429: the provider did not bill it
      [2, "succeeded", false],
    ]);
    expect(turn0.reduce((n, x) => n + unaccountedUsd(x), 0)).toBe(0);
  });

  it("counts a request that failed with a timeout at its reserved maximum (billing unknown)", async () => {
    class TimeoutOnce extends MockProvider {
      n = 0;
      override async generate(req: ModelRequest, o: Parameters<MockProvider["generate"]>[1]) {
        if (this.n++ === 0) throw providerError("timeout", "mock");
        return super.generate(req, o);
      }
    }
    const s = setup({ mock: new TimeoutOnce() });
    const a = s.store.addAgent({ organizationId: ORG, name: "A" });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is 2 + 2?" });
    await s.engine.execute(ORG, t.id);
    const first = s.store.attempts[0]!;
    expect(first).toMatchObject({ status: "failed", billingUnknown: true });
    expect(unaccountedUsd(first)).toBe(first.reservedUsd);
  });

  it("detects a request left open by a dead worker, flags possible duplicate billing and counts it", async () => {
    const mock = new CountingMock();
    const s = setup({ mock });
    const a = s.store.addAgent({ organizationId: ORG, name: "A", maxRunCostUsd: 1 });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is 2 + 2?" });
    const begin = await s.engine.beginRun(ORG, t.id);
    if (begin.kind !== "ready") throw new Error("not ready");
    // Simulate attempt 1 of the activity: it reserved and sent the request, then the worker died.
    const r = await s.store.reserveModelCall(ORG, {
      rootTaskId: t.id, taskId: t.id, runId: begin.runId, turn: 0, activityAttempt: 1, provider: "mock", model: "mock-scripted", reservedUsd: 0.4, treeLimitUsd: null, runLimitUsd: 1,
    });
    expect(r.ok).toBe(true);
    // Attempt 2 (the Temporal retry) runs the same turn.
    const out = await s.engine.modelTurn(ORG, t.id, begin.runId, 0, ctx(2));
    expect(out.kind).toBe("tools");
    expect(mock.calls).toBe(1);
    const [orphan, retry] = s.store.attempts;
    expect(orphan).toMatchObject({ status: "orphaned", activityAttempt: 1 });
    expect(retry).toMatchObject({ status: "succeeded", activityAttempt: 2, sequence: 2, possibleDuplicate: true });
    const dup = s.store.events.find((e) => e.type === "billing.possible_duplicate")!;
    expect(dup.payload).toMatchObject({ turn: 0, reason: "unsettled_request", countedUsd: 0.4 });
    // The orphan keeps counting against the limits at its reserved maximum.
    expect(unaccountedUsd(orphan!)).toBe(0.4);
  });

  it("refuses the retry when an orphaned reservation already uses up the budget", async () => {
    const mock = new CountingMock();
    const s = setup({ mock });
    const a = s.store.addAgent({ organizationId: ORG, name: "A", maxRunCostUsd: 0.01 });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is 2 + 2?" });
    const begin = await s.engine.beginRun(ORG, t.id);
    if (begin.kind !== "ready") throw new Error("not ready");
    await s.store.reserveModelCall(ORG, {
      rootTaskId: t.id, taskId: t.id, runId: begin.runId, turn: 0, activityAttempt: 1, provider: "mock", model: "mock-scripted", reservedUsd: 0.009, treeLimitUsd: null, runLimitUsd: 0.01,
    });
    const out = await s.engine.modelTurn(ORG, t.id, begin.runId, 0, ctx(2));
    expect(out).toMatchObject({ kind: "terminal", outcome: { status: "failed", failureCode: "budget_exceeded" } });
    expect(mock.calls).toBe(0);
    expect(s.store.events.map((e) => e.type)).toEqual(expect.arrayContaining(["billing.possible_duplicate", "budget.exceeded"]));
  });

  it("flags a reply that was billed but never stored (crash between reply and persist)", async () => {
    const s = setup();
    const a = s.store.addAgent({ organizationId: ORG, name: "A" });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is 2 + 2?" });
    const begin = await s.engine.beginRun(ORG, t.id);
    if (begin.kind !== "ready") throw new Error("not ready");
    const r = await s.store.reserveModelCall(ORG, {
      rootTaskId: t.id, taskId: t.id, runId: begin.runId, turn: 0, activityAttempt: 1, provider: "mock", model: "mock-scripted", reservedUsd: 0.01, treeLimitUsd: null, runLimitUsd: 1,
    });
    if (!r.ok) throw new Error("reserve failed");
    await s.store.settleModelCall(ORG, r.attemptId, { status: "succeeded", actualUsd: 0.002, inputTokens: 100, outputTokens: 50 });
    await s.engine.modelTurn(ORG, t.id, begin.runId, 0, ctx(2));
    const ev = s.store.events.find((e) => e.type === "billing.possible_duplicate")!;
    expect(ev.payload).toMatchObject({ reason: "reply_not_stored", lostReplies: 1 });
    expect(unaccountedUsd(s.store.attempts[0]!)).toBe(0.002); // the lost reply's estimated cost still counts
  });
});

describe("credential failures", () => {
  it("fails the run with credential_unavailable when the stored key cannot be decrypted", async () => {
    const credentials: CredentialResolver = {
      resolve: async () => {
        throw Object.assign(new Error("Stored credential failed integrity verification"), { code: "KMS_INTEGRITY", retryable: false });
      },
    };
    const s = setup({ credentials });
    // A non-mock provider so the credential path is used; the call never reaches the network.
    const a = s.store.addAgent({ organizationId: ORG, name: "A", provider: "openai", model: "gpt-6-luna" });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
    const out = await s.engine.execute(ORG, t.id);
    expect(out).toMatchObject({ status: "failed", failureCode: "credential_unavailable" });
    expect((out as { message: string }).message).toContain("KMS_INTEGRITY");
  });

  it("lets a retryable KMS outage propagate so the durable layer retries the step", async () => {
    const credentials: CredentialResolver = {
      resolve: async () => {
        throw Object.assign(new Error("AWS KMS decrypt failed: ThrottlingException"), { code: "KMS_UNAVAILABLE", retryable: true });
      },
    };
    const s = setup({ credentials });
    const a = s.store.addAgent({ organizationId: ORG, name: "A", provider: "openai", model: "gpt-6-luna" });
    const t = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
    await expect(s.engine.beginRun(ORG, t.id)).rejects.toThrow(/ThrottlingException/);
  });
});
