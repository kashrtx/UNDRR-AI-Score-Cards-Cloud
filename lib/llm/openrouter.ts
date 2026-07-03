/**
 * OpenRouter — OpenAI-compatible, CORS-enabled, with a catalogue of free models
 * (their id ends in ":free"). Free keys at https://openrouter.ai/keys .
 *
 * Thinking-model aware: reasoning models expose their chain-of-thought in a
 * separate `delta.reasoning` field; we stream that to the live narration and
 * keep only `delta.content` as the answer. A generous max_tokens leaves room
 * for reasoning + answer, and finish_reason is surfaced on empty output.
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
        max_tokens: 16384, // headroom for reasoning models
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
    let sawReasoning = false;
    let finishReason: string | undefined;

    await readSSE(res, (data) => {
      if (data === "[DONE]") return;
      let evt: {
        choices?: Array<{
          delta?: { content?: string; reasoning?: string; reasoning_content?: string };
          finish_reason?: string;
        }>;
        error?: { message?: string };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) throw new Error(`OpenRouter error: ${evt.error.message ?? "unknown"}`);
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        sawReasoning = true;
        handlers?.onToken?.(reasoning);
      }
      if (delta?.content) {
        full += delta.content;
        handlers?.onToken?.(delta.content);
      }
    });

    if (!full.trim()) {
      if (finishReason === "length") {
        throw new Error(
          "OpenRouter hit its output-token limit before finishing the answer" +
            (sawReasoning ? " (a reasoning model used the budget)" : "") +
            ". Try again or choose another model."
        );
      }
      throw new Error(
        `OpenRouter returned no answer text${finishReason ? ` (finish_reason: ${finishReason})` : ""}. ` +
          "Some free models are rate-limited or busy — try again or switch model."
      );
    }
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
