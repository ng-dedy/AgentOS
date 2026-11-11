import { z } from "zod";
import { boolFromEnv, RuntimeConfigSchema } from "@agentos/platform";

export const ConfigSchema = RuntimeConfigSchema.extend({
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  SESSION_COOKIE_SECURE: boolFromEnv,
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /** Start workflows for queued tasks that have none (e.g. Temporal was down at creation). */
  DISPATCH_RECONCILE_MS: z.coerce.number().int().min(0).default(15_000),
  /** Bearer token for GET /metrics (Prometheus). Unset = /metrics disabled. */
  AGENTOS_METRICS_TOKEN: z.string().min(1).optional(),
  /** After SIGTERM: report not-ready for this long (load balancer drains) before closing. */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(5_000),
  /** Exit even if connections have not closed by then. */
  SHUTDOWN_FORCE_MS: z.coerce.number().int().min(1_000).default(30_000),
  /** How often the event listener reconciles with Postgres (also on every notification). */
  EVENT_RECONCILE_MS: z.coerce.number().int().min(100).default(2_000),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
