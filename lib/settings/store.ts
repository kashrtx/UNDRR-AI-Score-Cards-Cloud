/**
 * Settings — provider choice + per-provider model, persisted (non-secret) in
 * localStorage. API keys are stored separately and encrypted (see crypto.ts).
 */

import { getSecret, hasSecret, setSecret, clearSecret } from "./crypto";

export type ProviderId =
  | "claude" | "gemini" | "openrouter"
  | "openai" | "xai" | "zai" | "nvidia" | "meta" | "azure" | "perplexity" | "createai"
  | "ollama" | "lmstudio";
/** Providers that require an API key (all cloud ones). */
export type CloudProviderId =
  | "claude" | "gemini" | "openrouter"
  | "openai" | "xai" | "zai" | "nvidia" | "meta" | "azure" | "perplexity" | "createai";
/** Local providers run on the visitor's machine — no key. */
export type LocalProviderId = "ollama" | "lmstudio";

export interface AppSettings {
  /**
   * The AI helper being configured in Settings, and the "primary" one for
   * features that use a single AI. Always one of `providers`.
   */
  provider: ProviderId;
  /** Every AI helper the user picked; each fills its own copy of the scorecard. */
  providers: ProviderId[];
  claudeModel: string;
  geminiModel: string;
  openrouterModel: string;
  openaiModel: string;
  xaiModel: string;
  zaiModel: string;
  nvidiaModel: string;
  metaModel: string;
  perplexityModel: string;
  /** ASU CreateAI model id, "provider/model" as CreateAI lists it (e.g. "openai/gpt4_1-mini"). */
  createaiModel: string;
  azureEndpoint: string;
  azureDeployment: string;
  azureApiVersion: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
  lmstudioModel: string;
  lmstudioBaseUrl: string;
  /** Let cloud providers use their built-in web search while analysing. */
  webSearch: boolean;
  /**
   * Let the Assistant make an educated guess for an indicator it finds no
   * evidence for (labelled as a guess). Off: such indicators are left blank,
   * with the reason.
   */
  allowGuesses: boolean;
  /** Use Tavily for web-search grounding (only takes effect if a key is set). */
  useTavily: boolean;
  /** Optional data sources (lib/data/catalog.ts ids) the AI should prefer; none by default. */
  dataSources: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "gemini",
  providers: ["gemini"],
  claudeModel: "claude-sonnet-4-6",
  geminiModel: "gemini-3.6-flash",
  openrouterModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
  openaiModel: "gpt-5.5",
  xaiModel: "grok-4.3",
  zaiModel: "glm-4.7",
  nvidiaModel: "z-ai/glm-5.2",
  metaModel: "Llama-4-Maverick-17B-128E-Instruct-FP8",
  perplexityModel: "sonar",
  createaiModel: "openai/gpt4_1-mini",
  azureEndpoint: "",
  azureDeployment: "",
  azureApiVersion: "2024-10-21",
  ollamaModel: "qwen2.5:3b", // small enough for an 8 GB laptop
  ollamaBaseUrl: "http://127.0.0.1:11434",
  lmstudioModel: "local-model",
  lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
  webSearch: true,
  allowGuesses: false,
  useTavily: false,
  dataSources: [],
};

const SETTINGS_KEY = "undrr.settings";

// Each cloud provider's API key is stored under its own secret name.
export const SECRET_NAMES: Record<CloudProviderId, string> = {
  claude: "claude_api_key",
  gemini: "gemini_api_key",
  openrouter: "openrouter_api_key",
  openai: "openai_api_key",
  xai: "xai_api_key",
  zai: "zai_api_key",
  nvidia: "nvidia_api_key",
  meta: "meta_api_key",
  azure: "azure_api_key",
  perplexity: "perplexity_api_key",
  createai: "createai_api_key",
};

export const CLOUD_PROVIDERS: CloudProviderId[] = ["gemini", "openrouter", "createai", "claude", "openai", "xai", "zai", "nvidia", "meta", "azure", "perplexity"];

