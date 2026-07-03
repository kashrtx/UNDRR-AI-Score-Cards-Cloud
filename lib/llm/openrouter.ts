/**
 * OpenRouter — OpenAI-compatible, CORS-enabled, with a catalogue of free models
 * (their id ends in ":free"). Free keys at https://openrouter.ai/keys .
 */

import { LLMProvider, LLMStreamHandlers, readSSE } from "./types";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  constructor(readonly model: string, private apiKey: string) {}

  private headers() {
    const h: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    // Optional attribution headers (safe in the browser).
    if (typeof window !== "undefined") {
      h["HTTP-Referer"] = window.location.origin;
      h["X-Title"] = "UNDRR ARISE Scorecard Analyzer";
    }
    return h;
  }

  async complete(
    system: string,
    user: string,
    handlers?: LLMStreamHandlers,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.apiKey) throw new Error("No OpenRouter API key set. Add one in Settings.");

    const res = await fetch(API_URL, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.model,
        temperature: 0.3,
        max_tokens: 4096,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenRouter API error ${res.status}: ${truncate(detail)}`);
    }

    let full = "";
    await readSSE(res, (data) => {
      if (data === "[DONE]") return;
      let evt: {
        choices?: Array<{ delta?: { content?: string } }>;
        error?: { message?: string };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) throw new Error(`OpenRouter error: ${evt.error.message ?? "unknown"}`);
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        handlers?.onToken?.(delta);
      }
    });

    if (!full.trim()) throw new Error("OpenRouter returned an empty response.");
    return full;
  }

  async test(signal?: AbortSignal) {
    if (!this.apiKey) return { ok: false, message: "No API key set." };
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal,
      });
      if (res.ok) return { ok: true, message: "Connected — OpenRouter key is valid." };
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
