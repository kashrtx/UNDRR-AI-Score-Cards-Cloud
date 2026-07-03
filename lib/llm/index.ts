/**
 * Provider factory — resolve the active LLMProvider from settings, decrypting
 * the relevant API key in memory only at the moment of use.
 */

import type { LLMProvider } from "./types";
import { ClaudeProvider } from "./claude";
import { GeminiProvider } from "./gemini";
import { OpenRouterProvider } from "./openrouter";
import { OllamaProvider } from "./ollama";
import { AppSettings, getApiKey } from "@/lib/settings/store";

export type { LLMProvider, LLMStreamHandlers } from "./types";

export async function createProvider(settings: AppSettings): Promise<LLMProvider> {
  switch (settings.provider) {
    case "claude": {
      const key = (await getApiKey("claude")) ?? "";
      return new ClaudeProvider(settings.claudeModel, key);
    }
    case "gemini": {
      const key = (await getApiKey("gemini")) ?? "";
      return new GeminiProvider(settings.geminiModel, key);
    }
    case "openrouter": {
      const key = (await getApiKey("openrouter")) ?? "";
      return new OpenRouterProvider(settings.openrouterModel, key);
    }
    case "ollama":
      return new OllamaProvider(settings.ollamaModel, settings.ollamaBaseUrl);
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }
}
