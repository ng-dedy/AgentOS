import type { FailureCode, TaskStatus } from "@agentos/contracts";
import { TERMINAL_TASK_STATUSES } from "@agentos/contracts";
import {
  ProviderError,
  type ModelProvider,
  type ModelResponse,
  type ProviderRegistry,
  type ToolCallRequest,
} from "@agentos/providers";
import { executeTool, type ToolRegistry } from "@agentos/tools";
import { buildSystemPrompt, extractStructured } from "./context";
import type { AgentConfig, EventSink, RunRecord, RunStore, TaskRecord, ToolCallRecord } from "./store";

export interface EngineOptions {
  store: RunStore;
  events: EventSink;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  now?: () => Date;
  /** Per model call. */
  providerTimeoutMs?: number;
  /** Retries for retryable provider errors (in addition to the first attempt). */
  providerRetries?: number;
  retryBaseDelayMs?: number;
  logger?: { error: (obj: unknown, msg?: string) => void };
}

export type RunOutcome =
  | { status: "completed"; result: string }
  | { status: "awaiting_approval" }
  | { status: "failed"; failureCode: FailureCode; message: string }
  | { status: "cancelled" };

class RunStop extends Error {
  constructor(readonly outcome: Exclude<RunOutcome, { status: "completed" } | { status: "awaiting_approval" }>) {
    super(outcome.status);
  }
}

/**
 * Executes one task with one agent: context → model → tools → model … until a
 * final answer or an enforced limit. All state lives in the RunStore, so a run
 * paused for approval can be resumed by any process.
 */
