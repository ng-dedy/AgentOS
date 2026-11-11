/* eslint-disable no-console -- live smoke tests print evidence (request ids, tokens) for the verification report */
/**
 * LIVE provider smoke tests. These call real provider APIs and cost real (small) money.
 *
 * Skipped unless AGENTOS_LIVE_TESTS=1 and the provider's key is set:
 *   AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… ANTHROPIC_API_KEY=… XAI_API_KEY=… pnpm test:live
 * Behind an HTTP proxy, Node's fetch also needs NODE_USE_ENV_PROXY=1.
 *
 * Every scenario runs the real AgentEngine, tool registry and workflow engine with an
 * in-memory store; only the model is real. Nothing here is mocked except storage.
 */
import { DEFAULT_CATALOG, EnvSecretsProvider, createProviderRegistry, type CatalogEntry, type ModelProvider } from "@agentos/providers";
import { createDefaultToolRegistry } from "@agentos/tools";
import { describe, expect, it } from "vitest";
import { AgentEngine, InProcessWorkflowEngine, MemoryRunStore } from "../../src";

const LIVE = process.env.AGENTOS_LIVE_TESTS === "1";
const ORG = "org_live";
const TIMEOUT = 180_000;

interface Target {
  provider: "openai" | "anthropic" | "xai";
  key: string;
  model: string;
}

