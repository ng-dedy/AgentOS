import Anthropic from "@anthropic-ai/sdk";
import { ClientCache } from "../clientCache";
import {
  classifyStatus,
  parseRetryAfter,
  providerError,
  ProviderError,
  safeProviderCode,
  withTimeout,
  type ProviderErrorKind,
} from "../errors";
import type {
  DiscoveredModel,
  GenerateOptions,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  SecretsProvider,
  StopReason,
  ToolCallRequest,
} from "../types";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Anthropic Messages API adapter (official SDK, streaming + finalMessage).
 *
 * The base URL is always passed explicitly. Without it the SDK reads
 * ANTHROPIC_BASE_URL from the process environment, which hosting environments may
 * set for their own tooling; the organization's key would then go to that host.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic";
  readonly isMock = false;
  readonly endpoint: string;
  private readonly clients = new ClientCache<Anthropic>();

  constructor(
    private readonly secrets: SecretsProvider,
    baseURL: string = ANTHROPIC_DEFAULT_BASE_URL,
    private readonly clientFactory: (apiKey: string, baseURL: string) => Anthropic = (apiKey, url) =>
      new Anthropic({ apiKey, baseURL: url, maxRetries: 0 }),
  ) {
    this.endpoint = baseURL;
  }

  isConfigured(): boolean {
    return this.secrets.get("ANTHROPIC_API_KEY") !== undefined;
  }

  /** `apiKey` is the calling organization's key; without it the deployment key is used. */
  private getClient(apiKey?: string): Anthropic {
    const key = apiKey ?? this.secrets.get("ANTHROPIC_API_KEY");
    if (!key) throw providerError("not_configured", this.id);
    return this.clients.get(key, () => this.clientFactory(key, this.endpoint));
  }

  async listModels(signal: AbortSignal, apiKey?: string): Promise<DiscoveredModel[]> {
    const client = this.getClient(apiKey);
    try {
      const out: DiscoveredModel[] = [];
      for await (const m of client.models.list({ limit: 100 }, { signal })) {
        out.push({
          id: m.id,
          label: m.display_name,
          ...(typeof m.max_input_tokens === "number" ? { maxInputTokens: m.max_input_tokens } : {}),
          ...(typeof m.max_tokens === "number" ? { maxOutputTokens: m.max_tokens } : {}),
        });
      }
      return out;
    } catch (err) {
      throw normalizeAnthropicError(err);
    }
  }

  async generate(req: ModelRequest, opts: GenerateOptions): Promise<ModelResponse> {
    const client = this.getClient(opts.apiKey);
    let started = false;
    let requestId: string | undefined;
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
        stream.on("streamEvent", () => {
          started = true;
        });
        if (opts.onDelta) stream.on("text", (delta) => opts.onDelta?.(delta));
        const final = await stream.finalMessage();
        requestId = stream.request_id ?? undefined;
        return final;
      });
      const res = fromAnthropicMessage(message);
      return requestId ? { ...res, requestId } : res;
    } catch (err) {
      // A connection drop after events started arriving is an interrupted stream.
      if (started && isInterruption(err)) {
        throw providerError("stream_interrupted", "anthropic");
      }
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
  const refusal =
    stop === "refusal"
      ? (message.stop_details?.explanation ?? (message.stop_details?.category ? `Refused (${message.stop_details.category})` : "The model declined the request"))
      : undefined;
  return {
    text,
    toolCalls: stop === "refusal" ? [] : toolCalls,
    stopReason: stop,
    servedModel: message.model,
    ...(refusal ? { refusal } : {}),
    usage: {
      inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
    },
    providerState: message.content,
  };
}

const ANTHROPIC_TYPE_KINDS: Partial<Record<string, ProviderErrorKind>> = {
  authentication_error: "auth",
  permission_error: "auth",
  billing_error: "quota_exceeded",
  not_found_error: "model_not_found",
  rate_limit_error: "rate_limit",
  overloaded_error: "overloaded",
  timeout_error: "timeout",
  api_error: "server",
};

export function normalizeAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return providerError("aborted", "anthropic");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return providerError("timeout", "anthropic");
  if (err instanceof Anthropic.APIConnectionError) return providerError("network", "anthropic");
  if (err instanceof Anthropic.APIError) {
    const providerCode = safeProviderCode(err.errorCode) ?? safeProviderCode(err.type);
    const byType = err.type ? ANTHROPIC_TYPE_KINDS[err.type] : undefined;
    let kind: ProviderErrorKind = byType ?? classifyStatus(err.status);
    // A too-long prompt is an invalid_request_error; detect it from the stable code when present.
    if (providerCode && /context|too_long|prompt_too_long/i.test(providerCode)) kind = "context_length";
    return providerError(kind, "anthropic", {
      status: err.status,
      providerCode,
      requestId: err.requestID ?? undefined,
      retryAfterMs: parseRetryAfter(err.headers),
    });
  }
  return providerError("unknown", "anthropic");
}

/**
 * Errors that, once streaming started, mean the stream broke rather than the request
 * failed: dropped connections (undici raises a bare TypeError "terminated") or SDK
 * stream errors without an HTTP status.
 */
function isInterruption(err: unknown): boolean {
  if (err instanceof ProviderError) return false;
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  return !(err instanceof Anthropic.APIError);
}
