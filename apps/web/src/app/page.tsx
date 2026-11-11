"use client";

import { Activity, Bot, CheckCircle2, CircleDollarSign, Plus, ShieldAlert, XCircle } from "lucide-react";
import Link from "next/link";
import { AgentAvatar, EmptyState, MockBadge, PageHeader, Stat, StatusBadge } from "@/components/common";
import { eventSummary } from "@/components/event-timeline";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { useApi, useEventStream } from "@/lib/hooks";
import type { Agent, Dashboard, Task } from "@/lib/types";
import { formatNumber, formatUsd, timeAgo } from "@/lib/utils";

export default function DashboardPage() {
  const dash = useApi<Dashboard>("/dashboard");
  const agents = useApi<Agent[]>("/agents");
  const tasks = useApi<Task[]>("/tasks?limit=8");
  const { events, state } = useEventStream("/events/stream", {
    onEvent: (e) => {
      if (["task.status", "task.created", "approval.required", "approval.decided", "usage.recorded"].includes(e.type)) {
        void dash.reload();
        void tasks.reload();
        void agents.reload();
      }
    },
  });
  const agentName = (id: string | null) => agents.data?.find((a) => a.id === id)?.name ?? "Agent";
  const feed = events
    .filter((e) => !["usage.recorded", "task.status", "model.output", "tool.requested"].includes(e.type))
    .slice(-12)
    .reverse();

  return (
    <div>
      <PageHeader
        title="Command center"
        description="Agents, live activity and spend across your workspace."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/agents/new">
                <Plus /> New agent
              </Link>
            </Button>
            <Button asChild>
              <Link href="/tasks?new=1">
                <Plus /> New task
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {dash.data ? (
          <>
            <Stat label="Agents" value={dash.data.agents} icon={<Bot />} />
            <Stat label="Active tasks" value={dash.data.tasks.active} icon={<Activity />} hint={dash.data.pendingApprovals ? `${dash.data.pendingApprovals} awaiting approval` : "none waiting"} />
            <Stat label="Completed" value={dash.data.tasks.completed} icon={<CheckCircle2 />} />
            <Stat label="Failed" value={dash.data.tasks.failed} icon={<XCircle />} hint={dash.data.tasks.cancelled ? `${dash.data.tasks.cancelled} cancelled` : undefined} />
            <Stat
              label="Estimated spend"
              value={formatUsd(dash.data.usage.costUsd)}
              icon={<CircleDollarSign />}
              hint={`${formatNumber(dash.data.usage.inputTokens + dash.data.usage.outputTokens)} tokens · ${dash.data.usage.live.modelCalls} live / ${dash.data.usage.mock.modelCalls} mock calls`}
            />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-24" />)
        )}
      </div>

      {dash.data ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="provider-strip">
          <span>Providers:</span>
          {dash.data.providers.map((p) =>
            p.isMock ? (
              <MockBadge key={p.id} />
            ) : (
              <Badge key={p.id} variant={p.configured ? "success" : "secondary"} data-provider={p.id}>
                {p.label}: {p.configured ? "key set" : "not configured"}
              </Badge>
            ),
          )}
          <Link href="/settings" className="text-primary hover:underline">
            Check accounts
          </Link>
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-5 [&>*]:min-w-0">
        <div className="flex flex-col gap-6 lg:col-span-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Agents</CardTitle>
              <Link href="/agents" className="text-xs text-primary hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent>
              {agents.data && agents.data.length === 0 ? (
                <EmptyState icon={<Bot />} title="No agents yet">
                  <Link className="text-primary hover:underline" href="/agents/new">
                    Create your first agent
                  </Link>
                </EmptyState>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(agents.data ?? []).slice(0, 6).map((a) => (
                    <Link key={a.id} href={`/agents/${a.id}`} className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40 hover:bg-secondary/50">
                      <AgentAvatar name={a.name} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{a.name}</span>
                          {a.activeTasks ? <span className="size-1.5 rounded-full bg-accent animate-pulse-dot" title="Working" /> : null}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{a.role}</div>
                      </div>
                      {a.isMock ? <MockBadge /> : <StatusBadge status={a.status} />}
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Recent tasks</CardTitle>
              <Link href="/tasks" className="text-xs text-primary hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent className="px-0">
              {tasks.data && tasks.data.length === 0 ? (
                <div className="px-5">
                  <EmptyState title="No tasks yet" />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {(tasks.data ?? []).map((t) => (
                    <li key={t.id}>
                      <Link href={`/tasks/${t.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-secondary/40">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{t.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {t.kind === "pipeline" ? "Pipeline" : (t.agent?.name ?? "")} · {timeAgo(t.createdAt)}
                          </div>
                        </div>
                        <StatusBadge status={t.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Live activity</CardTitle>
            <Badge variant={state === "live" ? "success" : "secondary"} data-testid="stream-state">
              {state === "live" ? <span className="size-1.5 rounded-full bg-current animate-pulse-dot" /> : null}
              {state}
            </Badge>
          </CardHeader>
          <CardContent>
            {feed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Activity appears here as agents work.</p>
            ) : (
              <ul className="flex flex-col gap-2.5" data-testid="activity-feed">
                {feed.map((e) => (
                  <li key={e.seq} className="flex items-start gap-2 text-sm animate-fade-in">
                    {e.type === "approval.required" ? (
                      <ShieldAlert className="mt-0.5 size-3.5 text-warning" />
                    ) : (
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/70" />
                    )}
                    <Link href={`/tasks/${e.rootTaskId}`} className="min-w-0 flex-1 break-words hover:underline">
                      <span className="font-medium">{agentName(e.agentId)}</span> <span className="text-muted-foreground">{eventSummary(e)}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{timeAgo(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
