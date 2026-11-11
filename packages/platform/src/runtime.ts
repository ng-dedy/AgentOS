import type { PrismaClient } from "@agentos/db";
import { createProviderRegistry, EnvSecretsProvider, MockProvider, type ProviderRegistry, type SecretsProvider } from "@agentos/providers";
import { AgentEngine, PipelineCoordinator, type EngineLogger } from "@agentos/runtime";
import { createDefaultToolRegistry, type ToolRegistry } from "@agentos/tools";
import type { RuntimeConfig } from "./config";
import { createKms, type KeyManagementService } from "./credentials/kms";
import { CredentialService } from "./credentials/service";
import { EventBus, PrismaEventSink } from "./events/bus";
import { PrismaRunStore } from "./store/prismaStore";

export interface Runtime {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  bus: EventBus;
  sink: PrismaEventSink;
  store: PrismaRunStore;
  credentials: CredentialService;
  engine: AgentEngine;
  pipelines: PipelineCoordinator;
}

export interface RuntimeOptions {
  prisma: PrismaClient;
  config: RuntimeConfig;
  logger: EngineLogger;
  secrets?: SecretsProvider;
  providers?: ProviderRegistry;
  /** Override the KMS (tests). `undefined` = from env, `null` = credential storage off. */
  kms?: KeyManagementService | null;
  env?: NodeJS.ProcessEnv;
  /** Send live-only deltas to other processes over NOTIFY (worker processes). */
  crossProcessEvents?: boolean;
  engineOverrides?: { retryBaseDelayMs?: number; providerTimeoutMs?: number };
}

/** Everything that executes agent runs, wired to Postgres. Shared by the API and the worker. */
export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const { prisma, config } = opts;
  const secrets = opts.secrets ?? new EnvSecretsProvider(opts.env);
  const providers =
    opts.providers ??
    createProviderRegistry({
      secrets,
      enableMock: config.AGENTOS_ENABLE_MOCK_PROVIDER,
      mock: new MockProvider({ slowMs: config.AGENTOS_MOCK_SLOW_MS }),
      catalogJson: config.AGENTOS_MODEL_CATALOG_JSON,
      endpoints: { openai: config.AGENTOS_OPENAI_BASE_URL, anthropic: config.AGENTOS_ANTHROPIC_BASE_URL, xai: config.AGENTOS_XAI_BASE_URL },
    });
  const tools = createDefaultToolRegistry();
  const bus = new EventBus();
  const store = new PrismaRunStore(prisma);
  const sink = new PrismaEventSink(prisma, bus, { crossProcess: opts.crossProcessEvents });
  const kms = opts.kms === undefined ? await createKms(opts.env ?? process.env) : opts.kms;
  const credentials = new CredentialService(prisma, kms, {
    allowDeploymentKeys: config.AGENTOS_ALLOW_DEPLOYMENT_KEYS,
    deploymentSecrets: secrets,
    cacheTtlMs: config.AGENTOS_CREDENTIAL_CACHE_TTL_MS,
  });
  const engine = new AgentEngine({
    store,
    events: sink,
    providers,
    tools,
    credentials,
    logger: opts.logger,
    retryBaseDelayMs: opts.engineOverrides?.retryBaseDelayMs,
    providerTimeoutMs: opts.engineOverrides?.providerTimeoutMs ?? config.PROVIDER_TIMEOUT_MS,
    providerRetries: config.PROVIDER_MAX_RETRIES,
    unpricedCallReserveUsd: config.AGENTOS_UNPRICED_CALL_RESERVE_USD,
  });
  const pipelines = new PipelineCoordinator(store, sink);
  return { providers, tools, bus, sink, store, credentials, engine, pipelines };
}
