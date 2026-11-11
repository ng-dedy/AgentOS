import { HandoffSchema, TERMINAL_TASK_STATUSES, type Handoff } from "@agentos/contracts";
import type { AgentEngine, RunOutcome } from "./engine";
import type { EventSink, RunStore, TaskRecord } from "./store";

/**
 * Durable-execution seam. The in-process implementation below is enough for a
 * single API instance; a Temporal implementation would map `start` to starting a
 * workflow, `signalApproval` to a workflow signal, and `cancel` to cancellation.
 */
export interface WorkflowEngine {
  /** Begin executing a queued task (single, chat or pipeline). Returns immediately. */
  start(orgId: string, taskId: string): void;
  /** Request cancellation. Safe to call repeatedly. */
  cancel(orgId: string, taskId: string): Promise<void>;
  /** A human decided an approval for this task; continue the run. */
  signalApproval(orgId: string, taskId: string): void;
}

export class InProcessWorkflowEngine implements WorkflowEngine {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly engine: AgentEngine,
    private readonly store: RunStore,
    private readonly events: EventSink,
    private readonly logger?: { error: (obj: unknown, msg?: string) => void },
  ) {}

  start(orgId: string, taskId: string): void {
    this.track(this.runTask(orgId, taskId));
  }

  signalApproval(orgId: string, taskId: string): void {
    this.track(this.runTask(orgId, taskId));
  }

  async cancel(orgId: string, taskId: string): Promise<void> {
    const task = await this.store.getTask(orgId, taskId);
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return;
    await this.store.requestCancel(orgId, taskId);

    if (task.kind === "pipeline") {
      const children = await this.store.listChildTasks(orgId, taskId);
      const active = children.find((c) => !TERMINAL_TASK_STATUSES.includes(c.status));
      if (active) await this.cancel(orgId, active.id);
      else await this.settlePipeline(orgId, taskId);
      return;
    }

    // An in-flight run will notice the abort and finish as cancelled.
    if (this.engine.abort(taskId)) return;
    // Nothing is running (queued or waiting for approval): finalize directly.
    const now = new Date();
    const run = await this.store.getLatestRun(orgId, taskId);
    if (run && (run.status === "running" || run.status === "awaiting_approval")) {
      await this.store.updateRun(orgId, run.id, { status: "cancelled", completedAt: now });
    }
    await this.store.updateTask(orgId, taskId, { status: "cancelled", completedAt: now });
    await this.store.closePendingApprovals(orgId, taskId, "Task was cancelled");
    await this.emit(task, "run.cancelled", { runId: run?.id ?? null }, run?.id ?? null);
    await this.emit(task, "task.status", { status: "cancelled" });
    if (task.parentTaskId) await this.advancePipeline(orgId, task.parentTaskId);
  }

  /** Resolves when all background work has settled (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<unknown>) {
    const wrapped = p.catch((err: unknown) => this.logger?.error({ err }, "workflow step failed"));
    this.inflight.add(wrapped);
    void wrapped.finally(() => this.inflight.delete(wrapped));
  }

  private async runTask(orgId: string, taskId: string): Promise<void> {
    const task = await this.store.getTask(orgId, taskId);
    if (!task) return;
    if (task.kind === "pipeline") {
      await this.advancePipeline(orgId, taskId);
      return;
    }
    const outcome: RunOutcome = await this.engine.execute(orgId, taskId);
    if (outcome.status !== "awaiting_approval" && task.parentTaskId) {
      await this.advancePipeline(orgId, task.parentTaskId);
    }
  }

  /**
   * Sequential two-agent pipeline. Idempotent: inspects persisted child tasks and
   * performs the single next step, so it can be re-invoked after any event.
   */
  async advancePipeline(orgId: string, parentId: string): Promise<void> {
    const parent = await this.store.getTask(orgId, parentId);
    if (!parent || parent.kind !== "pipeline" || !parent.pipelineSpec) return;
    if (TERMINAL_TASK_STATUSES.includes(parent.status)) return;
    const steps = parent.pipelineSpec;
    const children = (await this.store.listChildTasks(orgId, parentId)).sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
    const last = children[children.length - 1];

    if (parent.cancelRequestedAt && (!last || TERMINAL_TASK_STATUSES.includes(last.status))) {
      await this.settlePipeline(orgId, parentId);
      return;
    }

    if (!last) {
      await this.store.updateTask(orgId, parentId, { status: "running", startedAt: new Date() });
      await this.emit(parent, "task.status", { status: "running" });
      await this.startStep(parent, 0, null);
      return;
    }
    if (!TERMINAL_TASK_STATUSES.includes(last.status)) return; // still running / awaiting approval

    const idx = last.stepIndex ?? 0;
    if (last.status === "completed") {
      if (idx + 1 < steps.length) {
        const fromAgent = last.agentId ? await this.store.getAgent(orgId, last.agentId) : null;
        const handoff: Handoff = HandoffSchema.parse({
          fromAgentId: last.agentId ?? "",
          fromAgentName: fromAgent?.name ?? "previous agent",
          fromTaskId: last.id,
          summary: (last.result ?? "").slice(0, 20_000),
          data: last.resultData ?? null,
        });
        const next = await this.startStep(parent, idx + 1, handoff);
        await this.emit(parent, "agent.handoff", {
          fromAgentId: handoff.fromAgentId,
          fromAgentName: handoff.fromAgentName,
          toAgentId: next.agentId,
          fromTaskId: last.id,
          toTaskId: next.id,
          summary: handoff.summary.slice(0, 500),
          hasData: handoff.data !== null,
        });
        this.track(this.runTask(orgId, next.id));
        return;
      }
      await this.store.updateTask(orgId, parentId, {
        status: "completed",
        result: last.result,
        resultData: last.resultData,
        completedAt: new Date(),
      });
      await this.emit(parent, "run.completed", { result: last.result, steps: steps.length });
      await this.emit(parent, "task.status", { status: "completed" });
      return;
    }

    await this.settlePipeline(orgId, parentId, last);
  }

  private async startStep(parent: TaskRecord, index: number, handoff: Handoff | null): Promise<TaskRecord> {
    const step = parent.pipelineSpec?.[index];
    if (!step) throw new Error("missing pipeline step");
    const child = await this.store.createChildTask(parent.organizationId, {
      parentTaskId: parent.id,
      stepIndex: index,
      agentId: step.agentId,
      title: `${parent.title} · step ${index + 1}`,
      instruction: `${parent.instruction}\n\nYour step: ${step.instruction}`,
      handoffInput: handoff,
    });
    await this.events.emit({
      organizationId: parent.organizationId,
      taskId: child.id,
      runId: null,
      agentId: child.agentId,
      type: "task.created",
      payload: { kind: child.kind, title: child.title, stepIndex: index, parentTaskId: parent.id },
    });
    if (index === 0) this.track(this.runTask(parent.organizationId, child.id));
    return child;
  }

  /** End a pipeline after a failed/cancelled step (or cancellation): mark remaining steps skipped. */
  private async settlePipeline(orgId: string, parentId: string, failedStep?: TaskRecord): Promise<void> {
    const parent = await this.store.getTask(orgId, parentId);
    if (!parent || TERMINAL_TASK_STATUSES.includes(parent.status) || !parent.pipelineSpec) return;
    const children = await this.store.listChildTasks(orgId, parentId);
    for (let i = children.length; i < parent.pipelineSpec.length; i++) {
      const step = parent.pipelineSpec[i]!;
      await this.store.createChildTask(orgId, {
        parentTaskId: parentId,
        stepIndex: i,
        agentId: step.agentId,
        title: `${parent.title} · step ${i + 1}`,
        instruction: step.instruction,
        handoffInput: null,
        status: "skipped",
      });
    }
    const cancelled = parent.cancelRequestedAt !== null || failedStep?.status === "cancelled";
    const now = new Date();
    if (cancelled) {
      await this.store.updateTask(orgId, parentId, { status: "cancelled", completedAt: now });
      await this.emit(parent, "run.cancelled", {});
      await this.emit(parent, "task.status", { status: "cancelled" });
    } else {
      const message = `Step ${(failedStep?.stepIndex ?? 0) + 1} failed: ${failedStep?.failureMessage ?? "unknown error"}`;
      await this.store.updateTask(orgId, parentId, { status: "failed", failureCode: "step_failed", failureMessage: message, completedAt: now });
      await this.emit(parent, "run.failed", { failureCode: "step_failed", message });
      await this.emit(parent, "task.status", { status: "failed", failureCode: "step_failed" });
    }
  }

  private emit(task: TaskRecord, type: Parameters<EventSink["emit"]>[0]["type"], payload: Record<string, unknown>, runId: string | null = null) {
    return this.events.emit({ organizationId: task.organizationId, taskId: task.id, runId, agentId: task.agentId, type, payload });
  }
}
