export type ProviderErrorKind =
  | "not_configured"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "bad_request"
  | "server"
  | "network"
  | "refusal"
  | "aborted"
  | "unknown";

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "timeout", "server", "network"]);

/**
 * Normalized provider error. `message` is safe to show users: it never contains
 * the raw provider response body, request headers or keys.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = RETRYABLE.has(kind);
  }
}

const SAFE_MESSAGES: Record<ProviderErrorKind, string> = {
  not_configured: "Provider is not configured",
  auth: "Provider rejected the credentials",
  rate_limit: "Provider rate limit reached",
  timeout: "Provider request timed out",
  bad_request: "Provider rejected the request",
  server: "Provider had a server error",
  network: "Could not reach the provider",
  refusal: "The model declined the request",
  aborted: "Request was cancelled",
  unknown: "Unexpected provider error",
};

export function classifyStatus(status: number | undefined): ProviderErrorKind {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

export function providerError(kind: ProviderErrorKind, provider: string, status?: number): ProviderError {
  return new ProviderError(kind, SAFE_MESSAGES[kind], provider, status);
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
