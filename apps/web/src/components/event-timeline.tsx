"use client";

import {
  ArrowRightLeft,
  Ban,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  CircleSlash,
  Hand,
  PlayCircle,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type { RunEvent } from "@/lib/types";
import { cn, formatUsd } from "@/lib/utils";
import { JsonView } from "./common";

interface Described {
  icon: ReactNode;
  title: string;
  tone: "default" | "success" | "warning" | "destructive" | "accent" | "muted";
  body?: ReactNode;
}

function describe(e: RunEvent, agentName: (id: string | null) => string): Described {
  const p = e.payload as Record<string, unknown>;
  const who = agentName(e.agentId);
  switch (e.type) {
    case "task.created":
      return { icon: <Sparkles />, title: `Task created${p.stepIndex !== undefined ? ` (step ${Number(p.stepIndex) + 1})` : ""}`, tone: "muted" };
    case "task.status":
      return { icon: <CircleSlash />, title: `Status → ${String(p.status).replace("_", " ")}`, tone: "muted" };
    case "run.started":
      return { icon: <PlayCircle />, title: `${who} started on ${String(p.provider)} · ${String(p.model)}${p.isMock ? " (MOCK)" : ""}`, tone: "accent" };
    case "model.output": {
      const calls = (p.toolCalls as { name: string }[] | undefined) ?? [];
      return {
        icon: <Bot />,
        title: calls.length ? `${who} requested ${calls.map((c) => c.name).join(", ")}` : `${who} responded`,
        tone: "default",
        body: p.text ? <p className="whitespace-pre-wrap text-sm text-foreground/90">{String(p.text)}</p> : undefined,
      };
    }
    case "tool.requested":
      return { icon: <Wrench />, title: `Tool requested: ${String(p.toolName)}`, tone: "muted", body: <JsonView value={p.arguments} /> };
    case "tool.completed":
      return {
        icon: <CheckCircle2 />,
        title: `Tool executed on server: ${String(p.toolName)} (${String(p.durationMs)} ms)`,
        tone: "success",
        body: <JsonView value={p.output} />,
      };
    case "tool.failed":
      return { icon: <XCircle />, title: `Tool failed: ${String(p.toolName)}`, tone: "destructive", body: <p className="text-sm">{String(p.reason)}</p> };
    case "tool.rejected":
      return { icon: <Ban />, title: `Tool blocked: ${String(p.toolName)}`, tone: "destructive", body: <p className="text-sm">{String(p.reason)}</p> };
    case "approval.required":
      return {
        icon: <ShieldAlert />,
        title: `Approval required for ${String(p.toolName)}`,
        tone: "warning",
        body: (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{String(p.reason)}</p>
            <JsonView value={p.arguments} />
          </div>
        ),
      };
    case "approval.decided":
      return { icon: p.decision === "approved" ? <ShieldCheck /> : <Hand />, title: `Approval ${String(p.decision)}${p.note ? `: ${String(p.note)}` : ""}`, tone: p.decision === "approved" ? "success" : "destructive" };
    case "agent.handoff":
      return {
        icon: <ArrowRightLeft />,
        title: `Handoff from ${String(p.fromAgentName)} to next agent`,
        tone: "accent",
        body: <p className="text-sm text-muted-foreground">{String(p.summary)}</p>,
      };
    case "usage.recorded":
      return {
        icon: <CircleDollarSign />,
        title: `Usage: ${String(p.inputTokens)} in / ${String(p.outputTokens)} out · ${formatUsd(Number(p.costUsd))} (run ${formatUsd(Number(p.runCostUsd))})`,
        tone: "muted",
      };
    case "run.completed":
      return { icon: <CheckCircle2 />, title: `Run completed`, tone: "success" };
    case "run.failed":
      return { icon: <XCircle />, title: `Run failed: ${String(p.failureCode)}`, tone: "destructive", body: <p className="text-sm">{String(p.message)}</p> };
    case "run.cancelled":
      return { icon: <Ban />, title: "Run cancelled", tone: "muted" };
    default:
      return { icon: <Sparkles />, title: e.type, tone: "muted" };
  }
}

const TONE: Record<Described["tone"], string> = {
  default: "text-primary border-primary/30 bg-primary/10",
  accent: "text-accent border-accent/30 bg-accent/10",
  success: "text-success border-success/30 bg-success/10",
  warning: "text-warning border-warning/30 bg-warning/10",
  destructive: "text-destructive border-destructive/30 bg-destructive/10",
  muted: "text-muted-foreground border-border bg-secondary",
};

export function EventTimeline({ events, agentName, compact = false }: { events: RunEvent[]; agentName: (id: string | null) => string; compact?: boolean }) {
  const visible = compact ? events.filter((e) => e.type !== "usage.recorded" && e.type !== "task.status") : events;
  return (
    <ol className="relative flex flex-col gap-3" data-testid="event-timeline">
      {visible.map((e) => {
        const d = describe(e, agentName);
        return (
          <li key={e.seq ?? `${e.type}-${e.createdAt}`} className="flex gap-3 animate-fade-in" data-event-type={e.type}>
            <div className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border [&_svg]:size-3.5", TONE[d.tone])}>{d.icon}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm font-medium">{d.title}</span>
                <time className="font-mono text-[10px] text-muted-foreground" dateTime={e.createdAt}>
                  #{e.seq} · {new Date(e.createdAt).toLocaleTimeString()}
                </time>
              </div>
              {d.body ? <div className="mt-1.5">{d.body}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function eventSummary(e: RunEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "tool.completed":
      return `ran ${String(p.toolName)}`;
    case "approval.required":
      return `needs approval for ${String(p.toolName)}`;
    case "run.completed":
      return "completed a run";
    case "run.failed":
      return `failed (${String(p.failureCode)})`;
    case "agent.handoff":
      return `handed off from ${String(p.fromAgentName)}`;
    case "task.created":
      return `created ${String(p.kind)} task “${String(p.title)}”`;
    case "run.started":
      return "started a run";
    default:
      return e.type;
  }
}
