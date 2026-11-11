import type { ProviderId, ProviderInfo } from "@agentos/contracts";
import { AnthropicProvider } from "./adapters/anthropic";
import { MockProvider } from "./adapters/mock";
import { OpenAICompatibleProvider } from "./adapters/openaiCompatible";
import { ModelCatalog } from "./catalog";
import { EnvSecretsProvider, type ModelProvider, type SecretsProvider } from "./types";

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
      models: this.catalog.forProvider(p.id).map((m) => ({
        id: m.id,
        label: m.label,
        inputPerMTok: m.inputPerMTok,
        outputPerMTok: m.outputPerMTok,
      })),
    }));
  }
}

export interface ProviderRegistryOptions {
  secrets?: SecretsProvider;
  enableMock?: boolean;
  catalogJson?: string;
  mock?: MockProvider;
}

export function createProviderRegistry(opts: ProviderRegistryOptions = {}): ProviderRegistry {
  const secrets = opts.secrets ?? new EnvSecretsProvider();
  const registry = new ProviderRegistry(ModelCatalog.fromEnv(opts.catalogJson))
    .register(new OpenAICompatibleProvider({ id: "openai", label: "OpenAI", secretName: "OPENAI_API_KEY" }, secrets))
    .register(new AnthropicProvider(secrets))
    .register(
      new OpenAICompatibleProvider({ id: "xai", label: "xAI Grok", secretName: "XAI_API_KEY", baseURL: "https://api.x.ai/v1" }, secrets),
    );
  if (opts.enableMock) registry.register(opts.mock ?? new MockProvider());
  return registry;
}
