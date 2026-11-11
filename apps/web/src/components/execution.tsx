"use client";

import { AlertTriangle, Cpu, RadioTower, Server, Workflow } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { Diagnostics, SystemHealth, SystemMetrics, TaskWorkflow, WorkflowInfo } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

const ms = (v: number | null) => (v === null ? "–" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);

function usePoll(reload: () => Promise<void>, everyMs: number) {
  useEffect(() => {
    const t = setInterval(() => void reload(), everyMs);
    return () => clearInterval(t);
  }, [reload, everyMs]);
}

/** Dashboard panel: durable-execution infrastructure, workers and recovery diagnostics. */
export function ExecutionPanel() {
  const health = useApi<SystemHealth>("/system/health");
  const metrics = useApi<SystemMetrics>("/system/metrics");
  const diag = useApi<Diagnostics>("/system/diagnostics");
  usePoll(health.reload, 10_000);
  usePoll(diag.reload, 15_000);
  usePoll(metrics.reload, 30_000);
  const h = health.data;

  return (
    <Card data-testid="execution-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Workflow className="size-4 text-primary" /> Execution
        </CardTitle>
        <CardDescription>Where tasks run, and whether anything needs attention.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!h ? (
          <Skeleton className="h-20" />
        ) : (
          <div className="grid gap-2 text-xs">
            <Row icon={<Server />} label="Engine">
              {h.engine === "temporal" ? (
                <Badge variant={h.temporal?.reachable ? "success" : "destructive"} data-testid="engine-badge">
                  Durable · Temporal {h.temporal?.reachable ? "reachable" : "unreachable"}
                </Badge>
              ) : (
                <Badge variant="warning" data-testid="engine-badge">
                  In-process (not durable)
                </Badge>
              )}
            </Row>
            <Row icon={<Cpu />} label="Workers">
              {h.engine === "temporal" ? (
                <Badge variant={h.healthyWorkers > 0 ? "success" : "destructive"} data-testid="worker-badge">
                  {h.healthyWorkers} healthy{h.workers.length > h.healthyWorkers ? ` · ${h.workers.length - h.healthyWorkers} stale` : ""}
                </Badge>
              ) : (
                <span className="text-muted-foreground">runs inside the API</span>
              )}
            </Row>
            <Row icon={<RadioTower />} label="Live events">
              <Badge variant={h.events.listenerConnected ? "success" : h.events.crossInstance ? "destructive" : "secondary"}>
                {h.events.listenerConnected ? "multi-instance" : h.events.crossInstance ? "reconnecting" : "single instance"}
              </Badge>
            </Row>
            {metrics.data ? (
              <Row icon={<Workflow />} label="Retries (7 d)">
                <span className="tabular-nums" data-testid="retry-count">
                  {metrics.data.retries.model} model · {metrics.data.retries.activity} worker step
                </span>
              </Row>
            ) : null}
          </div>
        )}

        {h && h.workers.length > 0 ? (
          <ul className="flex flex-col gap-1 text-[11px]" data-testid="worker-list">
            {h.workers.slice(0, 4).map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`size-1.5 shrink-0 rounded-full ${w.healthy ? "bg-success animate-pulse-dot" : "bg-muted-foreground"}`} />
                  <span className="truncate font-mono">{w.id}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {w.activeActivities} active · {timeAgo(w.lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {metrics.data ? (
          <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
            <Metric label="Queue p50" value={ms(metrics.data.queueLatencyMs.p50)} />
            <Metric label="Run p50" value={ms(metrics.data.runDurationMs.p50)} />
            <Metric label="Model p95" value={ms(Math.max(...metrics.data.modelLatencyMs.map((m) => m.p95 ?? 0), 0) || null)} />
          </div>
        ) : null}

        {diag.data && diag.data.issues.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="diagnostics">
            {diag.data.issues.slice(0, 5).map((i, n) => (
              <li key={n} className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-warning">
                  <AlertTriangle className="size-3.5" /> {i.detail}
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  {i.hint}{" "}
                  {i.taskId ? (
                    <Link className="text-primary hover:underline" href={`/tasks/${i.taskId}`}>
                      Open task
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : diag.data ? (
          <p className="text-xs text-muted-foreground" data-testid="diagnostics-clear">
            No stuck tasks, stale tool calls or missing workers.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border py-1.5">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const WF_VARIANT: Record<string, "success" | "destructive" | "accent" | "secondary" | "warning"> = {
  RUNNING: "accent",
  COMPLETED: "success",
  FAILED: "destructive",
  TERMINATED: "destructive",
  TIMED_OUT: "destructive",
  CANCELLED: "secondary",
  NOT_FOUND: "warning",
};

function WorkflowLine({ label, wf }: { label: string; wf: WorkflowInfo | null }) {
  if (!wf) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <Badge variant={WF_VARIANT[wf.status] ?? "secondary"} data-testid="workflow-status">
          {wf.engine === "temporal" ? wf.status.toLowerCase().replace("_", " ") : "in-process"}
        </Badge>
        {wf.workflowId ? <span className="font-mono text-[10px] text-muted-foreground">{wf.workflowId}</span> : null}
        {wf.historyLength ? <span className="text-[10px] text-muted-foreground">{wf.historyLength} history events</span> : null}
      </div>
      {wf.pendingActivities.map((a, i) => (
        <div key={i} className="ml-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-mono">{a.activityType}</span>
          <Badge variant={a.attempt > 1 ? "warning" : "secondary"}>attempt {a.attempt}</Badge>
          <span className="text-muted-foreground">{a.state.toLowerCase()}</span>
          {a.lastFailure ? <span className="text-destructive">{a.lastFailure}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** Task page panel: the durable execution behind this task and its retry history. */
export function WorkflowPanel({ taskId, status }: { taskId: string; status: string }) {
  const wf = useApi<TaskWorkflow>(`/tasks/${taskId}/workflow`);
  const active = ["queued", "running", "awaiting_approval"].includes(status);
  usePoll(wf.reload, active ? 3_000 : 60_000);
  // Refresh as soon as the task changes state (the workflow closes right after it ends).
  const { reload } = wf;
  useEffect(() => {
    void reload();
    if (active) return;
    const t = setTimeout(() => void reload(), 1_500);
    return () => clearTimeout(t);
  }, [status, active, reload]);
  const d = wf.data;
  if (!d) return <Skeleton className="h-16" />;
  return (
    <Card data-testid="workflow-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Workflow className="size-4 text-primary" /> Execution
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <WorkflowLine label="Task" wf={d.workflow} />
        {d.children.map((c) => (
          <WorkflowLine key={c.taskId} label={`Step ${(c.stepIndex ?? 0) + 1}`} wf={c.workflow} />
        ))}
        {d.retryHistory.length > 0 ? (
          <div className="flex flex-col gap-1" data-testid="retry-history">
            <div className="text-xs text-muted-foreground">Retry history</div>
            {d.retryHistory.map((r) => (
              <div key={r.seq} className="flex flex-wrap items-center gap-2 text-[11px]">
                <Badge variant="warning">{r.type === "activity.retry" ? "worker step" : "model call"}</Badge>
                <span className="font-mono">
                  {r.type === "activity.retry" ? String(r.payload.activity) : `attempt ${String(r.payload.attempt)}`}
                </span>
                {r.type === "activity.retry" ? <span>attempt {String(r.payload.attempt)}</span> : null}
                {r.type === "model.retry" && typeof r.payload.error === "object" && r.payload.error ? (
                  <span className="text-muted-foreground">{String((r.payload.error as { code?: string }).code ?? "")}</span>
                ) : null}
                <span className="text-muted-foreground">{timeAgo(r.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">No retries.</p>
        )}
      </CardContent>
    </Card>
  );
}
