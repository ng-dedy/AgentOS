import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, type WorkerOptions } from "@temporalio/worker";
import type { AgentActivities } from "./types";

/** Path of the workflow entry point, bundled by the Temporal worker. */
export const WORKFLOWS_PATH = fileURLToPath(new URL("./workflows/index.ts", import.meta.url));

export interface CreateWorkerOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  activities: AgentActivities;
  identity?: string;
  maxConcurrentActivityTaskExecutions?: number;
  shutdownGraceTime?: WorkerOptions["shutdownGraceTime"];
}

export async function createAgentWorker(opts: CreateWorkerOptions): Promise<{ worker: Worker; connection: NativeConnection }> {
  const connection = await NativeConnection.connect({ address: opts.address });
  const worker = await Worker.create({
    connection,
    namespace: opts.namespace,
    taskQueue: opts.taskQueue,
    workflowsPath: WORKFLOWS_PATH,
    activities: opts.activities,
    identity: opts.identity,
    maxConcurrentActivityTaskExecutions: opts.maxConcurrentActivityTaskExecutions ?? 20,
    shutdownGraceTime: opts.shutdownGraceTime ?? "10 seconds",
  });
  return { worker, connection };
}
