import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run the real API (Fastify + Postgres) and the production
 * Next.js build. AI calls use the clearly labelled MOCK provider because no
 * provider keys are available in CI; every tool call still executes on the
 * backend and is persisted.
 */
const API_PORT = 4100;
const WEB_PORT = 3100;
const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agentos_e2e";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
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
        AGENTOS_ENABLE_MOCK_PROVIDER: "true",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        XAI_API_KEY: "",
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
