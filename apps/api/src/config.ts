import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

export const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  SESSION_COOKIE_SECURE: bool,
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  AGENTOS_ENABLE_MOCK_PROVIDER: bool,
  AGENTOS_MODEL_CATALOG_JSON: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z.string().default("info"),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
