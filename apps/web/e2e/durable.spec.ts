import { expect, test } from "@playwright/test";
import { createAgent, signUp } from "./helpers";

/** Milestone 2B: durable execution and credential management, seen from the browser. */
test.describe("milestone 2B: durable execution", () => {
  test.skip(process.env.E2E_WORKFLOW_ENGINE === "inprocess", "needs Temporal and a worker");

  test("dashboard shows the durable engine and a healthy worker; a task page shows its workflow", async ({ page }) => {
    await signUp(page);
    await page.goto("/");
    const panel = page.getByTestId("execution-panel");
    await expect(panel.getByTestId("engine-badge")).toContainText("Durable · Temporal reachable");
    await expect(panel.getByTestId("worker-badge")).toContainText("1 healthy");
    await expect(page.getByTestId("active-breakdown")).toContainText("0 queued · 0 running · 0 awaiting approval");

    const atlasId = await createAgent(page, { name: "Atlas", role: "Analyst", tools: ["calculator"] });
    await page.goto(`/tasks?new=1&agentId=${atlasId}`);
    await page.getByLabel("Title").fill("Durable total");
    await page.getByLabel("Instruction", { exact: true }).fill("What is 40 + 2?");
    await page.getByRole("button", { name: "Start task" }).click();
    await page.waitForURL(/\/tasks\/[a-z0-9]+$/);
    await expect(page.getByTestId("task-result")).toContainText("Final answer: 42");
    const wf = page.getByTestId("workflow-panel");
    await expect(wf.getByTestId("workflow-status").first()).toHaveText("completed");
    await expect(wf).toContainText("task-");
    await expect(wf).toContainText("No retries.");
  });

  test("settings shows encrypted, write-only credential management for owners", async ({ page }) => {
    await signUp(page);
    await page.goto("/settings");
    await expect(page.getByTestId("credential-storage")).toContainText("Encrypted with local-dev");
    await expect(page.getByTestId("credential-storage")).toContainText("development KMS, not for production");
    const openai = page.locator('[data-provider="openai"]');
    await expect(openai.getByTestId("credential-source")).toHaveText("No key");
    await openai.getByTestId("credential-edit").click();
    const input = openai.getByLabel("OpenAI API key");
    await expect(input).toHaveAttribute("type", "password");
    await expect(openai.getByRole("button", { name: "Save and verify" })).toBeVisible();
  });
});
