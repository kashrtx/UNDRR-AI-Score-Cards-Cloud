/**
 * Microsoft Azure OpenAI provider.
 *
 * This is Microsoft's official, API-key-based, OpenAI-compatible service, and
 * the same engine behind Microsoft Copilot. (Consumer/M365 "Copilot" itself has
 * no plain API key — it uses OAuth/Entra and a licence — so Azure OpenAI is the
 * seamless, production path for a bring-your-own-key app like this one.)
 *
 * Differs from vanilla OpenAI in two ways, both handled by our /api/llm proxy:
 *   • URL: {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…
 *   • Auth: an `api-key` header instead of a bearer token.
 * The request/response bodies and SSE streaming are standard OpenAI shape, so we
 * reuse the same streaming reader as the other providers.
 */

import { LLMProvider, LLMStreamHandlers, readSSE } from "./types";

export interface AzureConfig {
  endpoint: string;   // e.g. https://my-resource.openai.azure.com
  deployment: string; // the deployment name you created in Azure
  apiVersion: string; // e.g. 2024-10-21
}

export class AzureOpenAIProvider implements LLMProvider {
  readonly name = "azure";
  readonly model: string;
  constructor(private cfg: AzureConfig, private apiKey: string) {
    this.model = cfg.deployment || "azure-deployment";
  }

  private body(system: string, user: string, stream: boolean, maxTokens: number) {
    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream,
      temperature: 0.3,
      max_tokens: maxTokens,
    };
  }

  private async call(body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch("/api/llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        provider: "azure",
        apiKey: this.apiKey,
        azure: this.cfg,
        body,
      }),
    });
  }

  async complete(system: string, user: string, handlers?: LLMStreamHandlers, signal?: AbortSignal): Promise<string> {
    if (!this.apiKey) throw new Error("No Azure OpenAI API key set. Add one in Settings.");
    if (!this.cfg.endpoint || !this.cfg.deployment) {
      throw new Error("Azure OpenAI needs both an endpoint and a deployment name (set them in Settings).");
    }

    const res = await this.call(this.body(system, user, true, 20000), signal);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Azure OpenAI error ${res.status}: ${truncate(detail)}`);
    }

    let full = "";
    let reasoningFull = "";
    let finishReason: string | undefined;
    await readSSE(res, (data) => {
      if (data === "[DONE]") return;
      let evt: {
        choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string }; finish_reason?: string }>;
        error?: { message?: string };
      };
      try { evt = JSON.parse(data); } catch { return; }
      if (evt.error) throw new Error(`Azure OpenAI error: ${evt.error.message ?? "unknown"}`);
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) { reasoningFull += reasoning; handlers?.onToken?.(reasoning); }
      if (delta?.content) { full += delta.content; handlers?.onToken?.(delta.content); }
    });

    const answer = full.trim() ? full : reasoningFull;
    if (!answer.trim()) {
      if (finishReason === "length") throw new Error("Azure OpenAI hit its output-token limit before finishing. Try again or pick a lighter model.");
      throw new Error(`Azure OpenAI returned no text${finishReason ? ` (finish_reason: ${finishReason})` : ""}. Try again, or check the deployment name.`);
    }
    return answer;
  }

  async test(signal?: AbortSignal) {
    if (!this.apiKey) return { ok: false, message: "No API key set." };
    if (!this.cfg.endpoint || !this.cfg.deployment) return { ok: false, message: "Set the Azure endpoint and deployment name first." };
    try {
      const res = await this.call(this.body("You are a connectivity check.", "Reply with the single word: ok", false, 16), signal);
      if (res.ok) return { ok: true, message: "Connected, your Azure OpenAI deployment works." };
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `HTTP ${res.status}: ${truncate(detail)}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

function truncate(s: string, n = 240): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
