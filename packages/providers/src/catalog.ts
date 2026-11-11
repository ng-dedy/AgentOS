import { z } from "zod";
import type { ProviderId } from "@agentos/contracts";

/**
 * Model catalog. This is data, not code: override with AGENTOS_MODEL_CATALOG_JSON.
 * Prices are USD per million tokens and are ESTIMATES used for budgets and
 * reporting. Anthropic prices were taken from Anthropic's published table
 * (Nov 2026). OpenAI and xAI entries are placeholders that must be checked
 * against the providers' current price lists before relying on cost figures.
 */
export const CatalogEntrySchema = z.object({
  provider: z.enum(["openai", "anthropic", "xai", "mock"]),
  id: z.string().min(1),
  label: z.string().min(1),
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  maxOutputTokens: z.number().int().positive().default(8192),
  priceSource: z.enum(["published", "unverified", "mock"]).default("unverified"),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const DEFAULT_CATALOG: CatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", inputPerMTok: 4, outputPerMTok: 20, maxOutputTokens: 16000, priceSource: "published" },
  { provider: "anthropic", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10, maxOutputTokens: 16000, priceSource: "published" },
  { provider: "anthropic", id: "claude-haiku-5-5", label: "Claude Haiku 5.5", inputPerMTok: 0.1, outputPerMTok: 0.5, maxOutputTokens: 16000, priceSource: "published" },
  { provider: "openai", id: "gpt-5", label: "GPT-5", inputPerMTok: 1.25, outputPerMTok: 10, maxOutputTokens: 16000, priceSource: "unverified" },
  { provider: "openai", id: "gpt-5-mini", label: "GPT-5 mini", inputPerMTok: 0.25, outputPerMTok: 2, maxOutputTokens: 16000, priceSource: "unverified" },
  { provider: "xai", id: "grok-4", label: "Grok 4", inputPerMTok: 3, outputPerMTok: 15, maxOutputTokens: 16000, priceSource: "unverified" },
  { provider: "xai", id: "grok-4-fast", label: "Grok 4 Fast", inputPerMTok: 0.2, outputPerMTok: 0.5, maxOutputTokens: 16000, priceSource: "unverified" },
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

  /** Cost in USD. Cached input is charged at the full input price (conservative). */
  cost(provider: string, model: string, usage: { inputTokens: number; outputTokens: number }): number {
    const e = this.find(provider, model);
    if (!e) return 0;
    return (usage.inputTokens * e.inputPerMTok + usage.outputTokens * e.outputPerMTok) / 1_000_000;
  }
}
