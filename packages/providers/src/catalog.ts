import { z } from "zod";
import type { ProviderId } from "@agentos/contracts";

/**
 * Model catalog. This is data, not code: override with AGENTOS_MODEL_CATALOG_JSON.
 *
 * Prices are USD per million tokens, copied from each provider's published price
 * list on the date in `priceCheckedAt`. Costs computed from them are ESTIMATES:
 * providers bill from their own meters, and prices change. Never present them as
 * invoiced amounts.
 *
 * Which of these ids the configured account can actually use is checked at runtime
 * through each provider's Models API (GET /providers/:id/models), not assumed here.
 */
export const CatalogEntrySchema = z.object({
  provider: z.enum(["openai", "anthropic", "xai", "mock"]),
  id: z.string().min(1),
  label: z.string().min(1),
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  /** Published price for cache-hit input tokens. When absent, cached input is charged at the full input price (conservative). */
  cachedInputPerMTok: z.number().min(0).optional(),
  maxOutputTokens: z.number().int().positive().default(8192),
  priceSource: z.enum(["published", "unverified", "mock"]).default("unverified"),
  priceSourceUrl: z.string().url().optional(),
  priceCheckedAt: z.string().optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

const OPENAI_PRICES = "https://developers.openai.com/api/docs/pricing";
const XAI_PRICES = "https://docs.x.ai/developers/pricing";

export const DEFAULT_CATALOG: CatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", inputPerMTok: 4, outputPerMTok: 20, maxOutputTokens: 16000, priceSource: "published", priceCheckedAt: "2026-11-03" },
  { provider: "anthropic", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10, maxOutputTokens: 16000, priceSource: "published", priceCheckedAt: "2026-11-03" },
  { provider: "anthropic", id: "claude-haiku-5-5", label: "Claude Haiku 5.5", inputPerMTok: 0.1, outputPerMTok: 0.5, maxOutputTokens: 16000, priceSource: "published", priceCheckedAt: "2026-11-03" },
  { provider: "openai", id: "gpt-6.1-sol", label: "GPT-6.1 Sol", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.1, maxOutputTokens: 16000, priceSource: "published", priceSourceUrl: OPENAI_PRICES, priceCheckedAt: "2026-11-11" },
  { provider: "openai", id: "gpt-6.1-terra", label: "GPT-6.1 Terra", inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.05, maxOutputTokens: 16000, priceSource: "published", priceSourceUrl: OPENAI_PRICES, priceCheckedAt: "2026-11-11" },
  { provider: "openai", id: "gpt-6-luna", label: "GPT-6 Luna", inputPerMTok: 0.1, outputPerMTok: 0.5, cachedInputPerMTok: 0.01, maxOutputTokens: 16000, priceSource: "published", priceSourceUrl: OPENAI_PRICES, priceCheckedAt: "2026-11-11" },
  { provider: "xai", id: "grok-4.7", label: "Grok 4.7", inputPerMTok: 2, outputPerMTok: 6, maxOutputTokens: 16000, priceSource: "published", priceSourceUrl: XAI_PRICES, priceCheckedAt: "2026-11-11" },
  { provider: "mock", id: "mock-scripted", label: "MOCK scripted model", inputPerMTok: 1, outputPerMTok: 2, maxOutputTokens: 4096, priceSource: "mock" },
  { provider: "mock", id: "mock-expensive", label: "MOCK expensive model (budget tests)", inputPerMTok: 50_000, outputPerMTok: 50_000, maxOutputTokens: 4096, priceSource: "mock" },
];

export class ModelCatalog {
  constructor(private readonly entries: CatalogEntry[] = DEFAULT_CATALOG) {}

  static fromEnv(json: string | undefined): ModelCatalog {
    if (!json || json.trim() === "") return new ModelCatalog();
    const parsed = z.array(CatalogEntrySchema).parse(JSON.parse(json));
    return new ModelCatalog(parsed);
  }

  forProvider(provider: ProviderId): CatalogEntry[] {
    return this.entries.filter((e) => e.provider === provider);
  }

  find(provider: string, model: string): CatalogEntry | undefined {
    return this.entries.find((e) => e.provider === provider && e.id === model);
  }

  /**
   * Estimated cost in USD. `inputTokens` includes cached tokens; those are charged at
   * the published cached price when the catalog has one, otherwise at the full input price.
   */
  cost(provider: string, model: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): number {
    const e = this.find(provider, model);
    if (!e) return 0;
    const cached = e.cachedInputPerMTok !== undefined ? Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens) : 0;
    const input = (usage.inputTokens - cached) * e.inputPerMTok + cached * (e.cachedInputPerMTok ?? e.inputPerMTok);
    return (input + usage.outputTokens * e.outputPerMTok) / 1_000_000;
  }
}
