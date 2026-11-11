// Shared between workflow code (deterministic sandbox) and activities. Type-only imports.
import type { FailureCode } from "@agentos/contracts";
import type { BeginResult, PipelineDecision, TerminalOutcome, ToolStepResult, TurnResult } from "@agentos/runtime";

export interface TaskInput {
  orgId: string;
  taskId: string;
}

/** Workflow arguments. `options` are recorded in history, so replay stays deterministic. */
export interface WorkflowInput extends TaskInput {
  options?: WorkflowOptions;
}
/**
 * Recorded in history with the workflow input, so replay stays deterministic. Every field
 * is optional and defaults to the milestone 2B value, so histories started before a field
 * existed replay unchanged (see the committed history fixtures).
 */
export interface WorkflowOptions {
  /** How long an activity may go without a heartbeat before it is retried elsewhere. Default 30 s. */
  heartbeatTimeoutMs?: number;
  /** start-to-close timeout of one model or tool step. Default 15 min. */
  stepTimeoutMs?: number;
  /** Infrastructure retries of one step. Default 5. */
  stepMaxAttempts?: number;
}
export interface RunInput extends TaskInput {
  runId: string;
}

/** Activities the workflows call. Every one is idempotent and safe to retry. */
export interface AgentActivities {
  beginRun(input: TaskInput): Promise<BeginResult>;
  modelTurn(input: RunInput & { turn: number }): Promise<TurnResult>;
  toolStep(input: RunInput & { toolCallId: string }): Promise<ToolStepResult>;
  pauseForApproval(input: RunInput): Promise<void>;
  resumeAfterApproval(input: RunInput): Promise<void>;
  failRun(input: TaskInput & { runId: string | null; code: FailureCode; message: string; detail?: Record<string, unknown> }): Promise<TerminalOutcome>;
  cancelTask(input: TaskInput): Promise<TerminalOutcome>;
  advancePipeline(input: TaskInput): Promise<PipelineDecision>;
}

/** Live state exposed through the `state` query. */
export interface AgentWorkflowState {
  phase: "starting" | "model" | "tools" | "awaiting_approval" | "finalizing" | "done";
  runId: string | null;
  turn: number;
  waitingOn: string[];
  approvalSignals: number;
}

export const workflowIdFor = (taskId: string) => `task-${taskId}`;
