"use client";

import { ShieldAlert } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { ErrorNotice } from "@/components/common";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { api, ApiRequestError, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Agent, Provider, Skill, ToolInfo } from "@/lib/types";

export function AgentForm({ agent, onSaved }: { agent?: Agent; onSaved: (a: Agent) => void }) {
  const providers = useApi<Provider[]>("/providers");
  const tools = useApi<ToolInfo[]>("/tools");
  const skills = useApi<Skill[]>("/skills");
  const [provider, setProvider] = useState(agent?.provider ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [allowed, setAllowed] = useState<string[]>(agent?.allowedTools ?? ["calculator", "current_datetime"]);
  const [skillIds, setSkillIds] = useState<string[]>(agent?.skills.map((s) => s.id) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idemKey] = useState(newIdempotencyKey);

  const selectedProvider = providers.data?.find((p) => p.id === provider);
  const models = selectedProvider?.models ?? [];
  const latestSkills = useMemo(() => {
    const byName = new Map<string, Skill>();
    for (const s of skills.data ?? []) if (!byName.has(s.name) || byName.get(s.name)!.version < s.version) byName.set(s.name, s);
    return [...byName.values()];
  }, [skills.data]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get("name")),
      role: String(f.get("role")),
      instructions: String(f.get("instructions") ?? ""),
      provider,
      model,
      allowedTools: allowed,
      maxIterations: Number(f.get("maxIterations")),
      maxRunCostUsd: Number(f.get("maxRunCostUsd")),
      maxRunTokens: f.get("maxRunTokens") ? Number(f.get("maxRunTokens")) : null,
      status: String(f.get("status")),
      skillIds,
    };
    setBusy(true);
    setError(null);
    try {
      const saved = agent ? await api.patch<Agent>(`/agents/${agent.id}`, body) : await api.post<Agent>("/agents", body, { idempotencyKey: idemKey });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        const details = Array.isArray(err.details) ? (err.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`).join("; ") : "";
        setError(details ? `${err.message} (${details})` : err.message);
      } else setError("Could not reach the API");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-5" aria-label={agent ? "Edit agent" : "Create agent"}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="name">
          <Input id="name" name="name" required maxLength={60} defaultValue={agent?.name} placeholder="Atlas" />
        </Field>
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={agent?.status ?? "active"}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </Select>
        </Field>
      </div>
      <Field label="Role" htmlFor="role">
        <Input id="role" name="role" required maxLength={200} defaultValue={agent?.role} placeholder="Financial analyst who verifies every number" />
      </Field>
      <Field label="System instructions" htmlFor="instructions">
        <Textarea id="instructions" name="instructions" rows={5} defaultValue={agent?.instructions} placeholder="How this agent should work, what to prioritise, how to format answers." />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="AI provider" htmlFor="provider">
          <Select
            id="provider"
            name="provider"
            required
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(providers.data?.find((p) => p.id === e.target.value)?.models[0]?.id ?? "");
            }}
          >
            <option value="" disabled>
              Select a provider
            </option>
            {(providers.data ?? []).map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.label}
                {p.configured ? "" : " (not configured)"}
              </option>
            ))}
          </Select>
          {selectedProvider?.isMock ? (
            <p className="text-xs text-warning">MOCK provider: a scripted test double, not an AI model. Use it for tests and demos only.</p>
          ) : null}
        </Field>
        <Field label="Model" htmlFor="model">
          <Select id="model" name="model" required value={model} onChange={(e) => setModel(e.target.value)} disabled={!models.length}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · ${m.inputPerMTok}/${m.outputPerMTok} per M tokens
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Allowed tools</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(tools.data ?? []).map((t) => (
            <label key={t.name} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
              <input
                type="checkbox"
                name="tool"
                value={t.name}
                className="mt-0.5 accent-[var(--primary)]"
                checked={allowed.includes(t.name)}
                onChange={(e) => setAllowed((prev) => (e.target.checked ? [...prev, t.name] : prev.filter((x) => x !== t.name)))}
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="font-mono text-xs">{t.name}</span>
                  {t.requiresApproval ? (
                    <Badge variant="warning">
                      <ShieldAlert className="size-3" /> approval
                    </Badge>
                  ) : (
                    <Badge variant="secondary">{t.risk}</Badge>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {latestSkills.length ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Skills (loaded into context as text, never executed)</legend>
          {latestSkills.map((s) => (
            <label key={s.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={skillIds.includes(s.id)}
                onChange={(e) => setSkillIds((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
              />
              <span>
                <span className="text-sm font-medium">
                  {s.name} <span className="text-xs text-muted-foreground">v{s.version}</span>
                </span>
                <span className="block text-xs text-muted-foreground">{s.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Max iterations" htmlFor="maxIterations">
          <Input id="maxIterations" name="maxIterations" type="number" min={1} max={50} required defaultValue={agent?.maxIterations ?? 8} />
        </Field>
        <Field label="Max run cost (USD)" htmlFor="maxRunCostUsd">
          <Input id="maxRunCostUsd" name="maxRunCostUsd" type="number" min={0} max={100} step="0.01" required defaultValue={agent?.maxRunCostUsd ?? 1} />
        </Field>
        <Field label="Max tokens per run (optional)" htmlFor="maxRunTokens">
          <Input id="maxRunTokens" name="maxRunTokens" type="number" min={1000} defaultValue={agent?.maxRunTokens ?? ""} />
        </Field>
      </div>

      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || !provider || !model}>
          {busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
