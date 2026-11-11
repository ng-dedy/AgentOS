import { z } from "zod";
import type { AnyToolDefinition, ToolContext, ToolExecutionResult } from "./types";

const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export interface ToolSpec {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition): this {
    if (!NAME_RE.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    if (tool.timeoutMs <= 0 || tool.timeoutMs > 60_000) throw new Error(`Invalid timeout for ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Provider-facing spec. Only tools passed in `names` are exported. */
  specs(names: readonly string[]): ToolSpec[] {
    return names
      .map((n) => this.tools.get(n))
      .filter((t): t is AnyToolDefinition => t !== undefined)
      .map((t) => ({ name: t.name, description: t.description, inputJsonSchema: toJsonSchema(t.inputSchema) }));
  }
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/**
 * Validate input, run the handler with a hard timeout, validate output.
 * Never throws: all failures are returned as values so callers can record them.
 */
export async function executeTool(
  tool: AnyToolDefinition,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, kind: "invalid_input", error: formatZodError(parsed.error), durationMs: elapsed() };
  }
  if (ctx.signal.aborted) return { ok: false, kind: "aborted", error: "Run was cancelled", durationMs: elapsed() };

  const timeout = new AbortController();
  const onAbort = () => timeout.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const output = await Promise.race([
      tool.handler(parsed.data, { ...ctx, signal: timeout.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timeout.abort();
          reject(new ToolTimeoutError(tool.timeoutMs));
        }, tool.timeoutMs);
      }),
    ]);
    const out = tool.outputSchema.safeParse(output);
    if (!out.success) {
      return { ok: false, kind: "invalid_output", error: formatZodError(out.error), durationMs: elapsed() };
    }
    return { ok: true, output: out.data, durationMs: elapsed() };
  } catch (err) {
    if (err instanceof ToolTimeoutError) return { ok: false, kind: "timeout", error: err.message, durationMs: elapsed() };
    if (ctx.signal.aborted) return { ok: false, kind: "aborted", error: "Run was cancelled", durationMs: elapsed() };
    const message = err instanceof ToolUserError ? err.message : "Tool execution failed";
    return { ok: false, kind: "error", error: message, durationMs: elapsed() };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`Tool timed out after ${ms}ms`);
  }
}

/** Errors whose message is safe to show to the model and the user. */
export class ToolUserError extends Error {}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
