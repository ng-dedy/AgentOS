import { createProviderRegistry, MockProvider, providerError, type ModelProvider, type ModelResponse } from "@agentos/providers";
import { createDefaultToolRegistry } from "@agentos/tools";
import { describe, expect, it } from "vitest";
import { AgentEngine, failureForProviderError, MemoryRunStore } from "../src";

const ORG = "org_a";
const ok: ModelResponse = { text: "done", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };

function setup(provider: ModelProvider, engineOpts: Partial<ConstructorParameters<typeof AgentEngine>[0]> = {}) {
  const store = new MemoryRunStore();
  const providers = createProviderRegistry({ enableMock: true, mock: new MockProvider(), secrets: { get: () => undefined } });
  providers.register(provider);
  const logs: { level: string; obj: Record<string, unknown> }[] = [];
  const logger = {
    error: (obj: unknown) => logs.push({ level: "error", obj: obj as Record<string, unknown> }),
    warn: (obj: unknown) => logs.push({ level: "warn", obj: obj as Record<string, unknown> }),
    info: (obj: unknown) => logs.push({ level: "info", obj: obj as Record<string, unknown> }),
  };
  const engine = new AgentEngine({ store, events: store, providers, tools: createDefaultToolRegistry(), retryBaseDelayMs: 0, random: () => 1, logger, ...engineOpts });
  return { store, engine, logs };
}

/** Pretends to be the mock provider id so it passes catalog checks; fails `failures` times first. */
function scripted(errors: ReturnType<typeof providerError>[], after: ModelResponse = ok) {
  let calls = 0;
  const p: ModelProvider & { calls: () => number } = {
    id: "mock",
    label: "scripted",
    isMock: true,
    isConfigured: () => true,
    calls: () => calls,
    generate: async () => {
      const e = errors[calls++];
      if (e) throw e;
      return after;
    },
  };
  return p;
}

