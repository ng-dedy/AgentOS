"use client";

import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, ErrorNotice, JsonView, PageHeader, StatusBadge } from "@/components/common";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Skeleton } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { useApi, useEventStream } from "@/lib/hooks";
import type { Approval, AuditEntry } from "@/lib/types";
import { timeAgo } from "@/lib/utils";

export default function ApprovalsPage() {
  const pending = useApi<Approval[]>("/approvals?status=pending");
  const history = useApi<Approval[]>("/approvals");
  const audit = useApi<AuditEntry[]>("/audit");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEventStream("/events/stream", {
    onEvent: (e) => {
      if (e.type === "approval.required" || e.type === "approval.decided") {
        void pending.reload();
        void history.reload();
      }
    },
  });

  const decide = async (a: Approval, decision: "approve" | "reject") => {
    setError(null);
    try {
      await api.post(`/approvals/${a.id}/decision`, { decision, note: notes[a.id] || undefined });
      await Promise.all([pending.reload(), history.reload(), audit.reload()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Request failed");
    }
  };

  return (
    <div>
      <PageHeader title="Approvals" description="Sensitive tool calls pause here until a person decides. Agents cannot approve their own actions." />
      {error ? <ErrorNotice message={error} className="mb-4" /> : null}

      {!pending.data ? (
        <Skeleton className="h-32" />
      ) : pending.data.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title="Nothing waiting for approval" />
      ) : (
        <div className="grid gap-4" data-testid="pending-approvals">
          {pending.data.map((a) => (
            <Card key={a.id} className="border-warning/40">
              <CardContent className="grid gap-3 pt-5 md:grid-cols-[1fr_280px]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{a.toolName}</span>
                    {a.risk ? <Badge variant="warning">{a.risk}</Badge> : null}
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Requested by <span className="text-foreground">{a.agent.name}</span> in{" "}
                    <Link className="text-primary hover:underline" href={`/tasks/${a.task.rootTaskId}`}>
                      {a.task.title}
                    </Link>{" "}
                    · {timeAgo(a.createdAt)}
                  </p>
                  <p className="mt-2 text-sm">{a.reason}</p>
                  <JsonView value={a.arguments} className="mt-2" />
                </div>
                <div className="flex flex-col gap-2">
                  <Input placeholder="Note (optional)" value={notes[a.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))} aria-label="Decision note" />
                  <Button variant="success" onClick={() => void decide(a, "approve")}>
                    Approve
                  </Button>
                  <Button variant="destructive" onClick={() => void decide(a, "reject")}>
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Decision history</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y divide-border">
              {(history.data ?? [])
                .filter((a) => a.status !== "pending")
                .map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono">{a.toolName}</span> <span className="text-muted-foreground">by {a.agent.name}</span>
                      {a.decisionNote ? <span className="text-muted-foreground"> · “{a.decisionNote}”</span> : null}
                    </span>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="max-h-96 divide-y divide-border overflow-y-auto" data-testid="audit-log">
              {(audit.data ?? []).map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-2 text-sm">
                  <span className="font-mono text-xs text-accent">{e.action}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.actor}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{timeAgo(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
