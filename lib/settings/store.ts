/**
 * Settings — provider choice + per-provider model, persisted (non-secret) in
 * localStorage. API keys are stored separately and encrypted (see crypto.ts).
 */

import { getSecret, hasSecret, setSecret, clearSecret } from "./crypto";

export type ProviderId = "claude" | "gemini" | "openrouter" | "ollama" | "lmstudio";
/** Providers that require an API key (all cloud ones). */
export type CloudProviderId = "claude" | "gemini" | "openrouter";
/** Local providers run on the visitor's machine — no key. */
export type LocalProviderId = "ollama" | "lmstudio";

export interface AppSettings {
  provider: ProviderId;
  claudeModel: string;
  geminiModel: string;
  openrouterModel: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
  lmstudioModel: string;
  lmstudioBaseUrl: string;
  /** Let cloud providers use their built-in web search while analysing. */
  webSearch: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "gemini",
  claudeModel: "claude-sonnet-4-6",
  geminiModel: "gemini-3.5-flash",
  openrouterModel: "meta-llama/llama-3.3-70b-instruct:free",
  ollamaModel: "llama3.1:8b",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  lmstudioModel: "local-model",
  lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
  webSearch: true,
};

const SETTINGS_KEY = "undrr.settings";

// Each cloud provider's API key is stored under its own secret name.
export const SECRET_NAMES: Record<CloudProviderId, string> = {
  claude: "claude_api_key",
  gemini: "gemini_api_key",
  openrouter: "openrouter_api_key",
};

export const CLOUD_PROVIDERS: CloudProviderId[] = ["gemini", "openrouter", "claude"];
export const LOCAL_PROVIDERS: LocalProviderId[] = ["ollama", "lmstudio"];

export function isCloudProvider(p: ProviderId): p is CloudProviderId {
  return p === "claude" || p === "gemini" || p === "openrouter";
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
