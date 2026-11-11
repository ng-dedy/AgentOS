import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, type WorkerOptions } from "@temporalio/worker";
import { connectWithRetry, type TemporalConnectionConfig } from "./connection";
import type { AgentActivities } from "./types";

/** Path of the workflow entry point, bundled by the Temporal worker. */
export const WORKFLOWS_PATH = fileURLToPath(new URL("./workflows/index.ts", import.meta.url));

export interface WorkerDeploymentConfig {
  /** Turn on Temporal Worker Deployment versioning for this worker. */
  enabled: boolean;
  /** Deployment name (one per service), e.g. "agentos-worker". */
  deploymentName: string;
  /** Build id of this code, e.g. the git commit. Required when enabled. */
  buildId: string;
  /**
   * PINNED: a workflow stays on the build it started on (safest for code changes that are
   * not patched). AUTO_UPGRADE: running workflows move to the current build (needs patched()).
   */
  defaultBehavior: "PINNED" | "AUTO_UPGRADE";
}

export interface CreateWorkerOptions {
  connection: TemporalConnectionConfig;
  taskQueue: string;
  activities: AgentActivities;
  identity?: string;
  maxConcurrentActivityTaskExecutions?: number;
  maxConcurrentWorkflowTaskExecutions?: number;
  shutdownGraceTime?: WorkerOptions["shutdownGraceTime"];
  /** Pre-built workflow bundle (production); default bundles WORKFLOWS_PATH at startup. */
  workflowBundlePath?: string;
  deployment?: WorkerDeploymentConfig;
  logger?: { warn?: (o: unknown, m?: string) => void };
}

export async function createAgentWorker(opts: CreateWorkerOptions): Promise<{ worker: Worker; connection: NativeConnection }> {
  const connection = await connectWithRetry("worker", opts.connection, (o) => NativeConnection.connect(o), opts.logger);
  const d = opts.deployment;
  const worker = await Worker.create({
    connection,
    namespace: opts.connection.namespace,
    taskQueue: opts.taskQueue,
    ...(opts.workflowBundlePath ? { workflowBundle: { codePath: opts.workflowBundlePath } } : { workflowsPath: WORKFLOWS_PATH }),
    activities: opts.activities,
    identity: opts.identity,
    maxConcurrentActivityTaskExecutions: opts.maxConcurrentActivityTaskExecutions ?? 20,
    ...(opts.maxConcurrentWorkflowTaskExecutions ? { maxConcurrentWorkflowTaskExecutions: opts.maxConcurrentWorkflowTaskExecutions } : {}),
    shutdownGraceTime: opts.shutdownGraceTime ?? "10 seconds",
    ...(d?.enabled
      ? {
          workerDeploymentOptions: {
            version: { deploymentName: d.deploymentName, buildId: d.buildId },
            useWorkerVersioning: true as const,
            defaultVersioningBehavior: d.defaultBehavior,
          },
        }
      : {}),
  });
  return { worker, connection };
}
