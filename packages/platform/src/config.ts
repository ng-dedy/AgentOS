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
  /** Activity heartbeat timeout: how quickly a dead worker's step moves to another worker. */
  AGENTOS_ACTIVITY_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(2_000).default(30_000),
  /**
   * Allow organizations without their own credential to use the deployment's env keys
   * (OPENAI_API_KEY, ...). Off by default: each organization brings its own key.
   * Never falls back to another organization's key.
   */
  AGENTOS_ALLOW_DEPLOYMENT_KEYS: boolFromEnv,
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
