export type ProviderErrorKind =
  | "not_configured"
  | "auth"
  | "quota_exceeded"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "model_not_found"
  | "context_length"
  | "bad_request"
  | "server"
  | "network"
  | "stream_interrupted"
  | "refusal"
  | "aborted"
  | "unknown";

/**
 * Retryable kinds. `quota_exceeded` is deliberately NOT retryable: an exhausted
 * account balance returns HTTP 429 just like a rate limit, but retrying cannot help.
 */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "timeout",
  "server",
  "network",
  "stream_interrupted",
]);

/** Stable, machine-readable code for each kind (logged, persisted and shown in the UI). */
export function providerErrorCode(kind: ProviderErrorKind): string {
  return `PROVIDER_${kind.toUpperCase()}`;
}

export interface ProviderErrorDetails {
  status?: number;
  /** Provider's own error code/type, e.g. `insufficient_quota` or `overloaded_error`. Never contains secrets. */
  providerCode?: string;
  /** Provider request id, for support tickets. */
  requestId?: string;
  /** Server-requested wait before retrying, if the provider sent one. */
  retryAfterMs?: number;
}

/**
 * Normalized provider error. `message` is safe to show users: it never contains
 * the raw provider response body, request headers or keys.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly provider: string,
    details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = RETRYABLE.has(kind);
    this.code = providerErrorCode(kind);
    this.status = details.status;
    this.providerCode = details.providerCode;
    this.requestId = details.requestId;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** Safe, structured view for logs and event payloads. */
  toJSON() {
    return {
      code: this.code,
      kind: this.kind,
      provider: this.provider,
      retryable: this.retryable,
      status: this.status,
      providerCode: this.providerCode,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
      message: this.message,
    };
  }
}

const SAFE_MESSAGES: Record<ProviderErrorKind, string> = {
  not_configured: "Provider is not configured",
  auth: "Provider rejected the credentials",
  quota_exceeded: "Provider account has no remaining quota or credit",
  rate_limit: "Provider rate limit reached",
  overloaded: "Provider is temporarily overloaded",
  timeout: "Provider request timed out",
  model_not_found: "The model id is not available for this account",
  context_length: "The conversation is too long for this model",
  bad_request: "Provider rejected the request",
  server: "Provider had a server error",
  network: "Could not reach the provider",
  stream_interrupted: "The response stream ended unexpectedly",
  refusal: "The model declined the request",
  aborted: "Request was cancelled",
  unknown: "Unexpected provider error",
};

export function classifyStatus(status: number | undefined): ProviderErrorKind {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

export function providerError(kind: ProviderErrorKind, provider: string, details: ProviderErrorDetails = {}): ProviderError {
  return new ProviderError(kind, SAFE_MESSAGES[kind], provider, details);
}

/** Parse `retry-after-ms` / `retry-after` (seconds or HTTP date). Returns undefined when absent or invalid. */
export function parseRetryAfter(headers: Headers | undefined | null, now: number = Date.now()): number | undefined {
  if (!headers || typeof headers.get !== "function") return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms));
  const ra = headers.get("retry-after");
  if (!ra) return undefined;
  if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.round(Number(ra) * 1000);
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Only short, identifier-like provider codes are kept, so nothing user- or secret-bearing leaks into logs. */
export function safeProviderCode(v: unknown): string | undefined {
  return typeof v === "string" && /^[a-z0-9_.-]{1,64}$/i.test(v) ? v : undefined;
}

export async function withTimeout<T>(
  provider: string,
  timeoutMs: number,
  outer: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (outer.aborted) ctl.abort();
  outer.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(ctl.signal);
  } catch (err) {
    if (timedOut) throw providerError("timeout", provider);
    if (outer.aborted) throw providerError("aborted", provider);
    throw err;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}