describe("retry policy", () => {
  it("honours Retry-After, emits model.retry and then succeeds", async () => {
    const p = scripted([providerError("rate_limit", "mock", { status: 429, retryAfterMs: 40 })]);
    const { store, engine, logs } = setup(p, { providerRetries: 2 });
    const a = store.addAgent({ organizationId: ORG, name: "A" });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
    const started = Date.now();
    expect(await engine.execute(ORG, t.id)).toMatchObject({ status: "completed" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    const retry = store.events.find((e) => e.type === "model.retry")!;
    expect(retry.payload).toMatchObject({ attempt: 1, delayMs: 40, error: { code: "PROVIDER_RATE_LIMIT", retryAfterMs: 40 } });
    expect(logs.some((l) => l.level === "warn" && l.obj.event === "model_call_failed" && l.obj.code === "PROVIDER_RATE_LIMIT")).toBe(true);
    expect(logs.some((l) => l.level === "info" && l.obj.event === "model_call")).toBe(true);
  });

  it("uses bounded exponential backoff", async () => {
    const p = scripted([providerError("server", "mock"), providerError("server", "mock"), providerError("server", "mock")]);
    const { store, engine } = setup(p, { providerRetries: 3, retryBaseDelayMs: 10, retryMaxDelayMs: 25 });
    const a = store.addAgent({ organizationId: ORG, name: "A" });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
    expect(await engine.execute(ORG, t.id)).toMatchObject({ status: "completed" });
    expect(store.events.filter((e) => e.type === "model.retry").map((e) => e.payload.delayMs)).toEqual([10, 20, 25]);
  });

  it("does not wait out an excessive Retry-After; fails retryable instead", async () => {
    const p = scripted([providerError("rate_limit", "mock", { retryAfterMs: 120_000 })]);
    const { store, engine } = setup(p, { maxRetryAfterMs: 1_000 });
    const a = store.addAgent({ organizationId: ORG, name: "A" });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
    expect(await engine.execute(ORG, t.id)).toMatchObject({ status: "failed", failureCode: "provider_retryable_error" });
    expect(p.calls()).toBe(1);
  });

  it("never retries exhausted quota, bad credentials or unknown models", async () => {
    for (const [kind, code] of [
      ["quota_exceeded", "provider_quota"],
      ["auth", "provider_auth"],
      ["model_not_found", "model_not_found"],
      ["context_length", "context_length"],
      ["bad_request", "provider_error"],
    ] as const) {
      const p = scripted([providerError(kind, "mock")]);
      const { store, engine } = setup(p, { providerRetries: 3 });
      const a = store.addAgent({ organizationId: ORG, name: "A" });
      const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
      expect(await engine.execute(ORG, t.id)).toMatchObject({ status: "failed", failureCode: code });
      expect(p.calls()).toBe(1);
      const failed = store.events.find((e) => e.type === "run.failed")!;
      expect(failed.payload.error).toMatchObject({ kind, code: `PROVIDER_${kind.toUpperCase()}` });
    }
  });

  it("retries an interrupted stream", async () => {
    const p = scripted([providerError("stream_interrupted", "mock")]);
    const { store, engine } = setup(p);
    const a = store.addAgent({ organizationId: ORG, name: "A" });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
    expect(await engine.execute(ORG, t.id)).toMatchObject({ status: "completed" });
    expect(store.events.find((e) => e.type === "model.retry")!.payload.error).toMatchObject({ code: "PROVIDER_STREAM_INTERRUPTED" });
  });

  it("cancellation during backoff stops the run promptly", async () => {
    const p = scripted([providerError("server", "mock", { retryAfterMs: 5_000 })]);
    const { store, engine } = setup(p, { maxRetryAfterMs: 10_000 });
    const a = store.addAgent({ organizationId: ORG, name: "A" });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
    const run = engine.execute(ORG, t.id);
    await new Promise((r) => setTimeout(r, 30));
    engine.abort(t.id);
    const started = Date.now();
    expect(await run).toMatchObject({ status: "cancelled" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("maps every provider error kind to a failure code", () => {
    expect(failureForProviderError(providerError("refusal", "x"))).toBe("provider_refusal");
    expect(failureForProviderError(providerError("overloaded", "x"))).toBe("provider_retryable_error");
    expect(failureForProviderError(providerError("unknown", "x"))).toBe("provider_error");
  });
});

describe("loop guards", () => {
  it("stops after repeated turns where every tool call fails", async () => {
    const { store, engine } = setup(new MockProvider(), { maxConsecutiveToolFailures: 3 });
    const a = store.addAgent({ organizationId: ORG, name: "A", maxIterations: 10 });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "[mock:repeat_bad_tool]" });
    expect(await engine.execute(ORG, t.id)).toMatchObject({ status: "failed", failureCode: "tool_failure_limit" });
    expect([...store.runs.values()][0]!.iterations).toBe(3);
    expect([...store.toolCalls.values()].every((c) => c.status === "rejected")).toBe(true);
  });

  it("a refusal fails the run with a refusal code and the provider's explanation", async () => {
    const { store, engine } = setup(new MockProvider());
    const a = store.addAgent({ organizationId: ORG, name: "A" });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "[mock:refusal]" });
    const out = await engine.execute(ORG, t.id);
    expect(out).toMatchObject({ status: "failed", failureCode: "provider_refusal" });
    expect(out.status === "failed" && out.message).toContain("MOCK refusal for testing");
  });

  it("records usage and estimated-cost metadata on every model call", async () => {
    const { store, engine } = setup(new MockProvider());
    const a = store.addAgent({ organizationId: ORG, name: "A" });
    const t = store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is 2 + 3?" });
    await engine.execute(ORG, t.id);
    const usage = store.events.filter((e) => e.type === "usage.recorded");
    expect(usage.length).toBe(2);
    expect(usage[0]!.payload).toMatchObject({ costIsEstimate: true, priceSource: "mock" });
    const out = store.events.find((e) => e.type === "model.output")!;
    expect(out.payload).toMatchObject({ provider: "mock", requestedModel: "mock-scripted", isMock: true });
  });
});
