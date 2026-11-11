import { readFileSync } from "node:fs";

/** Temporal connectivity settings shared by the API (client) and the worker. */
export interface TemporalConnectionConfig {
  address: string;
  namespace: string;
  tls?: boolean;
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  serverName?: string;
  /** Temporal Cloud API key. */
  apiKey?: string;
  connectTimeoutMs?: number;
  /** Startup attempts before giving up (exponential backoff, capped at 10 s). */
  connectAttempts?: number;
}

export interface TlsOptions {
  serverNameOverride?: string;
  serverRootCACertificate?: Buffer;
  clientCertPair?: { crt: Buffer; key: Buffer };
}

/** The connection options both `Connection.connect` and `NativeConnection.connect` accept. */
export interface ResolvedConnectionOptions {
  address: string;
  tls?: TlsOptions;
  apiKey?: string;
}

export class TemporalConnectionError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "TemporalConnectionError";
  }
}

/**
 * Map configuration to SDK connection options. TLS is on when asked for, or implied by
 * an API key or a client certificate. Certificate files are read here so a missing file
 * fails at startup with its path, never later during a reconnect.
 */
export function resolveConnectionOptions(c: TemporalConnectionConfig): ResolvedConnectionOptions {
  const useTls = Boolean(c.tls || c.apiKey || c.certPath);
  if (Boolean(c.certPath) !== Boolean(c.keyPath)) throw new TemporalConnectionError("Temporal mTLS needs both a client certificate and a key", 0);
  if (!useTls) return { address: c.address };
  const read = (label: string, path: string) => {
    try {
      return readFileSync(path);
    } catch {
      throw new TemporalConnectionError(`Cannot read Temporal ${label} at ${path}`, 0);
    }
  };
  const tls: TlsOptions = {};
  if (c.serverName) tls.serverNameOverride = c.serverName;
  if (c.caPath) tls.serverRootCACertificate = read("CA certificate", c.caPath);
  if (c.certPath && c.keyPath) tls.clientCertPair = { crt: read("client certificate", c.certPath), key: read("client key", c.keyPath) };
  return { address: c.address, tls, ...(c.apiKey ? { apiKey: c.apiKey } : {}) };
}

/** A description of the connection that is safe to log (no key, no certificate material). */
export function describeConnection(c: TemporalConnectionConfig): Record<string, unknown> {
  return {
    address: c.address,
    namespace: c.namespace,
    tls: Boolean(c.tls || c.apiKey || c.certPath),
    mtls: Boolean(c.certPath),
    apiKey: c.apiKey ? "set" : "unset",
    customCa: Boolean(c.caPath),
  };
}

/**
 * Connect with bounded retries. Temporal being briefly unavailable during a rollout should
 * not crash-loop the process, but a wrong address or bad credentials must fail clearly.
 */
export async function connectWithRetry<T>(
  label: string,
  c: TemporalConnectionConfig,
  connect: (opts: ResolvedConnectionOptions) => Promise<T>,
  logger?: { warn?: (o: unknown, m?: string) => void },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  const opts = resolveConnectionOptions(c);
  const attempts = c.connectAttempts ?? 5;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await connect(opts);
    } catch (err) {
      last = err;
      if (i === attempts) break;
      const wait = Math.min(10_000, 500 * 2 ** (i - 1));
      logger?.warn?.({ event: "temporal_connect_failed", target: label, attempt: i, retryInMs: wait, err: errMessage(err), ...describeConnection(c) }, "cannot reach Temporal, retrying");
      await sleep(wait);
    }
  }
  throw new TemporalConnectionError(
    `Cannot connect the ${label} to Temporal at ${c.address} (namespace ${c.namespace}) after ${attempts} attempts: ${errMessage(last)}`,
    attempts,
  );
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 300);
}

/** Build the connection config from the shared runtime config. */
export function temporalConfigFrom(cfg: {
  TEMPORAL_ADDRESS: string;
  TEMPORAL_NAMESPACE: string;
  TEMPORAL_TLS: boolean;
  TEMPORAL_TLS_CA_PATH?: string;
  TEMPORAL_TLS_CERT_PATH?: string;
  TEMPORAL_TLS_KEY_PATH?: string;
  TEMPORAL_TLS_SERVER_NAME?: string;
  TEMPORAL_API_KEY?: string;
  TEMPORAL_CONNECT_TIMEOUT_MS: number;
  TEMPORAL_CONNECT_ATTEMPTS: number;
}): TemporalConnectionConfig {
  return {
    address: cfg.TEMPORAL_ADDRESS,
    namespace: cfg.TEMPORAL_NAMESPACE,
    tls: cfg.TEMPORAL_TLS,
    caPath: cfg.TEMPORAL_TLS_CA_PATH || undefined,
    certPath: cfg.TEMPORAL_TLS_CERT_PATH || undefined,
    keyPath: cfg.TEMPORAL_TLS_KEY_PATH || undefined,
    serverName: cfg.TEMPORAL_TLS_SERVER_NAME || undefined,
    apiKey: cfg.TEMPORAL_API_KEY || undefined,
    connectTimeoutMs: cfg.TEMPORAL_CONNECT_TIMEOUT_MS,
    connectAttempts: cfg.TEMPORAL_CONNECT_ATTEMPTS,
  };
}
