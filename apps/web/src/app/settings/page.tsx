"use client";

import { CheckCircle2, KeyRound, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorNotice, MockBadge, PageHeader } from "@/components/common";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Skeleton } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Provider, UsageSummary } from "@/lib/types";
import { formatNumber, formatUsd } from "@/lib/utils";

interface Workspace {
  id: string;
  name: string;
  defaultProvider: string | null;
  defaultModel: string | null;
  role: string;
}

const ENV_NAMES: Record<string, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", xai: "XAI_API_KEY", mock: "AGENTOS_ENABLE_MOCK_PROVIDER=true" };

export default function SettingsPage() {
  const providers = useApi<Provider[]>("/providers");
  const usage = useApi<UsageSummary>("/usage/summary");
  const ws = useApi<Workspace>("/workspace");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    try {
      await api.patch("/workspace", { name: f.get("name"), defaultProvider: f.get("defaultProvider") || null });
      setSaved(true);
      await ws.reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Request failed");
    }
  };

  return (
    <div>
      <PageHeader title="Settings" description="Providers, usage and workspace preferences." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>AI providers</CardTitle>
          <CardDescription>Keys live only on the API server (environment variables). They are never stored in the database or sent to the browser.</CardDescription>
        </CardHeader>
        <CardContent>
          {!providers.data ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="grid gap-3 md:grid-cols-2" data-testid="provider-list">
              {providers.data.map((p) => (
                <div key={p.id} className="rounded-lg border border-border p-4" data-provider={p.id} data-configured={p.configured}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-medium">
                      {p.configured ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-muted-foreground" />}
                      {p.label}
                    </div>
                    {p.isMock ? <MockBadge /> : <Badge variant={p.configured ? "success" : "secondary"}>{p.configured ? "Connected" : "Not configured"}</Badge>}
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <KeyRound className="size-3" /> {ENV_NAMES[p.id]}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">{p.models.map((m) => m.label).join(" · ")}</div>
                  {p.configured && !p.isMock ? <div className="mt-2 text-[11px] text-muted-foreground">Key present. A live call has not been verified from this screen.</div> : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Usage and cost</CardTitle>
          <CardDescription>Estimated from provider-reported token counts and the configured price catalog.</CardDescription>
        </CardHeader>
        <CardContent>
          {!usage.data ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-6 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">Spend</div>
                  <div className="text-lg font-semibold tabular-nums">{formatUsd(usage.data.total.costUsd)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Model calls</div>
                  <div className="text-lg font-semibold tabular-nums">{formatNumber(usage.data.total.modelCalls)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Tokens in / out</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {formatNumber(usage.data.total.inputTokens)} / {formatNumber(usage.data.total.outputTokens)}
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 font-medium">Model</th>
                      <th className="py-2 font-medium">Calls</th>
                      <th className="py-2 font-medium">Tokens</th>
                      <th className="py-2 font-medium">Cost</th>
                      <th className="py-2 font-medium">Price data</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {usage.data.byModel.map((m) => (
                      <tr key={`${m.provider}/${m.model}`}>
                        <td className="py-2 font-mono text-xs">
                          {m.provider}/{m.model} {m.isMock ? <MockBadge className="ml-1" /> : null}
                        </td>
                        <td className="py-2 tabular-nums">{m.modelCalls}</td>
                        <td className="py-2 tabular-nums">{formatNumber(m.inputTokens + m.outputTokens)}</td>
                        <td className="py-2 tabular-nums">{formatUsd(m.costUsd)}</td>
                        <td className="py-2 text-xs text-muted-foreground">{m.priceSource}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          {!ws.data ? (
            <Skeleton className="h-24" />
          ) : (
            <form onSubmit={save} className="grid max-w-md gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ws-name">Workspace name</Label>
                <Input id="ws-name" name="name" defaultValue={ws.data.name} disabled={ws.data.role !== "owner"} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ws-provider">Default provider for new agents</Label>
                <Select id="ws-provider" name="defaultProvider" defaultValue={ws.data.defaultProvider ?? ""} disabled={ws.data.role !== "owner"}>
                  <option value="">None</option>
                  {(providers.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
              {error ? <ErrorNotice message={error} /> : null}
              {ws.data.role === "owner" ? (
                <div className="flex items-center gap-3">
                  <Button type="submit">Save</Button>
                  {saved ? <span className="text-xs text-success">Saved</span> : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Only workspace owners can change these settings.</p>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
