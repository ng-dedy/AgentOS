import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyJsonOperations,
  createDefaultToolRegistry,
  defineTool,
  evaluateExpression,
  executeTool,
  type ToolContext,
} from "../src";

const ctx = (): ToolContext => ({
  organizationId: "org",
  agentId: "agent",
  runId: "run",
  signal: new AbortController().signal,
  now: () => new Date("2026-01-02T03:04:05Z"),
});

describe("calculator", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(17 * 23) + 4", 395],
    ["2 ^ 3 ^ 2", 512],
    ["-3 + +4", 1],
    ["sqrt(16) + max(1, 9, 3)", 13],
    ["10 % 4", 2],
    ["round(pi * 100)", 314],
  ])("%s = %d", (expr, expected) => {
    expect(evaluateExpression(expr)).toBe(expected);
  });

  it.each(["", "1 +", "process.exit()", "constructor", "1/0", "2 ** 3", "alert(1)", "1;2"])("rejects %j", (expr) => {
    expect(() => evaluateExpression(expr)).toThrow();
  });
});

describe("json_transform", () => {
  const data = [
    { name: "b", n: 2, team: "x" },
    { name: "a", n: 5, team: "y" },
    { name: "c", n: 1, team: "x" },
  ];
  it("chains operations", () => {
    expect(applyJsonOperations(data, [{ op: "filter_eq", key: "team", value: "x" }, { op: "sum", key: "n" }])).toBe(3);
    expect(applyJsonOperations(data, [{ op: "sort_by", key: "name", order: "asc" }, { op: "get", path: "0.name" }])).toBe("a");
    expect(applyJsonOperations({ a: 1, b: 2 }, [{ op: "pick", keys: ["a"] }])).toEqual({ a: 1 });
  });
  it("refuses prototype paths", () => {
    expect(() => applyJsonOperations({}, [{ op: "get", path: "__proto__.x" }])).toThrow(/Forbidden/);
  });
});

describe("executeTool", () => {
  const registry = createDefaultToolRegistry();

  it("runs a valid call and validates output", async () => {
    const r = await executeTool(registry.get("calculator")!, { expression: "6*7" }, ctx());
    expect(r).toMatchObject({ ok: true, output: { result: 42 } });
  });

  it("rejects invalid input without running the handler", async () => {
    const r = await executeTool(registry.get("calculator")!, { expression: 42 }, ctx());
    expect(r).toMatchObject({ ok: false, kind: "invalid_input" });
    const extra = await executeTool(registry.get("calculator")!, { expression: "1", shell: "rm -rf" }, ctx());
    expect(extra).toMatchObject({ ok: false, kind: "invalid_input" });
  });

  it("enforces timeouts", async () => {
    const slow = defineTool({
      name: "slow_tool",
      description: "",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      permission: "tool:slow",
      risk: "safe",
      requiresApproval: false,
      timeoutMs: 20,
      handler: () => new Promise((r) => setTimeout(() => r({}), 500)),
    });
    const r = await executeTool(slow, {}, ctx());
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
  });

  it("rejects outputs that do not match the schema", async () => {
    const bad = defineTool({
      name: "bad_tool",
      description: "",
      inputSchema: z.object({}),
      outputSchema: z.object({ n: z.number() }),
      permission: "tool:bad",
      risk: "safe",
      requiresApproval: false,
      timeoutMs: 100,
      handler: async () => ({ n: "nope" }) as unknown as { n: number },
    });
    expect(await executeTool(bad, {}, ctx())).toMatchObject({ ok: false, kind: "invalid_output" });
  });

  it("hides unexpected handler errors", async () => {
    const boom = defineTool({
      name: "boom_tool",
      description: "",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      permission: "tool:boom",
      risk: "safe",
      requiresApproval: false,
      timeoutMs: 100,
      handler: async () => {
        throw new Error("secret internal detail");
      },
    });
    const r = await executeTool(boom, {}, ctx());
    expect(r).toMatchObject({ ok: false, kind: "error", error: "Tool execution failed" });
  });

  it("uses the injected clock and validates time zones", async () => {
    const r = await executeTool(registry.get("current_datetime")!, { timezone: "Asia/Jakarta" }, ctx());
    expect(r).toMatchObject({ ok: true, output: { iso: "2026-01-02T03:04:05.000Z", weekday: "Friday" } });
    const bad = await executeTool(registry.get("current_datetime")!, { timezone: "Mars/Olympus" }, ctx());
    expect(bad).toMatchObject({ ok: false, kind: "error" });
  });

  it("exports JSON schemas for providers", () => {
    const [spec] = registry.specs(["calculator"]);
    expect(spec?.inputJsonSchema).toMatchObject({ type: "object", required: ["expression"] });
    expect(registry.specs(["nope"])).toEqual([]);
  });

  it("marks the mock approval tool as sensitive", () => {
    const t = registry.get("mock_external_action")!;
    expect(t.requiresApproval).toBe(true);
    expect(t.risk).toBe("sensitive");
  });
});
