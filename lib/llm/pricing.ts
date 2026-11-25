/**
 * What an AI helper's work costs, for comparing models.
 *
 *   • OpenRouter reports the exact amount it charges for each request ("billed").
 *   • Local helpers (Ollama, LM Studio) cost nothing.
 *   • Everyone else reports exact token counts, priced here at the model's list
 *     price from OpenRouter's public model catalog ("list"), which covers the
 *     Claude, Gemini, OpenAI, Grok, GLM, Llama and Sonar families. A free tier
 *     (Gemini's, NVIDIA's credits) can make the real charge $0; the list price
 *     is still the fair way to compare models.
 *
 * The catalog is fetched once a day and cached in the browser.
 */

import type { ProviderId } from "@/lib/settings/store";

export interface ModelPrice {
  /** The catalog entry used, e.g. "anthropic/claude-sonnet-4.6". */
  id: string;
  /** US dollars per token. */
  input: number;
  output: number;
}

export type PriceCatalog = Map<string, ModelPrice>;

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "undrr.prices.v1";
const CACHE_MS = 24 * 60 * 60 * 1000;
/** Anthropic bills its web search tool per search. */
const CLAUDE_SEARCH_USD = 0.01;

// Which catalog organisation each provider's model names belong to.
const ORG: Partial<Record<ProviderId, string>> = {
  claude: "anthropic", gemini: "google", openai: "openai", azure: "openai",
  xai: "x-ai", zai: "z-ai", perplexity: "perplexity", meta: "meta-llama",
};

let catalogPromise: Promise<PriceCatalog | null> | null = null;

function toCatalog(rows: Array<{ id: string; input: number; output: number }>): PriceCatalog {
  return new Map(rows.map((r) => [r.id, { id: r.id, input: r.input, output: r.output }]));
}

/** The price catalog (null if it can't be reached and nothing is cached). */
export function loadPriceCatalog(): Promise<PriceCatalog | null> {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    let cached: { at: number; rows: Array<{ id: string; input: number; output: number }> } | null = null;
    try {
      cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    } catch { /* ignore */ }
    if (cached && Date.now() - cached.at < CACHE_MS) return toCatalog(cached.rows);
    try {
      const res = await fetch(CATALOG_URL);
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
      const rows = (j.data || [])
        .map((m) => ({ id: m.id, input: Number(m.pricing?.prompt), output: Number(m.pricing?.completion) }))
        .filter((r) => r.id && Number.isFinite(r.input) && Number.isFinite(r.output) && r.input >= 0 && r.output >= 0);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows })); } catch { /* quota */ }
      return toCatalog(rows);
    } catch {
      catalogPromise = null; // try again next time
      return cached ? toCatalog(cached.rows) : null;
    }
  })();
  return catalogPromise;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const namePart = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** The catalog's list price for a helper's model, if it has one. */
export function findPrice(cat: PriceCatalog, provider: ProviderId, model: string): ModelPrice | null {
  const m = model.replace(/:online$/, "");
  if (cat.has(m)) return cat.get(m)!; // OpenRouter ids, and NIM ids like "z-ai/glm-5.2"
  if (m.endsWith(":free")) return { id: m, input: 0, output: 0 }; // OpenRouter's free variants
  const want = norm(namePart(m));
  if (!want) return null;
  const org = ORG[provider] ?? (m.includes("/") ? m.slice(0, m.indexOf("/")) : undefined);
  const free = m.endsWith(":free");
  let best: ModelPrice | null = null;
  let bestScore = -1;
  for (const p of cat.values()) {
    if (/:batch$/.test(p.id) || (!free && /:free$/.test(p.id))) continue;
    const name = norm(namePart(p.id).replace(/:(free|batch)$/, ""));
    // An exact name, or the catalog name as the start of ours ("llama-4-maverick"
    // for "Llama-4-Maverick-17B-128E-Instruct-FP8"); never a longer catalog name
    // ("gpt-5.5-pro" is not "gpt-5.5").
    const exact = name === want;
    if (!exact && !(name.length >= 6 && want.startsWith(name))) continue;
    const score = (exact ? 1000 : name.length) + (org && p.id.startsWith(`${org}/`) ? 500 : 0);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

export interface CostEstimate {
  /** US dollars; null when no price is known. */
  usd: number | null;
  /** billed = charged by the provider; list = tokens at list price; local = runs on this computer. */
  basis: "billed" | "list" | "local" | "unknown";
  /** e.g. "$0 on Gemini's free tier". */
  note?: string;
  /** The catalog entry used for a list price. */
  priceId?: string;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Exact charges reported by the provider, and how many requests reported one. */
  billedUsd: number;
  billedRequests: number;
  webSearches: number;
  /** Requests whose provider didn't report usage (so the total is a lower bound). */
  unreported?: number;
}

export const emptyTotals = (): UsageTotals => ({
  requests: 0, inputTokens: 0, outputTokens: 0, billedUsd: 0, billedRequests: 0, webSearches: 0, unreported: 0,
});

/** What the work cost: exact where the provider billed it, list price otherwise. */
export function costOf(t: UsageTotals, provider: ProviderId, model: string, cat: PriceCatalog | null): CostEstimate {
  if (provider === "ollama" || provider === "lmstudio") return { usd: 0, basis: "local", note: "runs on this computer" };
  if (t.requests > 0 && t.billedRequests === t.requests) return { usd: t.billedUsd, basis: "billed" };
  const price = cat ? findPrice(cat, provider, model) : null;
  if (!price) return { usd: null, basis: "unknown", note: cat ? "no list price found for this model" : "price list not loaded" };
  let usd = t.inputTokens * price.input + t.outputTokens * price.output;
  if (provider === "claude") usd += t.webSearches * CLAUDE_SEARCH_USD;
  const note = [
    provider === "gemini" ? "$0 on Gemini's free tier" : provider === "nvidia" ? "free with NVIDIA's credits" : "",
    t.unreported ? `${t.unreported} request(s) didn't report usage, so this is a minimum` : "",
  ].filter(Boolean).join("; ") || undefined;
  return { usd, basis: "list", note, priceId: price.id };
}

/** "$0.0123", "<$0.0001", "$1.24". */
export function formatUsd(usd: number | null): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** "142k", "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
