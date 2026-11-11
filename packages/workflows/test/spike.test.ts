import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { expect, it } from "vitest";
it("round-trips a workflow on the local dev server", { timeout: 60_000 }, async () => {
  const nc = await NativeConnection.connect({ address: "127.0.0.1:7233" });
  const worker = await Worker.create({
    connection: nc,
    taskQueue: "spike",
    workflowsPath: fileURLToPath(new URL("./fixtures/spikeWorkflow.ts", import.meta.url)),
    activities: { greet: async (n: string) => `hi ${n}` },
  });
  const run = worker.run();
  const client = new Client({ connection: await Connection.connect({ address: "127.0.0.1:7233" }) });
  const r = await client.workflow.execute("spike", { taskQueue: "spike", workflowId: `spike-${Date.now()}`, args: ["x"] });
  expect(r).toBe("hi x");
  worker.shutdown();
  await run;
  await nc.close();
});
