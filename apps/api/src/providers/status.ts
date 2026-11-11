import type { AppDeps } from "../app";

/** Provider ids this organization can run right now (mock, its own key, or an explicitly allowed deployment key). */
export async function readyProviders(deps: Pick<AppDeps, "providers" | "credentials">, orgId: string): Promise<Set<string>> {
  const ready = new Set<string>();
  for (const p of deps.providers.list()) {
    if (p.isMock || (await deps.credentials.resolve(orgId, p.id)) !== null) ready.add(p.id);
  }
  return ready;
}

/** Provider list with configuration resolved for one organization. Never includes keys. */
export async function providersForOrg(deps: Pick<AppDeps, "providers" | "credentials">, orgId: string) {
  const ready = await readyProviders(deps, orgId);
  const creds = new Map((await deps.credentials.list(orgId)).map((c) => [c.provider as string, c]));
  return deps.providers.list().map((p) => ({
    ...p,
    configured: ready.has(p.id),
    credential: p.isMock ? null : (creds.get(p.id) ?? null),
  }));
}
