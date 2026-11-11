import { providerError } from "../errors";
import type { GenerateOptions, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ToolCallRequest } from "../types";

/**
 * MOCK provider: a deterministic script, NOT an AI model.
 *
 * It exists so the platform can be tested end to end without provider keys. Every
 * answer it produces starts with "[MOCK]" and is derived from the tool results the
 * runtime actually fed back to it, so a test that sees the right number in the
 * final answer proves that the backend executed the tool.
 *
 * Directives (in the latest user message) used by tests:
 *   [mock:unknown_tool]   request a tool that does not exist / is not allowed
 *   [mock:invalid_args]   call calculator with arguments that fail validation
 *   [mock:loop]           keep calling calculator forever (iteration limit)
 *   [mock:slow]           wait ~3s before answering (cancellation)
 *   [mock:error=<kind>]   throw a normalized provider error (e.g. rate_limit, auth)
 *   [mock:approval]       call the approval-gated mock_external_action tool
 */
export class MockProvider implements ModelProvider {
  readonly id = "mock" as const;
  readonly label = "MOCK (scripted, not an AI model)";
  readonly isMock = true;
  private counter = 0;

  constructor(private readonly options: { slowMs?: number } = {}) {}

  isConfigured(): boolean {
    return true;
  }

  async generate(req: ModelRequest, opts: GenerateOptions): Promise<ModelResponse> {
    if (opts.signal.aborted) throw providerError("aborted", this.id);
    const lastUserIdx = findLastIndex(req.messages, (m) => m.role === "user");
    const lastUser = req.messages[lastUserIdx];
    const instruction = lastUser?.role === "user" ? lastUser.content : "";
    const after = req.messages.slice(lastUserIdx + 1);
    const toolResults = after.filter((m): m is Extract<ModelMessage, { role: "tool" }> => m.role === "tool");
    const available = new Set(req.tools.map((t) => t.name));

    const errMatch = /\[mock:error=([a-z_]+)\]/.exec(instruction);
    if (errMatch) throw providerError(errMatch[1] as Parameters<typeof providerError>[0], this.id);

    if (instruction.includes("[mock:slow]")) await sleep(this.options.slowMs ?? 3000, opts.signal);

    const call = (name: string, args: unknown): ModelResponse => this.toolResponse(req, { id: this.nextId(), name, arguments: args });

    if (instruction.includes("[mock:loop]")) return call("calculator", { expression: `${toolResults.length} + 1` });

    if (toolResults.length === 0) {
      if (instruction.includes("[mock:unknown_tool]")) return call("shell_exec", { command: "cat /etc/passwd" });
      if (instruction.includes("[mock:invalid_args]")) return call("calculator", { expr: 12 });
      if (instruction.includes("[mock:approval]") && available.has("mock_external_action")) {
        return call("mock_external_action", { action: "notify", target: "ops-channel", reason: "Task asked to notify the ops channel" });
      }
      const expr = extractExpression(instruction);
      if (expr && available.has("calculator")) return call("calculator", { expression: expr });
      if (/\b(time|date|today)\b/i.test(instruction) && available.has("current_datetime")) return call("current_datetime", {});
    }

    // Invalid-args directive: after one error result, answer without retrying.
    return this.finalResponse(req, instruction, toolResults, opts);
  }

  private nextId(): string {
    this.counter += 1;
    return `mock_call_${Date.now().toString(36)}_${this.counter}`;
  }

  private toolResponse(req: ModelRequest, call: ToolCallRequest): ModelResponse {
    return {
      text: "",
      toolCalls: [call],
      stopReason: "tool_use",
      usage: estimateUsage(req, JSON.stringify(call.arguments)),
    };
  }

  private async finalResponse(
    req: ModelRequest,
    instruction: string,
    toolResults: Extract<ModelMessage, { role: "tool" }>[],
    opts: GenerateOptions,
  ): Promise<ModelResponse> {
    let text: string;
    if (toolResults.length > 0) {
      const lines = toolResults.map((r) => {
        if (r.isError) return `- ${r.toolName} reported an error: ${truncate(r.content, 300)}`;
        return `- ${r.toolName} returned ${summarizeToolOutput(r.content)}`;
      });
      const last = toolResults[toolResults.length - 1];
      const answer = last && !last.isError ? summarizeToolOutput(last.content) : "unavailable (the tool call did not succeed)";
      text = `[MOCK] Tool evidence:\n${lines.join("\n")}\nFinal answer: ${answer}`;
    } else {
      const handoff = /<handoff[^>]*>([\s\S]*?)<\/handoff>/.exec(req.system)?.[1]?.trim();
      text = handoff
        ? `[MOCK] Reviewed the handoff from the previous agent. It reported: ${truncate(handoff, 400)}`
        : `[MOCK] No tool was needed. Received instruction: "${truncate(instruction, 200)}"`;
    }
    for (const word of text.split(/(?<=\s)/)) {
      if (opts.signal.aborted) throw providerError("aborted", this.id);
      opts.onDelta?.(word);
    }
    return { text, toolCalls: [], stopReason: "end", usage: estimateUsage(req, text) };
  }
}

/** Pull the first arithmetic expression out of free text, e.g. "What is (17 * 23) + 4?". */
export function extractExpression(text: string): string | undefined {
  const cleaned = text.replace(/\[mock:[^\]]*\]/g, "");
  const matches = cleaned.match(/[\d.(][\d\s.+\-*/%^()]*[\d)]/g) ?? [];
  return matches.map((m) => m.trim()).find((m) => /\d\s*[-+*/%^]\s*[\d(]/.test(m));
}

function summarizeToolOutput(content: string): string {
  try {
    const v = JSON.parse(content) as Record<string, unknown>;
    if (v && typeof v === "object" && "result" in v) return JSON.stringify(v.result);
    if (v && typeof v === "object" && "iso" in v) return String(v.iso);
    return truncate(content, 300);
  } catch {
    return truncate(content, 300);
  }
}

function estimateUsage(req: ModelRequest, output: string) {
  const inputChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  return { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.max(1, Math.ceil(output.length / 4)), cachedInputTokens: 0 };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i] as T)) return i;
  return -1;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(providerError("aborted", "mock"));
      },
      { once: true },
    );
  });
}
