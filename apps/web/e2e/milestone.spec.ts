import { expect, test } from "@playwright/test";
import { createAgent, signUp } from "./helpers";

test.describe("milestone 1: primary workflow", () => {
  test("sign in, create Atlas, run a tool-using task, watch it live, and reload", async ({ page, context }) => {
    await signUp(page);

    // Providers without keys are shown as unconfigured, not faked.
    await page.goto("/settings");
    await expect(page.locator('[data-provider="anthropic"]')).toHaveAttribute("data-configured", "false");
    await expect(page.locator('[data-provider="openai"]')).toContainText("Not configured");
    await expect(page.locator('[data-provider="mock"]')).toContainText("Mock provider");

    const atlasId = await createAgent(page, { name: "Atlas", role: "Analyst who verifies numbers with tools", tools: ["calculator", "current_datetime"] });
    await expect(page.getByText("Mock provider").first()).toBeVisible();

    // A second tab watches the dashboard while the task runs.
    const dashboard = await context.newPage();
    await dashboard.goto("/");
    await expect(dashboard.getByTestId("stream-state")).toHaveText("live");

    await page.goto(`/tasks?new=1&agentId=${atlasId}`);
    await page.getByLabel("Title").fill("Verify the order total");
    await page.getByLabel("Instruction", { exact: true }).fill("What is (17 * 23) + 4? Use the calculator.");
    await page.getByRole("button", { name: "Start task" }).click();
    await page.waitForURL(/\/tasks\/[a-z0-9]+$/);
    const taskUrl = page.url();

    // The tool ran on the backend and its real output reached the agent.
    await expect(page.getByTestId("task-result")).toContainText("Final answer: 395");
    const timeline = page.getByTestId("event-timeline");
    await expect(timeline.locator('[data-event-type="tool.completed"]')).toContainText("Tool executed on server: calculator");
    await expect(timeline.locator('[data-event-type="run.completed"]')).toBeVisible();
    await expect(page.locator('[data-tool="calculator"]')).toHaveAttribute("data-status", "succeeded");
    await expect(page.getByText("Mock provider").first()).toBeVisible();

    // The dashboard received the events live, without a reload.
    const feed = dashboard.getByTestId("activity-feed");
    await expect(feed).toContainText("ran calculator");
    await expect(feed).toContainText("completed a run");

    // Everything is persisted: reload and check task, events and tool calls.
    await page.reload();
    await expect(page.getByTestId("task-result")).toContainText("Final answer: 395");
    await expect(page.getByTestId("event-timeline").locator('[data-event-type="tool.completed"]')).toBeVisible();
    await page.locator('[data-tool="calculator"] summary').click();
    await expect(page.locator('[data-tool="calculator"]')).toContainText('"result": 395');
    expect(page.url()).toBe(taskUrl);

    // Chat: the conversation persists across reloads too.
    await page.goto(`/agents/${atlasId}/chat`);
    await page.getByLabel("Message").fill("What is 6 * 7?");
    await page.getByRole("button", { name: "Send" }).click();
    const messages = page.getByTestId("chat-messages");
    await expect(messages).toContainText("Final answer: 42");
    await expect(messages).toContainText("executed on server");
    await page.reload();
    await expect(page.getByTestId("chat-messages")).toContainText("Final answer: 42");
    await expect(page.getByTestId("chat-messages")).toContainText("What is 6 * 7?");
  });

  test("two agents run sequentially with a handoff", async ({ page }) => {
    await signUp(page);
    await createAgent(page, { name: "Atlas", role: "Computes figures", tools: ["calculator"] });
    await createAgent(page, { name: "Vega", role: "Writes summaries", tools: [] });

    await page.goto("/tasks?new=1");
    await page.getByRole("radio", { name: "Two-agent pipeline" }).click();
    await page.getByLabel("Title").fill("Annual revenue note");
    await page.getByLabel("Instruction", { exact: true }).fill("Prepare the revenue note");
    await page.locator("#agent1").selectOption({ label: "Atlas (mock/mock-scripted, MOCK)" });
    await page.getByLabel("Step instruction").first().fill("Compute 1250 * 12");
    await page.locator("#agent2").selectOption({ label: "Vega (mock/mock-scripted, MOCK)" });
    await page.getByLabel("Step instruction").nth(1).fill("Summarise the figure for leadership");
    await page.getByRole("button", { name: "Start task" }).click();

    const steps = page.getByTestId("pipeline-steps");
    await expect(page.getByTestId("task-result")).toContainText("Reviewed the handoff");
    await expect(page.getByTestId("task-result")).toContainText("15000");
    await expect(steps.locator("li").nth(0)).toContainText("Completed");
    await expect(steps.locator("li").nth(1)).toContainText("Handoff from Atlas");
    await expect(page.getByTestId("event-timeline").locator('[data-event-type="agent.handoff"]')).toBeVisible();
    await expect(page.getByTestId("run-card")).toHaveCount(2);

    await page.reload();
    await expect(page.getByTestId("run-card")).toHaveCount(2);
    await expect(page.getByTestId("event-timeline").locator('[data-event-type="agent.handoff"]')).toBeVisible();
  });

  test("sensitive tool waits for human approval", async ({ page }) => {
    await signUp(page);
    await createAgent(page, { name: "Ops", role: "Notifies other systems", tools: ["mock_external_action"] });
    await page.goto("/tasks?new=1");
    await page.getByLabel("Title").fill("Notify ops");
    await page.getByLabel("Instruction", { exact: true }).fill("[mock:approval] Tell the ops channel the release is done");
    await page.locator("#agentId").selectOption({ label: "Ops (mock/mock-scripted, MOCK)" });
    await page.getByRole("button", { name: "Start task" }).click();
    await page.waitForURL(/\/tasks\/[a-z0-9]+$/);
    const taskUrl = page.url();

    await expect(page.getByText("Waiting for your approval")).toBeVisible();
    await expect(page.locator('[data-tool="mock_external_action"]')).toHaveAttribute("data-status", "awaiting_approval");

    await page.goto("/approvals");
    const card = page.getByTestId("pending-approvals");
    await expect(card).toContainText("mock_external_action");
    await expect(card).toContainText("notify the ops channel");
    await page.getByLabel("Decision note").fill("Release confirmed");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Nothing waiting for approval")).toBeVisible();
    await expect(page.getByTestId("audit-log")).toContainText("approval.approved");

    await page.goto(taskUrl);
    await expect(page.getByTestId("task-result")).toContainText("mock_external_action returned");
    await expect(page.locator('[data-tool="mock_external_action"]')).toHaveAttribute("data-status", "succeeded");
  });
});
