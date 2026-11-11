"use client";

import { Bot, Plus, Wrench } from "lucide-react";
import Link from "next/link";
import { AgentAvatar, EmptyState, ErrorNotice, MockBadge, PageHeader, StatusBadge } from "@/components/common";
import { Badge, Button, Card, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { Agent } from "@/lib/types";
import { formatUsd } from "@/lib/utils";

export default function AgentsPage() {
  const { data, error } = useApi<Agent[]>("/agents");
  return (
    <div>
      <PageHeader
        title="Agents"
        description="Specialised workers with their own model, instructions, tools and limits."
        actions={
          <Button asChild>
            <Link href="/agents/new">
              <Plus /> New agent
            </Link>
          </Button>
        }
      />
      {error ? <ErrorNotice message={error.message} /> : null}
      {!data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <EmptyState icon={<Bot />} title="No agents yet">
          Create an agent, give it a model and a small set of tools, then hand it a task.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="agent-list">
          {data.map((a) => (
            <Link key={a.id} href={`/agents/${a.id}`} className="group">
              <Card className="flex h-full flex-col gap-4 p-5 transition-colors group-hover:border-primary/40">
                <div className="flex items-start gap-3">
                  <AgentAvatar name={a.name} className="size-10" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-medium">{a.name}</h2>
                      {a.activeTasks ? <span className="size-1.5 rounded-full bg-accent animate-pulse-dot" title="Working" /> : null}
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{a.role}</p>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="font-mono">
                    {a.provider}/{a.model}
                  </Badge>
                  {a.isMock ? <MockBadge /> : null}
                  {!a.providerConfigured ? <Badge variant="destructive">provider not configured</Badge> : null}
                </div>
                <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Wrench className="size-3.5" /> {a.allowedTools.length} tools
                  </span>
                  <span>
                    ≤ {a.maxIterations} steps · ≤ {formatUsd(a.maxRunCostUsd)}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
