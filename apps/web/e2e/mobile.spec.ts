import { expect, test, type Page } from "@playwright/test";
import { createAgent, signUp } from "./helpers";

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("mobile layout: navigation menu and no horizontal overflow", async ({ page }) => {
  await signUp(page);
  const atlasId = await createAgent(page, { name: "Atlas", role: "Analyst", tools: ["calculator"] });
  await page.goto(`/tasks?new=1&agentId=${atlasId}`);
  await page.getByLabel("Title").fill("A fairly long task title that should wrap on small screens");
  await page.getByLabel("Instruction", { exact: true }).fill("What is (17 * 23) + 4?");
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByTestId("task-result")).toContainText("395");
  await expectNoHorizontalOverflow(page);

  await page.goto("/");
  await expect(page.getByTestId("activity-feed")).toContainText("ran calculator");
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