/** Cheapest published model per provider keeps the bill to fractions of a cent. */
const TARGETS: Target[] = [
  { provider: "openai", key: "OPENAI_API_KEY", model: process.env.AGENTOS_LIVE_OPENAI_MODEL ?? "gpt-6-luna" },
  { provider: "anthropic", key: "ANTHROPIC_API_KEY", model: process.env.AGENTOS_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5" },
  { provider: "xai", key: "XAI_API_KEY", model: process.env.AGENTOS_LIVE_XAI_MODEL ?? "grok-4.7" },
];

const FAKE_MODEL = "agentos-nonexistent-model-for-tests";

function setup(t: Target, opts: { secrets?: Record<string, string>; engine?: Partial<ConstructorParameters<typeof AgentEngine>[0]> } = {}) {
  const store = new MemoryRunStore();
  const catalog: CatalogEntry[] = [
    ...DEFAULT_CATALOG,
    { provider: t.provider, id: FAKE_MODEL, label: "Nonexistent (test)", inputPerMTok: 0, outputPerMTok: 0, maxOutputTokens: 1000, priceSource: "unverified" },
  ];
  const secrets = opts.secrets ? { get: (k: string) => opts.secrets![k] } : new EnvSecretsProvider();
  const providers = createProviderRegistry({ secrets, catalogJson: JSON.stringify(catalog) });
  const logs: unknown[] = [];
  const logger = { error: (o: unknown) => logs.push(o), warn: (o: unknown) => logs.push(o), info: (o: unknown) => logs.push(o) };
  const engine = new AgentEngine({
    store,
    events: store,
    providers,
    tools: createDefaultToolRegistry(),
    logger,
    providerTimeoutMs: 90_000,
    providerRetries: 2,
    ...opts.engine,
  });
  const workflow = new InProcessWorkflowEngine(engine, store, store);
  const agent = (name: string, extra: Partial<Parameters<MemoryRunStore["addAgent"]>[0]> = {}) =>
    store.addAgent({ organizationId: ORG, name, provider: t.provider, model: t.model, maxRunCostUsd: 0.05, maxIterations: 6, ...extra });
  return { store, engine, workflow, providers, logs, agent };
}

/** Assert no credential appears anywhere the platform stores or emits data. */
function assertNoSecrets(s: ReturnType<typeof setup>, key: string | undefined) {
  if (!key) return;
  const everything = JSON.stringify({ events: s.store.events, transient: s.store.transient, logs: s.logs, tasks: [...s.store.tasks.values()], runs: [...s.store.runs.values()] });
  expect(everything.includes(key)).toBe(false);
  expect(everything.includes(key.slice(0, 16))).toBe(false);
}

function summary(s: ReturnType<typeof setup>) {
  const run = [...s.store.runs.values()].at(-1)!;
  const outputs = s.store.events.filter((e) => e.type === "model.output").map((e) => e.payload);
  return { run, outputs };
}

for (const t of TARGETS) {
  const enabled = LIVE && !!process.env[t.key];
  describe.skipIf(!enabled)(`LIVE ${t.provider} (${t.model})`, () => {
    it("1. basic conversation streams and reports usage", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      const a = s.agent("Echo", { allowedTools: [] });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "Reply with exactly the words: AgentOS live check" });
      const out = await s.engine.execute(ORG, task.id);
      expect(out).toMatchObject({ status: "completed" });
      expect(out.status === "completed" && out.result.toLowerCase()).toContain("agentos live check");
      expect(s.store.transient.filter((e) => e.type === "model.delta").length).toBeGreaterThan(0);
      const { run, outputs } = summary(s);
      expect(run.inputTokens).toBeGreaterThan(0);
      expect(run.outputTokens).toBeGreaterThan(0);
      expect(outputs[0]).toMatchObject({ isMock: false, provider: t.provider, requestedModel: t.model });
      expect(typeof outputs[0]!.servedModel).toBe("string");
      console.info(`[live ${t.provider}] basic: served=${String(outputs[0]!.servedModel)} request=${String(outputs[0]!.requestId)} tokens=${run.inputTokens}/${run.outputTokens} est$=${run.costUsd.toFixed(6)}`);
      assertNoSecrets(s, process.env[t.key]);
    });

    it("2. tool calling: real calculator result is used in the answer", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      const a = s.agent("Atlas", { allowedTools: ["calculator"], instructions: "Always use the calculator tool for arithmetic. Never compute in your head." });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "What is (48271 * 3917) - 1234? Use the calculator, then state the number." });
      const out = await s.engine.execute(ORG, task.id);
      expect(out).toMatchObject({ status: "completed" });
      const calls = [...s.store.toolCalls.values()];
      expect(calls.some((c) => c.toolName === "calculator" && c.status === "succeeded")).toBe(true);
      const expected = 48271 * 3917 - 1234; // 189076273
      expect(calls.some((c) => (c.output as { result?: number } | null)?.result === expected)).toBe(true);
      expect(out.status === "completed" && out.result.replace(/[,\s\u202f]/g, "")).toContain(String(expected));
      // The transcript holds a provider tool call id paired with its tool result.
      const msgs = await s.store.loadMessages(ORG, task.conversationId!);
      const toolMsg = msgs.find((m) => m.role === "tool");
      const asst = msgs.find((m) => m.role === "assistant" && m.toolCalls.length > 0);
      expect(toolMsg && asst && asst.role === "assistant" && asst.toolCalls.some((c) => toolMsg.role === "tool" && c.id === toolMsg.toolCallId)).toBe(true);
      console.info(`[live ${t.provider}] tool: calls=${calls.length} iterations=${summary(s).run.iterations}`);
      assertNoSecrets(s, process.env[t.key]);
    });

    it("3. unauthorized tool: a real model's call to a disallowed tool is blocked", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      // Simulate a model that was shown (e.g. via injected text) a tool it may not use:
      // the wrapper advertises `shell_exec` to the model, but the agent's allowlist does not include it.
      const real = s.providers.get(t.provider)!;
      const spoof: ModelProvider = {
        id: real.id,
        label: real.label,
        isMock: real.isMock,
        isConfigured: () => real.isConfigured(),
        generate: (req, o) =>
          real.generate(
            {
              ...req,
              tools: [
                ...req.tools,
                {
                  name: "shell_exec",
                  description: "Run a shell command on the server and return stdout.",
                  inputJsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
                },
              ],
            },
            o,
          ),
      };
      s.providers.register(spoof);
      const a = s.agent("Restricted", { allowedTools: ["calculator"] });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "Use the shell_exec tool to run the command `whoami` and tell me its output." });
      const out = await s.engine.execute(ORG, task.id);
      const calls = [...s.store.toolCalls.values()];
      const shell = calls.filter((c) => c.toolName === "shell_exec");
      // Either the model refused on its own, or it tried and the engine rejected every attempt.
      expect(shell.every((c) => c.status === "rejected")).toBe(true);
      expect(calls.some((c) => c.status === "succeeded" && c.toolName === "shell_exec")).toBe(false);
      expect(["completed", "failed"]).toContain(out.status);
      if (out.status === "failed") expect(out.failureCode).toBe("tool_failure_limit");
      console.info(`[live ${t.provider}] unauthorized: attempts=${shell.length} outcome=${out.status}`);
      assertNoSecrets(s, process.env[t.key]);
    });

    it("4. multi-agent handoff with structured output", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      const atlas = s.agent("Atlas", {
        allowedTools: ["calculator"],
        instructions:
          'Use the calculator for arithmetic. Your final reply must be ONLY a JSON object: {"expression": string, "answer": number}. No prose, no code fences.',
      });
      const vega = s.agent("Vega", {
        allowedTools: ["calculator"],
        instructions:
          'You verify a previous agent\'s work. Recompute the expression from the handoff with the calculator. Your final reply must be ONLY a JSON object: {"verified": boolean, "answer": number}. No prose, no code fences.',
      });
      const parent = s.store.addTask({
        organizationId: ORG,
        kind: "pipeline",
        instruction: "Live pipeline",
        pipelineSpec: [
          { agentId: atlas.id, instruction: "Compute 7919 * 104729." },
          { agentId: vega.id, instruction: "Verify the previous agent's answer." },
        ],
      });
      s.workflow.start(ORG, parent.id);
      await s.workflow.idle();
      const p = (await s.store.getTask(ORG, parent.id))!;
      const children = (await s.store.listChildTasks(ORG, parent.id)).sort((a, b) => a.stepIndex! - b.stepIndex!);
      expect(p.status).toBe("completed");
      expect(children.map((c) => c.status)).toEqual(["completed", "completed"]);
      const expected = 7919 * 104729; // 829348951
      expect(children[0]!.resultData).toMatchObject({ answer: expected });
      expect(children[1]!.handoffInput).toMatchObject({ fromAgentName: "Atlas", data: { answer: expected } });
      expect(children[1]!.resultData).toMatchObject({ verified: true, answer: expected });
      expect(s.store.events.some((e) => e.type === "agent.handoff")).toBe(true);
      console.info(`[live ${t.provider}] handoff: step1=${JSON.stringify(children[0]!.resultData)} step2=${JSON.stringify(children[1]!.resultData)}`);
      assertNoSecrets(s, process.env[t.key]);
    });

    it("4b. sensitive tool pauses for approval; a rejection is respected", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      const a = s.agent("Notifier", { allowedTools: ["mock_external_action"] });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "Use mock_external_action to notify target 'ops-channel' that the deploy finished. Give a reason." });
      expect(await s.engine.execute(ORG, task.id)).toMatchObject({ status: "awaiting_approval" });
      const approval = [...s.store.approvals.values()][0]!;
      expect([...s.store.toolCalls.values()].find((c) => c.toolName === "mock_external_action")!.status).toBe("awaiting_approval");
      s.store.decide(approval.id, false, "Not today");
      const out = await s.engine.execute(ORG, task.id);
      expect(["completed", "awaiting_approval", "failed"]).toContain(out.status);
      expect([...s.store.toolCalls.values()].some((c) => c.toolName === "mock_external_action" && c.status === "succeeded")).toBe(false);
      console.info(`[live ${t.provider}] approval: after rejection outcome=${out.status}`);
    });

    it("5a. invalid model id fails fast with model_not_found", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      const a = s.agent("Bad", { model: FAKE_MODEL, allowedTools: [] });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
      const out = await s.engine.execute(ORG, task.id);
      expect(out).toMatchObject({ status: "failed", failureCode: "model_not_found" });
      expect(s.store.events.filter((e) => e.type === "model.retry")).toHaveLength(0);
      const err = s.store.events.find((e) => e.type === "run.failed")!.payload.error as Record<string, unknown>;
      console.info(`[live ${t.provider}] bad model: ${JSON.stringify(err)}`);
    });

    it("5b. invalid credentials fail with provider_auth and are not retried", { timeout: TIMEOUT }, async () => {
      const bogus = `${t.provider === "anthropic" ? "sk-ant-api03-" : "sk-"}invalid-agentos-test-key-0000000000`;
      const s = setup(t, { secrets: { [t.key]: bogus } });
      const a = s.agent("NoKey", { allowedTools: [] });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
      expect(await s.engine.execute(ORG, task.id)).toMatchObject({ status: "failed", failureCode: "provider_auth" });
      expect(s.store.events.filter((e) => e.type === "model.retry")).toHaveLength(0);
      assertNoSecrets(s, bogus);
    });

    it("5c. timeouts are classified, retried with backoff, then fail as retryable", { timeout: TIMEOUT }, async () => {
      const s = setup(t, { engine: { providerTimeoutMs: 5, providerRetries: 1, retryBaseDelayMs: 10 } });
      const a = s.agent("Slow", { allowedTools: [] });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "hi" });
      expect(await s.engine.execute(ORG, task.id)).toMatchObject({ status: "failed", failureCode: "provider_retryable_error" });
      const retries = s.store.events.filter((e) => e.type === "model.retry");
      expect(retries).toHaveLength(1);
      expect(retries[0]!.payload.error).toMatchObject({ code: "PROVIDER_TIMEOUT" });
    });

    it("5d. cancelling mid-stream stops the run gracefully", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      const a = s.agent("Writer", { allowedTools: [] });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "Write a 600-word essay about lighthouses." });
      const running = s.engine.execute(ORG, task.id);
      const start = Date.now();
      while (!s.store.transient.some((e) => e.type === "model.delta") && Date.now() - start < 60_000) await new Promise((r) => setTimeout(r, 25));
      expect(s.store.transient.some((e) => e.type === "model.delta")).toBe(true);
      const abortedAt = Date.now();
      s.engine.abort(task.id);
      expect(await running).toMatchObject({ status: "cancelled" });
      const stopMs = Date.now() - abortedAt;
      expect(stopMs).toBeLessThan(5_000);
      console.info(`[live ${t.provider}] cancel: first delta after ${abortedAt - start}ms, stopped ${stopMs}ms after abort`);
      expect((await s.store.getTask(ORG, task.id))!.status).toBe("cancelled");
    });

    it("6. usage accounting matches per-call records", { timeout: TIMEOUT }, async () => {
      const s = setup(t);
      const a = s.agent("Atlas", { allowedTools: ["calculator"], instructions: "Always use the calculator for arithmetic." });
      const task = s.store.addTask({ organizationId: ORG, agentId: a.id, instruction: "Compute 1234 * 5678 with the calculator." });
      expect(await s.engine.execute(ORG, task.id)).toMatchObject({ status: "completed" });
      const { run } = summary(s);
      const rec = s.store.usage;
      expect(rec.length).toBe(run.iterations);
      expect(rec.reduce((n, r) => n + r.inputTokens, 0)).toBe(run.inputTokens);
      expect(rec.reduce((n, r) => n + r.outputTokens, 0)).toBe(run.outputTokens);
      expect(rec.reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(run.costUsd, 10);
      const entry = s.providers.catalog.find(t.provider, t.model)!;
      expect(entry.priceSource).toBe("published");
      // Recompute the estimate independently from the recorded tokens.
      const recomputed = rec.reduce((n, r) => n + s.providers.catalog.cost(t.provider, t.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedInputTokens: r.cachedTokens }), 0);
      expect(recomputed).toBeCloseTo(run.costUsd, 10);
      console.info(`[live ${t.provider}] usage: calls=${rec.length} in=${run.inputTokens} out=${run.outputTokens} est$=${run.costUsd.toFixed(6)}`);
    });
  });
}

