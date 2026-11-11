"use client";

import { Bot, CheckCircle2, LayoutDashboard, ListChecks, LogOut, Menu, Settings, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth";
import { Button, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/settings", label: "Settings", icon: Settings },
];

function usePendingApprovals(enabled: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.get<{ pendingApprovals: number }>("/dashboard");
        if (!stop) setN(d.pendingApprovals);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [enabled]);
  return n;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { me, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const pending = usePendingApprovals(!!me);

  useEffect(() => setOpen(false), [pathname]);

  if (pathname === "/login") return <>{children}</>;
  if (loading || !me) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Skeleton className="h-8 w-40" />
      </div>
    );
  }

  const nav = (
    <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Icon className={cn("size-4", active ? "text-primary" : "")} aria-hidden />
            <span className="flex-1">{label}</span>
            {href === "/approvals" && pending > 0 ? (
              <span className="rounded-full bg-warning/20 px-1.5 text-[10px] font-semibold text-warning" data-testid="pending-count">
                {pending}
              </span>
            ) : null}
            {active ? <span className="h-4 w-0.5 rounded-full bg-primary" aria-hidden /> : null}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-2">
      <div className="flex size-8 items-center justify-center rounded-lg border border-primary/40 bg-primary/10">
        <CheckCircle2 className="size-4 text-accent" aria-hidden />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight">AgentOS</div>
        <div className="text-[11px] text-muted-foreground">{me.organization.name}</div>
      </div>
    </div>
  );

  const footer = (
    <div className="border-t border-border pt-3">
      <div className="truncate px-2 text-xs text-muted-foreground">{me.user.email}</div>
      <Button variant="ghost" size="sm" className="mt-1 w-full justify-start text-muted-foreground" onClick={() => void logout()}>
        <LogOut aria-hidden /> Sign out
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r border-border bg-sidebar p-4 lg:flex">
        {brand}
        {nav}
        {footer}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-sidebar/90 px-4 py-3 backdrop-blur lg:hidden">
          {brand}
          <Button variant="ghost" size="icon" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((v) => !v)}>
            {open ? <X /> : <Menu />}
          </Button>
        </header>
        {open ? (
          <div className="fixed inset-0 top-[57px] z-10 flex flex-col gap-4 bg-sidebar p-4 animate-fade-in lg:hidden">
            {nav}
            {footer}
          </div>
        ) : null}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
