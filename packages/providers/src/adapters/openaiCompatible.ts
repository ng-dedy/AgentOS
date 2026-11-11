import OpenAI from "openai";
import type { ProviderId } from "@agentos/contracts";
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

interface Config {
  id: Extract<ProviderId, "openai" | "xai">;
  label: string;
  secretName: string;
  /**
   * Always set explicitly. If omitted, the SDK would read OPENAI_BASE_URL from the
   * process environment, which could silently send the key to another host.
   */
  baseURL: string;
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
  readonly endpoint: string;
  private client: OpenAI | undefined;

  constructor(
    private readonly config: Config,
    private readonly secrets: SecretsProvider,
    private readonly clientFactory: (apiKey: string, baseURL: string) => OpenAI = (apiKey, baseURL) =>
      new OpenAI({ apiKey, baseURL, maxRetries: 0 }),
  ) {
    this.id = config.id;
    this.label = config.label;
    this.endpoint = config.baseURL;
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

  async listModels(signal: AbortSignal): Promise<DiscoveredModel[]> {
    const client = this.getClient();
    try {
      const out: DiscoveredModel[] = [];
      for await (const m of client.models.list({ signal })) out.push({ id: m.id });
      return out;
    } catch (err) {
      throw normalizeOpenAIError(err, this.id);
    }
  }

  async generate(req: ModelRequest, opts: GenerateOptions): Promise<ModelResponse> {
    const client = this.getClient();
    const acc = new ChatStreamAccumulator();
    try {
      return await withTimeout(this.id, opts.timeoutMs, opts.signal, async (signal) => {
        const { data: stream, request_id } = await client.chat.completions
          .create(
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
          )
          .withResponse();
        for await (const chunk of stream) {
          const delta = acc.push(chunk);
          if (delta && opts.onDelta) opts.onDelta(delta);
        }
        const result = acc.result(this.id);
        return request_id ? { ...result, requestId: request_id } : result;
      });
    } catch (err) {
      // A connection drop after data started flowing is an interrupted stream, not a connect failure.
      if (acc.started && isInterruption(err)) {
        throw providerError("stream_interrupted", this.id);
      }
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
  private refusal = "";
  private finish: string | null = null;
  private model: string | undefined;
  private sawUsage = false;
  started = false;
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };

  push(chunk: OpenAI.ChatCompletionChunk): string | undefined {
    this.started = true;
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) {
      this.sawUsage = true;
      this.usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    }
    const choice = chunk.choices[0];
    if (!choice) return undefined;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    if (choice.delta.refusal) this.refusal += choice.delta.refusal;
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

  /**
   * @throws ProviderError(stream_interrupted) when the stream ended without a finish
   * reason: the response is incomplete and must not be treated as an answer.
   */
  result(provider = "openai"): ModelResponse {
    if (this.finish === null) throw providerError("stream_interrupted", provider);
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
      this.refusal !== "" || this.finish === "content_filter"
        ? "refusal"
        : this.finish === "stop"
          ? "end"
          : this.finish === "tool_calls"
            ? "tool_use"
            : this.finish === "length"
              ? "max_tokens"
              : toolCalls.length > 0
                ? "tool_use"
                : "other";
    return {
      text: this.text,
      toolCalls: stopReason === "refusal" ? [] : toolCalls,
      stopReason,
      usage: this.sawUsage ? this.usage : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      ...(this.refusal ? { refusal: this.refusal } : {}),
      ...(this.model ? { servedModel: this.model } : {}),
    };
  }
}

const OPENAI_CODE_KINDS: Record<string, ProviderErrorKind> = {
  insufficient_quota: "quota_exceeded",
  billing_hard_limit_reached: "quota_exceeded",
  model_not_found: "model_not_found",
  context_length_exceeded: "context_length",
  invalid_api_key: "auth",
  // Codes carried by in-stream `error` events (no HTTP status), which the SDK raises as APIError.
  server_error: "server",
  rate_limit_exceeded: "rate_limit",
  invalid_prompt: "bad_request",
  bio_policy: "refusal",
  misalignment_policy_violation: "refusal",
};

export function normalizeOpenAIError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return providerError("aborted", provider);
  if (err instanceof OpenAI.APIConnectionTimeoutError) return providerError("timeout", provider);
  if (err instanceof OpenAI.APIConnectionError) return providerError("network", provider);
  if (err instanceof OpenAI.APIError) {
    const providerCode = safeProviderCode(err.code) ?? safeProviderCode(err.type);
    let kind: ProviderErrorKind = (providerCode && OPENAI_CODE_KINDS[providerCode]) || classifyStatus(err.status);
    // A 404 on a non-model resource would be a bug in this adapter, but chat completions 404s mean the model.
    if (kind === "model_not_found" && err.status !== 404 && providerCode !== "model_not_found") kind = "bad_request";
    return providerError(kind, provider, {
      status: err.status,
      providerCode,
      requestId: err.requestID ?? undefined,
      retryAfterMs: parseRetryAfter(err.headers),
    });
  }
  return providerError("unknown", provider);
}

/**
 * Errors that, once streaming started, mean the stream broke rather than the request
 * failed: dropped connections (undici raises a bare TypeError "terminated") or SDK
 * stream errors without an HTTP status.
 */
function isInterruption(err: unknown): boolean {
  if (err instanceof ProviderError) return false;
  if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.APIUserAbortError) return false;
  if (err instanceof OpenAI.APIConnectionError) return true;
  return !(err instanceof OpenAI.APIError);
}
