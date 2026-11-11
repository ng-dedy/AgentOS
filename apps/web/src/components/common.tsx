"use client";

import { AlertTriangle, FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "success" | "warning" | "destructive" | "accent"; live?: boolean }> = {
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "accent", live: true },
  awaiting_approval: { label: "Needs approval", variant: "warning", live: true },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
  skipped: { label: "Skipped", variant: "secondary" },
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "secondary" },
  pending: { label: "Pending", variant: "warning", live: true },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  succeeded: { label: "Succeeded", variant: "success" },
  invalid: { label: "Invalid args", variant: "destructive" },
  approval_rejected: { label: "Rejected by reviewer", variant: "destructive" },
  requested: { label: "Requested", variant: "secondary" },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = STATUS[status] ?? { label: status, variant: "secondary" as const };
  return (
    <Badge variant={s.variant} className={className} data-status={status}>
      {s.live ? <span className="size-1.5 rounded-full bg-current animate-pulse-dot" aria-hidden /> : null}
      {s.label}
    </Badge>
  );
}

/** Shown wherever output comes from the scripted mock provider. Never hidden. */
export function MockBadge({ className }: { className?: string }) {
  return (
    <Badge variant="mock" className={className} title="Scripted test double. Not an AI model. Output is deterministic and derived from real tool results.">
      <FlaskConical className="size-3" aria-hidden />
      Mock provider
    </Badge>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      {icon ? <div className="text-muted-foreground [&_svg]:size-6">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function ErrorNotice({ message, className }: { message: string; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive", className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-64 overflow-auto rounded-md border border-border bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function AgentAvatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  let hue = 0;
  for (const c of name) hue = (hue * 31 + c.charCodeAt(0)) % 60;
  return (
    <div
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 text-xs font-semibold text-primary", className)}
      style={{ background: `linear-gradient(135deg, oklch(0.32 0.08 ${200 + hue}), oklch(0.22 0.05 ${230 + hue}))` }}
      aria-hidden
    >
      {initials}
    </div>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        {icon ? <span className="[&_svg]:size-4">{icon}</span> : null}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
