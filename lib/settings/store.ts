/**
 * Settings — provider choice + per-provider model, persisted (non-secret) in
 * localStorage. API keys are stored separately and encrypted (see crypto.ts).
 */

import { getSecret, hasSecret, setSecret, clearSecret } from "./crypto";

export type ProviderId = "claude" | "gemini" | "openrouter" | "ollama";

export interface AppSettings {
  provider: ProviderId;
  claudeModel: string;
  geminiModel: string;
  openrouterModel: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "gemini",
  claudeModel: "claude-sonnet-4-6",
  geminiModel: "gemini-2.0-flash",
  openrouterModel: "meta-llama/llama-3.3-70b-instruct:free",
  ollamaModel: "llama3.1:8b",
  ollamaBaseUrl: "http://localhost:11434",
};

const SETTINGS_KEY = "undrr.settings";

// Each provider's API key is stored under its own secret name.
export const SECRET_NAMES: Record<Exclude<ProviderId, "ollama">, string> = {
  claude: "claude_api_key",
  gemini: "gemini_api_key",
  openrouter: "openrouter_api_key",
};

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
export async function setApiKey(provider: Exclude<ProviderId, "ollama">, key: string) {
  await setSecret(SECRET_NAMES[provider], key);
}
export async function getApiKey(provider: Exclude<ProviderId, "ollama">): Promise<string | null> {
  return getSecret(SECRET_NAMES[provider]);
}
export function hasApiKey(provider: Exclude<ProviderId, "ollama">): boolean {
  return hasSecret(SECRET_NAMES[provider]);
}
export function clearApiKey(provider: Exclude<ProviderId, "ollama">) {
  clearSecret(SECRET_NAMES[provider]);
}
