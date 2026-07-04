/**
 * Provider factory — resolve the active LLMProvider from settings, decrypting
 * the relevant API key in memory only at the moment of use.
 */

import type { LLMProvider } from "./types";
import { ClaudeProvider } from "./claude";
import { GeminiProvider } from "./gemini";
import { OpenRouterProvider } from "./openrouter";
import { OllamaProvider } from "./ollama";
import { LMStudioProvider } from "./lmstudio";
import { AppSettings, getApiKey, isCloudProvider } from "@/lib/settings/store";

export type { LLMProvider, LLMStreamHandlers } from "./types";

export async function createProvider(
  settings: AppSettings,
  opts?: { webSearch?: boolean }
): Promise<LLMProvider> {
  // Web search only applies to cloud providers with the toggle on. The
  // orchestrator can force it off (opts.webSearch=false) for a safe retry.
  const web =
    (opts?.webSearch ?? settings.webSearch ?? false) && isCloudProvider(settings.provider);
  switch (settings.provider) {
    case "claude": {
      const key = (await getApiKey("claude")) ?? "";
      return new ClaudeProvider(settings.claudeModel, key, web);
    }
    case "gemini": {
      const key = (await getApiKey("gemini")) ?? "";
      return new GeminiProvider(settings.geminiModel, key, web);
    }
    case "openrouter": {
      const key = (await getApiKey("openrouter")) ?? "";
      return new OpenRouterProvider(settings.openrouterModel, key, web);
    }
    case "ollama":
      return new OllamaProvider(settings.ollamaModel, settings.ollamaBaseUrl);
    case "lmstudio":
      return new LMStudioProvider(settings.lmstudioModel, settings.lmstudioBaseUrl);
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }
}
