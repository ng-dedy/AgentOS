import { expect, test, type Page } from "@playwright/test";
import { signUp } from "../e2e/helpers";

const LIVE = process.env.AGENTOS_LIVE_TESTS === "1";
const SHOTS = process.env.AGENTOS_LIVE_SCREENSHOTS;
const TARGETS = [
  { provider: "openai", key: "OPENAI_API_KEY", model: "gpt-6-luna" },
  { provider: "anthropic", key: "ANTHROPIC_API_KEY", model: "claude-haiku-5-5" },
].filter((t) => process.env[t.key]);

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.skip(!LIVE || TARGETS.length === 0, "set AGENTOS_LIVE_TESTS=1 and a provider key");

test("live provider: account check, real tool-using task, live timeline", async ({ page }) => {
  await signUp(page);

  // Settings: no mock provider; each keyed provider is checked against its Models API.
  await page.goto("/settings");
  await expect(page.locator('[data-provider="mock"]')).toHaveCount(0);
  for (const t of TARGETS) {
    const card = page.locator(`[data-provider="${t.provider}"]`);
    await card.getByRole("button", { name: "Check account" }).click();
    await expect(card.getByTestId("provider-status")).toHaveText("Live: account verified");
    await expect(card.locator(`[data-model="${t.model}"]`)).toContainText("on account");
  }
  await shot(page, "settings-providers");

  const t = TARGETS[0]!;
  await page.goto("/agents/new");
  await page.getByLabel("Name", { exact: true }).fill("Atlas Live");
  await page.getByLabel("Role").fill("Analyst who verifies numbers with tools");
  await page.getByLabel("System instructions").fill("Always use the calculator for arithmetic, then state the number.");
  await page.getByLabel("AI provider").selectOption(t.provider);
  await page.getByLabel("Model").selectOption(t.model);
  for (const box of await page.locator('input[name="tool"]').all()) {
    if ((await box.getAttribute("value")) === "calculator") await box.check();
    else await box.uncheck();
  }
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("agent-model")).toHaveText(`${t.provider}/${t.model}`);
  const agentId = page.url().split("/").pop()!;

  await page.goto(`/tasks?new=1&agentId=${agentId}`);
  await page.getByLabel("Title").fill("Live arithmetic check");
  await page.getByLabel("Instruction", { exact: true }).fill("What is (48271 * 3917) - 1234? Use the calculator.");
  await page.getByRole("button", { name: "Start task" }).click();
  await page.waitForURL(/\/tasks\/[a-z0-9]+$/);

  await expect(page.getByTestId("task-result")).toContainText(/189[,\s.\u202f]?076[,\s.\u202f]?273/);
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByText("Mock provider")).toHaveCount(0);
  const timeline = page.getByTestId("event-timeline");
  await expect(timeline.locator('[data-event-type="tool.completed"]')).toContainText("Tool executed on server: calculator");
  await expect(timeline.getByTestId("model-meta").first()).toContainText("LIVE");
  await expect(page.locator('[data-tool="calculator"]')).toHaveAttribute("data-status", "succeeded");
  await expect(page.getByTestId("run-card")).toContainText("LIVE");
  await shot(page, "task-live-result");

  await page.goto("/");
  await expect(page.getByTestId("provider-strip")).toContainText("key set");
  await shot(page, "dashboard");
});
