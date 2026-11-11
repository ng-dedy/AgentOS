"use client";

import { MessageSquare, Pencil, Play } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AgentForm } from "@/components/agent-form";
import { AgentAvatar, ErrorNotice, MockBadge, PageHeader, Stat, StatusBadge } from "@/components/common";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { AgentDetail } from "@/lib/types";
import { formatNumber, formatUsd, timeAgo } from "@/lib/utils";

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agent, error, reload } = useApi<AgentDetail>(`/agents/${id}`);
  const [editing, setEditing] = useState(false);

  if (error) return <ErrorNotice message={error.message} />;
  if (!agent) return <Skeleton className="h-64" />;

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <AgentAvatar name={agent.name} className="size-12 text-sm" />
        <div className="min-w-0 flex-1">
          <PageHeader title={agent.name} description={agent.role} />
        </div>
        <div className="flex flex-wrap gap-2 sm:-mt-6">
          <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
            <Pencil /> {editing ? "Close editor" : "Edit"}
          </Button>
          <Button variant="secondary" asChild>
            <Link href={`/agents/${agent.id}/chat`}>
              <MessageSquare /> Chat
            </Link>
          </Button>
          <Button asChild>
            <Link href={`/tasks?new=1&agentId=${agent.id}`}>
              <Play /> Assign task
            </Link>
          </Button>
        </div>
      </div>

      {editing ? (
        <Card className="mb-6">
          <CardContent className="pt-5">
            <AgentForm
              agent={agent}
              onSaved={() => {
                setEditing(false);
                void reload();
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Model calls" value={formatNumber(agent.usage.modelCalls)} />
        <Stat label="Tokens" value={formatNumber(agent.usage.inputTokens + agent.usage.outputTokens)} />
        <Stat label="Estimated spend" value={formatUsd(agent.usage.costUsd)} />
        <Stat label="Limits per run" value={`${agent.maxIterations} steps`} hint={`${formatUsd(agent.maxRunCostUsd)}${agent.maxRunTokens ? ` · ${formatNumber(agent.maxRunTokens)} tokens` : ""}`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={agent.status} />
              <Badge variant="secondary" className="font-mono" data-testid="agent-model">
                {agent.provider}/{agent.model}
              </Badge>
              {agent.isMock ? <MockBadge /> : null}
              {!agent.providerConfigured ? <Badge variant="destructive">Provider not configured</Badge> : null}
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">System instructions</div>
              <p className="whitespace-pre-wrap rounded-md border border-border bg-background/60 p-3 text-sm">{agent.instructions || "None"}</p>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Allowed tools</div>
              <div className="flex flex-wrap gap-1.5">
                {agent.allowedTools.length ? agent.allowedTools.map((t) => <Badge key={t} variant="accent" className="font-mono">{t}</Badge>) : <span className="text-muted-foreground">No tools</span>}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Skills</div>
              <div className="flex flex-wrap gap-1.5">
                {agent.skills.length ? agent.skills.map((s) => <Badge key={s.id} variant="secondary">{s.name} v{s.version}</Badge>) : <span className="text-muted-foreground">No skills</span>}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent tasks</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {agent.recentTasks.length === 0 ? (
              <p className="px-5 text-sm text-muted-foreground">No tasks yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {agent.recentTasks.map((t) => (
                  <li key={t.id}>
                    <Link href={`/tasks/${t.id}`} className="flex items-center gap-2 px-5 py-2.5 hover:bg-secondary/40">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{t.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {t.kind} · {timeAgo(t.createdAt)}
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
    </div>
  );
}
