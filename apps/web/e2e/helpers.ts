import { expect, type Page } from "@playwright/test";

export async function signUp(page: Page) {
  const email = `e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login");
  await page.getByRole("button", { name: "Create a workspace" }).click();
  await page.getByLabel("Your name").fill("E2E Operator");
  await page.getByLabel("Workspace name").fill("E2E Workspace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Command center" })).toBeVisible();
  return email;
}

export async function createAgent(page: Page, opts: { name: string; role: string; tools: string[] }) {
  await page.goto("/agents/new");
  await page.getByLabel("Name", { exact: true }).fill(opts.name);
  await page.getByLabel("Role").fill(opts.role);
  await page.getByLabel("System instructions").fill("Use tools for anything you can verify.");
  await page.getByLabel("AI provider").selectOption("mock");
  await expect(page.getByText("MOCK provider: a scripted test double")).toBeVisible();
  await expect(page.getByLabel("Model")).toHaveValue("mock-scripted");
  // Default selection is calculator + current_datetime; set exactly what the test wants.
  for (const box of await page.locator('input[name="tool"]').all()) {
    const name = await box.getAttribute("value");
    if (opts.tools.includes(name ?? "")) await box.check();
    else await box.uncheck();
  }
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name: opts.name })).toBeVisible();
  await expect(page.getByTestId("agent-model")).toHaveText("mock/mock-scripted");
  return page.url().split("/").pop()!;
}
