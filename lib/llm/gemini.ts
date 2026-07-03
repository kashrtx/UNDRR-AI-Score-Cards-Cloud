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
        // Large budget so a thinking model has room to reason AND answer.
        generationConfig: { temperature: 0.3, maxOutputTokens: 65536 },
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
            ". Try again, or pick a lighter model such as gemini-2.0-flash."
        );
      }
      throw new Error(
        `Gemini returned no answer text${finishReason ? ` (finishReason: ${finishReason})` : ""}. ` +
          "Try again or choose another model."
      );
    }
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
