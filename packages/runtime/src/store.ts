import type {
  ApprovalStatus,
  FailureCode,
  Handoff,
  RunEventType,
  RunStatus,
  TaskKind,
  TaskStatus,
  ToolCallStatus,
} from "@agentos/contracts";
import type { ModelMessage, ToolCallRequest } from "@agentos/providers";

export interface SkillContext {
  name: string;
  version: number;
  instructions: string;
}

export interface AgentConfig {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  instructions: string;
  provider: string;
  model: string;
  allowedTools: string[];
  maxIterations: number;
  maxRunCostUsd: number;
  maxRunTokens: number | null;
  status: "active" | "paused";
  skills: SkillContext[];
}

export interface PipelineStepSpec {
  agentId: string;
  instruction: string;
}

export interface TaskRecord {
  id: string;
  organizationId: string;
  kind: TaskKind;
  title: string;
  instruction: string;
  status: TaskStatus;
  agentId: string | null;
  conversationId: string | null;
  parentTaskId: string | null;
  stepIndex: number | null;
  pipelineSpec: PipelineStepSpec[] | null;
  handoffInput: Handoff | null;
  result: string | null;
  resultData: unknown;
  failureCode: FailureCode | null;
  failureMessage: string | null;
  cancelRequestedAt: Date | null;
  /** Spending limit for the whole task tree (all runs and pipeline steps), or null. */
  maxCostUsd?: number | null;
}

export interface RunRecord {
  id: string;
  organizationId: string;
  taskId: string;
  agentId: string;
  provider: string;
  model: string;
  status: RunStatus;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  providerCallId: string;
  toolName: string;
  arguments: unknown;
  status: ToolCallStatus;
  output: unknown;
  error: string | null;
  risk?: string | null;
}

export interface AssistantTurn {
  content: string;
  toolCalls: ToolCallRequest[];
}

export interface ApprovalRecord {
  id: string;
  organizationId: string;
  toolCallId: string;
  taskId: string;
  runId: string;
  status: ApprovalStatus;
  decisionNote: string | null;
}

export interface NewEvent {
  organizationId: string;
  taskId: string;
  runId: string | null;
  agentId: string | null;
  type: RunEventType;
  payload: Record<string, unknown>;
}

/**
 * Persistence port for the runtime. Every method is organization-scoped; an
 * implementation must never return rows belonging to another organization.
 */
export interface RunStore {
  getTask(orgId: string, taskId: string): Promise<TaskRecord | null>;
  updateTask(
    orgId: string,
    taskId: string,
    patch: Partial<Pick<TaskRecord, "status" | "result" | "resultData" | "failureCode" | "failureMessage">> & {
      startedAt?: Date;
      completedAt?: Date;
    },
  ): Promise<void>;
  requestCancel(orgId: string, taskId: string): Promise<void>;
  listChildTasks(orgId: string, parentTaskId: string): Promise<TaskRecord[]>;
  /** Creates a child task with its own conversation and the initial user message. */
  createChildTask(
    orgId: string,
    input: { parentTaskId: string; stepIndex: number; agentId: string; title: string; instruction: string; handoffInput: Handoff | null; status?: TaskStatus },
  ): Promise<TaskRecord>;

  getAgent(orgId: string, agentId: string): Promise<AgentConfig | null>;

  createRun(orgId: string, input: { taskId: string; agentId: string; provider: string; model: string }): Promise<RunRecord>;
  getRun(orgId: string, runId: string): Promise<RunRecord | null>;
  getLatestRun(orgId: string, taskId: string): Promise<RunRecord | null>;
  updateRun(
    orgId: string,
    runId: string,
    patch: Partial<Pick<RunRecord, "status" | "iterations" | "inputTokens" | "outputTokens" | "costUsd">> & {
      failureCode?: FailureCode;
      failureMessage?: string;
      completedAt?: Date;
    },
  ): Promise<void>;

  loadMessages(orgId: string, conversationId: string): Promise<ModelMessage[]>;
  appendMessage(orgId: string, conversationId: string, runId: string | null, message: ModelMessage): Promise<void>;

  /** Idempotent on (runId, providerCallId): returns the existing row if already recorded. */
  createToolCall(
    orgId: string,
    input: { runId: string; taskId: string; call: ToolCallRequest; status: ToolCallStatus; risk: string | null },
  ): Promise<{ record: ToolCallRecord; created: boolean }>;
  updateToolCall(
    orgId: string,
    id: string,
    patch: { status: ToolCallStatus; output?: unknown; error?: string | null; durationMs?: number },
  ): Promise<void>;
  listToolCalls(orgId: string, runId: string, status?: ToolCallStatus): Promise<ToolCallRecord[]>;
  getToolCall(orgId: string, id: string): Promise<ToolCallRecord | null>;
  /**
   * Compare-and-set: apply `patch` only if the current status is one of `from`.
   * Returns false when another execution already moved the row. This is what
   * guarantees a tool runs at most once across retries and workers.
   */
  transitionToolCall(
    orgId: string,
    id: string,
    from: ToolCallStatus[],
    patch: { status: ToolCallStatus; output?: unknown; error?: string | null; durationMs?: number },
  ): Promise<boolean>;

  /** Assistant messages written by one run, oldest first: turn n is index n. */
  getAssistantTurns(orgId: string, conversationId: string, runId: string): Promise<AssistantTurn[]>;
  /** Whether the transcript already holds the result for this provider tool call id. */
  hasToolResult(orgId: string, conversationId: string, providerCallId: string): Promise<boolean>;
  /** Total estimated spend of a task tree (root plus children), in USD. */
  getTreeSpend(orgId: string, rootTaskId: string): Promise<number>;

  /** Idempotent on toolCallId: returns the existing approval if one was already created. */
  createApproval(
    orgId: string,
    input: { toolCallId: string; taskId: string; runId: string; agentId: string; toolName: string; arguments: unknown; reason: string },
  ): Promise<ApprovalRecord>;
  getApprovalByToolCall(orgId: string, toolCallId: string): Promise<ApprovalRecord | null>;
  /** Auto-reject pending approvals for a task (e.g. when it is cancelled). */
  closePendingApprovals(orgId: string, taskId: string, note: string): Promise<number>;

  recordUsage(
    orgId: string,
    input: { runId: string; agentId: string; provider: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; latencyMs?: number; attempt?: number },
  ): Promise<void>;
}

/** Event output port. `emit` persists then publishes; `emitTransient` publishes only. */
export interface EventSink {
  emit(event: NewEvent): Promise<void>;
  emitTransient(event: NewEvent): void;
}
