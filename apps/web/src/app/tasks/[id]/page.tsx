"use client";

import { ArrowRight, Ban, RotateCcw, ShieldAlert, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, JsonView, MockBadge, StatusBadge } from "@/components/common";
import { EventTimeline } from "@/components/event-timeline";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { api, ApiRequestError, newIdempotencyKey } from "@/lib/api";
import { useApi, useEventStream } from "@/lib/hooks";
import type { Task, TaskDetail } from "@/lib/types";
import { formatNumber, formatUsd } from "@/lib/utils";

const ACTIVE = ["queued", "running", "awaiting_approval"];

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const task = useApi<TaskDetail>(`/tasks/${id}`);
  const [live, setLive] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { events, state } = useEventStream(`/tasks/${id}/events/stream`, {
    onDelta: (e) => setLive((s) => s + String((e.payload as { text: string }).text)),
    onEvent: (e) => {
      // A retry discards the partial text streamed by the failed attempt.
      if (e.type === "model.output" || e.type === "model.retry") setLive("");
      if (["task.status", "tool.completed", "tool.rejected", "approval.required", "approval.decided", "agent.handoff", "run.completed", "run.failed", "run.cancelled"].includes(e.type)) {
        void task.reload();
      }
    },
  });

  const t = task.data;
  if (task.error) return <ErrorNotice message={task.error.message} />;
  if (!t) return <Skeleton className="h-96" />;

  const agentNames = new Map<string, string>();
  for (const r of t.runs) agentNames.set(r.agentId, r.agentName);
  for (const c of [t, ...t.children]) if (c.agent) agentNames.set(c.agent.id, c.agent.name);
  const agentName = (aid: string | null) => (aid ? (agentNames.get(aid) ?? "Agent") : "System");
  const isMock = t.runs.some((r) => r.isMock);
  const totalCost = t.runs.reduce((n, r) => n + r.costUsd, 0);
  const totalTokens = t.runs.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
  const pending = t.approvals.filter((a) => a.status === "pending");

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await task.reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Request failed");
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            <Badge variant="secondary">{t.kind === "pipeline" ? "Two-agent pipeline" : "Single agent"}</Badge>
            {isMock ? <MockBadge /> : t.runs.length ? <Badge variant="success" data-testid="live-badge">Live provider</Badge> : null}
          </div>
          <h1 className="text-xl font-semibold tracking-tight" data-testid="task-title">
            {t.title}
          </h1>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{t.instruction}</p>
          {t.retryOfId ? (
            <Link className="text-xs text-primary hover:underline" href={`/tasks/${t.retryOfId}`}>
              Retry of an earlier task
            </Link>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          {ACTIVE.includes(t.status) ? (
            <Button variant="destructive" onClick={() => void act(() => api.post(`/tasks/${t.id}/cancel`))}>
              <Ban /> Cancel
            </Button>
          ) : null}
          {t.retryable ? (
            <Button
              variant="secondary"
              onClick={() =>
                void act(async () => {
                  const r = await api.post<Task>(`/tasks/${t.id}/retry`, {}, { idempotencyKey: newIdempotencyKey() });
                  router.push(`/tasks/${r.id}`);
                })
              }
            >
              <RotateCcw /> Retry
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorNotice message={error} className="mb-4" /> : null}

      {pending.length ? (
        <Card className="mb-6 border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-warning">
              <ShieldAlert className="size-4" /> Waiting for your approval
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pending.map((a) => (
              <div key={a.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-mono">{a.toolName}</span> · <span className="text-muted-foreground">{a.reason}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="success" onClick={() => void act(() => api.post(`/approvals/${a.id}/decision`, { decision: "approve" }))}>
                    Approve
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void act(() => api.post(`/approvals/${a.id}/decision`, { decision: "reject" }))}>
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {t.result || t.failureMessage || live ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t.result ? "Result" : t.failureMessage ? "Failure" : "Streaming"}</CardTitle>
          </CardHeader>
          <CardContent>
            {t.result ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed" data-testid="task-result">
                {t.result}
              </p>
            ) : t.failureMessage ? (
              <ErrorNotice message={`${t.failureCode}: ${t.failureMessage}`} />
            ) : (
              <p className="whitespace-pre-wrap text-sm" data-testid="task-live">
                {live}
                <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-accent animate-pulse-dot" />
              </p>
            )}
            {t.resultData ? <JsonView value={t.resultData} className="mt-3" /> : null}
          </CardContent>
        </Card>
      ) : null}

      {t.kind === "pipeline" ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col items-stretch gap-3 md:flex-row md:items-center" data-testid="pipeline-steps">
              {(t.pipelineSpec ?? []).map((s, i) => {
                const child = t.children.find((c) => c.stepIndex === i);
                return (
                  <li key={i} className="flex flex-1 items-center gap-3">
                    <div className="flex-1 rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-accent">Step {i + 1}</span>
                        <StatusBadge status={child?.status ?? "queued"} />
                      </div>
                      <div className="mt-1 text-sm font-medium">{agentName(s.agentId)}</div>
                      <div className="text-xs text-muted-foreground">{s.instruction}</div>
                      {child?.handoffInput ? (
                        <div className="mt-2 rounded-md bg-secondary/60 p-2 text-xs text-muted-foreground">
                          Handoff from {child.handoffInput.fromAgentName}: {child.handoffInput.summary.slice(0, 160)}
                        </div>
                      ) : null}
                    </div>
                    {i === 0 ? <ArrowRight className="hidden size-4 text-muted-foreground md:block" /> : null}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5 [&>*]:min-w-0">
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Execution timeline</CardTitle>
            <Badge variant={state === "live" ? "success" : "secondary"} data-testid="stream-state">
              {state}
            </Badge>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? <p className="text-sm text-muted-foreground">Waiting for events…</p> : <EventTimeline events={events} agentName={agentName} compact />}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {t.runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
              {t.runs.map((r) => (
                <div key={r.id} className="rounded-lg border border-border p-3 text-sm" data-testid="run-card">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{r.agentName}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
                    {r.provider}/{r.model}
                    {r.isMock ? <MockBadge /> : <Badge variant="success">LIVE</Badge>}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                    <span>{r.iterations} iterations</span>
                    <span>{formatNumber(r.inputTokens + r.outputTokens)} tok</span>
                    <span title="Estimated from provider-reported tokens and the price catalog">est. {formatUsd(r.costUsd)}</span>
                  </div>
                  {r.failureMessage ? (
                    <p className="mt-2 text-xs text-destructive">
                      {r.failureCode ? <span className="font-mono">{r.failureCode}: </span> : null}
                      {r.failureMessage}
                    </p>
                  ) : null}
                </div>
              ))}
              {t.runs.length ? (
                <div className="text-xs text-muted-foreground">
                  Total: {formatNumber(totalTokens)} tokens · {formatUsd(totalCost)} (estimate)
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tool calls</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3" data-testid="tool-calls">
              {t.runs.flatMap((r) => r.toolCalls).length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
              {t.runs.flatMap((r) =>
                r.toolCalls.map((c) => (
                  <details key={c.id} className="rounded-lg border border-border p-3 text-sm" data-tool={c.toolName} data-status={c.status}>
                    <summary className="flex cursor-pointer items-center gap-2">
                      <Wrench className="size-3.5 text-muted-foreground" />
                      <span className="flex-1 font-mono text-xs">{c.toolName}</span>
                      <StatusBadge status={c.status} />
                    </summary>
                    <div className="mt-2 grid gap-2">
                      <div className="text-xs text-muted-foreground">Arguments</div>
                      <JsonView value={c.arguments} />
                      {c.output ? (
                        <>
                          <div className="text-xs text-muted-foreground">Output (recorded by the server{c.durationMs !== null ? `, ${c.durationMs} ms` : ""})</div>
                          <JsonView value={c.output} />
                        </>
                      ) : null}
                      {c.error ? <p className="text-xs text-destructive">{c.error}</p> : null}
                    </div>
                  </details>
                )),
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
