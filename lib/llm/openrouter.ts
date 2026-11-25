/**
 * OpenRouter — OpenAI-compatible, CORS-enabled, with a catalogue of free models
 * (their id ends in ":free"). Free keys at https://openrouter.ai/keys .
 *
 * Thinking-model aware: reasoning models expose their chain-of-thought in a
 * separate `delta.reasoning` field; we stream that to the live narration and
 * keep only `delta.content` as the answer. A generous max_tokens leaves room
 * for reasoning + answer, and finish_reason is surfaced on empty output.
 */

import { LLMProvider, LLMStreamHandlers, readSSE, fromOpenAIUsage, citationsFrom, type OpenAIStyleUsage, type UrlAnnotation } from "./types";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  constructor(
    readonly model: string,
    private apiKey: string,
    private useWebSearch = false
  ) {}

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
        // The ":online" suffix enables OpenRouter's web search for any model,
        // incorporating cited real-time results into the response. It's billed
        // per request even on free models, so free (":free") models never get
        // it: they stay free, and the app's own research still feeds them.
        model:
          this.useWebSearch && !this.model.endsWith(":online") && !this.model.endsWith(":free")
            ? `${this.model}:online`
            : this.model,
        temperature: 0.3,
        max_tokens: 16384, // headroom for reasoning models
        stream: true,
        usage: { include: true }, // the final chunk reports tokens and the exact cost
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(res.status === 401 ? authProblem(this.apiKey, detail) : `OpenRouter API error ${res.status}: ${truncate(detail)}`);
    }

    let full = "";
    let sawReasoning = false;
    let answeredBy: string | undefined;
    let finishReason: string | undefined;
    let usage: OpenAIStyleUsage | undefined;

    await readSSE(res, (data) => {
      if (data === "[DONE]") return;
      let evt: {
        choices?: Array<{
          delta?: { content?: string; reasoning?: string; reasoning_content?: string; annotations?: UrlAnnotation[] };
          message?: { annotations?: UrlAnnotation[] };
          finish_reason?: string;
        }>;
        usage?: OpenAIStyleUsage;
        error?: { message?: string };
        model?: string;
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) throw new Error(`OpenRouter error: ${evt.error.message ?? "unknown"}`);
      if (evt.model) answeredBy = evt.model;
      if (evt.usage) usage = evt.usage;
      // ":online" web search: the pages it used.
      const pages = citationsFrom([...(evt.choices?.[0]?.delta?.annotations ?? []), ...(evt.choices?.[0]?.message?.annotations ?? [])]);
      if (pages.length) handlers?.onCitations?.(pages);
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        sawReasoning = true;
        if (handlers?.onReasoning) handlers.onReasoning(reasoning); else handlers?.onToken?.(reasoning);
      }
      if (delta?.content) {
        full += delta.content;
        handlers?.onToken?.(delta.content);
      }
    });

    if (usage) handlers?.onUsage?.(fromOpenAIUsage(usage));
    if (answeredBy) handlers?.onModel?.(answeredBy);

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
      // /key needs a working key (the public /models list answers any key at all).
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal,
      });
      if (res.ok) return { ok: true, message: "Connected — OpenRouter key is valid." };
      const detail = await res.text().catch(() => "");
      if (res.status === 401) return { ok: false, message: authProblem(this.apiKey, detail) };
      return { ok: false, message: `HTTP ${res.status}: ${truncate(detail)}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** A 401 in plain words: the usual cause is a key from another service, or a revoked one. */
function authProblem(key: string, detail: string): string {
  if (!/^sk-or-/.test(key.trim())) {
    return "That isn't an OpenRouter key (they start with \"sk-or-v1-\"). It may be a key for a different service: paste it under that provider in Settings, or get a free OpenRouter key at openrouter.ai/keys.";
  }
  if (/user not found/i.test(detail)) {
    return "OpenRouter doesn't recognise this key (it may have been deleted or mistyped). Create a new one at openrouter.ai/keys and paste it in Settings.";
  }
  return `OpenRouter rejected the key (401): ${truncate(detail)}`;
}

function truncate(s: string, n = 240): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
