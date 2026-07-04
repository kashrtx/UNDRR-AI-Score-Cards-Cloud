/**
 * Gemini (Google AI Studio) — direct browser calls to
 * generativelanguage.googleapis.com, which is CORS-enabled. Free API keys are
 * available at https://aistudio.google.com/apikey .
 *
 * Thinking-model aware: Gemini "thinking" models (2.5/3.x Flash & Pro) spend
 * output tokens on internal reasoning. We therefore (a) request a large output
 * budget so reasoning doesn't starve the answer, (b) route any "thought" parts
 * to the live narration instead of the answer, and (c) surface finishReason /
 * safety blocks in errors instead of a bare "empty response".
 */

import { LLMProvider, LLMStreamHandlers, readSSE } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  constructor(
    readonly model: string,
    private apiKey: string,
    private useWebSearch = false
  ) {}

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
        // Large budget so a thinking model has room to reason AND answer.
        generationConfig: { temperature: 0.3, maxOutputTokens: 65536 },
        // Grounding with Google Search — the model decides when to search,
        // executes automatically, and returns grounded, citable text.
        ...(this.useWebSearch ? { tools: [{ google_search: {} }] } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${truncate(detail)}`);
    }

    let full = "";
    let sawThinking = false;
    let finishReason: string | undefined;
    let blockReason: string | undefined;

    await readSSE(res, (data) => {
      if (!data || data === "[DONE]") return;
      let evt: {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
          finishReason?: string;
        }>;
        promptFeedback?: { blockReason?: string };
        error?: { message?: string };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) throw new Error(`Gemini error: ${evt.error.message ?? "unknown"}`);
      if (evt.promptFeedback?.blockReason) blockReason = evt.promptFeedback.blockReason;

      const cand = evt.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      for (const p of cand?.content?.parts ?? []) {
        if (!p.text) continue;
        if (p.thought) {
          // Internal reasoning — show it live, but keep it out of the answer.
          sawThinking = true;
          handlers?.onToken?.(p.text);
        } else {
          full += p.text;
          handlers?.onToken?.(p.text);
        }
      }
    });

    if (!full.trim()) {
      if (blockReason) {
        throw new Error(`Gemini blocked the request (${blockReason}). Try a different model.`);
      }
      if (finishReason === "MAX_TOKENS") {
        throw new Error(
          "Gemini reached its output-token limit before finishing the answer" +
            (sawThinking ? " (a thinking model used the budget reasoning)" : "") +
            ". Try again, or pick a lighter model such as gemini-3.1-flash-lite."
        );
      }
      // The stream yielded nothing usable — fall back to a single non-streaming
      // request, which avoids any SSE-framing quirks entirely.
      const fallback = await this.generateOnce(system, user, signal);
      if (fallback.text.trim()) return fallback.text;
      if (fallback.blockReason) {
        throw new Error(`Gemini blocked the request (${fallback.blockReason}). Try a different model.`);
      }
      throw new Error(
        `Gemini returned no answer text${
          fallback.finishReason ? ` (finishReason: ${fallback.finishReason})` : ""
        }. Try again or choose another model (e.g. gemini-3.1-flash-lite).`
      );
    }
    return full;
  }

  /** Non-streaming request — used as a fallback and immune to SSE framing. */
  private async generateOnce(
    system: string,
    user: string,
    signal?: AbortSignal
  ): Promise<{ text: string; finishReason?: string; blockReason?: string }> {
    const url = `${BASE}/models/${encodeURIComponent(
      this.model
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 65536 },
        ...(this.useWebSearch ? { tools: [{ google_search: {} }] } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${truncate(detail)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    return {
      text,
      finishReason: data.candidates?.[0]?.finishReason,
      blockReason: data.promptFeedback?.blockReason,
    };
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
