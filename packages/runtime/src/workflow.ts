import { TERMINAL_TASK_STATUSES } from "@agentos/contracts";
import type { AgentEngine } from "./engine";
import { PipelineCoordinator } from "./pipeline";
import type { EventSink, RunStore } from "./store";

/** Live view of a task's durable execution, for inspection endpoints. */
export interface WorkflowDescription {
  engine: "temporal" | "inprocess";
  workflowId: string | null;
  status: string;
  historyLength?: number;
  startTime?: string | null;
  closeTime?: string | null;
  taskQueue?: string;
  pendingActivities: {
    activityType: string;
    attempt: number;
    state: string;
    lastFailure?: string | null;
    lastHeartbeatTime?: string | null;
    scheduledTime?: string | null;
  }[];
  children?: { workflowId: string; status?: string }[];
}

/**
 * Durable-execution seam used by the API. Implementations:
 * - `InProcessWorkflowEngine` (below): runs steps in the API process. Unit tests and fallback.
 * - `TemporalWorkflowEngine` (`@agentos/workflows`): starts workflows that dedicated workers execute.
 */
export interface WorkflowEngine {
  readonly kind: "temporal" | "inprocess";
  /** Begin executing a queued task (single, chat or pipeline). Idempotent per task. */
  start(orgId: string, taskId: string): Promise<void>;
  /** Request cancellation. Safe to call repeatedly. */
  cancel(orgId: string, taskId: string): Promise<void>;
  /** A human decided an approval for this task; continue the run. */
  signalApproval(orgId: string, taskId: string): Promise<void>;
  /** Inspect the execution behind a task. */
  describe?(orgId: string, taskId: string): Promise<WorkflowDescription | null>;
  /** Resolves when local background work has settled (tests and graceful shutdown). */
  idle?(): Promise<void>;
  close?(): Promise<void>;
}

export class InProcessWorkflowEngine implements WorkflowEngine {
  readonly kind = "inprocess" as const;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly pipelines: PipelineCoordinator;

  constructor(
    private readonly engine: AgentEngine,
    private readonly store: RunStore,
    events: EventSink,
    private readonly logger?: { error: (obj: unknown, msg?: string) => void },
  ) {
    this.pipelines = new PipelineCoordinator(store, events);
  }

  async start(orgId: string, taskId: string): Promise<void> {
    this.track(this.runTask(orgId, taskId));
  }

  async signalApproval(orgId: string, taskId: string): Promise<void> {
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
      else await this.advancePipeline(orgId, taskId);
      return;
    }

    // An in-flight run will notice the abort and finish as cancelled.
    if (this.engine.abort(taskId)) return;
    // Nothing is running (queued or waiting for approval): finalize directly.
    await this.engine.cancelTask(orgId, taskId);
    if (task.parentTaskId) await this.advancePipeline(orgId, task.parentTaskId);
  }

  async describe(orgId: string, taskId: string): Promise<WorkflowDescription | null> {
    const task = await this.store.getTask(orgId, taskId);
    if (!task) return null;
    return { engine: "inprocess", workflowId: null, status: this.engine.isActive(taskId) ? "RUNNING" : task.status.toUpperCase(), pendingActivities: [] };
  }

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
    const outcome = await this.engine.execute(orgId, taskId);
    if (outcome.status !== "awaiting_approval" && task.parentTaskId) {
      await this.advancePipeline(orgId, task.parentTaskId);
    }
  }

  /** Advance a pipeline one step and run the next child if it is ready. */
  async advancePipeline(orgId: string, parentId: string): Promise<void> {
    const d = await this.pipelines.advance(orgId, parentId);
    if (d.kind === "step" && d.childStatus === "queued" && !this.engine.isActive(d.childTaskId)) {
      this.track(this.runTask(orgId, d.childTaskId));
    }
  }
}
