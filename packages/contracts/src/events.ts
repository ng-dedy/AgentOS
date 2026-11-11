import { z } from "zod";

export const RunEventTypeSchema = z.enum([
  "task.created",
  "task.status",
  "run.started",
  "model.delta",
  "model.output",
  "model.retry",
  "activity.retry",
  "tool.requested",
  "tool.rejected",
  "approval.required",
  "approval.decided",
  "tool.completed",
  "tool.failed",
  "agent.handoff",
  "usage.recorded",
  "run.completed",
  "run.failed",
  "run.cancelled",
  /** A spending limit stopped the run (before a call: reservation; after: backstop). Costs are estimates. */
  "budget.exceeded",
  /** A provider request may have been billed without its result being kept (worker crash window). */
  "billing.possible_duplicate",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

/** Event as sent to clients (persisted events have a seq; live-only deltas do not). */
export const RunEventSchema = z.object({
  seq: z.string().nullable(),
  type: RunEventTypeSchema,
  taskId: z.string(),
  rootTaskId: z.string(),
  runId: z.string().nullable(),
  agentId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const HandoffSchema = z.object({
  fromAgentId: z.string(),
  fromAgentName: z.string(),
  fromTaskId: z.string(),
  summary: z.string().max(20_000),
  data: z.unknown().nullable(),
});
export type Handoff = z.infer<typeof HandoffSchema>;
