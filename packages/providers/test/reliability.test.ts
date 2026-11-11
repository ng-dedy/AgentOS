import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  ChatStreamAccumulator,
  createProviderRegistry,
  fromAnthropicMessage,
  ModelCatalog,
  normalizeAnthropicError,
  normalizeOpenAIError,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  fromResponse,
  toResponsesInput,
  parseRetryAfter,
  ProviderError,
  type ModelRequest,
} from "../src";

const secrets = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const req: ModelRequest = { model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 10 };
const opts = () => ({ signal: new AbortController().signal, timeoutMs: 5_000 });

/** A fetch that answers with a Server-Sent Events body made of the given raw frames. */
function sseFetch(frames: string[], { breakAfter = false, status = 200, headers = {} as Record<string, string> } = {}) {
  return async () => {
    const enc = new TextEncoder();
    let i = 0;
    // pull() delivers frames one at a time so an error arrives only after they were read
    // (erroring in start() would discard the queued frames).
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (i < frames.length) ctl.enqueue(enc.encode(frames[i++]!));
        else if (breakAfter) ctl.error(new TypeError("terminated"));
        else ctl.close();
      },
    });
    return new Response(body, { status, headers: { "content-type": "text/event-stream", "x-request-id": "req_test", ...headers } });
  };
}

function jsonFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const openaiWith = (fetchImpl: typeof fetch) =>
  new OpenAICompatibleProvider(
    { id: "openai", label: "OpenAI", secretName: "K", baseURL: "https://api.openai.com/v1" },
    secrets({ K: "sk-test-secret" }),
    (apiKey, baseURL) => new OpenAI({ apiKey, baseURL, maxRetries: 0, fetch: fetchImpl }),
  );

const anthropicWith = (fetchImpl: typeof fetch) =>
  new AnthropicProvider(secrets({ ANTHROPIC_API_KEY: "sk-ant-test-secret" }), "https://api.anthropic.com", (apiKey, baseURL) =>
    new Anthropic({ apiKey, baseURL, maxRetries: 0, fetch: fetchImpl }),
  );

