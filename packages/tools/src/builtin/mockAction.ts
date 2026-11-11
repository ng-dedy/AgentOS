import { z } from "zod";
import { defineTool } from "../types";

/**
 * MOCK sensitive tool used to exercise the approval flow. It contacts no external
 * system and has no side effects beyond the ToolCall row the runtime records.
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
  timeoutMs: 2000,
  handler: async ({ action, target }) => ({
    mock: true as const,
    status: "simulated" as const,
    action,
    target,
    note: "MOCK: no external system was contacted",
  }),
});
