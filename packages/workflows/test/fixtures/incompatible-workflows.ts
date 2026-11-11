// Test-only: a deliberately non-replay-compatible change (a new timer before the first
// activity, without patched()). The compatibility test must reject it.
import { proxyActivities, sleep } from "@temporalio/workflow";
import type { AgentActivities, WorkflowInput } from "../../src/types";

const steps = proxyActivities<AgentActivities>({ startToCloseTimeout: "1 minute" });

export async function agentTaskWorkflow(args: WorkflowInput) {
  await sleep(1);
  return steps.beginRun({ orgId: args.orgId, taskId: args.taskId });
}

export async function pipelineWorkflow(args: WorkflowInput) {
  await sleep(1);
  return steps.advancePipeline({ orgId: args.orgId, taskId: args.taskId });
}