describe("endpoint pinning", () => {
  const saved = { a: process.env.ANTHROPIC_BASE_URL, o: process.env.OPENAI_BASE_URL };
  afterEach(() => {
    process.env.ANTHROPIC_BASE_URL = saved.a;
    process.env.OPENAI_BASE_URL = saved.o;
    if (saved.a === undefined) delete process.env.ANTHROPIC_BASE_URL;
    if (saved.o === undefined) delete process.env.OPENAI_BASE_URL;
  });

  it("ignores the SDKs' own base-URL env vars so keys only go to the configured host", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://attacker.example";
    process.env.OPENAI_BASE_URL = "https://attacker.example/v1";
    const seen: string[] = [];
    const capture = (async (url: string | URL | Request) => {
      seen.push(String(url instanceof Request ? url.url : url));
      return new Response(JSON.stringify({ data: [], has_more: false, object: "list" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const reg = createProviderRegistry({ secrets: secrets({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", XAI_API_KEY: "x" }) });
    expect(reg.get("anthropic")!.endpoint).toBe("https://api.anthropic.com");
    expect(reg.get("openai")!.endpoint).toBe("https://api.openai.com/v1");
    expect(reg.get("xai")!.endpoint).toBe("https://api.x.ai/v1");

    // The default client factories must pass the pinned URL explicitly.
    await anthropicWith(capture).listModels(new AbortController().signal);
    await openaiWith(capture).listModels(new AbortController().signal);
    expect(seen.every((u) => !u.includes("attacker.example"))).toBe(true);
    const ap = new AnthropicProvider(secrets({ ANTHROPIC_API_KEY: "a" }));
    expect((ap as unknown as { getClient(): Anthropic }).getClient().baseURL).toBe("https://api.anthropic.com");
    const op = reg.get("openai") as OpenAICompatibleProvider;
    expect((op as unknown as { getClient(): OpenAI }).getClient().baseURL).toBe("https://api.openai.com/v1");
  });

  it("never lists credentials in provider info", () => {
    const reg = createProviderRegistry({ secrets: secrets({ OPENAI_API_KEY: "sk-very-secret" }) });
    expect(JSON.stringify(reg.list())).not.toContain("sk-very-secret");
  });
});

describe("structured provider errors", () => {
  const h = (v: Record<string, string> = {}) => new Headers(v);

  it("separates exhausted quota (not retryable) from rate limits (retryable)", () => {
    const quota = normalizeOpenAIError(new OpenAI.RateLimitError(429, { code: "insufficient_quota", type: "insufficient_quota" }, "x", h()), "openai");
    expect(quota).toMatchObject({ kind: "quota_exceeded", code: "PROVIDER_QUOTA_EXCEEDED", retryable: false, status: 429, providerCode: "insufficient_quota" });
    const rl = normalizeOpenAIError(new OpenAI.RateLimitError(429, { type: "requests" }, "x", h({ "retry-after": "3", "x-request-id": "req_1" })), "openai");
    expect(rl).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 3000, requestId: "req_1" });
  });

  it("classifies invalid model ids and context overflow", () => {
    expect(normalizeOpenAIError(new OpenAI.NotFoundError(404, { code: "model_not_found" }, "x", h()), "openai")).toMatchObject({
      kind: "model_not_found",
      retryable: false,
    });
    expect(normalizeOpenAIError(new OpenAI.BadRequestError(400, { code: "context_length_exceeded" }, "x", h()), "openai")).toMatchObject({
      kind: "context_length",
    });
    expect(normalizeAnthropicError(new Anthropic.NotFoundError(404, undefined, "x", h(), "not_found_error"))).toMatchObject({ kind: "model_not_found" });
    expect(normalizeAnthropicError(new Anthropic.APIError(400, undefined, "x", h(), "billing_error"))).toMatchObject({ kind: "quota_exceeded", retryable: false });
    expect(normalizeAnthropicError(new Anthropic.InternalServerError(529, undefined, "x", h({ "retry-after": "2" }), "overloaded_error"))).toMatchObject({
      kind: "overloaded",
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it("keeps error messages and JSON free of provider bodies and secrets", () => {
    const e = normalizeOpenAIError(new OpenAI.AuthenticationError(401, { message: "Incorrect API key provided: sk-very-secret" }, "x", h()), "openai");
    expect(e.message).toBe("Provider rejected the credentials");
    expect(JSON.stringify(e.toJSON())).not.toContain("sk-very-secret");
    // Only identifier-like provider codes survive.
    const weird = normalizeOpenAIError(new OpenAI.BadRequestError(400, { code: "contains sk-very-secret and spaces" }, "x", h()), "openai");
    expect(weird.providerCode).toBeUndefined();
  });

  it("parses retry-after in seconds, milliseconds and HTTP dates", () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(parseRetryAfter(new Headers({ "retry-after": "1.5" }))).toBe(1500);
    expect(parseRetryAfter(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000)).toBe(6_000);
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe("interrupted streams", () => {
  const chunk = (o: object) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m-2026", ...o })}\n\n`;

  it("OpenAI: a stream that ends without a finish reason is an interruption, not an answer", async () => {
    const p = openaiWith(sseFetch([chunk({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })]) as typeof fetch);
    await expect(p.generate(req, opts())).rejects.toMatchObject({ kind: "stream_interrupted", retryable: true });
  });

  it("OpenAI: a connection dropped mid-stream is an interruption", async () => {
    const p = openaiWith(sseFetch([chunk({ choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] })], { breakAfter: true }) as typeof fetch);
    await expect(p.generate(req, opts())).rejects.toMatchObject({ kind: "stream_interrupted" });
  });

  it("OpenAI: a complete stream yields text, served model, request id and usage", async () => {
    const p = openaiWith(
      sseFetch([
        chunk({ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 7 } } }),
        "data: [DONE]\n\n",
      ]) as typeof fetch,
    );
    const r = await p.generate(req, opts());
    expect(r).toMatchObject({ text: "Hello", stopReason: "end", servedModel: "m-2026", requestId: "req_test" });
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 9, cachedInputTokens: 0, reasoningTokens: 7 });
  });

  it("Anthropic: a stream that stops before message_stop is an interruption", async () => {
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const p = anthropicWith(
      sseFetch([
        ev("message_start", {
          message: { id: "msg", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } },
        }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "par" } }),
      ]) as typeof fetch,
    );
    await expect(p.generate(req, opts())).rejects.toMatchObject({ kind: "stream_interrupted", retryable: true });
  });

  it("maps HTTP errors from a real SDK request", async () => {
    const p = openaiWith(jsonFetch(404, { error: { message: "The model `nope` does not exist", type: "invalid_request_error", code: "model_not_found" } }) as typeof fetch);
    const err = await p.generate({ ...req, model: "nope" }, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "model_not_found", code: "PROVIDER_MODEL_NOT_FOUND", status: 404 });
  });
});

describe("refusals", () => {
  it("OpenAI refusal deltas produce a refusal stop and drop tool calls", () => {
    const acc = new ChatStreamAccumulator();
    acc.push({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { refusal: "I can't help" }, finish_reason: "stop" }] } as unknown as OpenAI.ChatCompletionChunk);
    expect(acc.result()).toMatchObject({ stopReason: "refusal", refusal: "I can't help", toolCalls: [] });
  });

  it("Anthropic refusal carries the stop_details explanation", () => {
    const r = fromAnthropicMessage({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Declined: exploit development" },
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message);
    expect(r).toMatchObject({ stopReason: "refusal", refusal: "Declined: exploit development", servedModel: "claude-opus-5-5" });
  });
});

describe("catalog", () => {
  it("only lists models with a published price or explicit mock label", () => {
    const cat = new ModelCatalog();
    for (const p of ["openai", "anthropic", "xai"] as const) {
      for (const m of cat.forProvider(p)) expect(m.priceSource).toBe("published");
    }
  });

  it("charges cached input at the published cached price when known, else full price", () => {
    const cat = new ModelCatalog();
    // gpt-6-luna: $0.10 in, $0.01 cached, $0.50 out per M
    expect(cat.cost("openai", "gpt-6-luna", { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 })).toBeCloseTo(0.055, 6);
    // Anthropic entries have no cached price in the catalog: conservative full price.
    expect(cat.cost("anthropic", "claude-haiku-5-5", { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 })).toBeCloseTo(0.1, 6);
  });
});

describe("OpenAI Responses adapter", () => {
  const ev = (o: object) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
  const responsesWith = (fetchImpl: typeof fetch) =>
    new OpenAIResponsesProvider(secrets({ OPENAI_API_KEY: "sk-test-secret" }), "https://api.openai.com/v1", (apiKey, baseURL) =>
      new OpenAI({ apiKey, baseURL, maxRetries: 0, fetch: fetchImpl }),
    );
  const final = {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-6-luna",
    output: [
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque" },
      { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "calculator", arguments: '{"expression":"6*7"}' },
    ],
    usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 4 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 29 },
  };

  it("parses a streamed tool call, usage and keeps output items for replay", async () => {
    const p = responsesWith(
      sseFetch([ev({ type: "response.created", sequence_number: 0, response: { ...final, status: "in_progress", output: [] } }), ev({ type: "response.completed", sequence_number: 1, response: final })]) as typeof fetch,
    );
    const r = await p.generate(req, opts());
    expect(r).toMatchObject({ stopReason: "tool_use", servedModel: "gpt-6-luna", toolCalls: [{ id: "call_1", name: "calculator", arguments: { expression: "6*7" } }] });
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 9, cachedInputTokens: 4, reasoningTokens: 3 });
    // Reasoning items are replayed verbatim on the next turn, followed by our tool output.
    const input = toResponsesInput([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: r.toolCalls, providerState: r.providerState },
      { role: "tool", toolCallId: "call_1", toolName: "calculator", content: '{"result":42}', isError: false },
    ]);
    expect(input.map((i) => ("type" in i ? i.type : "message"))).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
  });

  it("treats a stream without response.completed as interrupted", async () => {
    const p = responsesWith(sseFetch([ev({ type: "response.output_text.delta", sequence_number: 1, item_id: "m", output_index: 0, content_index: 0, delta: "par", logprobs: [] })]) as typeof fetch);
    await expect(p.generate(req, opts())).rejects.toMatchObject({ kind: "stream_interrupted" });
  });

  it("maps response.failed and in-stream errors", async () => {
    const failed = responsesWith(sseFetch([ev({ type: "response.failed", sequence_number: 1, response: { ...final, status: "failed", error: { code: "rate_limit_exceeded", message: "slow down" } } })]) as typeof fetch);
    await expect(failed.generate(req, opts())).rejects.toMatchObject({ kind: "rate_limit", providerCode: "rate_limit_exceeded" });
    const errored = responsesWith(sseFetch([ev({ type: "error", sequence_number: 1, code: "server_error", message: "x", param: null })]) as typeof fetch);
    await expect(errored.generate(req, opts())).rejects.toMatchObject({ kind: "server", retryable: true });
  });

  it("maps refusals and output limits", () => {
    expect(
      fromResponse({ ...final, output: [{ id: "m", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "No." }] }] } as unknown as OpenAI.Responses.Response),
    ).toMatchObject({ stopReason: "refusal", refusal: "No.", toolCalls: [] });
    expect(
      fromResponse({ ...final, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } as unknown as OpenAI.Responses.Response),
    ).toMatchObject({ stopReason: "max_tokens" });
  });
});