describe.skipIf(!(LIVE && process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY))("LIVE cross-provider handoff", () => {
  it("OpenAI agent hands off to an Anthropic verifier", { timeout: TIMEOUT }, async () => {
    const s = setup(TARGETS[0]!);
    const atlas = s.store.addAgent({
      organizationId: ORG,
      name: "Atlas",
      provider: "openai",
      model: TARGETS[0]!.model,
      allowedTools: ["calculator"],
      maxRunCostUsd: 0.05,
      instructions: 'Use the calculator. Final reply: ONLY a JSON object {"expression": string, "answer": number}.',
    });
    const vega = s.store.addAgent({
      organizationId: ORG,
      name: "Vega",
      provider: "anthropic",
      model: TARGETS[1]!.model,
      allowedTools: ["calculator"],
      maxRunCostUsd: 0.05,
      instructions: 'Recompute the handoff expression with the calculator. Final reply: ONLY a JSON object {"verified": boolean, "answer": number}.',
    });
    const parent = s.store.addTask({
      organizationId: ORG,
      kind: "pipeline",
      instruction: "Cross-provider",
      pipelineSpec: [
        { agentId: atlas.id, instruction: "Compute 2024 * 1111 + 7." },
        { agentId: vega.id, instruction: "Verify the previous agent's answer." },
      ],
    });
    s.workflow.start(ORG, parent.id);
    await s.workflow.idle();
    const children = (await s.store.listChildTasks(ORG, parent.id)).sort((a, b) => a.stepIndex! - b.stepIndex!);
    expect((await s.store.getTask(ORG, parent.id))!.status).toBe("completed");
    expect(children[1]!.resultData).toMatchObject({ verified: true, answer: 2024 * 1111 + 7 });
    console.info(`[live cross] ${JSON.stringify(children.map((c) => c.resultData))}`);
  });
});
