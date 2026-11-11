import { ProviderError, type ProviderRegistry } from "@agentos/providers";

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
 * Checks the catalog against each provider's Models API. Results are cached so the
 * settings page does not call the provider on every load.
 */
export class ModelDiscoveryService {
  private readonly cache = new Map<string, { at: number; value: ModelDiscovery }>();

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly ttlMs = 5 * 60_000,
    private readonly timeoutMs = 15_000,
  ) {}

  peek(providerId: string): ModelDiscovery | null {
    return this.cache.get(providerId)?.value ?? null;
  }

  async discover(providerId: string, force = false): Promise<ModelDiscovery | null> {
    const provider = this.providers.get(providerId);
    if (!provider) return null;
    const cached = this.cache.get(providerId);
    if (!force && cached && Date.now() - cached.at < this.ttlMs) return cached.value;

    const catalog = this.providers.catalog.forProvider(provider.id);
    let value: ModelDiscovery;
    if (provider.isMock || !provider.listModels) {
      value = {
        provider: provider.id,
        checkedAt: new Date().toISOString(),
        ok: true,
        error: null,
        catalog: catalog.map((m) => ({ id: m.id, label: m.label, availableOnAccount: provider.isMock ? true : null, priceSource: m.priceSource })),
        listedCount: catalog.length,
      };
    } else if (!provider.isConfigured()) {
      value = {
        provider: provider.id,
        checkedAt: new Date().toISOString(),
        ok: false,
        error: { code: "PROVIDER_NOT_CONFIGURED", message: "Provider is not configured" },
        catalog: catalog.map((m) => ({ id: m.id, label: m.label, availableOnAccount: null, priceSource: m.priceSource })),
        listedCount: 0,
      };
    } else {
      try {
        const listed = await provider.listModels(AbortSignal.timeout(this.timeoutMs));
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
    this.cache.set(providerId, { at: Date.now(), value });
    return value;
  }
}
