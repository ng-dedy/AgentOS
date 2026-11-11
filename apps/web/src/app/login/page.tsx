"use client";

import { CheckCircle2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth";
import { ErrorNotice } from "@/components/common";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";

function LoginForm() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await api.post("/auth/login", { email: f.get("email"), password: f.get("password") });
      } else {
        await api.post("/auth/signup", {
          email: f.get("email"),
          password: f.get("password"),
          name: f.get("name"),
          organizationName: f.get("organizationName"),
        });
      }
      await refresh();
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reach the API");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl border border-primary/40 bg-primary/10">
            <CheckCircle2 className="size-5 text-accent" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">AgentOS</h1>
            <p className="text-sm text-muted-foreground">{mode === "login" ? "Sign in to your workspace" : "Create a workspace"}</p>
          </div>
        </div>
        <Card>
          <CardContent className="pt-5">
            <form onSubmit={submit} className="flex flex-col gap-4">
              {mode === "signup" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="name">Your name</Label>
                    <Input id="name" name="name" required autoComplete="name" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="organizationName">Workspace name</Label>
                    <Input id="organizationName" name="organizationName" required />
                  </div>
                </>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required autoComplete="email" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={mode === "signup" ? 10 : 1}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                />
              </div>
              {error ? <ErrorNotice message={error} /> : null}
              <Button type="submit" disabled={busy}>
                {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create workspace"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === "login" ? "New here?" : "Already have an account?"}{" "}
          <button type="button" className="text-primary hover:underline" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
            {mode === "login" ? "Create a workspace" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
