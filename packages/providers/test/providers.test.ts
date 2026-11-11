import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  ChatStreamAccumulator,
  createProviderRegistry,
  extractExpression,
  fromAnthropicMessage,
  MockProvider,
  ModelCatalog,
  normalizeAnthropicError,
  normalizeOpenAIError,
  ProviderError,
  toAnthropicMessages,
  toOpenAIMessages,
  type ModelMessage,
  type ModelRequest,
  type SecretsProvider,
} from "../src";

const secrets = (values: Record<string, string>): SecretsProvider => ({ get: (k) => values[k] });
const opts = () => ({ signal: new AbortController().signal, timeoutMs: 5000 });

describe("provider configuration", () => {
  it("reports unconfigured providers without exposing keys", () => {
    const reg = createProviderRegistry({ secrets: secrets({ ANTHROPIC_API_KEY: "sk-ant-secret" }) });
    const list = reg.list();
    expect(list.map((p) => [p.id, p.configured])).toEqual([
      ["openai", false],
      ["anthropic", true],
      ["xai", false],
    ]);
    expect(JSON.stringify(list)).not.toContain("sk-ant-secret");
  });

  it("only registers the mock provider when enabled, and labels it", () => {
    expect(createProviderRegistry({ secrets: secrets({}) }).get("mock")).toBeUndefined();
    const mock = createProviderRegistry({ secrets: secrets({}), enableMock: true }).list().find((p) => p.id === "mock");
    expect(mock).toMatchObject({ isMock: true, configured: true });
    expect(mock?.label).toMatch(/MOCK/);
  });

  it("refuses to call an unconfigured provider", async () => {
    const reg = createProviderRegistry({ secrets: secrets({}) });
    const req: ModelRequest = { model: "gpt-6-luna", system: "s", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 10 };
    await expect(reg.get("openai")!.generate(req, opts())).rejects.toMatchObject({ kind: "not_configured", retryable: false });
  });

  it("computes cost from the catalog and accepts overrides", () => {
    const c = new ModelCatalog();
    expect(c.cost("anthropic", "claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(6);
    const custom = ModelCatalog.fromEnv(JSON.stringify([{ provider: "openai", id: "x", label: "X", inputPerMTok: 1, outputPerMTok: 1 }]));
    expect(custom.forProvider("openai").map((m) => m.id)).toEqual(["x"]);
    expect(() => ModelCatalog.fromEnv('[{"provider":"bogus"}]')).toThrow();
  });
});

describe("error normalization", () => {
  it("classifies Anthropic SDK errors", () => {
    const h = new Headers();
    expect(normalizeAnthropicError(new Anthropic.RateLimitError(429, undefined, "x", h))).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(normalizeAnthropicError(new Anthropic.AuthenticationError(401, undefined, "x", h))).toMatchObject({ kind: "auth", retryable: false });
    expect(normalizeAnthropicError(new Anthropic.InternalServerError(529, undefined, "overloaded", h))).toMatchObject({ kind: "overloaded", code: "PROVIDER_OVERLOADED", retryable: true });
    expect(normalizeAnthropicError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: "timeout", retryable: true });
    expect(normalizeAnthropicError(new Error("boom"))).toMatchObject({ kind: "unknown", retryable: false });
  });

  it("classifies OpenAI SDK errors and never leaks the raw message", () => {
    const h = new Headers();
    const e = normalizeOpenAIError(new OpenAI.BadRequestError(400, { message: "secret detail" }, "secret detail", h), "xai");
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: "bad_request", provider: "xai", retryable: false });
    expect(e.message).not.toContain("secret");
    expect(normalizeOpenAIError(new OpenAI.APIConnectionError({ message: "x" }), "openai")).toMatchObject({ kind: "network", retryable: true });
  });
});

