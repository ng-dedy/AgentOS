import OpenAI from "openai";
import type { ProviderId } from "@agentos/contracts";
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

interface Config {
  id: Extract<ProviderId, "openai" | "xai">;
  label: string;
  secretName: string;
  baseURL?: string;
}

/**
 * Chat Completions adapter built on the official `openai` SDK. Used for OpenAI and
 * for xAI Grok, whose API is documented by xAI as OpenAI-compatible
 * (base URL https://api.x.ai/v1).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: Config["id"];
  readonly label: string;
  readonly isMock = false;
  private client: OpenAI | undefined;

  constructor(
    private readonly config: Config,
    private readonly secrets: SecretsProvider,
    private readonly clientFactory: (apiKey: string, baseURL?: string) => OpenAI = (apiKey, baseURL) =>
      new OpenAI({ apiKey, baseURL, maxRetries: 0 }),
  ) {
    this.id = config.id;
    this.label = config.label;
  }

  isConfigured(): boolean {
    return this.secrets.get(this.config.secretName) !== undefined;
  }

  private getClient(): OpenAI {
    const key = this.secrets.get(this.config.secretName);
    if (!key) throw providerError("not_configured", this.id);
    this.client ??= this.clientFactory(key, this.config.baseURL);
    return this.client;
  }

  async generate(req: ModelRequest, opts: GenerateOptions): Promise<ModelResponse> {
    const client = this.getClient();
    try {
      return await withTimeout(this.id, opts.timeoutMs, opts.signal, async (signal) => {
        const stream = await client.chat.completions.create(
          {
            model: req.model,
            messages: toOpenAIMessages(req.system, req.messages),
            max_completion_tokens: req.maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true },
            ...(req.tools.length > 0
              ? {
                  tools: req.tools.map((t) => ({
                    type: "function" as const,
                    function: { name: t.name, description: t.description, parameters: t.inputJsonSchema },
                  })),
                }
              : {}),
          },
          { signal },
        );
        const acc = new ChatStreamAccumulator();
        for await (const chunk of stream) {
          const delta = acc.push(chunk);
          if (delta && opts.onDelta) opts.onDelta(delta);
        }
        return acc.result();
      });
    } catch (err) {
      throw normalizeOpenAIError(err, this.id);
    }
  }
}

export function toOpenAIMessages(system: string, messages: ModelMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

/** Accumulates streamed chat-completion chunks into one normalized response. */
export class ChatStreamAccumulator {
  private text = "";
  private finish: string | null = null;
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  push(chunk: OpenAI.ChatCompletionChunk): string | undefined {
    if (chunk.usage) {
      this.usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
    const choice = chunk.choices[0];
    if (!choice) return undefined;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    for (const tc of choice.delta.tool_calls ?? []) {
      const cur = this.calls.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      this.calls.set(tc.index, cur);
    }
    const delta = choice.delta.content ?? undefined;
    if (delta) this.text += delta;
    return delta;
  }

  result(): ModelResponse {
    const toolCalls: ToolCallRequest[] = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => {
        const id = c.id || `call_${index}`;
        try {
          const parsed: unknown = c.args.trim() === "" ? {} : JSON.parse(c.args);
          return { id, name: c.name, arguments: parsed };
        } catch {
          return { id, name: c.name, arguments: null, parseError: "Tool arguments were not valid JSON" };
        }
      });
    const stopReason: StopReason =
      this.finish === "stop"
        ? "end"
        : this.finish === "tool_calls"
          ? "tool_use"
          : this.finish === "length"
            ? "max_tokens"
            : this.finish === "content_filter"
              ? "refusal"
              : toolCalls.length > 0
                ? "tool_use"
                : "other";
    return { text: this.text, toolCalls, stopReason, usage: this.usage };
  }
}

export function normalizeOpenAIError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return providerError("aborted", provider);
  if (err instanceof OpenAI.APIConnectionTimeoutError) return providerError("timeout", provider);
  if (err instanceof OpenAI.APIConnectionError) return providerError("network", provider);
  if (err instanceof OpenAI.APIError) return providerError(classifyStatus(err.status), provider, err.status);
  return providerError("unknown", provider);
}
