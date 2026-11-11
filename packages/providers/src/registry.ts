import type { ProviderId, ProviderInfo } from "@agentos/contracts";
import { AnthropicProvider } from "./adapters/anthropic";
import { MockProvider } from "./adapters/mock";
import { OpenAICompatibleProvider } from "./adapters/openaiCompatible";
import { OpenAIResponsesProvider } from "./adapters/openaiResponses";
import { ModelCatalog } from "./catalog";
import { EnvSecretsProvider, type ModelProvider, type SecretsProvider } from "./types";

export const DEFAULT_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  xai: "https://api.x.ai/v1",
} as const;

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ModelProvider>();
  constructor(readonly catalog: ModelCatalog) {}

  register(p: ModelProvider): this {
    this.providers.set(p.id, p);
    return this;
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id as ProviderId);
  }

  /** Public description. Never includes secrets. */
  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      configured: p.isConfigured(),
      isMock: p.isMock,
      endpoint: p.endpoint ?? null,
      models: this.catalog.forProvider(p.id).map((m) => ({
        id: m.id,
        label: m.label,
        inputPerMTok: m.inputPerMTok,
        outputPerMTok: m.outputPerMTok,
        priceSource: m.priceSource,
      })),
    }));
  }
}

export interface ProviderRegistryOptions {
  secrets?: SecretsProvider;
  /** Explicit API endpoints. Never read from the SDKs' own env vars (see adapters). */
  endpoints?: Partial<Record<"openai" | "anthropic" | "xai", string>>;
  enableMock?: boolean;
  catalogJson?: string;
  mock?: MockProvider;
}

export function createProviderRegistry(opts: ProviderRegistryOptions = {}): ProviderRegistry {
  const secrets = opts.secrets ?? new EnvSecretsProvider();
  const registry = new ProviderRegistry(ModelCatalog.fromEnv(opts.catalogJson))
    .register(new OpenAIResponsesProvider(secrets, opts.endpoints?.openai ?? DEFAULT_ENDPOINTS.openai))
    .register(new AnthropicProvider(secrets, opts.endpoints?.anthropic ?? DEFAULT_ENDPOINTS.anthropic))
    .register(
      new OpenAICompatibleProvider(
        { id: "xai", label: "xAI Grok", secretName: "XAI_API_KEY", baseURL: opts.endpoints?.xai ?? DEFAULT_ENDPOINTS.xai },
        secrets,
      ),
    );
  if (opts.enableMock) registry.register(opts.mock ?? new MockProvider());
  return registry;
}
