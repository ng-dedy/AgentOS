import { ProviderError, type ProviderRegistry } from "@agentos/providers";
import type { CredentialResolver } from "@agentos/runtime";

export interface ModelDiscovery {
  provider: string;
  checkedAt: string;
  ok: boolean;
  /** Structured error when the Models API call failed (never contains secrets). */
  error: { code: string; message: string; status?: number } | null;
  /** Catalog models with whether the provider's Models API lists them for this account. */
  catalog: { id: string; label: string; availableOnAccount: boolean | null; priceSource: string }[];
  /** Number of models the provider listed (all of them, not only catalog entries). */
  listedCount: number;
}

/**
 * Checks the catalog against each provider's Models API, using the calling
 * organization's own credential. Results are cached per organization so the
 * settings page does not call the provider on every load.
 */
export class ModelDiscoveryService {
  private readonly cache = new Map<string, { at: number; value: ModelDiscovery }>();

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly credentials: CredentialResolver,
    private readonly ttlMs = 5 * 60_000,
    private readonly timeoutMs = 15_000,
  ) {}

  peek(orgId: string, providerId: string): ModelDiscovery | null {
    return this.cache.get(`${orgId}|${providerId}`)?.value ?? null;
  }

  /** Forget cached results for an organization (after its credential changes). */
  invalidate(orgId: string, providerId: string) {
    this.cache.delete(`${orgId}|${providerId}`);
  }

  async discover(orgId: string, providerId: string, force = false): Promise<ModelDiscovery | null> {
    const provider = this.providers.get(providerId);
    if (!provider) return null;
    const cacheKey = `${orgId}|${providerId}`;
    const cached = this.cache.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < this.ttlMs) return cached.value;

    const catalog = this.providers.catalog.forProvider(provider.id);
    let value: ModelDiscovery;
    let apiKey: string | undefined;
    if (provider.isMock || !provider.listModels) {
      value = {
        provider: provider.id,
        checkedAt: new Date().toISOString(),
        ok: true,
        error: null,
        catalog: catalog.map((m) => ({ id: m.id, label: m.label, availableOnAccount: provider.isMock ? true : null, priceSource: m.priceSource })),
        listedCount: catalog.length,
      };
    } else if (!(apiKey = (await this.credentials.resolve(orgId, provider.id)) ?? undefined)) {
      value = {
        provider: provider.id,
        checkedAt: new Date().toISOString(),
        ok: false,
        error: { code: "PROVIDER_NOT_CONFIGURED", message: "No key is configured for this organization" },
        catalog: catalog.map((m) => ({ id: m.id, label: m.label, availableOnAccount: null, priceSource: m.priceSource })),
        listedCount: 0,
      };
    } else {
      try {
        const listed = await provider.listModels(AbortSignal.timeout(this.timeoutMs), apiKey);
        const ids = new Set(listed.map((m) => m.id));
        value = {
          provider: provider.id,
          checkedAt: new Date().toISOString(),
          ok: true,
          error: null,
          catalog: catalog.map((m) => ({ id: m.id, label: m.label, availableOnAccount: ids.has(m.id), priceSource: m.priceSource })),
          listedCount: listed.length,
        };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : null;
        value = {
          provider: provider.id,
          checkedAt: new Date().toISOString(),
          ok: false,
          error: pe ? { code: pe.code, message: pe.message, status: pe.status } : { code: "PROVIDER_UNKNOWN", message: "Unexpected provider error" },
          catalog: catalog.map((m) => ({ id: m.id, label: m.label, availableOnAccount: null, priceSource: m.priceSource })),
          listedCount: 0,
        };
      }
    }
    this.cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
}
