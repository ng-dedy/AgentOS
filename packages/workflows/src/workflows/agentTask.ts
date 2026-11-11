import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { TerminalOutcome } from "@agentos/runtime";
import type { AgentActivities, AgentWorkflowState, TaskInput, WorkflowInput } from "../types";

/** Sent by the API when a human decides an approval for this task. Carries no data: the decision lives in Postgres. */
export const approvalDecided = defineSignal("approvalDecided");
export const stateQuery = defineQuery<AgentWorkflowState>("state");

// Business failures (budget, refusal, auth, invalid tool...) come back as values, so
// these retries only cover infrastructure faults: a crashed worker, a lost DB connection.
function stepActivities(options: WorkflowInput["options"]) {
  return proxyActivities<AgentActivities>({
    // A model turn includes the engine's own provider retries and backoff.
    startToCloseTimeout: options?.stepTimeoutMs ?? "15 minutes",
    // A dead worker is detected within the heartbeat timeout and the step moves to another worker.
    heartbeatTimeout: options?.heartbeatTimeoutMs ?? 30_000,
    retry: { maximumAttempts: options?.stepMaxAttempts ?? 5, initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "30 seconds" },
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  });
}
const finalizers = proxyActivities<AgentActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 10, initialInterval: "1 second", maximumInterval: "30 seconds" },
});

/** Re-check the database this often while waiting, in case a signal was lost. Grows to 30 min. */
const RECHECK_START_MS = 30_000;
const RECHECK_MAX_MS = 30 * 60_000;

/**
 * One agent task, durably. Deterministic: it only orchestrates activities, timers
 * and signals. All I/O (model calls, tools, the database) happens in activities.
 */
export async function agentTaskWorkflow(args: WorkflowInput): Promise<TerminalOutcome> {
  const input: TaskInput = { orgId: args.orgId, taskId: args.taskId };
  const steps = stepActivities(args.options);
  const state: AgentWorkflowState = { phase: "starting", runId: null, turn: 0, waitingOn: [], approvalSignals: 0 };
  setHandler(approvalDecided, () => {
    state.approvalSignals++;
  });
  setHandler(stateQuery, () => state);

  try {
    const begin = await steps.beginRun(input);
    if (begin.kind === "terminal") return done(state, begin.outcome);
    const runId = begin.runId;
    state.runId = runId;
    state.turn = begin.turn;
    let pending = begin.pendingToolCallIds;
    let consecutiveFailures = 0;

    for (;;) {
      if (pending.length === 0) {
        state.phase = "model";
        const r = await steps.modelTurn({ ...input, runId, turn: state.turn });
        if (r.kind === "terminal") return done(state, r.outcome);
        state.turn++;
        pending = r.toolCallIds;
      }

      state.phase = "tools";
      let anySucceeded = false;
      let waiting: string[] = [];
      for (const toolCallId of pending) {
        const s = await steps.toolStep({ ...input, runId, toolCallId });
        if (typeof s === "object") return done(state, s.terminal);
        if (s === "succeeded") anySucceeded = true;
        if (s === "awaiting_approval") waiting.push(toolCallId);
      }

      if (waiting.length > 0) {
        state.phase = "awaiting_approval";
        await steps.pauseForApproval({ ...input, runId });
        let recheck = RECHECK_START_MS;
        while (waiting.length > 0) {
          state.waitingOn = waiting;
          const seen = state.approvalSignals;
          const signalled = await condition(() => state.approvalSignals > seen, recheck);
          if (!signalled) recheck = Math.min(RECHECK_MAX_MS, recheck * 2);
          const still: string[] = [];
          for (const toolCallId of waiting) {
            const s = await steps.toolStep({ ...input, runId, toolCallId });
            if (typeof s === "object") return done(state, s.terminal);
            if (s === "awaiting_approval") still.push(toolCallId);
            if (s === "succeeded") anySucceeded = true;
          }
          waiting = still;
        }
        state.waitingOn = [];
        await steps.resumeAfterApproval({ ...input, runId });
      }

      pending = [];
      consecutiveFailures = anySucceeded ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= begin.maxConsecutiveToolFailures) {
        return done(
          state,
          await steps.failRun({
            ...input,
            runId,
            code: "tool_failure_limit",
            message: `Stopped after ${consecutiveFailures} consecutive model turns whose tool calls all failed or were rejected`,
          }),
        );
      }
    }
  } catch (err) {
    state.phase = "finalizing";
    if (isCancellation(err)) {
      // Record the cancellation even though this workflow is being cancelled.
      return done(state, await CancellationScope.nonCancellable(() => finalizers.cancelTask(input)));
    }
    if (err instanceof ActivityFailure) {
      const cause = err.cause instanceof ApplicationFailure ? err.cause : null;
      const outcome = await CancellationScope.nonCancellable(() =>
        finalizers.failRun({
          ...input,
          runId: state.runId,
          code: "execution_failed",
          message: `Step '${err.activityType}' kept failing after retries${cause?.message ? `: ${cause.message.slice(0, 300)}` : ""}`,
          detail: { activity: err.activityType, retryState: String(err.retryState ?? ""), type: cause?.type ?? null },
        }),
      );
      return done(state, outcome);
    }
    throw err;
  }
}

function done(state: AgentWorkflowState, outcome: TerminalOutcome): TerminalOutcome {
  state.phase = "done";
  return outcome;
}
