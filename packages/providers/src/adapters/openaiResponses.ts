import OpenAI from "openai";
import { providerError, ProviderError, safeProviderCode, withTimeout, type ProviderErrorKind } from "../errors";
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
import { normalizeOpenAIError } from "./openaiCompatible";

type ResponsesInput = OpenAI.Responses.ResponseInputItem[];
type OutputItem = OpenAI.Responses.ResponseOutputItem;

/**
 * OpenAI adapter on the Responses API (official `openai` SDK).
 *
 * Why not Chat Completions: verified live on 2026-11-11, current OpenAI models
 * (e.g. gpt-6-luna) reject function tools on /v1/chat/completions unless reasoning
 * is switched off ("use /v1/responses or set reasoning_effort to 'none'").
 *
 * Requests are stateless (`store: false`). Reasoning items are requested with
 * `include: ["reasoning.encrypted_content"]` and replayed verbatim on the next turn
 * through `providerState`, so the model keeps its reasoning across tool calls without
 * OpenAI retaining the conversation.
 */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI";
  readonly isMock = false;
  private client: OpenAI | undefined;

  constructor(
    private readonly secrets: SecretsProvider,
    readonly endpoint: string = "https://api.openai.com/v1",
    private readonly clientFactory: (apiKey: string, baseURL: string) => OpenAI = (apiKey, baseURL) =>
      new OpenAI({ apiKey, baseURL, maxRetries: 0 }),
  ) {}

  isConfigured(): boolean {
    return this.secrets.get("OPENAI_API_KEY") !== undefined;
  }

  private getClient(): OpenAI {
    const key = this.secrets.get("OPENAI_API_KEY");
    if (!key) throw providerError("not_configured", this.id);
    this.client ??= this.clientFactory(key, this.endpoint);
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
    let started = false;
    try {
      return await withTimeout(this.id, opts.timeoutMs, opts.signal, async (signal) => {
        const { data: stream, request_id } = await client.responses
          .create(
            {
              model: req.model,
              instructions: req.system,
              input: toResponsesInput(req.messages),
              max_output_tokens: req.maxOutputTokens,
              store: false,
              include: ["reasoning.encrypted_content"],
              stream: true,
              ...(req.tools.length > 0
                ? {
                    tools: req.tools.map((t) => ({
                      type: "function" as const,
                      name: t.name,
                      description: t.description,
                      parameters: t.inputJsonSchema,
                      // Our schemas allow optional fields, which strict mode rejects. Arguments are
                      // validated server-side with Zod before any tool runs.
                      strict: false,
                    })),
                  }
                : {}),
            },
            { signal },
          )
          .withResponse();

        let final: OpenAI.Responses.Response | undefined;
        for await (const ev of stream) {
          started = true;
          switch (ev.type) {
            case "response.output_text.delta":
              if (ev.delta) opts.onDelta?.(ev.delta);
              break;
            case "response.completed":
            case "response.incomplete":
              final = ev.response;
              break;
            case "response.failed":
              throw responseFailure(ev.response.error?.code, request_id);
            case "error":
              throw responseFailure(ev.code, request_id);
            default:
              break;
          }
        }
        if (!final) throw providerError("stream_interrupted", this.id, { requestId: request_id ?? undefined });
        const res = fromResponse(final);
        return request_id ? { ...res, requestId: request_id } : res;
      });
    } catch (err) {
      if (started && !(err instanceof ProviderError) && !(err instanceof OpenAI.APIError)) {
        throw providerError("stream_interrupted", this.id);
      }
      if (started && err instanceof OpenAI.APIConnectionError && !(err instanceof OpenAI.APIConnectionTimeoutError)) {
        throw providerError("stream_interrupted", this.id);
      }
      throw normalizeOpenAIError(err, this.id);
    }
  }
}

const RESPONSE_ERROR_KINDS: Record<string, ProviderErrorKind> = {
  server_error: "server",
  rate_limit_exceeded: "rate_limit",
  insufficient_quota: "quota_exceeded",
  invalid_prompt: "bad_request",
  context_length_exceeded: "context_length",
  bio_policy: "refusal",
  misalignment_policy_violation: "refusal",
};

function responseFailure(code: string | null | undefined, requestId: string | null | undefined): ProviderError {
  const providerCode = safeProviderCode(code);
  return providerError((providerCode && RESPONSE_ERROR_KINDS[providerCode]) || "server", "openai", {
    providerCode,
    requestId: requestId ?? undefined,
  });
}

export function toResponsesInput(messages: ModelMessage[]): ResponsesInput {
  const out: ResponsesInput = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // Replay the exact output items (reasoning with encrypted content, messages, calls) when we have them.
      if (Array.isArray(m.providerState)) {
        out.push(...(m.providerState as ResponsesInput));
        continue;
      }
      if (m.content) out.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) });
      }
    } else {
      out.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    }
  }
  return out;
}

export function fromResponse(r: OpenAI.Responses.Response): ModelResponse {
  let text = "";
  let refusal = "";
  const toolCalls: ToolCallRequest[] = [];
  for (const item of r.output as OutputItem[]) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") text += part.text;
        else if (part.type === "refusal") refusal += part.refusal;
      }
    } else if (item.type === "function_call") {
      try {
        const parsed: unknown = item.arguments.trim() === "" ? {} : JSON.parse(item.arguments);
        toolCalls.push({ id: item.call_id, name: item.name, arguments: parsed });
      } catch {
        toolCalls.push({ id: item.call_id, name: item.name, arguments: null, parseError: "Tool arguments were not valid JSON" });
      }
    }
  }
  const incomplete = r.status === "incomplete" ? r.incomplete_details?.reason : undefined;
  const stopReason: StopReason =
    refusal !== "" || incomplete === "content_filter"
      ? "refusal"
      : toolCalls.length > 0
        ? "tool_use"
        : incomplete === "max_output_tokens"
          ? "max_tokens"
          : r.status === "completed"
            ? "end"
            : "other";
  const usage = r.usage;
  return {
    text,
    toolCalls: stopReason === "refusal" ? [] : toolCalls,
    stopReason,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    providerState: r.output,
    servedModel: r.model,
    ...(refusal ? { refusal } : {}),
  };
}
