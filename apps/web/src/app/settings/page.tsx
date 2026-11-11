"use client";

import { CheckCircle2, KeyRound, Lock, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorNotice, MockBadge, PageHeader } from "@/components/common";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Skeleton } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { CredentialsResponse, ModelDiscovery, Provider, UsageSummary } from "@/lib/types";
import { formatNumber, formatUsd } from "@/lib/utils";

interface Workspace {
  id: string;
  name: string;
  defaultProvider: string | null;
  defaultModel: string | null;
  role: string;
}

const ENV_NAMES: Record<string, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", xai: "XAI_API_KEY" };

export default function SettingsPage() {
  const providers = useApi<Provider[]>("/providers");
  const usage = useApi<UsageSummary>("/usage/summary");
  const ws = useApi<Workspace>("/workspace");
  const creds = useApi<CredentialsResponse>("/credentials");
  const refresh = async () => {
    await Promise.all([providers.reload(), creds.reload()]);
  };
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
          <CardDescription>
            Each workspace uses its own provider keys. Keys are encrypted at rest (AES-256-GCM envelope encryption), are write-only, and are never sent back to the
            browser: only the last four characters are shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {creds.data ? (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="credential-storage">
              <Lock className="size-3.5" />
              {creds.data.storage.enabled ? (
                <>
                  Encrypted with <span className="font-mono">{creds.data.storage.kms}</span>
                  {creds.data.storage.developmentOnly ? <Badge variant="warning">development KMS, not for production</Badge> : null}
                </>
              ) : (
                <Badge variant="destructive">Credential storage is not configured on this server</Badge>
              )}
              {creds.data.allowDeploymentKeys ? <Badge variant="secondary">deployment keys allowed as fallback</Badge> : null}
            </div>
          ) : null}
          {!providers.data ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="grid gap-3 md:grid-cols-2" data-testid="provider-list">
              {providers.data.map((p) => (
                <ProviderCard key={p.id} provider={p} isOwner={ws.data?.role === "owner"} storageEnabled={creds.data?.storage.enabled ?? false} onChanged={refresh} />
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

const PRICE_LABEL: Record<string, string> = { published: "published price", unverified: "unverified price", mock: "mock" };

function ProviderCard({ provider: p, isOwner, storageEnabled, onChanged }: { provider: Provider; isOwner: boolean; storageEnabled: boolean; onChanged: () => Promise<void> }) {
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(p.discovery);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setDiscovery(await api.get<ModelDiscovery>(`/providers/${p.id}/models?refresh=1`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Request failed");
    } finally {
      setChecking(false);
    }
  };
  const avail = new Map((discovery?.catalog ?? []).map((m) => [m.id, m.availableOnAccount]));
  return (
    <div className="min-w-0 rounded-lg border border-border p-4" data-provider={p.id} data-configured={p.configured}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          {p.configured ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-muted-foreground" />}
          {p.label}
        </div>
        {p.isMock ? (
          <MockBadge />
        ) : (
          <Badge variant={!p.configured ? "secondary" : discovery?.ok ? "success" : discovery ? "destructive" : "secondary"} data-testid="provider-status">
            {!p.configured ? "Not configured" : discovery?.ok ? "Live: account verified" : discovery ? "Key rejected or unreachable" : "Key set, not checked"}
          </Badge>
        )}
      </div>
      {!p.isMock ? <CredentialRow provider={p} isOwner={isOwner} storageEnabled={storageEnabled} onChanged={onChanged} /> : null}
      {p.endpoint ? <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Endpoint: {p.endpoint}</div> : null}
      <ul className="mt-2 flex flex-col gap-1 text-xs">
        {p.models.map((m) => {
          const a = avail.get(m.id);
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-x-2" data-model={m.id}>
              <span>{m.label}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{m.id}</span>
              <span className="text-[10px] text-muted-foreground">
                ${m.inputPerMTok}/${m.outputPerMTok} per M · {PRICE_LABEL[m.priceSource] ?? m.priceSource}
              </span>
              {a === true ? <Badge variant="success">on account</Badge> : a === false ? <Badge variant="destructive">not on account</Badge> : null}
            </li>
          );
        })}
      </ul>
      {!p.isMock && p.configured ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void check()} disabled={checking}>
            <RefreshCw className={checking ? "animate-spin" : undefined} /> Check account
          </Button>
          {discovery ? (
            <span className="text-[11px] text-muted-foreground">
              {discovery.ok ? `Models API listed ${discovery.listedCount} models` : `${discovery.error?.code ?? "error"}: ${discovery.error?.message ?? ""}`} ·{" "}
              {new Date(discovery.checkedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? <ErrorNotice message={error} className="mt-2" /> : null}
    </div>
  );
}

function CredentialRow({ provider: p, isOwner, storageEnabled, onChanged }: { provider: Provider; isOwner: boolean; storageEnabled: boolean; onChanged: () => Promise<void> }) {
  const c = p.credential;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      await onChanged();
      if (done) setNote(done);
      return true;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const apiKey = String(new FormData(form).get("apiKey") ?? "");
    const ok = await run(() => api.put(`/credentials/${p.id}`, { apiKey }), "Saved and checked");
    if (ok) {
      form.reset();
      setEditing(false);
    }
  };

  const source =
    c?.source === "organization" ? (
      <Badge variant={c.status === "valid" ? "success" : c.status === "invalid" ? "destructive" : "secondary"} data-testid="credential-source">
        Workspace key ••••{c.keyHint ?? ""} · {c.status === "valid" ? "verified" : c.status === "invalid" ? "rejected" : "not verified"}
      </Badge>
    ) : c?.source === "deployment" ? (
      <Badge variant="warning" data-testid="credential-source">
        Deployment key ({ENV_NAMES[p.id]})
      </Badge>
    ) : (
      <Badge variant="secondary" data-testid="credential-source">
        No key
      </Badge>
    );

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="credential-row">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <KeyRound className="size-3" /> {source}
        {c?.lastVerifyError ? <span className="text-destructive">{c.lastVerifyError}</span> : null}
      </div>
      {isOwner && storageEnabled ? (
        editing ? (
          <form onSubmit={save} className="flex flex-wrap items-center gap-2">
            <Input
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`${p.label} API key`}
              aria-label={`${p.label} API key`}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              required
              minLength={8}
            />
            <Button size="sm" type="submit" disabled={busy}>
              Save and verify
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-testid="credential-edit">
              <KeyRound /> {c?.source === "organization" ? "Replace key" : "Add key"}
            </Button>
            {c?.source === "organization" ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.post(`/credentials/${p.id}/verify`), "Checked")}>
                  <RefreshCw className={busy ? "animate-spin" : undefined} /> Verify
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove the ${p.label} key for this workspace? Agents using ${p.label} will stop working.`)) void run(() => api.delete(`/credentials/${p.id}`), "Removed");
                  }}
                >
                  <Trash2 /> Remove
                </Button>
              </>
            ) : null}
          </div>
        )
      ) : !isOwner ? (
        <p className="text-[11px] text-muted-foreground">Only workspace owners can manage keys.</p>
      ) : null}
      {note ? <span className="text-[11px] text-success">{note}</span> : null}
      {error ? <ErrorNotice message={error} /> : null}
    </div>
  );
}
