import { z } from "zod";
import { ToolUserError } from "../registry";
import { defineTool } from "../types";

export const currentDateTimeTool = defineTool({
  name: "current_datetime",
  description: "Return the current date and time from the server clock, optionally in an IANA time zone.",
  inputSchema: z
    .object({ timezone: z.string().max(64).optional().describe("IANA time zone such as Europe/Berlin. Defaults to UTC.") })
    .strict(),
  outputSchema: z.object({ iso: z.string(), unixMs: z.number(), timezone: z.string(), local: z.string(), weekday: z.string() }),
  permission: "tool:current_datetime",
  risk: "safe",
  requiresApproval: false,
  timeoutMs: 1000,
  handler: async ({ timezone }, ctx) => {
    const tz = timezone ?? "UTC";
    const now = ctx.now();
    let local: string;
    let weekday: string;
    try {
      local = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        dateStyle: "short",
        timeStyle: "medium",
        hourCycle: "h23",
      }).format(now);
      weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
    } catch {
      throw new ToolUserError(`Unknown time zone '${tz}'`);
    }
    return { iso: now.toISOString(), unixMs: now.getTime(), timezone: tz, local, weekday };
  },
});
