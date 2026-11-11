import { z } from "zod";

export const ProviderIdSchema = z.enum(["openai", "anthropic", "xai", "mock"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ToolRiskSchema = z.enum(["safe", "sensitive", "dangerous"]);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const AgentStatusSchema = z.enum(["active", "paused"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const TaskKindSchema = z.enum(["single", "pipeline", "pipeline_step", "chat"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled", "skipped"];

export const RunStatusSchema = z.enum(["running", "awaiting_approval", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ToolCallStatusSchema = z.enum([
  "requested",
  "rejected",
  "invalid",
  "awaiting_approval",
  "approval_rejected",
  "running",
  "succeeded",
  "failed",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** Why a run ended in failure. `retryable` failures can be retried from the UI. */
export const FailureCodeSchema = z.enum([
  "provider_not_configured",
  "provider_error",
  "provider_retryable_error",
  "provider_auth",
  "provider_quota",
  "model_not_found",
  "provider_refusal",
  "context_length",
  "tool_failure_limit",
  "iteration_limit",
  "budget_exceeded",
  "token_limit",
  "interrupted",
  "step_failed",
  "execution_failed",
  "internal_error",
]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;
export const RETRYABLE_FAILURES: readonly FailureCode[] = [
  "provider_retryable_error",
  "provider_auth",
  "provider_quota",
  "interrupted",
  "provider_error",
  "step_failed",
  "execution_failed",
  "internal_error",
];
