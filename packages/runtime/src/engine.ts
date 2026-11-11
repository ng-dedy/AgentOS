import type { FailureCode, TaskStatus } from "@agentos/contracts";
import { TERMINAL_TASK_STATUSES } from "@agentos/contracts";
import {
  ProviderError,
  providerError,
  type ModelProvider,
  type ModelResponse,
  type ProviderRegistry,
  type ToolCallRequest,
} from "@agentos/providers";
import { executeTool, type ToolRegistry } from "@agentos/tools";
import { buildSystemPrompt, extractStructured } from "./context";
import type { AgentConfig, EventSink, RunRecord, RunStore, TaskRecord, ToolCallRecord } from "./store";

/** Resolves the API key an organization uses for a provider. Null means "not configured for this org". */
export interface CredentialResolver {
  resolve(orgId: string, provider: string): Promise<string | null>;
}

export interface EngineOptions {
  store: RunStore;
  events: EventSink;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  /**
   * Per-organization credentials. When omitted, providers use their own
   * deployment-level configuration (env keys), as in milestone 2A.
   */
  credentials?: CredentialResolver;
  now?: () => Date;
  /** Per model call. */
  providerTimeoutMs?: number;
  /** Retries for retryable provider errors (in addition to the first attempt). */
  providerRetries?: number;
  /** First backoff delay; doubles per attempt, with full jitter between 50% and 100%. */
  retryBaseDelayMs?: number;
  /** Upper bound for one backoff delay. */
  retryMaxDelayMs?: number;
  /**
   * If the provider asks us to wait longer than this (Retry-After), fail now with a
   * retryable error instead of holding the run open.
   */
  maxRetryAfterMs?: number;
  /** Stop a run after this many consecutive model turns in which every tool call failed or was rejected. */
  maxConsecutiveToolFailures?: number;
  /** Jitter source, injectable for tests. */
  random?: () => number;
  logger?: EngineLogger;
}

