import type { ToolRisk } from "@agentos/contracts";
import type { z } from "zod";

export interface ToolContext {
  organizationId: string;
  agentId: string;
  runId: string;
  signal: AbortSignal;
  now: () => Date;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  /** Unique, stable identifier exposed to models. `^[a-z][a-z0-9_]{1,63}$` */
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  /** Permission string an agent must hold (via its allowlist) to call this tool. */
  permission: string;
  risk: ToolRisk;
  requiresApproval: boolean;
  timeoutMs: number;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry stores heterogeneous tools
export type AnyToolDefinition = ToolDefinition<any, any>;

export function defineTool<I, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return def;
}

export type ToolExecutionResult =
  | { ok: true; output: unknown; durationMs: number }
  | { ok: false; kind: "invalid_input" | "invalid_output" | "timeout" | "error" | "aborted"; error: string; durationMs: number };