/** Optional web-search (Tavily) key for the research/RAG step. */
export const SEARCH_SECRET_NAME = "tavily_api_key";
export async function setSearchKey(key: string) { await setSecret(SEARCH_SECRET_NAME, key); }
export async function getSearchKey(): Promise<string | null> { return getSecret(SEARCH_SECRET_NAME); }
export function hasSearchKey(): boolean { return hasSecret(SEARCH_SECRET_NAME); }
export function clearSearchKey() { clearSecret(SEARCH_SECRET_NAME); }
export const LOCAL_PROVIDERS: LocalProviderId[] = ["ollama", "lmstudio"];

export function isCloudProvider(p: ProviderId): p is CloudProviderId {
  return p !== "ollama" && p !== "lmstudio";
}

/** The active model id for the chosen provider (single source of truth). */
export function modelForSettings(s: AppSettings): string {
  switch (s.provider) {
    case "claude": return s.claudeModel;
    case "gemini": return s.geminiModel;
    case "openrouter": return s.openrouterModel;
    case "openai": return s.openaiModel;
    case "xai": return s.xaiModel;
    case "zai": return s.zaiModel;
    case "nvidia": return s.nvidiaModel;
    case "meta": return s.metaModel;
    case "azure": return s.azureDeployment;
    case "perplexity": return s.perplexityModel;
    case "createai": return s.createaiModel;
    case "lmstudio": return s.lmstudioModel;
    case "ollama": return s.ollamaModel;
    default: return "";
  }
}

/** Short names, as shown on the sub-tabs ("Gemini", "OpenRouter", …). */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude", gemini: "Gemini", openrouter: "OpenRouter",
  openai: "OpenAI", xai: "xAI Grok", zai: "z.AI GLM", nvidia: "NVIDIA NIM", meta: "Meta Llama", azure: "Microsoft Azure", perplexity: "Perplexity", createai: "ASU CreateAI",
  ollama: "Ollama", lmstudio: "LM Studio",
};

/** The AI helpers picked in Settings, in the order they appear there. */
export function selectedProviders(s: AppSettings): ProviderId[] {
  const list = s.providers?.length ? s.providers : [s.provider];
  return list.filter((p, i) => list.indexOf(p) === i);
}

/** The settings as one AI helper sees them (its provider is the active one). */
export function settingsFor(s: AppSettings, p: ProviderId): AppSettings {
  return s.provider === p ? s : { ...s, provider: p };
}

/** Whether a helper can run: a cloud one needs its key; local ones always can. */
export function providerIsReady(p: ProviderId): boolean {
  return isCloudProvider(p) ? hasApiKey(p) : true;
}

/** Providers whose model can search the web natively (built-in tool). */
export const WEBSEARCH_PROVIDERS: ProviderId[] = ["claude", "gemini", "openrouter", "perplexity"];
export function providerSupportsWebSearch(p: ProviderId): boolean {
  return WEBSEARCH_PROVIDERS.includes(p);
}

export function loadSettings(): AppSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    const s = { ...DEFAULT_SETTINGS, ...saved };
    // Settings saved before multi-select only have the one provider.
    s.providers = saved.providers?.length ? saved.providers : [s.provider];
    if (!s.providers.includes(s.provider)) s.provider = s.providers[0];
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ── API key helpers ─────────────────────────────────────────
export async function setApiKey(provider: CloudProviderId, key: string) {
  await setSecret(SECRET_NAMES[provider], key);
}
export async function getApiKey(provider: CloudProviderId): Promise<string | null> {
  return getSecret(SECRET_NAMES[provider]);
}
export function hasApiKey(provider: CloudProviderId): boolean {
  return hasSecret(SECRET_NAMES[provider]);
}
export function clearApiKey(provider: CloudProviderId) {
  clearSecret(SECRET_NAMES[provider]);
}