describe("Anthropic mapping", () => {
  it("groups tool results into one user message and replays raw assistant content", () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "calculator", input: { expression: "1+1" } },
      { type: "tool_use", id: "t2", name: "calculator", input: { expression: "2+2" } },
    ];
    const msgs: ModelMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [], providerState: raw },
      { role: "tool", toolCallId: "t1", toolName: "calculator", content: "2", isError: false },
      { role: "tool", toolCallId: "t2", toolName: "calculator", content: "bad", isError: true },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[1]?.content).toBe(raw);
    expect(out[2]).toMatchObject({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", is_error: false },
        { type: "tool_result", tool_use_id: "t2", is_error: true },
      ],
    });
  });

  it("normalizes a tool_use response", () => {
    const msg = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "text", text: "Let me compute." },
        { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "6*7" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Message;
    const r = fromAnthropicMessage(msg);
    expect(r).toMatchObject({
      text: "Let me compute.",
      stopReason: "tool_use",
      toolCalls: [{ id: "tu_1", name: "calculator", arguments: { expression: "6*7" } }],
      usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 2 },
    });
    expect(r.providerState).toBe(msg.content);
  });
});

describe("OpenAI-compatible mapping", () => {
  it("accumulates streamed tool calls and usage", () => {
    const acc = new ChatStreamAccumulator();
    const chunk = (delta: object, finish: string | null = null, usage?: object) =>
      ({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], usage }) as unknown as OpenAI.ChatCompletionChunk;
    acc.push(chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "calculator", arguments: '{"expre' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'ssion":"1+2"}' } }] }));
    acc.push(chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "calculator", arguments: "{oops" } }] }, "tool_calls"));
    acc.push({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } as unknown as OpenAI.ChatCompletionChunk);
    const r = acc.result();
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls[0]).toEqual({ id: "call_a", name: "calculator", arguments: { expression: "1+2" } });
    expect(r.toolCalls[1]).toMatchObject({ id: "call_b", arguments: null, parseError: expect.any(String) });
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 });
  });

  it("maps normalized messages to chat format", () => {
    const out = toOpenAIMessages("sys", [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "calculator", arguments: { expression: "1" } }] },
      { role: "tool", toolCallId: "c1", toolName: "calculator", content: "1", isError: false },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(out[2]).toMatchObject({ tool_calls: [{ id: "c1", function: { name: "calculator", arguments: '{"expression":"1"}' } }] });
  });
});

describe("MockProvider", () => {
  const tools = [{ name: "calculator", description: "", inputJsonSchema: {} }];
  const base = (messages: ModelMessage[]): ModelRequest => ({ model: "mock-scripted", system: "s", messages, tools, maxOutputTokens: 100 });

  it("extracts arithmetic from prose", () => {
    expect(extractExpression("What is (17 * 23) + 4? Use the calculator.")).toBe("(17 * 23) + 4");
    expect(extractExpression("Version 2 of the plan")).toBeUndefined();
  });

  it("requests a tool, then answers only from the tool result it was given", async () => {
    const p = new MockProvider();
    const first = await p.generate(base([{ role: "user", content: "Compute 6 * 7" }]), opts());
    expect(first.toolCalls[0]).toMatchObject({ name: "calculator", arguments: { expression: "6 * 7" } });
    const call = first.toolCalls[0]!;
    const deltas: string[] = [];
    const second = await p.generate(
      base([
        { role: "user", content: "Compute 6 * 7" },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: call.id, toolName: "calculator", content: '{"expression":"6 * 7","result":42}', isError: false },
      ]),
      { ...opts(), onDelta: (d) => deltas.push(d) },
    );
    expect(second.text).toMatch(/^\[MOCK\]/);
    expect(second.text).toContain("Final answer: 42");
    expect(deltas.join("")).toBe(second.text);
  });

  it("can simulate provider errors", async () => {
    await expect(new MockProvider().generate(base([{ role: "user", content: "[mock:error=rate_limit]" }]), opts())).rejects.toMatchObject({
      kind: "rate_limit",
      retryable: true,
    });
  });
});