export interface EngineLogger {
  error: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export type RunOutcome =
  | { status: "completed"; result: string }
  | { status: "awaiting_approval" }
  | { status: "failed"; failureCode: FailureCode; message: string }
  | { status: "cancelled" };

export type TerminalOutcome = Exclude<RunOutcome, { status: "awaiting_approval" }>;

/** Result of starting or resuming a run. `turn` is the next model turn to execute. */
export type BeginResult =
  | { kind: "terminal"; outcome: TerminalOutcome }
  | { kind: "ready"; runId: string; turn: number; pendingToolCallIds: string[]; maxConsecutiveToolFailures: number };

export type TurnResult = { kind: "terminal"; outcome: TerminalOutcome } | { kind: "tools"; toolCallIds: string[] };

export type ToolStepResult = "succeeded" | "failed" | "awaiting_approval" | { terminal: TerminalOutcome };

/** Context the durable layer passes into each step. */
export interface StepContext {
  signal: AbortSignal;
  /** Called while long work is in progress (Temporal activity heartbeat). */
  heartbeat?: (details?: unknown) => void;
  /** Which attempt of this step this is (1 = first). Used for retry history. */
  attempt?: number;
}

class RunStop extends Error {
  constructor(
    readonly outcome: Exclude<RunOutcome, { status: "completed" } | { status: "awaiting_approval" }>,
    /** Structured, secret-free error detail for the run.failed event. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(outcome.status);
  }
}

const TERMINAL_TOOL_STATUSES = ["succeeded", "failed", "rejected", "invalid", "approval_rejected"] as const;
const INTERRUPTED_SIDE_EFFECT =
  "Outcome unknown: the worker stopped while this tool was running. It was not re-executed, to avoid repeating a side effect.";

/** Map a final (non-retried or retries-exhausted) provider error to a run failure code. */
export function failureForProviderError(err: ProviderError): FailureCode {
  switch (err.kind) {
    case "auth":
      return "provider_auth";
    case "quota_exceeded":
      return "provider_quota";
    case "model_not_found":
      return "model_not_found";
    case "refusal":
      return "provider_refusal";
    case "context_length":
      return "context_length";
    case "not_configured":
      return "provider_not_configured";
    default:
      return err.retryable ? "provider_retryable_error" : "provider_error";
  }
}

/**
 * Executes agent tasks as a sequence of durable, idempotent steps:
 *
 *   beginRun → modelTurn(0) → toolStep(...) → modelTurn(1) → … → terminal
 *
 * Every step reads its starting point from the RunStore and can be retried after a
 * crash without repeating work: a model turn whose assistant message is already
 * stored is not sent to the provider again, and a tool runs only after a
 * compare-and-set moves it from `requested` to `running`.
 *
 * `execute()` drives the steps in-process; the Temporal workflows drive the same
 * steps from activities, so both engines share one implementation.
 */
export class AgentEngine {
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => Date;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Abort an in-flight in-process run. Returns false if none is active here. */
  abort(taskId: string): boolean {
    const c = this.active.get(taskId);
    if (!c) return false;
    c.abort();
    return true;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  // ---------------------------------------------------------------------------
  // In-process driver
  // ---------------------------------------------------------------------------

  /** Start a fresh run for a queued task, or continue after an approval decision. */
  async execute(orgId: string, taskId: string): Promise<RunOutcome> {
    if (this.active.has(taskId)) throw new Error(`Task ${taskId} is already running`);
    const controller = new AbortController();
    this.active.set(taskId, controller);
    const ctx: StepContext = { signal: controller.signal };
    try {
      const begin = await this.beginRun(orgId, taskId);
      if (begin.kind === "terminal") return begin.outcome;
      let turn = begin.turn;
      let pending = begin.pendingToolCallIds;
      let consecutiveFailures = 0;
      for (;;) {
        if (pending.length === 0) {
          const r = await this.modelTurn(orgId, taskId, begin.runId, turn, ctx);
          if (r.kind === "terminal") return r.outcome;
          turn += 1;
          pending = r.toolCallIds;
        }
        let waiting = false;
        let anySucceeded = false;
        for (const id of pending) {
          const s = await this.toolStep(orgId, taskId, begin.runId, id, ctx);
          if (typeof s === "object") return s.terminal;
          if (s === "awaiting_approval") waiting = true;
          if (s === "succeeded") anySucceeded = true;
        }
        if (waiting) {
          await this.pauseForApproval(orgId, taskId, begin.runId);
          return { status: "awaiting_approval" };
        }
        pending = [];
        consecutiveFailures = anySucceeded ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= begin.maxConsecutiveToolFailures) {
          return await this.failRun(orgId, taskId, begin.runId, "tool_failure_limit", toolFailureMessage(consecutiveFailures));
        }
      }
    } finally {
      this.active.delete(taskId);
    }
  }

  // ---------------------------------------------------------------------------
  // Durable step API (each method is safe to retry)
  // ---------------------------------------------------------------------------

  /** Validate the task, then create a run or resume the latest unfinished one. */
  async beginRun(orgId: string, taskId: string): Promise<BeginResult> {
    const { store } = this.opts;
    const task = await this.mustGetTask(orgId, taskId);
    const terminal = this.terminalOutcome(task);
    if (terminal) return { kind: "terminal", outcome: terminal };
    const maxConsecutiveToolFailures = this.opts.maxConsecutiveToolFailures ?? 3;

    return this.guard(task, null, async () => {
      if (task.cancelRequestedAt) throw new RunStop({ status: "cancelled" });
      if (!task.agentId || !task.conversationId) return this.failTerminal(task, null, "internal_error", "Task has no agent or conversation");
      const agent = await store.getAgent(orgId, task.agentId);
      if (!agent) return this.failTerminal(task, null, "internal_error", "Agent not found");
      if (agent.status !== "active") return this.failTerminal(task, null, "internal_error", "Agent is paused");
      const provider = this.opts.providers.get(agent.provider);
      if (!provider || !(await this.isProviderConfigured(orgId, provider))) {
        return this.failTerminal(task, null, "provider_not_configured", `Provider '${agent.provider}' is not configured for this organization`);
      }
      if (!this.opts.providers.catalog.find(agent.provider, agent.model)) {
        return this.failTerminal(task, null, "provider_not_configured", `Model '${agent.model}' is not in the catalog`);
      }

      const latest = await store.getLatestRun(orgId, taskId);
      if (latest && (latest.status === "running" || latest.status === "awaiting_approval")) {
        // Resume: the next turn is the number of assistant turns already stored.
        const turns = await store.getAssistantTurns(orgId, task.conversationId, latest.id);
        const last = turns[turns.length - 1];
        const pendingToolCallIds: string[] = [];
        if (last && last.toolCalls.length > 0) {
          for (const c of last.toolCalls) {
            const rec = await this.ensureToolCallRecord(task, latest, c, false);
            pendingToolCallIds.push(rec.id);
          }
        }
        if (latest.status === "awaiting_approval") await this.resumeAfterApproval(orgId, taskId, latest.id);
        return { kind: "ready", runId: latest.id, turn: turns.length, pendingToolCallIds, maxConsecutiveToolFailures };
      }

      const run = await store.createRun(orgId, { taskId, agentId: agent.id, provider: agent.provider, model: agent.model });
      await store.updateTask(orgId, taskId, { status: "running", startedAt: this.now() });
      await this.emit(task, run, "run.started", { provider: agent.provider, model: agent.model, isMock: provider.isMock });
      await this.emit(task, run, "task.status", { status: "running" });
      return { kind: "ready", runId: run.id, turn: 0, pendingToolCallIds: [], maxConsecutiveToolFailures };
    });
  }

  /**
   * One model call. Idempotent per (run, turn): if the assistant message for this
   * turn is already stored, the provider is not called again.
   */
  async modelTurn(orgId: string, taskId: string, runId: string, turn: number, ctx: StepContext): Promise<TurnResult> {
    const { store, tools } = this.opts;
    const task = await this.mustGetTask(orgId, taskId);
    const terminal = this.terminalOutcome(task);
    if (terminal) return { kind: "terminal", outcome: terminal };
    const run = await this.mustGetRun(orgId, runId);

    return this.guard(task, run, async () => {
      const agent = await this.mustGetAgent(task);
      const provider = this.opts.providers.get(agent.provider);
      if (!provider) throw new RunStop({ status: "failed", failureCode: "provider_not_configured", message: `Provider '${agent.provider}' is not available` });
      const turns = await store.getAssistantTurns(orgId, task.conversationId!, run.id);

      let response: Pick<ModelResponse, "text" | "toolCalls" | "stopReason">;
      if (turns.length > turn) {
        // Already done before a crash or retry: reuse the stored turn.
        const stored = turns[turn]!;
        response = { text: stored.content, toolCalls: stored.toolCalls, stopReason: stored.toolCalls.length ? "tool_use" : "end" };
        this.opts.logger?.info?.({ event: "model_turn_reused", taskId, runId, turn, attempt: ctx.attempt }, "model turn already persisted; not calling the provider again");
      } else {
        await this.checkCancelled(task, ctx.signal);
        if (run.iterations >= agent.maxIterations) {
          throw new RunStop({ status: "failed", failureCode: "iteration_limit", message: `Stopped after ${agent.maxIterations} model iterations` });
        }
        await this.checkTreeBudget(task);
        response = await this.callAndRecord(task, agent, provider, run, ctx);
      }

      this.checkRunLimits(agent, run);
      if (response.stopReason === "refusal") {
        const refusal = (response as ModelResponse).refusal;
        throw new RunStop(
          { status: "failed", failureCode: "provider_refusal", message: `The model declined the request${refusal ? `: ${truncate(refusal, 500)}` : ""}` },
          { code: "PROVIDER_REFUSAL", provider: agent.provider },
        );
      }
      if (response.toolCalls.length === 0) return { kind: "terminal", outcome: await this.complete(task, run, response) };

      const ids: string[] = [];
      for (const call of response.toolCalls) {
        const rec = await this.ensureToolCallRecord(task, run, call, true, tools.get(call.name)?.risk ?? null);
        ids.push(rec.id);
      }
      return { kind: "tools", toolCallIds: ids };
    });
  }

  /**
   * Authorize, validate and execute one tool call, or request / apply a human
   * approval. Safe to retry: terminal tool calls are returned as they are, and a
   * side-effecting tool interrupted mid-run is never executed a second time.
   */
  async toolStep(orgId: string, taskId: string, runId: string, toolCallId: string, ctx: StepContext): Promise<ToolStepResult> {
    const { store, tools } = this.opts;
    const task = await this.mustGetTask(orgId, taskId);
    const terminal = this.terminalOutcome(task);
    if (terminal) return { terminal };
    const run = await this.mustGetRun(orgId, runId);

    const r = await this.guard(task, run, async (): Promise<ToolStepResult> => {
      await this.checkCancelled(task, ctx.signal);
      const agent = await this.mustGetAgent(task);
      const rec = await store.getToolCall(orgId, toolCallId);
      if (!rec || rec.runId !== runId) throw new Error(`Tool call ${toolCallId} not found in run ${runId}`);
      const call: ToolCallRequest = { id: rec.providerCallId, name: rec.toolName, arguments: rec.arguments };
      const tool = tools.get(rec.toolName);

      if ((TERMINAL_TOOL_STATUSES as readonly string[]).includes(rec.status)) {
        // Finished before a crash: make sure the model will see the result, nothing more.
        await this.ensureToolResult(task, run, call, rec);
        return rec.status === "succeeded" ? "succeeded" : "failed";
      }

      if (rec.status === "running") {
        if (tool && tool.risk === "safe") {
          // Read-only tools can be re-run without harm.
          return (await this.runTool(task, agent, run, rec, call, ctx, ["running"])) ? "succeeded" : "failed";
        }
        if (await store.transitionToolCall(orgId, rec.id, ["running"], { status: "failed", error: INTERRUPTED_SIDE_EFFECT })) {
          await this.emit(task, run, "tool.failed", { toolCallId: rec.id, toolName: rec.toolName, reason: INTERRUPTED_SIDE_EFFECT, kind: "interrupted" });
          await this.appendToolResult(task, run, call, { error: INTERRUPTED_SIDE_EFFECT }, true);
        }
        return "failed";
      }

      if (rec.status === "awaiting_approval") return this.applyApproval(task, agent, run, rec, call, ctx);

      // status === "requested"
      const reject = async (status: "rejected" | "invalid", reason: string) => {
        if (await store.transitionToolCall(orgId, rec.id, ["requested"], { status, error: reason })) {
          await this.emit(task, run, status === "rejected" ? "tool.rejected" : "tool.failed", { toolCallId: rec.id, toolName: call.name, reason });
          await this.appendToolResult(task, run, call, { error: reason }, true);
        }
        return "failed" as const;
      };
      if (!tool || !agent.allowedTools.includes(call.name)) return reject("rejected", `Tool '${call.name}' is not available to this agent`);
      if (call.arguments === null) return reject("invalid", "Tool arguments were not valid JSON");
      const parsed = tool.inputSchema.safeParse(call.arguments);
      if (!parsed.success) {
        return reject("invalid", `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
      }

      if (tool.requiresApproval) {
        const args = parsed.data as Record<string, unknown>;
        const reason =
          typeof args.reason === "string" && args.reason.trim()
            ? `Agent's stated reason: ${args.reason.trim()}`
            : `Tool '${tool.name}' is classified as ${tool.risk} and requires human approval`;
        if (await store.transitionToolCall(orgId, rec.id, ["requested"], { status: "awaiting_approval" })) {
          const approval = await store.createApproval(orgId, {
            toolCallId: rec.id,
            taskId: task.id,
            runId: run.id,
            agentId: agent.id,
            toolName: tool.name,
            arguments: parsed.data,
            reason,
          });
          await this.emit(task, run, "approval.required", {
            approvalId: approval.id,
            toolCallId: rec.id,
            toolName: tool.name,
            arguments: parsed.data,
            reason,
            risk: tool.risk,
          });
        }
        return "awaiting_approval";
      }

      return (await this.runTool(task, agent, run, rec, call, ctx, ["requested"])) ? "succeeded" : "failed";
    });
    return isTerminalWrapper(r) ? { terminal: r.outcome } : r;
  }

  /** Mark the run and task as waiting for a human. Idempotent. */
  async pauseForApproval(orgId: string, taskId: string, runId: string): Promise<void> {
    const run = await this.mustGetRun(orgId, runId);
    if (run.status !== "awaiting_approval") await this.opts.store.updateRun(orgId, runId, { status: "awaiting_approval" });
    const task = await this.mustGetTask(orgId, taskId);
    if (task.status !== "awaiting_approval" && !TERMINAL_TASK_STATUSES.includes(task.status)) await this.setTaskStatus(task, "awaiting_approval");
  }

  /** Mark the run and task as running again after a decision. Idempotent. */
  async resumeAfterApproval(orgId: string, taskId: string, runId: string): Promise<void> {
    const run = await this.mustGetRun(orgId, runId);
    if (run.status === "awaiting_approval") await this.opts.store.updateRun(orgId, runId, { status: "running" });
    const task = await this.mustGetTask(orgId, taskId);
    if (task.status === "awaiting_approval") await this.setTaskStatus(task, "running");
  }

  /** Fail a run for a reason decided by the coordinator (e.g. the tool-failure loop guard). */
  async failRun(orgId: string, taskId: string, runId: string | null, code: FailureCode, message: string, detail?: Record<string, unknown>): Promise<TerminalOutcome> {
    const task = await this.mustGetTask(orgId, taskId);
    const terminal = this.terminalOutcome(task);
    if (terminal) return terminal;
    const run = runId ? await this.opts.store.getRun(orgId, runId) : await this.opts.store.getLatestRun(orgId, taskId);
    return this.failTask(task, run && (run.status === "running" || run.status === "awaiting_approval") ? run : null, code, message, detail);
  }

  /** Finalize a task as cancelled (run, approvals, events). Idempotent. */
  async cancelTask(orgId: string, taskId: string): Promise<TerminalOutcome> {
    const task = await this.mustGetTask(orgId, taskId);
    const terminal = this.terminalOutcome(task);
    if (terminal) return terminal;
    const run = await this.opts.store.getLatestRun(orgId, taskId);
    return this.finishStopped(task, run && (run.status === "running" || run.status === "awaiting_approval") ? run : null, { status: "cancelled" });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async isProviderConfigured(orgId: string, provider: ModelProvider): Promise<boolean> {
    if (provider.isMock || !this.opts.credentials) return provider.isConfigured();
    return (await this.opts.credentials.resolve(orgId, provider.id)) !== null;
  }

  private async callAndRecord(task: TaskRecord, agent: AgentConfig, provider: ModelProvider, run: RunRecord, ctx: StepContext): Promise<ModelResponse> {
    const { store, tools } = this.opts;
    const orgId = task.organizationId;
    const allowed = agent.allowedTools.filter((n) => tools.has(n));
    const catalogEntry = this.opts.providers.catalog.find(agent.provider, agent.model);
    const messages = await store.loadMessages(orgId, task.conversationId!);
    const apiKey = provider.isMock || !this.opts.credentials ? undefined : ((await this.opts.credentials.resolve(orgId, provider.id)) ?? undefined);
    if (!provider.isMock && this.opts.credentials && !apiKey) {
      throw new RunStop({ status: "failed", failureCode: "provider_not_configured", message: `Provider '${agent.provider}' is not configured for this organization` });
    }
    const started = Date.now();
    const response = await this.callModel(task, run, provider, ctx, apiKey, {
      model: agent.model,
      system: buildSystemPrompt(agent, task.handoffInput),
      messages,
      tools: tools.specs(allowed),
      maxOutputTokens: catalogEntry?.maxOutputTokens ?? 4096,
    });
    const latencyMs = Date.now() - started;

    // Persist the turn first: once the assistant message exists, a retry never calls the model again.
    await store.appendMessage(orgId, task.conversationId!, run.id, {
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
      providerState: response.providerState,
    });

    // Usage accounting happens before any limit check so overspend is always recorded.
    const cost = this.opts.providers.catalog.cost(agent.provider, agent.model, response.usage);
    run.iterations += 1;
    run.inputTokens += response.usage.inputTokens;
    run.outputTokens += response.usage.outputTokens;
    run.costUsd += cost;
    await store.updateRun(orgId, run.id, { iterations: run.iterations, inputTokens: run.inputTokens, outputTokens: run.outputTokens, costUsd: run.costUsd });
    await store.recordUsage(orgId, {
      runId: run.id,
      agentId: agent.id,
      provider: agent.provider,
      model: agent.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedTokens: response.usage.cachedInputTokens,
      costUsd: cost,
      latencyMs,
    });
    this.opts.logger?.info?.(
      {
        event: "model_call",
        taskId: task.id,
        runId: run.id,
        provider: agent.provider,
        model: agent.model,
        servedModel: response.servedModel,
        requestId: response.requestId,
        stopReason: response.stopReason,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        reasoningTokens: response.usage.reasoningTokens,
        toolCalls: response.toolCalls.length,
        latencyMs,
        attempt: ctx.attempt,
        estimatedCostUsd: cost,
      },
      "model call completed",
    );
    await this.emit(task, run, "usage.recorded", {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      reasoningTokens: response.usage.reasoningTokens ?? 0,
      costUsd: cost,
      runCostUsd: run.costUsd,
      latencyMs,
      // Cost is always an estimate from the catalog; priceSource says how trustworthy the price is.
      costIsEstimate: true,
      priceSource: catalogEntry?.priceSource ?? "unverified",
    });
    await this.emit(task, run, "model.output", {
      text: response.text,
      iteration: run.iterations,
      stopReason: response.stopReason,
      toolCalls: response.toolCalls.map((c) => ({ id: c.id, name: c.name })),
      provider: agent.provider,
      requestedModel: agent.model,
      servedModel: response.servedModel ?? null,
      requestId: response.requestId ?? null,
      isMock: provider.isMock,
      ...(response.refusal ? { refusal: response.refusal } : {}),
    });
    return response;
  }

  private checkRunLimits(agent: AgentConfig, run: RunRecord) {
    if (run.costUsd > agent.maxRunCostUsd) {
      throw new RunStop({
        status: "failed",
        failureCode: "budget_exceeded",
        message: `Run cost $${run.costUsd.toFixed(4)} exceeded the agent budget of $${agent.maxRunCostUsd.toFixed(4)}`,
      });
    }
    if (agent.maxRunTokens !== null && run.inputTokens + run.outputTokens > agent.maxRunTokens) {
      throw new RunStop({ status: "failed", failureCode: "token_limit", message: `Run exceeded ${agent.maxRunTokens} tokens` });
    }
  }

  /** Per-task spending limit, summed over every run in the task tree (pipeline steps included). */
  private async checkTreeBudget(task: TaskRecord) {
    const root = task.parentTaskId ? await this.opts.store.getTask(task.organizationId, task.parentTaskId) : task;
    const limit = root?.maxCostUsd ?? null;
    if (limit === null || limit === undefined || !root) return;
    const spent = await this.opts.store.getTreeSpend(task.organizationId, root.id);
    if (spent >= limit) {
      throw new RunStop({
        status: "failed",
        failureCode: "budget_exceeded",
        message: `Task spending $${spent.toFixed(4)} reached the task limit of $${limit.toFixed(4)}`,
      });
    }
  }

  private async callModel(
    task: TaskRecord,
    run: RunRecord,
    provider: ModelProvider,
    ctx: StepContext,
    apiKey: string | undefined,
    req: Parameters<ModelProvider["generate"]>[0],
  ): Promise<ModelResponse> {
    const retries = this.opts.providerRetries ?? 2;
    const base = this.opts.retryBaseDelayMs ?? 500;
    const cap = this.opts.retryMaxDelayMs ?? 8_000;
    const maxRetryAfter = this.opts.maxRetryAfterMs ?? 30_000;
    const random = this.opts.random ?? Math.random;
    const signal = ctx.signal;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      try {
        ctx.heartbeat?.({ phase: "model", attempt });
        return await provider.generate(req, {
          signal,
          timeoutMs: this.opts.providerTimeoutMs ?? 120_000,
          ...(apiKey ? { apiKey } : {}),
          onDelta: (text) => {
            ctx.heartbeat?.({ phase: "model", attempt });
            this.opts.events.emitTransient({
              organizationId: task.organizationId,
              taskId: task.id,
              runId: run.id,
              agentId: run.agentId,
              type: "model.delta",
              payload: { text, attempt },
            });
          },
        });
      } catch (err) {
        if (signal.aborted || (err instanceof ProviderError && err.kind === "aborted")) {
          throw new RunStop({ status: "cancelled" });
        }
        const pe = err instanceof ProviderError ? err : null;
        const detail = pe ? pe.toJSON() : { code: "PROVIDER_UNKNOWN", provider: provider.id };
        const log = { event: "model_call_failed", taskId: task.id, runId: run.id, model: req.model, attempt, latencyMs: Date.now() - started, ...detail };
        const retryAfter = pe?.retryAfterMs;
        if (pe?.retryable && attempt < retries && (retryAfter === undefined || retryAfter <= maxRetryAfter)) {
          const backoff = Math.min(cap, base * 2 ** attempt) * (0.5 + random() / 2);
          const waitMs = Math.round(Math.max(backoff, retryAfter ?? 0));
          this.opts.logger?.warn?.({ ...log, retryInMs: waitMs }, "model call failed, retrying");
          // Persisted so the UI can discard partial streamed text from the failed attempt.
          await this.emit(task, run, "model.retry", { attempt: attempt + 1, maxRetries: retries, delayMs: waitMs, error: detail });
          await delay(waitMs, signal, ctx.heartbeat);
          if (signal.aborted) throw new RunStop({ status: "cancelled" });
          continue;
        }
        this.opts.logger?.error(log, "model call failed");
        const failureCode = pe ? failureForProviderError(pe) : "provider_error";
        const suffix = pe?.retryable && attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
        throw new RunStop({ status: "failed", failureCode, message: `${pe ? pe.message : "Unexpected provider error"}${suffix}` }, detail);
      }
    }
  }

  private async ensureToolCallRecord(task: TaskRecord, run: RunRecord, call: ToolCallRequest, emit: boolean, risk: string | null = null) {
    const { record, created } = await this.opts.store.createToolCall(task.organizationId, {
      runId: run.id,
      taskId: task.id,
      call,
      status: "requested",
      risk: risk ?? this.opts.tools.get(call.name)?.risk ?? null,
    });
    if (created && emit) {
      await this.emit(task, run, "tool.requested", { toolCallId: record.id, toolName: call.name, arguments: call.arguments });
    }
    return record;
  }

  private async applyApproval(
    task: TaskRecord,
    agent: AgentConfig,
    run: RunRecord,
    rec: ToolCallRecord,
    call: ToolCallRequest,
    ctx: StepContext,
  ): Promise<ToolStepResult> {
    const { store } = this.opts;
    const approval = await store.getApprovalByToolCall(task.organizationId, rec.id);
    if (!approval || approval.status === "pending") return "awaiting_approval";
    if (approval.status === "approved") {
      return (await this.runTool(task, agent, run, rec, call, ctx, ["awaiting_approval"])) ? "succeeded" : "failed";
    }
    const reason = `Rejected by a human reviewer${approval.decisionNote ? `: ${approval.decisionNote}` : ""}`;
    if (await store.transitionToolCall(task.organizationId, rec.id, ["awaiting_approval"], { status: "approval_rejected", error: reason })) {
      await this.emit(task, run, "tool.rejected", { toolCallId: rec.id, toolName: rec.toolName, reason });
      await this.appendToolResult(task, run, call, { error: reason }, true);
    }
    return "failed";
  }

  /**
   * Run a tool after moving it to `running` with a compare-and-set from one of
   * `from`. If the transition fails, another execution owns it: do not run.
   */
  private async runTool(
    task: TaskRecord,
    agent: AgentConfig,
    run: RunRecord,
    record: Pick<ToolCallRecord, "id">,
    call: ToolCallRequest,
    ctx: StepContext,
    from: ToolCallRecord["status"][],
  ): Promise<boolean> {
    const { store, tools } = this.opts;
    const tool = tools.get(call.name);
    if (!tool) throw new Error("tool vanished");
    const owned = from.includes("running") || (await store.transitionToolCall(task.organizationId, record.id, from, { status: "running" }));
    if (!owned) {
      const now = await store.getToolCall(task.organizationId, record.id);
      return now?.status === "succeeded";
    }
    ctx.heartbeat?.({ phase: "tool", tool: call.name });
    const res = await executeTool(tool, call.arguments, {
      organizationId: task.organizationId,
      agentId: agent.id,
      runId: run.id,
      signal: ctx.signal,
      now: this.now,
    });
    if (res.ok) {
      await store.transitionToolCall(task.organizationId, record.id, ["running"], { status: "succeeded", output: res.output, durationMs: res.durationMs });
      await this.emit(task, run, "tool.completed", { toolCallId: record.id, toolName: call.name, output: res.output, durationMs: res.durationMs });
      await this.appendToolResult(task, run, call, res.output, false);
      return true;
    }
    if (res.kind === "aborted") throw new RunStop({ status: "cancelled" });
    await store.transitionToolCall(task.organizationId, record.id, ["running"], { status: "failed", error: res.error, durationMs: res.durationMs });
    await this.emit(task, run, "tool.failed", { toolCallId: record.id, toolName: call.name, reason: res.error, kind: res.kind });
    await this.appendToolResult(task, run, call, { error: res.error }, true);
    return false;
  }

  /** Append the stored outcome of a finished tool call if the transcript does not have it yet. */
  private async ensureToolResult(task: TaskRecord, run: RunRecord, call: ToolCallRequest, rec: ToolCallRecord) {
    if (await this.opts.store.hasToolResult(task.organizationId, task.conversationId!, call.id)) return;
    if (rec.status === "succeeded") await this.appendToolResult(task, run, call, rec.output, false);
    else await this.appendToolResult(task, run, call, { error: rec.error ?? "Tool call did not succeed" }, true);
  }

  private async appendToolResult(task: TaskRecord, run: RunRecord, call: ToolCallRequest, body: unknown, isError: boolean) {
    await this.opts.store.appendMessage(task.organizationId, task.conversationId!, run.id, {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: JSON.stringify(body),
      isError,
    });
  }

  /** Run `fn`; convert RunStop into a finalized terminal outcome. */
  private async guard<T>(task: TaskRecord, run: RunRecord | null, fn: () => Promise<T>): Promise<T | { kind: "terminal"; outcome: TerminalOutcome }> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RunStop) return { kind: "terminal", outcome: await this.finishStopped(task, run, err.outcome, err.detail) };
      throw err;
    }
  }

