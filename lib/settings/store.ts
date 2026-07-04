/**
 * Settings — provider choice + per-provider model, persisted (non-secret) in
 * localStorage. API keys are stored separately and encrypted (see crypto.ts).
 */

import { getSecret, hasSecret, setSecret, clearSecret } from "./crypto";

export type ProviderId =
  | "claude" | "gemini" | "openrouter"
  | "openai" | "xai" | "zai" | "nvidia" | "meta"
  | "ollama" | "lmstudio";
/** Providers that require an API key (all cloud ones). */
export type CloudProviderId =
  | "claude" | "gemini" | "openrouter"
  | "openai" | "xai" | "zai" | "nvidia" | "meta";
/** Local providers run on the visitor's machine — no key. */
export type LocalProviderId = "ollama" | "lmstudio";

export interface AppSettings {
  provider: ProviderId;
  claudeModel: string;
  geminiModel: string;
  openrouterModel: string;
  openaiModel: string;
  xaiModel: string;
  zaiModel: string;
  nvidiaModel: string;
  metaModel: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
  lmstudioModel: string;
  lmstudioBaseUrl: string;
  /** Let cloud providers use their built-in web search while analysing. */
  webSearch: boolean;
  /** Use Tavily for web-search grounding (only takes effect if a key is set). */
  useTavily: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "gemini",
  claudeModel: "claude-sonnet-4-6",
  geminiModel: "gemini-3.5-flash",
  openrouterModel: "meta-llama/llama-3.3-70b-instruct:free",
  openaiModel: "gpt-5.5",
  xaiModel: "grok-4.3",
  zaiModel: "glm-4.7",
  nvidiaModel: "meta/llama-3.3-70b-instruct",
  metaModel: "Llama-4-Maverick-17B-128E-Instruct-FP8",
  ollamaModel: "llama3.1:8b",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  lmstudioModel: "local-model",
  lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
  webSearch: true,
  useTavily: false,
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
};

export const CLOUD_PROVIDERS: CloudProviderId[] = ["gemini", "openrouter", "claude", "openai", "xai", "zai", "nvidia", "meta"];

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

/** Providers whose model can search the web natively (built-in tool). */
export const WEBSEARCH_PROVIDERS: ProviderId[] = ["claude", "gemini", "openrouter"];
export function providerSupportsWebSearch(p: ProviderId): boolean {
  return WEBSEARCH_PROVIDERS.includes(p);
}

export function loadSettings(): AppSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
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
