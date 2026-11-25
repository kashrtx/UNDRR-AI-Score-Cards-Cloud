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
    type ClaudeUsage = {
      input_tokens?: number; output_tokens?: number;
      cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
      server_tool_use?: { web_search_requests?: number };
    };
    let inTok = 0, outTok = 0, searches = 0;

    await readSSE(res, (data) => {
      if (data === "[DONE]") return;
      let evt: {
        type?: string;
        delta?: {
          type?: string; text?: string; thinking?: string; stop_reason?: string;
          citation?: { url?: string; title?: string };
        };
        content_block?: { type?: string; content?: Array<{ type?: string; url?: string; title?: string }> };
        message?: { usage?: ClaudeUsage };
        usage?: ClaudeUsage;
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
      // Pages Claude's web search found, and the ones its text cites.
      if (evt.type === "content_block_start" && evt.content_block?.type === "web_search_tool_result") {
        const pages = (evt.content_block.content ?? [])
          .filter((r) => r.type === "web_search_result" && r.url)
          .map((r) => ({ url: r.url!, title: r.title || r.url! }));
        if (pages.length) handlers?.onCitations?.(pages);
      }
      if (evt.type === "content_block_delta" && evt.delta?.type === "citations_delta" && evt.delta.citation?.url) {
        handlers?.onCitations?.([{ url: evt.delta.citation.url, title: evt.delta.citation.title || evt.delta.citation.url }]);
      }
      if (evt.type === "content_block_delta") {
        if (evt.delta?.type === "text_delta" && evt.delta.text) {
          full += evt.delta.text;
          handlers?.onToken?.(evt.delta.text);
        } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
          // Extended thinking — show it live, keep it out of the answer.
          sawThinking = true;
          if (handlers?.onReasoning) handlers.onReasoning(evt.delta.thinking); else handlers?.onToken?.(evt.delta.thinking);
        }
      } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
        stopReason = evt.delta.stop_reason;
      }
      // Input tokens arrive with message_start; output (cumulative) with message_delta.
      const u = evt.message?.usage ?? evt.usage;
      if (u) {
        const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        if (input) inTok = input;
        if (u.output_tokens != null) outTok = u.output_tokens;
        if (u.server_tool_use?.web_search_requests != null) searches = u.server_tool_use.web_search_requests;
      }
    });
    handlers?.onUsage?.({ inputTokens: inTok, outputTokens: outTok, ...(searches ? { webSearches: searches } : {}) });

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
