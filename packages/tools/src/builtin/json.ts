import { z } from "zod";
import { ToolUserError } from "../registry";
import { defineTool } from "../types";

const Path = z.string().max(200).describe("Dot path such as items.0.name; empty string means the root");
const Operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), path: Path }),
  z.object({ op: z.literal("pick"), keys: z.array(z.string().max(100)).min(1).max(50) }),
  z.object({ op: z.literal("sort_by"), key: z.string().max(100), order: z.enum(["asc", "desc"]).default("asc") }),
  z.object({ op: z.literal("filter_eq"), key: z.string().max(100), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ op: z.literal("sum"), key: z.string().max(100) }),
  z.object({ op: z.literal("count") }),
]);
type Operation = z.infer<typeof Operation>;

const MAX_INPUT_CHARS = 200_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function getPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (FORBIDDEN_KEYS.has(part)) throw new ToolUserError(`Forbidden path segment '${part}'`);
    if (cur === null || typeof cur !== "object") return null;
    cur = Object.hasOwn(cur, part) ? (cur as Record<string, unknown>)[part] : null;
  }
  return cur ?? null;
}

function requireArray(v: unknown, op: string): unknown[] {
  if (!Array.isArray(v)) throw new ToolUserError(`'${op}' requires an array`);
  return v;
}

export function applyJsonOperations(data: unknown, ops: readonly Operation[]): unknown {
  let cur = data;
  for (const op of ops) {
    switch (op.op) {
      case "get":
        cur = getPath(cur, op.path);
        break;
      case "pick": {
        const pickOne = (o: unknown) =>
          o && typeof o === "object" && !Array.isArray(o)
            ? Object.fromEntries(op.keys.filter((k) => !FORBIDDEN_KEYS.has(k) && Object.hasOwn(o, k)).map((k) => [k, (o as Record<string, unknown>)[k]]))
            : null;
        cur = Array.isArray(cur) ? cur.map(pickOne) : pickOne(cur);
        break;
      }
      case "sort_by": {
        const arr = [...requireArray(cur, "sort_by")];
        const dir = op.order === "desc" ? -1 : 1;
        arr.sort((a, b) => {
          const x = getPath(a, op.key);
          const y = getPath(b, op.key);
          if (x === y) return 0;
          if (x === null) return 1;
          if (y === null) return -1;
          return (x as number | string) < (y as number | string) ? -dir : dir;
        });
        cur = arr;
        break;
      }
      case "filter_eq":
        cur = requireArray(cur, "filter_eq").filter((x) => getPath(x, op.key) === op.value);
        break;
      case "sum":
        cur = requireArray(cur, "sum").reduce<number>((acc, x) => {
          const v = getPath(x, op.key);
          return typeof v === "number" ? acc + v : acc;
        }, 0);
        break;
      case "count":
        cur = requireArray(cur, "count").length;
        break;
    }
  }
  return cur;
}

export const jsonTransformTool = defineTool({
  name: "json_transform",
  description:
    "Transform JSON data with a fixed pipeline of operations: get (dot path), pick (keys), sort_by, filter_eq, sum, count. " +
    "Pass the data as a JSON string in `json`.",
  inputSchema: z.object({ json: z.string().max(MAX_INPUT_CHARS), operations: z.array(Operation).min(1).max(20) }).strict(),
  outputSchema: z.object({ result: z.unknown() }),
  permission: "tool:json_transform",
  risk: "safe",
  requiresApproval: false,
  timeoutMs: 2000,
  handler: async ({ json, operations }) => {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw new ToolUserError("`json` is not valid JSON");
    }
    return { result: applyJsonOperations(data, operations) };
  },
});
