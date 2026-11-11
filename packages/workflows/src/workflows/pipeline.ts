import { CancellationScope, ChildWorkflowCancellationType, executeChild, isCancellation, ParentClosePolicy, proxyActivities } from "@temporalio/workflow";
import type { TaskStatus } from "@agentos/contracts";
import type { AgentActivities, TaskInput, WorkflowInput } from "../types";
import { workflowIdFor } from "../types";
import { agentTaskWorkflow } from "./agentTask";

const steps = proxyActivities<AgentActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 10, initialInterval: "1 second", maximumInterval: "30 seconds" },
});

/**
 * Sequential multi-agent pipeline. Each step is a child `agentTaskWorkflow`; the
 * handoff between steps is computed by the idempotent `advancePipeline` activity.
 * Cancelling this workflow cancels the running child first, then settles the pipeline.
 */
export async function pipelineWorkflow(args: WorkflowInput): Promise<TaskStatus> {
  const input: TaskInput = { orgId: args.orgId, taskId: args.taskId };
  try {
    for (;;) {
      const d = await steps.advancePipeline(input);
      if (d.kind === "done") return d.status;
      await executeChild(agentTaskWorkflow, {
        workflowId: workflowIdFor(d.childTaskId),
        args: [{ orgId: input.orgId, taskId: d.childTaskId, options: args.options }],
        cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      });
    }
  } catch (err) {
    if (!isCancellation(err)) throw err;
    return CancellationScope.nonCancellable(async () => {
      for (let i = 0; i < 5; i++) {
        const d = await steps.advancePipeline(input);
        if (d.kind === "done") return d.status;
        // The step is still finishing its own cancellation; ask it to stop and settle again.
        await steps.cancelTask({ orgId: input.orgId, taskId: d.childTaskId });
      }
      return "cancelled" as const;
    });
  }
}
