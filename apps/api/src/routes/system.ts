import type { FastifyInstance } from "fastify";
import { TERMINAL_TASK_STATUSES, type TaskStatus } from "@agentos/contracts";
import type { AppDeps } from "../app";
import { requireAuth } from "../auth/plugin";
import { notFound } from "../http/errors";

/** A worker is healthy if it heartbeated within this window (it writes every 5 s). */
export const WORKER_STALE_MS = 30_000;
const STALE_TOOL_MS = 10 * 60_000;

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export async function systemRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, temporal, listener, workflow } = deps;

  async function workers(includeHost: boolean) {
    const rows = await prisma.workerHeartbeat.findMany({ where: { lastSeenAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, orderBy: { lastSeenAt: "desc" }, take: 50 });
    const now = Date.now();
    return rows.map((w) => ({
      id: w.id,
      ...(includeHost ? { hostname: w.hostname, pid: w.pid } : {}),
      taskQueue: w.taskQueue,
      version: w.version,
      status: w.status,
      activeActivities: w.activeActivities,
      startedAt: w.startedAt.toISOString(),
      lastSeenAt: w.lastSeenAt.toISOString(),
      healthy: w.status === "running" && now - w.lastSeenAt.getTime() < WORKER_STALE_MS,
    }));
  }

  /** Execution infrastructure health: workflow service, workers, event fan-out, credential storage. */
  app.get("/system/health", async (req) => {
    const auth = requireAuth(req);
    let temporalStatus: { reachable: boolean; workflowPollers: number; activityPollers: number; error?: string } | null = null;
    if (temporal) {
      try {
        temporalStatus = { reachable: true, ...(await temporal.hasPollers()) };
      } catch (err) {
        temporalStatus = { reachable: false, workflowPollers: 0, activityPollers: 0, error: err instanceof Error ? err.message.slice(0, 200) : "unreachable" };
      }
    }
    const ws = await workers(auth.role === "owner");
    return {
      engine: workflow.kind,
      taskQueue: temporal ? deps.config.TEMPORAL_TASK_QUEUE : null,
      temporal: temporalStatus,
      workers: ws,
      healthyWorkers: ws.filter((w) => w.healthy).length,
      events: { crossInstance: listener !== null, listenerConnected: listener?.connected ?? false, reconnects: listener?.reconnects ?? 0 },
      credentials: { enabled: deps.credentials.enabled, kms: deps.credentials.kmsName, developmentOnly: deps.credentials.kmsDevelopmentOnly },
    };
  });

  /** Durable execution behind one task: workflow state, pending activities, retry history. */
  app.get("/tasks/:id/workflow", async (req) => {
    const { organizationId } = requireAuth(req);
    const { id } = req.params as { id: string };
    const task = await prisma.task.findFirst({ where: { id, organizationId }, select: { id: true, parentTaskId: true, status: true, workflowId: true } });
    if (!task) throw notFound("Task");
    const children = await prisma.task.findMany({ where: { organizationId, parentTaskId: id }, select: { id: true, status: true, stepIndex: true }, orderBy: { stepIndex: "asc" } });
    const description = await workflow.describe?.(organizationId, id);
    const childDescriptions = await Promise.all(children.map(async (c) => ({ taskId: c.id, stepIndex: c.stepIndex, status: c.status, workflow: (await workflow.describe?.(organizationId, c.id)) ?? null })));
    const retries = await prisma.runEvent.findMany({
      where: { organizationId, rootTaskId: task.parentTaskId ?? task.id, type: { in: ["model.retry", "activity.retry"] } },
      orderBy: { seq: "asc" },
      take: 200,
    });
    return {
      taskId: id,
      status: task.status,
      workflowId: task.workflowId,
      workflow: description ?? null,
      children: childDescriptions,
      retryHistory: retries.map((r) => ({ seq: r.seq.toString(), type: r.type, taskId: r.taskId, payload: r.payload, createdAt: r.createdAt.toISOString() })),
    };
  });

  /** Latency, failure and retry metrics for this organization (recent window). */
  app.get("/system/metrics", async (req) => {
    const { organizationId } = requireAuth(req);
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    const [tasks, usage, failures, retryCounts] = await Promise.all([
      prisma.task.findMany({ where: { organizationId, createdAt: { gt: since }, startedAt: { not: null } }, select: { createdAt: true, startedAt: true, completedAt: true }, orderBy: { createdAt: "desc" }, take: 500 }),
      prisma.usageRecord.findMany({ where: { organizationId, createdAt: { gt: since }, latencyMs: { not: null } }, select: { provider: true, latencyMs: true, attempt: true }, orderBy: { createdAt: "desc" }, take: 2000 }),
      prisma.task.groupBy({ by: ["failureCode"], where: { organizationId, status: "failed", createdAt: { gt: since } }, _count: true }),
      prisma.runEvent.groupBy({ by: ["type"], where: { organizationId, type: { in: ["model.retry", "activity.retry"] }, createdAt: { gt: since } }, _count: true }),
    ]);
    const queue = tasks.map((t) => t.startedAt!.getTime() - t.createdAt.getTime());
    const runs = tasks.filter((t) => t.completedAt).map((t) => t.completedAt!.getTime() - t.startedAt!.getTime());
    const byProvider = new Map<string, number[]>();
    for (const u of usage) byProvider.set(u.provider, [...(byProvider.get(u.provider) ?? []), u.latencyMs!]);
    const retries = Object.fromEntries(retryCounts.map((r) => [r.type, r._count]));
    return {
      window: { since: since.toISOString() },
      queueLatencyMs: { p50: percentile(queue, 50), p95: percentile(queue, 95), samples: queue.length },
      runDurationMs: { p50: percentile(runs, 50), p95: percentile(runs, 95), samples: runs.length },
      modelLatencyMs: [...byProvider.entries()].map(([provider, v]) => ({ provider, p50: percentile(v, 50), p95: percentile(v, 95), samples: v.length })),
      failuresByCode: failures.map((f) => ({ code: f.failureCode ?? "unknown", count: f._count })),
      retries: { model: retries["model.retry"] ?? 0, activity: retries["activity.retry"] ?? 0 },
    };
  });

  /** Things that look stuck, with what to do about them. */
  app.get("/system/diagnostics", async (req) => {
    const auth = requireAuth(req);
    const { organizationId } = auth;
    const now = Date.now();
    const issues: { kind: string; taskId?: string; detail: string; hint: string }[] = [];

    const active = await prisma.task.findMany({
      where: { organizationId, parentTaskId: null, status: { in: ["queued", "running", "awaiting_approval"] } },
      select: { id: true, status: true, workflowId: true, createdAt: true },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    for (const t of active) {
      if (workflow.kind === "temporal" && !t.workflowId && now - t.createdAt.getTime() > 60_000) {
        issues.push({ kind: "not_dispatched", taskId: t.id, detail: `Task is ${t.status} but no workflow was started`, hint: "Check that the API can reach Temporal; the dispatcher retries every few seconds." });
        continue;
      }
      if (workflow.kind === "temporal" && t.workflowId) {
        const d = await workflow.describe?.(organizationId, t.id).catch(() => null);
        if (d && d.status !== "RUNNING") {
          issues.push({ kind: "workflow_mismatch", taskId: t.id, detail: `Task is ${t.status} in the database but its workflow is ${d.status}`, hint: "Retry the task, or cancel it to finalize." });
        }
        const stuck = d?.pendingActivities.find((a) => a.attempt > 2);
        if (stuck) issues.push({ kind: "activity_retrying", taskId: t.id, detail: `${stuck.activityType} is on attempt ${stuck.attempt}: ${stuck.lastFailure ?? "no failure recorded"}`, hint: "Check worker logs and database connectivity." });
      }
    }

    const staleTools = await prisma.toolCall.findMany({
      where: { organizationId, status: "running", createdAt: { lt: new Date(now - STALE_TOOL_MS) } },
      select: { id: true, taskId: true, toolName: true, createdAt: true },
      take: 50,
    });
    for (const tc of staleTools) {
      issues.push({ kind: "stale_tool_call", taskId: tc.taskId, detail: `Tool '${tc.toolName}' has been running since ${tc.createdAt.toISOString()}`, hint: "If its worker died, the retried step marks it 'outcome unknown' instead of re-running it." });
    }

    const ws = await workers(auth.role === "owner");
    if (workflow.kind === "temporal" && !ws.some((w) => w.healthy)) {
      issues.push({ kind: "no_healthy_worker", detail: "No worker has reported a heartbeat in the last 30 seconds", hint: "Start a worker: pnpm --filter @agentos/worker start" });
    }
    for (const w of ws.filter((x) => !x.healthy && x.status === "running" && now - Date.parse(x.lastSeenAt) < 3600_000)) {
      issues.push({ kind: "stale_worker", detail: `Worker ${w.id} last seen ${w.lastSeenAt}`, hint: "Its in-flight steps are retried on another worker after the 30 s heartbeat timeout." });
    }
    return { checkedAt: new Date().toISOString(), engine: workflow.kind, issues, activeTasks: active.filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status as TaskStatus)).length };
  });
}
