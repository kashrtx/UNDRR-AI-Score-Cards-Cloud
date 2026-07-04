/**
 * OpenAI-compatible providers routed through our /api/llm proxy: OpenAI (GPT),
 * xAI (Grok), z.AI (GLM), NVIDIA NIM, and Meta (Llama). One implementation,
 * parameterised per provider.
 *
 * Thinking-model aware (this is the fix for the "empty answer" bug): reasoning
 * models put their chain-of-thought in a separate `delta.reasoning` /
 * `delta.reasoning_content` field, and the real answer in `delta.content`. We
 * stream reasoning to the live narration and keep only `content` as the answer.
 * Models that instead wrap reasoning in <think>…</think> inside content are
 * handled downstream by extractJson(). A generous max-token budget leaves room
 * for reasoning + answer, and finish_reason is surfaced if the output is empty.
 */

import { LLMProvider, LLMStreamHandlers, readSSE } from "./types";

export type ProxyProviderId = "openai" | "xai" | "zai" | "nvidia" | "meta";

interface Cfg {
  label: string;
  /** Newer OpenAI + Meta reasoning models require max_completion_tokens. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** OpenAI reasoning models reject a custom temperature; omit it there. */
  temperature: boolean;
  keyHint: string;
  /** Extra body fields (e.g. disable z.AI's thinking for reliable JSON). */
  extraBody?: Record<string, unknown>;
}

const CFG: Record<ProxyProviderId, Cfg> = {
  openai: { label: "OpenAI", maxTokensParam: "max_completion_tokens", temperature: false, keyHint: "sk-..." },
  xai: { label: "xAI (Grok)", maxTokensParam: "max_tokens", temperature: true, keyHint: "xai-..." },
  // z.AI's GLM defaults to a long "thinking" pass; for a structured JSON task we
  // disable it so the model returns the answer directly (faster, no truncation).
  zai: { label: "z.AI (GLM)", maxTokensParam: "max_tokens", temperature: true, keyHint: "...", extraBody: { thinking: { type: "disabled" } } },
  nvidia: { label: "NVIDIA NIM", maxTokensParam: "max_tokens", temperature: true, keyHint: "nvapi-..." },
  meta: { label: "Meta (Llama)", maxTokensParam: "max_completion_tokens", temperature: true, keyHint: "LLM|..." },
};

export function proxyKeyHint(id: ProxyProviderId): string {
  return CFG[id].keyHint;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  constructor(
    private providerId: ProxyProviderId,
    readonly model: string,
    private apiKey: string
  ) {
    this.name = providerId;
  }

  private buildBody(system: string, user: string, stream: boolean, maxTokens: number) {
    const cfg = CFG[this.providerId];
    const body: Record<string, unknown> = {
      model: this.model,
      stream,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      [cfg.maxTokensParam]: maxTokens,
    };
    if (cfg.temperature) body.temperature = 0.3;
    if (cfg.extraBody) Object.assign(body, cfg.extraBody);
    return body;
  }

  async complete(
    system: string,
    user: string,
    handlers?: LLMStreamHandlers,
    signal?: AbortSignal
  ): Promise<string> {
    const cfg = CFG[this.providerId];
    if (!this.apiKey) throw new Error(`No ${cfg.label} API key set. Add one in Settings.`);

    const res = await fetch("/api/llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        provider: this.providerId,
        apiKey: this.apiKey,
        body: this.buildBody(system, user, true, 20000),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${cfg.label} error ${res.status}: ${truncate(detail)}`);
    }

    let full = "";
    let reasoningFull = "";
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
      if (evt.error) throw new Error(`${cfg.label} error: ${evt.error.message ?? "unknown"}`);
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        reasoningFull += reasoning;
        handlers?.onToken?.(reasoning);
      }
      if (delta?.content) {
        full += delta.content;
        handlers?.onToken?.(delta.content);
      }
    });

    // Prefer the real answer (content). But some reasoning models (seen with
    // GLM on NIM) stream the whole reply — including the final JSON — into
    // reasoning_content and leave content empty. In that case fall back to the
    // reasoning text so the JSON isn't lost; extractJson() downstream strips any
    // <think> wrapper and pulls the JSON object out.
    const answer = full.trim() ? full : reasoningFull;

    if (!answer.trim()) {
      if (finishReason === "length") {
        throw new Error(
          `${cfg.label} hit its output-token limit before finishing. ` +
            "Try again or pick a lighter (non-reasoning) model."
        );
      }
      throw new Error(
        `${cfg.label} returned no text${finishReason ? ` (finish_reason: ${finishReason})` : ""}. ` +
          "Try again, or pick another model."
      );
    }
    return answer;
  }

  async test(signal?: AbortSignal) {
    const cfg = CFG[this.providerId];
    if (!this.apiKey) return { ok: false, message: "No API key set." };
    try {
      const res = await fetch("/api/llm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          provider: this.providerId,
          apiKey: this.apiKey,
          body: this.buildBody("You are a connectivity check.", "Reply with the single word: ok", false, 16),
        }),
      });
      if (res.ok) return { ok: true, message: `Connected — ${cfg.label} key looks valid.` };
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
