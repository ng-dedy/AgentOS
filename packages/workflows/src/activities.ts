import { Context } from "@temporalio/activity";
import type { AgentEngine, EngineLogger, EventSink, PipelineCoordinator, StepContext } from "@agentos/runtime";
import type { AgentActivities, TaskInput } from "./types";

export interface ActivityDeps {
  engine: AgentEngine;
  pipelines: PipelineCoordinator;
  events: EventSink;
  logger?: EngineLogger;
  /** Heartbeat interval; must be well under the workflow's heartbeatTimeout (30 s). */
  heartbeatMs?: number;
}

/** Counters for worker health reporting. */
export const activityStats = { active: 0, started: 0, retried: 0, failed: 0 };

/**
 * Activity implementations: thin adapters from Temporal to the engine's idempotent
 * step API. Each one heartbeats (so a dead worker is noticed and its step moves to
 * another worker), forwards Temporal cancellation as an AbortSignal, and records a
 * persisted `activity.retry` event whenever it runs as a retry.
 */
export function createActivities(deps: ActivityDeps): AgentActivities {
  const { engine, pipelines } = deps;

  const run = <I extends TaskInput, O>(fn: (input: I, ctx: StepContext) => Promise<O>) =>
    async (input: I): Promise<O> => {
      const c = Context.current();
      const ctl = new AbortController();
      const onCancel = () => ctl.abort();
      c.cancellationSignal.addEventListener("abort", onCancel, { once: true });
      const timeout = c.info.heartbeatTimeoutMs ?? 30_000;
      const hb = setInterval(() => c.heartbeat(), deps.heartbeatMs ?? Math.max(500, Math.min(5_000, Math.floor(timeout / 3))));
      const attempt = c.info.attempt;
      activityStats.active++;
      activityStats.started++;
      const started = Date.now();
      try {
        if (attempt > 1) {
          activityStats.retried++;
          deps.logger?.warn?.({ event: "activity_retry", activity: c.info.activityType, attempt, taskId: input.taskId, workflowId: c.info.workflowExecution?.workflowId }, "activity retry");
          await deps.events.emit({
            organizationId: input.orgId,
            taskId: input.taskId,
            runId: "runId" in input && typeof input.runId === "string" ? input.runId : null,
            agentId: null,
            type: "activity.retry",
            payload: { activity: c.info.activityType, attempt, workflowId: c.info.workflowExecution?.workflowId },
          });
        }
        const out = await fn(input, { signal: ctl.signal, heartbeat: (d) => c.heartbeat(d), attempt });
        // The engine has already recorded the cancellation; acknowledge it to Temporal.
        if (c.cancellationSignal.aborted) await c.cancelled;
        return out;
      } catch (err) {
        if (!c.cancellationSignal.aborted) {
          activityStats.failed++;
          deps.logger?.error(
            { event: "activity_failed", activity: c.info.activityType, attempt, taskId: input.taskId, durationMs: Date.now() - started, err: err instanceof Error ? err.message : String(err) },
            "activity failed",
          );
        }
        throw err;
      } finally {
        clearInterval(hb);
        c.cancellationSignal.removeEventListener("abort", onCancel);
        activityStats.active--;
      }
    };

  return {
    beginRun: run((i) => engine.beginRun(i.orgId, i.taskId)),
    modelTurn: run((i: TaskInput & { runId: string; turn: number }, ctx) => engine.modelTurn(i.orgId, i.taskId, i.runId, i.turn, ctx)),
    toolStep: run((i: TaskInput & { runId: string; toolCallId: string }, ctx) => engine.toolStep(i.orgId, i.taskId, i.runId, i.toolCallId, ctx)),
    pauseForApproval: run((i: TaskInput & { runId: string }) => engine.pauseForApproval(i.orgId, i.taskId, i.runId)),
    resumeAfterApproval: run((i: TaskInput & { runId: string }) => engine.resumeAfterApproval(i.orgId, i.taskId, i.runId)),
    failRun: run((i: Parameters<AgentActivities["failRun"]>[0]) => engine.failRun(i.orgId, i.taskId, i.runId, i.code, i.message, i.detail)),
    cancelTask: run((i) => engine.cancelTask(i.orgId, i.taskId)),
    advancePipeline: run((i) => pipelines.advance(i.orgId, i.taskId)),
  };
}