export class AgentEngine {
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => Date;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Abort an in-flight run in this process. Returns false if none is active here. */
  abort(taskId: string): boolean {
    const c = this.active.get(taskId);
    if (!c) return false;
    c.abort();
    return true;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** Start a fresh run for a queued task, or continue the latest run after an approval decision. */
  async execute(orgId: string, taskId: string): Promise<RunOutcome> {
    const { store } = this.opts;
    const task = await store.getTask(orgId, taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) {
      return task.status === "completed"
        ? { status: "completed", result: task.result ?? "" }
        : task.status === "failed"
          ? { status: "failed", failureCode: task.failureCode ?? "internal_error", message: task.failureMessage ?? "" }
          : { status: "cancelled" };
    }
    if (this.active.has(taskId)) throw new Error(`Task ${taskId} is already running`);
    if (!task.agentId || !task.conversationId) return this.failTask(task, null, "internal_error", "Task has no agent or conversation");

    const controller = new AbortController();
    this.active.set(taskId, controller);
    let run: RunRecord | null = null;
    try {
      const agent = await store.getAgent(orgId, task.agentId);
      if (!agent) return await this.failTask(task, null, "internal_error", "Agent not found");
      if (agent.status !== "active") return await this.failTask(task, null, "internal_error", "Agent is paused");
      const provider = this.opts.providers.get(agent.provider);
      if (!provider || !provider.isConfigured()) {
        return await this.failTask(task, null, "provider_not_configured", `Provider '${agent.provider}' is not configured`);
      }
      if (!this.opts.providers.catalog.find(agent.provider, agent.model)) {
        return await this.failTask(task, null, "provider_not_configured", `Model '${agent.model}' is not in the catalog`);
      }

      const existing = task.status === "awaiting_approval" ? await store.getLatestRun(orgId, taskId) : null;
      if (existing && existing.status === "awaiting_approval") {
        run = existing;
        await store.updateRun(orgId, run.id, { status: "running" });
        await this.setTaskStatus(task, "running");
        const stillWaiting = await this.resolveApprovedCalls(task, agent, run, controller.signal);
        if (stillWaiting) return await this.pause(task, run);
      } else {
        run = await store.createRun(orgId, { taskId, agentId: agent.id, provider: agent.provider, model: agent.model });
        await store.updateTask(orgId, taskId, { status: "running", startedAt: this.now() });
        await this.emit(task, run, "run.started", { provider: agent.provider, model: agent.model, isMock: provider.isMock });
        await this.emit(task, run, "task.status", { status: "running" });
      }

      return await this.loop(task, agent, provider, run, controller.signal);
    } catch (err) {
      if (err instanceof RunStop) return await this.finishStopped(task, run, err.outcome);
      this.opts.logger?.error({ err, taskId }, "run crashed");
      return await this.failTask(task, run, "internal_error", "Internal error while running the task");
    } finally {
      this.active.delete(taskId);
    }
  }

  private async loop(task: TaskRecord, agent: AgentConfig, provider: ModelProvider, run: RunRecord, signal: AbortSignal): Promise<RunOutcome> {
    const { store, tools } = this.opts;
    const system = buildSystemPrompt(agent, task.handoffInput);
    const allowed = agent.allowedTools.filter((n) => tools.has(n));
    const toolSpecs = tools.specs(allowed);
    const catalogEntry = this.opts.providers.catalog.find(agent.provider, agent.model);
    const maxOutputTokens = catalogEntry?.maxOutputTokens ?? 4096;

    for (;;) {
      await this.checkCancelled(task, signal);
      if (run.iterations >= agent.maxIterations) {
        throw new RunStop({ status: "failed", failureCode: "iteration_limit", message: `Stopped after ${agent.maxIterations} model iterations` });
      }

      const messages = await store.loadMessages(task.organizationId, task.conversationId!);
      const response = await this.callModel(task, run, provider, signal, {
        model: agent.model,
        system,
        messages,
        tools: toolSpecs,
        maxOutputTokens,
      });

      // Usage accounting happens before any limit check so overspend is always recorded.
      const cost = this.opts.providers.catalog.cost(agent.provider, agent.model, response.usage);
      run.iterations += 1;
      run.inputTokens += response.usage.inputTokens;
      run.outputTokens += response.usage.outputTokens;
      run.costUsd += cost;
      await store.updateRun(task.organizationId, run.id, {
        iterations: run.iterations,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: run.costUsd,
      });
      await store.recordUsage(task.organizationId, {
        runId: run.id,
        agentId: agent.id,
        provider: agent.provider,
        model: agent.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedTokens: response.usage.cachedInputTokens,
        costUsd: cost,
      });
      await this.emit(task, run, "usage.recorded", {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: cost,
        runCostUsd: run.costUsd,
      });

      await store.appendMessage(task.organizationId, task.conversationId!, run.id, {
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
        providerState: response.providerState,
      });
      await this.emit(task, run, "model.output", {
        text: response.text,
        iteration: run.iterations,
        stopReason: response.stopReason,
        toolCalls: response.toolCalls.map((c) => ({ id: c.id, name: c.name })),
      });

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
      if (response.stopReason === "refusal") {
        throw new RunStop({ status: "failed", failureCode: "provider_error", message: "The model declined the request" });
      }

      if (response.toolCalls.length === 0) return this.complete(task, run, response);

      let waiting = false;
      for (const call of response.toolCalls) {
        await this.checkCancelled(task, signal);
        const r = await this.handleToolCall(task, agent, run, call, signal);
        if (r === "awaiting_approval") waiting = true;
      }
      if (waiting) return this.pause(task, run);
    }
  }

  private async callModel(
    task: TaskRecord,
    run: RunRecord,
    provider: ModelProvider,
    signal: AbortSignal,
    req: Parameters<ModelProvider["generate"]>[0],
  ): Promise<ModelResponse> {
    const retries = this.opts.providerRetries ?? 2;
    const base = this.opts.retryBaseDelayMs ?? 500;
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.generate(req, {
          signal,
          timeoutMs: this.opts.providerTimeoutMs ?? 120_000,
          onDelta: (text) =>
            this.opts.events.emitTransient({
              organizationId: task.organizationId,
              taskId: task.id,
              runId: run.id,
              agentId: run.agentId,
              type: "model.delta",
              payload: { text },
            }),
        });
      } catch (err) {
        if (signal.aborted || (err instanceof ProviderError && err.kind === "aborted")) {
          throw new RunStop({ status: "cancelled" });
        }
        const pe = err instanceof ProviderError ? err : null;
        if (pe?.retryable && attempt < retries) {
          await delay(base * 2 ** attempt, signal);
          continue;
        }
        throw new RunStop({
          status: "failed",
          failureCode: pe?.retryable ? "provider_retryable_error" : "provider_error",
          message: pe ? pe.message : "Unexpected provider error",
        });
      }
    }
  }

  /** Returns how the call ended. Never trusts the model's claim that a tool ran. */
  private async handleToolCall(
    task: TaskRecord,
    agent: AgentConfig,
    run: RunRecord,
    call: ToolCallRequest,
    signal: AbortSignal,
  ): Promise<"done" | "awaiting_approval"> {
    const { store, tools } = this.opts;
    const orgId = task.organizationId;
    const tool = tools.get(call.name);
    const { record, created } = await store.createToolCall(orgId, {
      runId: run.id,
      taskId: task.id,
      call,
      status: "requested",
      risk: tool?.risk ?? null,
    });
    if (!created && record.status !== "requested") {
      // Already handled (e.g. replay after a crash). Do not execute twice.
      return record.status === "awaiting_approval" ? "awaiting_approval" : "done";
    }
    await this.emit(task, run, "tool.requested", { toolCallId: record.id, toolName: call.name, arguments: call.arguments });

    const reject = async (status: "rejected" | "invalid", reason: string) => {
      await store.updateToolCall(orgId, record.id, { status, error: reason });
      await this.emit(task, run, status === "rejected" ? "tool.rejected" : "tool.failed", {
        toolCallId: record.id,
        toolName: call.name,
        reason,
      });
      await this.appendToolResult(task, run, call, { error: reason }, true);
      return "done" as const;
    };

    if (!tool || !agent.allowedTools.includes(call.name)) {
      return reject("rejected", `Tool '${call.name}' is not available to this agent`);
    }
    if (call.parseError) return reject("invalid", call.parseError);
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
      await store.updateToolCall(orgId, record.id, { status: "awaiting_approval" });
      const approval = await store.createApproval(orgId, {
        toolCallId: record.id,
        taskId: task.id,
        runId: run.id,
        agentId: agent.id,
        toolName: tool.name,
        arguments: parsed.data,
        reason,
      });
      await this.emit(task, run, "approval.required", {
        approvalId: approval.id,
        toolCallId: record.id,
        toolName: tool.name,
        arguments: parsed.data,
        reason,
        risk: tool.risk,
      });
      return "awaiting_approval";
    }

    await this.runTool(task, agent, run, record, call, signal);
    return "done";
  }

  private async runTool(
    task: TaskRecord,
    agent: AgentConfig,
    run: RunRecord,
    record: Pick<ToolCallRecord, "id">,
    call: ToolCallRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const { store, tools } = this.opts;
    const tool = tools.get(call.name);
    if (!tool) throw new Error("tool vanished");
    await store.updateToolCall(task.organizationId, record.id, { status: "running" });
    const res = await executeTool(tool, call.arguments, {
      organizationId: task.organizationId,
      agentId: agent.id,
      runId: run.id,
      signal,
      now: this.now,
    });
    if (res.ok) {
      await store.updateToolCall(task.organizationId, record.id, { status: "succeeded", output: res.output, durationMs: res.durationMs });
      await this.emit(task, run, "tool.completed", { toolCallId: record.id, toolName: call.name, output: res.output, durationMs: res.durationMs });
      await this.appendToolResult(task, run, call, res.output, false);
    } else {
      if (res.kind === "aborted") throw new RunStop({ status: "cancelled" });
      await store.updateToolCall(task.organizationId, record.id, { status: "failed", error: res.error, durationMs: res.durationMs });
      await this.emit(task, run, "tool.failed", { toolCallId: record.id, toolName: call.name, reason: res.error, kind: res.kind });
      await this.appendToolResult(task, run, call, { error: res.error }, true);
    }
  }

  /** After a decision: execute approved calls, return rejection results. Returns true if any are still pending. */
  private async resolveApprovedCalls(task: TaskRecord, agent: AgentConfig, run: RunRecord, signal: AbortSignal): Promise<boolean> {
    const { store } = this.opts;
    const waiting = await store.listToolCalls(task.organizationId, run.id, "awaiting_approval");
    let pending = false;
    for (const tc of waiting) {
      const approval = await store.getApprovalByToolCall(task.organizationId, tc.id);
      const call: ToolCallRequest = { id: tc.providerCallId, name: tc.toolName, arguments: tc.arguments };
      if (!approval || approval.status === "pending") {
        pending = true;
      } else if (approval.status === "approved") {
        await this.runTool(task, agent, run, tc, call, signal);
      } else {
        const reason = `Rejected by a human reviewer${approval.decisionNote ? `: ${approval.decisionNote}` : ""}`;
        await store.updateToolCall(task.organizationId, tc.id, { status: "approval_rejected", error: reason });
        await this.emit(task, run, "tool.rejected", { toolCallId: tc.id, toolName: tc.toolName, reason });
        await this.appendToolResult(task, run, call, { error: reason }, true);
      }
    }
    return pending;
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

  private async checkCancelled(task: TaskRecord, signal: AbortSignal) {
    if (signal.aborted) throw new RunStop({ status: "cancelled" });
    const fresh = await this.opts.store.getTask(task.organizationId, task.id);
    if (fresh?.cancelRequestedAt) throw new RunStop({ status: "cancelled" });
  }

  private async pause(task: TaskRecord, run: RunRecord): Promise<RunOutcome> {
    await this.opts.store.updateRun(task.organizationId, run.id, { status: "awaiting_approval" });
    await this.setTaskStatus(task, "awaiting_approval");
    return { status: "awaiting_approval" };
  }

  private async complete(task: TaskRecord, run: RunRecord, response: ModelResponse): Promise<RunOutcome> {
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

  private async finishStopped(task: TaskRecord, run: RunRecord | null, outcome: RunStop["outcome"]): Promise<RunOutcome> {
    if (outcome.status === "cancelled") {
      const now = this.now();
      if (run) await this.opts.store.updateRun(task.organizationId, run.id, { status: "cancelled", completedAt: now });
      await this.opts.store.updateTask(task.organizationId, task.id, { status: "cancelled", completedAt: now });
      await this.opts.store.closePendingApprovals(task.organizationId, task.id, "Task was cancelled");
      await this.emit(task, run, "run.cancelled", {});
      await this.emit(task, run, "task.status", { status: "cancelled" });
      return outcome;
    }
    return this.failTask(task, run, outcome.failureCode, outcome.message);
  }

  private async failTask(task: TaskRecord, run: RunRecord | null, code: FailureCode, message: string): Promise<RunOutcome> {
    const now = this.now();
    if (run) await this.opts.store.updateRun(task.organizationId, run.id, { status: "failed", failureCode: code, failureMessage: message, completedAt: now });
    await this.opts.store.updateTask(task.organizationId, task.id, { status: "failed", failureCode: code, failureMessage: message, completedAt: now });
    await this.emit(task, run, "run.failed", { failureCode: code, message });
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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
