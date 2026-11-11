"use client";

import { ListChecks, Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { EmptyState, ErrorNotice, PageHeader, StatusBadge } from "@/components/common";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Skeleton, Textarea } from "@/components/ui";
import { api, ApiRequestError, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Agent, Task } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

const FILTERS = ["all", "running", "awaiting_approval", "completed", "failed", "cancelled"] as const;

function TasksInner() {
  const params = useSearchParams();
  const [showForm, setShowForm] = useState(params.get("new") === "1");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const tasks = useApi<Task[]>(`/tasks${filter === "all" ? "" : `?status=${filter}`}`);

  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Work assigned to one agent, or a two-step pipeline with an explicit handoff."
        actions={
          <Button onClick={() => setShowForm((v) => !v)}>
            <Plus /> {showForm ? "Close" : "New task"}
          </Button>
        }
      />
      {showForm ? <NewTaskForm defaultAgentId={params.get("agentId") ?? undefined} /> : null}

      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter tasks">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn("rounded-md px-2.5 py-1 text-xs capitalize", filter === f ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary")}
          >
            {f.replace("_", " ")}
          </button>
        ))}
      </div>

      {tasks.error ? <ErrorNotice message={tasks.error.message} /> : null}
      {!tasks.data ? (
        <Skeleton className="h-48" />
      ) : tasks.data.length === 0 ? (
        <EmptyState icon={<ListChecks />} title="No tasks" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border" data-testid="task-list">
            {tasks.data.map((t) => (
              <li key={t.id}>
                <Link href={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/40">
                  {t.kind === "pipeline" ? <Workflow className="size-4 text-accent" aria-label="Pipeline" /> : <ListChecks className="size-4 text-muted-foreground" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.kind === "pipeline" ? "Two-agent pipeline" : t.agent?.name} · {timeAgo(t.createdAt)}
                      {t.failureMessage ? ` · ${t.failureMessage}` : ""}
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function NewTaskForm({ defaultAgentId }: { defaultAgentId?: string }) {
  const agents = useApi<Agent[]>("/agents");
  const router = useRouter();
  const [kind, setKind] = useState<"single" | "pipeline">("single");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idemKey] = useState(newIdempotencyKey);
  const usable = (agents.data ?? []).filter((a) => a.status === "active");

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body =
      kind === "single"
        ? { kind, title: f.get("title"), instruction: f.get("instruction"), agentId: f.get("agentId") }
        : {
            kind,
            title: f.get("title"),
            instruction: f.get("instruction"),
            steps: [
              { agentId: f.get("agent1"), instruction: f.get("step1") },
              { agentId: f.get("agent2"), instruction: f.get("step2") },
            ],
          };
    setBusy(true);
    setError(null);
    try {
      const t = await api.post<Task>("/tasks", body, { idempotencyKey: idemKey });
      router.push(`/tasks/${t.id}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reach the API");
      setBusy(false);
    }
  };

  const agentSelect = (name: string, label: string, def?: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Select id={name} name={name} required defaultValue={def ?? ""}>
        <option value="" disabled>
          Choose an agent
        </option>
        {usable.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.provider}/{a.model}
            {a.isMock ? ", MOCK" : ""}
            {a.providerConfigured ? "" : ", not configured"})
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>New task</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4" aria-label="Create task">
          <div className="flex gap-1.5" role="radiogroup" aria-label="Task type">
            {(["single", "pipeline"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn("rounded-md border px-3 py-1.5 text-xs", kind === k ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground")}
              >
                {k === "single" ? "Single agent" : "Two-agent pipeline"}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" name="title" required maxLength={200} placeholder="Quarterly revenue check" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="instruction">Instruction</Label>
            <Textarea id="instruction" name="instruction" required rows={3} placeholder="What is (17 * 23) + 4? Use the calculator." />
          </div>
          {kind === "single" ? (
            agentSelect("agentId", "Agent", defaultAgentId)
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-3 rounded-lg border border-border p-3">
                <div className="text-xs font-semibold text-accent">Step 1</div>
                {agentSelect("agent1", "Agent", defaultAgentId)}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="step1">Step instruction</Label>
                  <Input id="step1" name="step1" required placeholder="Compute 1250 * 12" />
                </div>
              </div>
              <div className="grid gap-3 rounded-lg border border-border p-3">
                <div className="text-xs font-semibold text-accent">Step 2 (receives step 1&apos;s output)</div>
                {agentSelect("agent2", "Agent")}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="step2">Step instruction</Label>
                  <Input id="step2" name="step2" required placeholder="Summarise the figure for leadership" />
                </div>
              </div>
            </div>
          )}
          {error ? <ErrorNotice message={error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              {busy ? "Starting…" : "Start task"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksInner />
    </Suspense>
  );
}
