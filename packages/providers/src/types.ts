import type { ProviderId } from "@agentos/contracts";

export interface ToolCallRequest {
  /** Provider-assigned id, used to pair results and for idempotency. */
  id: string;
  name: string;
  /** Parsed arguments, or null when the provider sent unparseable JSON. */
  arguments: unknown;
  parseError?: string;
}

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCallRequest[]; providerState?: unknown }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError: boolean };

export interface ModelToolSpec {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxOutputTokens: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Hidden reasoning tokens, already included in outputTokens (billed as output). */
  reasoningTokens?: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelResponse {
  text: string;
  toolCalls: ToolCallRequest[];
  stopReason: StopReason;
  usage: ModelUsage;
  /** Opaque provider data needed to replay this assistant turn verbatim. */
  providerState?: unknown;
  /** Refusal explanation from the provider, when stopReason is "refusal". */
  refusal?: string;
  /** Model id the provider reports it actually used (may be a dated snapshot of the requested id). */
  servedModel?: string;
  /** Provider request id, for support and log correlation. */
  requestId?: string;
}

/** A model as reported by the provider's own Models API. */
export interface DiscoveredModel {
  id: string;
  label?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface GenerateOptions {
  signal: AbortSignal;
  timeoutMs: number;
  onDelta?: (text: string) => void;
  /** The calling organization's API key. Never logged; when absent the adapter's deployment key is used. */
  apiKey?: string;
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly isMock: boolean;
  /** API base URL requests are sent to (never contains credentials). Undefined for the mock. */
  readonly endpoint?: string;
  isConfigured(): boolean;
  /** List models available to the configured account via the provider's Models API. */
  listModels?(signal: AbortSignal, apiKey?: string): Promise<DiscoveredModel[]>;
  generate(request: ModelRequest, options: GenerateOptions): Promise<ModelResponse>;
}

/** Server-side secret lookup. Values must never be logged or returned to clients. */
export interface SecretsProvider {
  get(name: string): string | undefined;
}

export class EnvSecretsProvider implements SecretsProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  get(name: string): string | undefined {
    const v = this.env[name];
    return v && v.trim() !== "" ? v.trim() : undefined;
  }
}
