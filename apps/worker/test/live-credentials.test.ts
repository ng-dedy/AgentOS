/* eslint-disable @typescript-eslint/no-explicit-any -- black-box HTTP test */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, db, resetDb, startApi, startWorker, type Proc } from "./harness";

/**
 * OPTIONAL live verification (AGENTOS_LIVE_TESTS=1 plus a provider key in this
 * process's environment). The key is never given to the worker or API through
 * their environment: the test stores it as the organization's encrypted credential
 * through the API, and the worker decrypts it per call. A skipped test is not a
 * verification.
 */
const LIVE = process.env.AGENTOS_LIVE_TESTS === "1";
const cases = [
  { provider: "anthropic", model: "claude-haiku-5-5", key: process.env.ANTHROPIC_API_KEY },
  { provider: "openai", model: "gpt-6-luna", key: process.env.OPENAI_API_KEY },
].filter((c) => LIVE && c.key);

const proxyEnv = Object.fromEntries(
  ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
);

describe.skipIf(cases.length === 0)("live: org credential through the durable stack", () => {
  let worker: Proc;
  let api: Awaited<ReturnType<typeof startApi>>;
  let a: Client;

  beforeAll(async () => {
    await resetDb();
    worker = await startWorker(proxyEnv);
    api = await startApi(proxyEnv);
    a = await new Client(api.url).signup("Live Org");
  });
  afterAll(async () => {
    await api?.kill("SIGTERM");
    await worker?.kill("SIGTERM");
    await db().$disconnect();
  });

  for (const c of cases) {
    it(`${c.provider}: verifies the org key, runs a tool-using task on the worker, never exposes the key`, async () => {
      const put = await a.put(`/credentials/${c.provider}`, { apiKey: c.key });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body.credential.status).toBe("valid"); // the provider's Models API accepted it
      const agent = await a.agent({ provider: c.provider, model: c.model, allowedTools: ["calculator"], maxRunCostUsd: 0.05, name: `Live ${c.provider}` });
      const t = await a.task(agent.id, "Use the calculator tool to compute (17 * 23) + 4, then reply with just the number.");
      const done = await a.waitStatus(t.id, ["completed", "failed"], 120_000);
      expect(done.failureMessage).toBeNull();
      expect(done.status).toBe("completed");
      expect(done.result).toContain("395");
      expect(done.runs[0].isMock).toBe(false);
      expect(done.runs[0].toolCalls.some((x: any) => x.toolName === "calculator" && x.status === "succeeded")).toBe(true);
      const usage = await db().usageRecord.findMany({ where: { runId: done.runs[0].id } });
      expect(usage.length).toBeGreaterThanOrEqual(2);
      expect(usage.every((u) => (u.latencyMs ?? 0) > 0)).toBe(true);
      for (const p of [api, worker]) expect(p.logs.join("")).not.toContain(c.key!);
      expect(JSON.stringify(await a.events(t.id))).not.toContain(c.key!);
      // eslint-disable-next-line no-console
      console.log(`[live] ${c.provider}/${c.model}: completed, ${usage.length} model calls, est. $${Number(done.runs[0].costUsd).toFixed(6)}, result: ${String(done.result).slice(0, 80)}`);
    });
  }
});
