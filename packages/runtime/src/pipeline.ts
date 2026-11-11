import { HandoffSchema, TERMINAL_TASK_STATUSES, type Handoff } from "@agentos/contracts";
import type { EventSink, RunStore, TaskRecord } from "./store";

/**
 * What a pipeline needs next.
 * - `step`: this child task must be executed (or is already executing); wait for it to end.
 * - `done`: the pipeline reached a terminal state.
 */
export type PipelineDecision = { kind: "step"; childTaskId: string; childStatus: TaskRecord["status"] } | { kind: "done"; status: TaskRecord["status"] };

/**
 * Sequential multi-agent pipeline logic, shared by the in-process engine and the
 * Temporal pipeline workflow. `advance` is idempotent: it inspects the persisted
 * child tasks and performs at most the single next transition, so it is safe to
 * call again after a crash, a retry or a duplicate wake-up.
 */
export class PipelineCoordinator {
  constructor(
    private readonly store: RunStore,
    private readonly events: EventSink,
  ) {}

  async advance(orgId: string, parentId: string): Promise<PipelineDecision> {
    const parent = await this.store.getTask(orgId, parentId);
    if (!parent || parent.kind !== "pipeline" || !parent.pipelineSpec) return { kind: "done", status: parent?.status ?? "failed" };
    if (TERMINAL_TASK_STATUSES.includes(parent.status)) return { kind: "done", status: parent.status };
    const steps = parent.pipelineSpec;
    const children = (await this.store.listChildTasks(orgId, parentId)).sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
    const last = children[children.length - 1];

    if (parent.cancelRequestedAt && (!last || TERMINAL_TASK_STATUSES.includes(last.status))) {
      return this.settle(orgId, parentId);
    }

    if (!last) {
      await this.store.updateTask(orgId, parentId, { status: "running", startedAt: new Date() });
      await this.emit(parent, "task.status", { status: "running" });
      const first = await this.createStep(parent, 0, null);
      return { kind: "step", childTaskId: first.id, childStatus: first.status };
    }
    if (!TERMINAL_TASK_STATUSES.includes(last.status)) return { kind: "step", childTaskId: last.id, childStatus: last.status };

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
        const next = await this.createStep(parent, idx + 1, handoff);
        await this.emit(parent, "agent.handoff", {
          fromAgentId: handoff.fromAgentId,
          fromAgentName: handoff.fromAgentName,
          toAgentId: next.agentId,
          fromTaskId: last.id,
          toTaskId: next.id,
          summary: handoff.summary.slice(0, 500),
          hasData: handoff.data !== null,
        });
        return { kind: "step", childTaskId: next.id, childStatus: next.status };
      }
      await this.store.updateTask(orgId, parentId, { status: "completed", result: last.result, resultData: last.resultData, completedAt: new Date() });
      await this.emit(parent, "run.completed", { result: last.result, steps: steps.length });
      await this.emit(parent, "task.status", { status: "completed" });
      return { kind: "done", status: "completed" };
    }
    return this.settle(orgId, parentId, last);
  }

  private async createStep(parent: TaskRecord, index: number, handoff: Handoff | null): Promise<TaskRecord> {
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
    return child;
  }

  /** End a pipeline after a failed or cancelled step (or cancellation): mark remaining steps skipped. */
  private async settle(orgId: string, parentId: string, failedStep?: TaskRecord): Promise<PipelineDecision> {
    const parent = await this.store.getTask(orgId, parentId);
    if (!parent || !parent.pipelineSpec) return { kind: "done", status: "failed" };
    if (TERMINAL_TASK_STATUSES.includes(parent.status)) return { kind: "done", status: parent.status };
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
      return { kind: "done", status: "cancelled" };
    }
    const message = `Step ${(failedStep?.stepIndex ?? 0) + 1} failed: ${failedStep?.failureMessage ?? "unknown error"}`;
    await this.store.updateTask(orgId, parentId, { status: "failed", failureCode: "step_failed", failureMessage: message, completedAt: now });
    await this.emit(parent, "run.failed", { failureCode: "step_failed", message });
    await this.emit(parent, "task.status", { status: "failed", failureCode: "step_failed" });
    return { kind: "done", status: "failed" };
  }

  private emit(task: TaskRecord, type: Parameters<EventSink["emit"]>[0]["type"], payload: Record<string, unknown>) {
    return this.events.emit({ organizationId: task.organizationId, taskId: task.id, runId: null, agentId: task.agentId, type, payload });
  }
}
