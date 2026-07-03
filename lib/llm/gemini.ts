/**
 * Gemini (Google AI Studio) — direct browser calls to
 * generativelanguage.googleapis.com, which is CORS-enabled. Free API keys are
 * available at https://aistudio.google.com/apikey .
 */

import { LLMProvider, LLMStreamHandlers, readSSE } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  constructor(readonly model: string, private apiKey: string) {}

  async complete(
    system: string,
    user: string,
    handlers?: LLMStreamHandlers,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.apiKey) throw new Error("No Google AI Studio API key set. Add one in Settings.");

    const url = `${BASE}/models/${encodeURIComponent(
      this.model
    )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${truncate(detail)}`);
    }

    let full = "";
    await readSSE(res, (data) => {
      if (!data || data === "[DONE]") return;
      let evt: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        error?: { message?: string };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) throw new Error(`Gemini error: ${evt.error.message ?? "unknown"}`);
      const parts = evt.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (p.text) {
          full += p.text;
          handlers?.onToken?.(p.text);
        }
      }
    });

    if (!full.trim()) throw new Error("Gemini returned an empty response.");
    return full;
  }

  async test(signal?: AbortSignal) {
    if (!this.apiKey) return { ok: false, message: "No API key set." };
    try {
      const res = await fetch(
        `${BASE}/models?key=${encodeURIComponent(this.apiKey)}`,
        { signal }
      );
      if (res.ok) return { ok: true, message: "Connected — Google AI Studio key is valid." };
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
