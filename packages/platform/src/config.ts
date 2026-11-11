import { z } from "zod";

export const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const httpsUrl = z
  .string()
  .url()
  .refine((u) => new URL(u).protocol === "https:", "must be an https URL");

/** Settings shared by the API and the worker (everything that executes or describes runs). */
export const RuntimeConfigSchema = z.object({
  /**
   * Deployment environment. `production` turns on strict startup validation
   * (see `validateProductionConfig`); `NODE_ENV=production` is treated the same way.
   */
  AGENTOS_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  AGENTOS_ENABLE_MOCK_PROVIDER: boolFromEnv,
  AGENTOS_MODEL_CATALOG_JSON: z.string().optional(),
  /** How long the MOCK provider's [mock:slow] directive waits (tests). */
  AGENTOS_MOCK_SLOW_MS: z.coerce.number().int().min(0).default(3000),
  /**
   * Provider endpoints. Set explicitly (defaults are the public APIs) so the SDKs never
   * pick up OPENAI_BASE_URL / ANTHROPIC_BASE_URL from the host environment.
   */
  AGENTOS_OPENAI_BASE_URL: httpsUrl.default("https://api.openai.com/v1"),
  AGENTOS_ANTHROPIC_BASE_URL: httpsUrl.default("https://api.anthropic.com"),
  AGENTOS_XAI_BASE_URL: httpsUrl.default("https://api.x.ai/v1"),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(2),
  /**
   * `temporal`: tasks run as Temporal workflows on dedicated workers (durable).
   * `inprocess`: tasks run inside the API process (unit tests, single-process dev).
   */
  AGENTOS_WORKFLOW_ENGINE: z.enum(["temporal", "inprocess"]).default("inprocess"),
  TEMPORAL_ADDRESS: z.string().default("127.0.0.1:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("agentos-tasks"),
  /** TLS to the Temporal frontend. Required in production. Implied by an API key or a client cert. */
  TEMPORAL_TLS: boolFromEnv,
  /** PEM files: custom server CA (optional), client certificate + key for mTLS (both or neither). */
  TEMPORAL_TLS_CA_PATH: z.string().optional(),
  TEMPORAL_TLS_CERT_PATH: z.string().optional(),
  TEMPORAL_TLS_KEY_PATH: z.string().optional(),
  /** Override the TLS server name (SNI) when it differs from the address host. */
  TEMPORAL_TLS_SERVER_NAME: z.string().optional(),
  /** Temporal Cloud API key (alternative to mTLS). Never logged. */
  TEMPORAL_API_KEY: z.string().optional(),
  /** Explicit, logged opt-out of TLS in production, for a network that already encrypts (service mesh). */
  TEMPORAL_ALLOW_PLAINTEXT_IN_PRODUCTION: boolFromEnv,
  /** Connect timeout and startup connection attempts (with backoff) before giving up. */
  TEMPORAL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
  TEMPORAL_CONNECT_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  /** Activity heartbeat timeout: how quickly a dead worker's step moves to another worker. */
  AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(2_000).default(30_000),
  /** start-to-close timeout for one model or tool step (includes the engine's provider retries). */
  AGENTOS_STEP_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(15 * 60_000),
  /** Infrastructure retries for one step (business failures are never retried). */
  AGENTOS_STEP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /** Hard cap on one task workflow run, approvals included. 0 = no cap. */
  AGENTOS_WORKFLOW_RUN_TIMEOUT_MS: z.coerce.number().int().min(0).default(0),
  /**
   * Budget reservation for a model whose price is unknown (catalog `priceSource: unverified`),
   * in USD per call. A task with a spending limit cannot call an unpriced model without it.
   */
  AGENTOS_UNPRICED_CALL_RESERVE_USD: z.coerce.number().min(0).default(0),
  /** How long a process keeps a decrypted provider key (see CredentialService). 0 = never. */
  AGENTOS_CREDENTIAL_CACHE_TTL_MS: z.coerce.number().int().min(0).max(15 * 60_000).default(60_000),
  /**
   * Allow organizations without their own credential to use the deployment's env keys
   * (OPENAI_API_KEY, ...). Off by default: each organization brings its own key.
   * Never falls back to another organization's key.
   */
  AGENTOS_ALLOW_DEPLOYMENT_KEYS: boolFromEnv,
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
