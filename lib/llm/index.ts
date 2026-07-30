/**
 * Provider factory — resolve the active LLMProvider from settings, decrypting
 * the relevant API key in memory only at the moment of use.
 */

import type { LLMProvider } from "./types";
import { ClaudeProvider } from "./claude";
import { GeminiProvider } from "./gemini";
import { OpenRouterProvider } from "./openrouter";
import { OpenAICompatibleProvider } from "./openaiCompatible";
import { AzureOpenAIProvider } from "./azure";
import { OllamaProvider } from "./ollama";
import { LMStudioProvider } from "./lmstudio";
import { AppSettings, getApiKey, providerSupportsWebSearch } from "@/lib/settings/store";

export type { LLMProvider, LLMStreamHandlers } from "./types";

export async function createProvider(
  settings: AppSettings,
  opts?: { webSearch?: boolean }
): Promise<LLMProvider> {
  // Native web search only applies to providers that actually implement it.
  // The orchestrator can force it off (opts.webSearch=false) for a safe retry.
  const web =
    (opts?.webSearch ?? settings.webSearch ?? false) && providerSupportsWebSearch(settings.provider);
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
    case "openai": {
      const key = (await getApiKey("openai")) ?? "";
      return new OpenAICompatibleProvider("openai", settings.openaiModel, key);
    }
    case "xai": {
      const key = (await getApiKey("xai")) ?? "";
      return new OpenAICompatibleProvider("xai", settings.xaiModel, key);
    }
    case "zai": {
      const key = (await getApiKey("zai")) ?? "";
      return new OpenAICompatibleProvider("zai", settings.zaiModel, key);
    }
    case "nvidia": {
      const key = (await getApiKey("nvidia")) ?? "";
      return new OpenAICompatibleProvider("nvidia", settings.nvidiaModel, key);
    }
    case "meta": {
      const key = (await getApiKey("meta")) ?? "";
      return new OpenAICompatibleProvider("meta", settings.metaModel, key);
    }
    case "perplexity": {
      const key = (await getApiKey("perplexity")) ?? "";
      return new OpenAICompatibleProvider("perplexity", settings.perplexityModel, key);
    }
    case "azure": {
      const key = (await getApiKey("azure")) ?? "";
      return new AzureOpenAIProvider(
        { endpoint: settings.azureEndpoint, deployment: settings.azureDeployment, apiVersion: settings.azureApiVersion },
        key
      );
    }
    case "ollama":
      return new OllamaProvider(settings.ollamaModel, settings.ollamaBaseUrl);
    case "lmstudio":
      return new LMStudioProvider(settings.lmstudioModel, settings.lmstudioBaseUrl);
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }
}
