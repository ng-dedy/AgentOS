import Anthropic from "@anthropic-ai/sdk";
import { classifyStatus, providerError, ProviderError, withTimeout } from "../errors";
import type {
  GenerateOptions,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  SecretsProvider,
  StopReason,
  ToolCallRequest,
} from "../types";

/** Anthropic Messages API adapter (official SDK, streaming + finalMessage). */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic";
  readonly isMock = false;
  private client: Anthropic | undefined;

  constructor(
    private readonly secrets: SecretsProvider,
    private readonly clientFactory: (apiKey: string) => Anthropic = (apiKey) => new Anthropic({ apiKey, maxRetries: 0 }),
  ) {}

  isConfigured(): boolean {
    return this.secrets.get("ANTHROPIC_API_KEY") !== undefined;
  }

  private getClient(): Anthropic {
    const key = this.secrets.get("ANTHROPIC_API_KEY");
    if (!key) throw providerError("not_configured", this.id);
    this.client ??= this.clientFactory(key);
    return this.client;
  }

  async generate(req: ModelRequest, opts: GenerateOptions): Promise<ModelResponse> {
    const client = this.getClient();
    try {
      const message = await withTimeout(this.id, opts.timeoutMs, opts.signal, async (signal) => {
        const stream = client.messages.stream(
          {
            model: req.model,
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: toAnthropicMessages(req.messages),
            ...(req.tools.length > 0
              ? {
                  tools: req.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputJsonSchema as Anthropic.Tool.InputSchema,
                  })),
                }
              : {}),
          },
          { signal },
        );
        if (opts.onDelta) stream.on("text", (delta) => opts.onDelta?.(delta));
        return stream.finalMessage();
      });
      return fromAnthropicMessage(message);
    } catch (err) {
      throw normalizeAnthropicError(err);
    }
  }
}

export function toAnthropicMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // Replay the provider's raw content (including thinking blocks) unchanged when we have it.
      const raw = Array.isArray(m.providerState) ? (m.providerState as Anthropic.ContentBlockParam[]) : undefined;
      const content: Anthropic.ContentBlockParam[] = raw ?? [
        ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.arguments ?? {} })),
      ];
      out.push({ role: "assistant", content });
    } else {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        is_error: m.isError,
      };
      const prev = out[out.length - 1];
      // All results for one assistant turn go in a single user message.
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

export function fromAnthropicMessage(message: Anthropic.Message): ModelResponse {
  let text = "";
  const toolCalls: ToolCallRequest[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") {
      const input = block.input;
      toolCalls.push(
        input !== null && typeof input === "object"
          ? { id: block.id, name: block.name, arguments: input }
          : { id: block.id, name: block.name, arguments: null, parseError: "Tool input was not an object" },
      );
    }
  }
  const stop: StopReason =
    message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence"
      ? "end"
      : message.stop_reason === "tool_use"
        ? "tool_use"
        : message.stop_reason === "max_tokens"
          ? "max_tokens"
          : message.stop_reason === "refusal"
            ? "refusal"
            : "other";
  return {
    text,
    toolCalls,
    stopReason: stop,
    usage: {
      inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
    },
    providerState: message.content,
  };
}

export function normalizeAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return providerError("aborted", "anthropic");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return providerError("timeout", "anthropic");
  if (err instanceof Anthropic.APIConnectionError) return providerError("network", "anthropic");
  if (err instanceof Anthropic.APIError) {
    // 529 overloaded is a server condition and retryable.
    return providerError(classifyStatus(err.status), "anthropic", err.status);
  }
  return providerError("unknown", "anthropic");
}
