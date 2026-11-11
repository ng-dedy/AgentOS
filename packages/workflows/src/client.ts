import { Client, Connection, WorkflowNotFoundError, type WorkflowHandle } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from "@temporalio/common";
import { TERMINAL_TASK_STATUSES } from "@agentos/contracts";
import type { RunStore, WorkflowDescription, WorkflowEngine } from "@agentos/runtime";
import { workflowIdFor, type WorkflowInput, type WorkflowOptions } from "./types";

export interface TemporalEngineOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  store: RunStore;
  /** Persist the execution id on the task. */
  recordWorkflowId: (orgId: string, taskId: string, workflowId: string) => Promise<void>;
  /** Finalize a cancellation when no workflow is running for the task (e.g. it already closed). */
  finalizeCancel: (orgId: string, taskId: string) => Promise<void>;
  logger?: { warn?: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  workflowOptions?: WorkflowOptions;
}

/**
 * API-side `WorkflowEngine` backed by Temporal. The API never executes agent steps
 * in this mode: it starts, signals, cancels and describes workflows that run on
 * dedicated worker processes.
 */
export class TemporalWorkflowEngine implements WorkflowEngine {
  readonly kind = "temporal" as const;

  private constructor(
    private readonly connection: Connection,
    readonly client: Client,
    private readonly opts: TemporalEngineOptions,
  ) {}

  static async connect(opts: TemporalEngineOptions): Promise<TemporalWorkflowEngine> {
    const connection = await Connection.connect({ address: opts.address });
    const client = new Client({ connection, namespace: opts.namespace });
    return new TemporalWorkflowEngine(connection, client, opts);
  }

  /**
   * Idempotent: the workflow id is derived from the task id. A second start for a task
   * whose workflow is running, or completed, is a no-op. A workflow that failed or was
   * terminated can be started again (the engine's steps resume from Postgres).
   */
  async start(orgId: string, taskId: string): Promise<void> {
    const task = await this.opts.store.getTask(orgId, taskId);
    if (!task) return;
    const workflowId = workflowIdFor(taskId);
    try {
      await this.client.workflow.start(task.kind === "pipeline" ? "pipelineWorkflow" : "agentTaskWorkflow", {
        workflowId,
        taskQueue: this.opts.taskQueue,
        args: [this.input(orgId, taskId)],
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        memo: { orgId },
      });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    }
    await this.opts.recordWorkflowId(orgId, taskId, workflowId);
  }

  /**
   * Wake the task's workflow after an approval decision. Uses signal-with-start so a
   * task whose workflow is missing (for example it was created before this engine
   * was enabled) still resumes. The workflow also re-checks Postgres periodically,
   * so a lost signal delays the resume but cannot hang the task.
   */
  async signalApproval(orgId: string, taskId: string): Promise<void> {
    const task = await this.opts.store.getTask(orgId, taskId);
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return;
    const workflowId = workflowIdFor(taskId);
    try {
      await this.client.workflow.signalWithStart("agentTaskWorkflow", {
        workflowId,
        taskQueue: this.opts.taskQueue,
        args: [this.input(orgId, taskId)],
        signal: "approvalDecided",
        signalArgs: [],
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        memo: { orgId },
      });
      await this.opts.recordWorkflowId(orgId, taskId, workflowId);
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) return;
      this.opts.logger?.warn?.({ event: "approval_signal_failed", taskId, err: err instanceof Error ? err.message : String(err) }, "approval signal failed; the workflow will re-check");
    }
  }

  async cancel(orgId: string, taskId: string): Promise<void> {
    const task = await this.opts.store.getTask(orgId, taskId);
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return;
    // Persist the request first: running steps check it even if the cancel RPC is lost.
    await this.opts.store.requestCancel(orgId, taskId);
    // A pipeline step is cancelled through its parent, so the pipeline settles too.
    const target = task.parentTaskId ?? taskId;
    if (task.parentTaskId) await this.opts.store.requestCancel(orgId, task.parentTaskId);
    const handle = this.client.workflow.getHandle(workflowIdFor(target));
    try {
      const d = await handle.describe();
      if (d.status.name === "RUNNING") {
        await handle.cancel();
        return;
      }
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;
    }
    // No live workflow (never started, or closed): finalize directly.
    await this.opts.finalizeCancel(orgId, taskId);
  }

  async describe(orgId: string, taskId: string): Promise<WorkflowDescription | null> {
    const task = await this.opts.store.getTask(orgId, taskId);
    if (!task) return null;
    const workflowId = workflowIdFor(taskId);
    const handle: WorkflowHandle = this.client.workflow.getHandle(workflowId);
    try {
      const d = await handle.describe();
      const raw = d.raw;
      return {
        engine: "temporal",
        workflowId,
        status: d.status.name,
        historyLength: d.historyLength,
        startTime: d.startTime?.toISOString() ?? null,
        closeTime: d.closeTime?.toISOString() ?? null,
        taskQueue: d.taskQueue,
        pendingActivities: (raw.pendingActivities ?? []).map((a) => ({
          activityType: a.activityType?.name ?? "unknown",
          attempt: a.attempt ?? 1,
          state: stateName(a.state),
          lastFailure: a.lastFailure?.message ? a.lastFailure.message.slice(0, 500) : null,
          lastHeartbeatTime: tsToIso(a.lastHeartbeatTime),
          scheduledTime: tsToIso(a.scheduledTime),
        })),
        children: (raw.pendingChildren ?? []).map((c) => ({ workflowId: c.workflowId ?? "" })),
      };
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return { engine: "temporal", workflowId, status: "NOT_FOUND", pendingActivities: [] };
      throw err;
    }
  }

  private input(orgId: string, taskId: string): WorkflowInput {
    return { orgId, taskId, ...(this.opts.workflowOptions ? { options: this.opts.workflowOptions } : {}) };
  }

  /** True when at least one worker is polling the task queue. */
  async hasPollers(): Promise<{ workflowPollers: number; activityPollers: number }> {
    const svc = this.connection.workflowService;
    const q = async (taskQueueType: 1 | 2) =>
      (await svc.describeTaskQueue({ namespace: this.opts.namespace, taskQueue: { name: this.opts.taskQueue }, taskQueueType })).pollers?.length ?? 0;
    return { workflowPollers: await q(1), activityPollers: await q(2) };
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

const STATES: Record<number, string> = { 1: "SCHEDULED", 2: "STARTED", 3: "CANCEL_REQUESTED", 4: "PAUSED", 5: "PAUSE_REQUESTED" };
function stateName(s: unknown): string {
  return typeof s === "number" ? (STATES[s] ?? String(s)) : "UNKNOWN";
}

function tsToIso(ts: { seconds?: unknown; nanos?: number | null } | null | undefined): string | null {
  if (!ts || ts.seconds === undefined || ts.seconds === null) return null;
  const secs = Number(ts.seconds as number | bigint | { toString(): string });
  return new Date(secs * 1000 + Math.floor((ts.nanos ?? 0) / 1e6)).toISOString();
}
