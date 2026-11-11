import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE browser test: the real API with real provider keys, the production web build,
 * and a real model. Costs a fraction of a cent per run. Skipped unless
 * AGENTOS_LIVE_TESTS=1 and OPENAI_API_KEY or ANTHROPIC_API_KEY is set.
 *   AGENTOS_LIVE_TESTS=1 OPENAI_API_KEY=… pnpm --filter @agentos/web test:e2e:live
 */
const API_PORT = 4200;
const WEB_PORT = 3200;
const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agentos_e2e";

export default defineConfig({
  testDir: "./e2e-live",
  timeout: 180_000,
  expect: { timeout: 90_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: "off", screenshot: "only-on-failure", viewport: { width: 1440, height: 900 } },
  projects: [{ name: "live", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "pnpm --filter @agentos/api exec tsx src/scripts/prepareDb.ts && pnpm --filter @agentos/api exec tsx src/server.ts",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: E2E_DB,
        API_PORT: String(API_PORT),
        API_HOST: "localhost",
        WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
        AGENTOS_ENABLE_MOCK_PROVIDER: "false",
        // Keys are passed through from the environment of the test runner only.
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        XAI_API_KEY: process.env.XAI_API_KEY ?? "",
        NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? "",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: `pnpm exec next build && pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