  private async failTerminal(task: TaskRecord, run: RunRecord | null, code: FailureCode, message: string): Promise<{ kind: "terminal"; outcome: TerminalOutcome }> {
    return { kind: "terminal", outcome: await this.failTask(task, run, code, message) };
  }

  private terminalOutcome(task: TaskRecord): TerminalOutcome | null {
    if (!TERMINAL_TASK_STATUSES.includes(task.status)) return null;
    if (task.status === "completed") return { status: "completed", result: task.result ?? "" };
    if (task.status === "failed") return { status: "failed", failureCode: task.failureCode ?? "internal_error", message: task.failureMessage ?? "" };
    return { status: "cancelled" };
  }

  private async mustGetTask(orgId: string, taskId: string): Promise<TaskRecord> {
    const task = await this.opts.store.getTask(orgId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return task;
  }

  private async mustGetRun(orgId: string, runId: string): Promise<RunRecord> {
    const run = await this.opts.store.getRun(orgId, runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    return run;
  }

  private async mustGetAgent(task: TaskRecord): Promise<AgentConfig> {
    const agent = task.agentId ? await this.opts.store.getAgent(task.organizationId, task.agentId) : null;
    if (!agent) throw new RunStop({ status: "failed", failureCode: "internal_error", message: "Agent not found" });
    return agent;
  }

  private async checkCancelled(task: TaskRecord, signal: AbortSignal) {
    if (signal.aborted) throw new RunStop({ status: "cancelled" });
    const fresh = await this.opts.store.getTask(task.organizationId, task.id);
    if (fresh?.cancelRequestedAt) throw new RunStop({ status: "cancelled" });
  }

  private async complete(task: TaskRecord, run: RunRecord, response: Pick<ModelResponse, "text" | "stopReason">): Promise<TerminalOutcome> {
    const { store } = this.opts;
    const now = this.now();
    const resultData = extractStructured(response.text);
    await store.updateRun(task.organizationId, run.id, { status: "completed", completedAt: now });
    await store.updateTask(task.organizationId, task.id, { status: "completed", result: response.text, resultData, completedAt: now });
    await this.emit(task, run, "run.completed", {
      result: response.text,
      truncated: response.stopReason === "max_tokens",
      iterations: run.iterations,
      costUsd: run.costUsd,
    });
    await this.emit(task, run, "task.status", { status: "completed" });
    return { status: "completed", result: response.text };
  }

  private async finishStopped(
    task: TaskRecord,
    run: RunRecord | null,
    outcome: RunStop["outcome"],
    detail?: Record<string, unknown>,
  ): Promise<TerminalOutcome> {
    if (outcome.status === "cancelled") {
      const fresh = await this.opts.store.getTask(task.organizationId, task.id);
      if (fresh && TERMINAL_TASK_STATUSES.includes(fresh.status)) return this.terminalOutcome(fresh)!;
      const now = this.now();
      if (run) await this.opts.store.updateRun(task.organizationId, run.id, { status: "cancelled", completedAt: now });
      await this.opts.store.updateTask(task.organizationId, task.id, { status: "cancelled", completedAt: now });
      await this.opts.store.closePendingApprovals(task.organizationId, task.id, "Task was cancelled");
      await this.emit(task, run, "run.cancelled", {});
      await this.emit(task, run, "task.status", { status: "cancelled" });
      return outcome;
    }
    return this.failTask(task, run, outcome.failureCode, outcome.message, detail);
  }

  private async failTask(
    task: TaskRecord,
    run: RunRecord | null,
    code: FailureCode,
    message: string,
    detail?: Record<string, unknown>,
  ): Promise<TerminalOutcome> {
    const now = this.now();
    if (run) await this.opts.store.updateRun(task.organizationId, run.id, { status: "failed", failureCode: code, failureMessage: message, completedAt: now });
    await this.opts.store.updateTask(task.organizationId, task.id, { status: "failed", failureCode: code, failureMessage: message, completedAt: now });
    await this.opts.store.closePendingApprovals(task.organizationId, task.id, "Task failed");
    await this.emit(task, run, "run.failed", { failureCode: code, message, ...(detail ? { error: detail } : {}) });
    this.opts.logger?.warn?.({ event: "run_failed", taskId: task.id, runId: run?.id, failureCode: code, ...(detail ?? {}) }, "run failed");
    await this.emit(task, run, "task.status", { status: "failed", failureCode: code });
    return { status: "failed", failureCode: code, message };
  }

  private async setTaskStatus(task: TaskRecord, status: TaskStatus) {
    await this.opts.store.updateTask(task.organizationId, task.id, { status });
    await this.opts.events.emit({
      organizationId: task.organizationId,
      taskId: task.id,
      runId: null,
      agentId: task.agentId,
      type: "task.status",
      payload: { status },
    });
  }

  private emit(task: TaskRecord, run: RunRecord | null, type: Parameters<EventSink["emit"]>[0]["type"], payload: Record<string, unknown>) {
    return this.opts.events.emit({
      organizationId: task.organizationId,
      taskId: task.id,
      runId: run?.id ?? null,
      agentId: run?.agentId ?? task.agentId,
      type,
      payload,
    });
  }
}

function isTerminalWrapper(v: unknown): v is { kind: "terminal"; outcome: TerminalOutcome } {
  return typeof v === "object" && v !== null && (v as { kind?: string }).kind === "terminal";
}

export function toolFailureMessage(n: number): string {
  return `Stopped after ${n} consecutive model turns whose tool calls all failed or were rejected`;
}

function delay(ms: number, signal: AbortSignal, heartbeat?: (d?: unknown) => void): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    const hb = heartbeat ? setInterval(() => heartbeat({ phase: "backoff" }), 5_000) : null;
    function done() {
      clearTimeout(t);
      if (hb) clearInterval(hb);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Re-exported for adapters that want to signal a missing org credential in the same way.
export const notConfigured = (provider: string) => providerError("not_configured", provider);
