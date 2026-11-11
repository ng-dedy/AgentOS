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
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelResponse {
  text: string;
  toolCalls: ToolCallRequest[];
  stopReason: StopReason;
  usage: ModelUsage;
  /** Opaque provider data needed to replay this assistant turn verbatim. */
  providerState?: unknown;
}

export interface GenerateOptions {
  signal: AbortSignal;
  timeoutMs: number;
  onDelta?: (text: string) => void;
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly isMock: boolean;
  isConfigured(): boolean;
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
