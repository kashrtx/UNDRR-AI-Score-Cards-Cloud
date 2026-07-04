/**
 * Claude (Anthropic) — direct browser calls, officially supported via the
 * `anthropic-dangerous-direct-browser-access` header. The key stays in the
 * browser and is sent only to Anthropic.
 *
 * Thinking-model aware: if a model streams extended-thinking blocks, those
 * `thinking_delta` chunks go to the live narration, never the answer, and the
 * final `stop_reason` is surfaced if no answer text arrives.
 */

import { LLMProvider, LLMStreamHandlers, readSSE } from "./types";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  constructor(
    readonly model: string,
    private apiKey: string,
    private useWebSearch = false
  ) {}

  private headers() {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  async complete(
    system: string,
    user: string,
    handlers?: LLMStreamHandlers,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.apiKey) throw new Error("No Anthropic API key set. Add one in Settings.");

    const res = await fetch(API_URL, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        temperature: 0.3,
        system,
        stream: true,
        messages: [{ role: "user", content: user }],
        // Anthropic runs the search server-side and streams the results back;
        // our SSE reader simply ignores the non-text blocks and keeps the
        // final answer text.
        ...(this.useWebSearch
          ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }
          : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Claude API error ${res.status}: ${truncate(detail)}`);
    }

    let full = "";
    let sawThinking = false;
    let stopReason: string | undefined;

    await readSSE(res, (data) => {
      if (data === "[DONE]") return;
      let evt: {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
        error?: { message?: string };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.type === "error") {
        throw new Error(`Claude stream error: ${evt.error?.message ?? "unknown"}`);
      }
      if (evt.type === "content_block_delta") {
        if (evt.delta?.type === "text_delta" && evt.delta.text) {
          full += evt.delta.text;
          handlers?.onToken?.(evt.delta.text);
        } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
          // Extended thinking — show it live, keep it out of the answer.
          sawThinking = true;
          handlers?.onToken?.(evt.delta.thinking);
        }
      } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
        stopReason = evt.delta.stop_reason;
      }
    });

    if (!full.trim()) {
      if (stopReason === "max_tokens") {
        throw new Error(
          "Claude reached its output-token limit before finishing the answer" +
            (sawThinking ? " (extended thinking used the budget)" : "") +
            ". Try again or pick a lighter model."
        );
      }
      throw new Error(
        `Claude returned no answer text${stopReason ? ` (stop_reason: ${stopReason})` : ""}.`
      );
    }
    return full;
  }

  async test(signal?: AbortSignal) {
    if (!this.apiKey) return { ok: false, message: "No API key set." };
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.ok) return { ok: true, message: `Connected — ${this.model} is reachable.` };
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
