import { appendFileSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "../types";

/**
 * Test hooks (never set in normal use):
 * - AGENTOS_MOCK_ACTION_LEDGER: file path. Each execution appends one JSON line, standing
 *   in for an external side effect so durability tests can count real executions.
 * - AGENTOS_MOCK_ACTION_DELAY_MS: hold the action open this long (worker-crash tests).
 */
const LEDGER = process.env.AGENTOS_MOCK_ACTION_LEDGER;
const DELAY_MS = Math.max(0, Number(process.env.AGENTOS_MOCK_ACTION_DELAY_MS ?? 0) || 0);

/**
 * MOCK sensitive tool used to exercise the approval flow. It contacts no external
 * system and has no side effects beyond the ToolCall row the runtime records
 * (and the optional test ledger above).
 */
export const mockExternalActionTool = defineTool({
  name: "mock_external_action",
  description:
    "MOCK sensitive action (requires human approval). Simulates sending a notification to an external system. " +
    "No external system is contacted.",
  inputSchema: z
    .object({
      action: z.string().min(1).max(100),
      target: z.string().min(1).max(200),
      reason: z.string().min(1).max(500).describe("Why this action is needed; shown to the approver"),
    })
    .strict(),
  outputSchema: z.object({ mock: z.literal(true), status: z.literal("simulated"), action: z.string(), target: z.string(), note: z.string() }),
  permission: "tool:mock_external_action",
  risk: "sensitive",
  requiresApproval: true,
  timeoutMs: 2000 + DELAY_MS,
  handler: async ({ action, target }, ctx) => {
    if (LEDGER) appendFileSync(LEDGER, `${JSON.stringify({ runId: ctx.runId, action, target, pid: process.pid, at: new Date().toISOString() })}\n`);
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    return {
      mock: true as const,
      status: "simulated" as const,
      action,
      target,
      note: "MOCK: no external system was contacted",
    };
  },
});
