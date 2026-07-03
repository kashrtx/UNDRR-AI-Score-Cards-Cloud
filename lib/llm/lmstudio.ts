/**
 * LM Studio — the visitor's own local model via LM Studio's built-in server.
 *
 * LM Studio exposes an OpenAI-compatible API (default http://127.0.0.1:1234/v1)
 * with CORS enabled by default, so — unlike Ollama — it usually "just works"
 * from a hosted site with no origin flags. No API key is required.
 *
 * Thinking-model aware: reasoning is streamed to the live narration (from a
 * `delta.reasoning`/`reasoning_content` field), and <think>…</think> blocks
 * embedded in the content are stripped by the analysis layer before parsing.
 */

import { LLMProvider, LLMStreamHandlers, readSSE } from "./types";

export class LMStudioProvider implements LLMProvider {
  readonly name = "lmstudio";
  constructor(
    readonly model: string,
    private baseUrl: string = "http://127.0.0.1:1234/v1"
  ) {}

  private base() {
    return this.baseUrl.replace(/\/+$/, "");
  }

  async complete(
    system: string,
    user: string,
    handlers?: LLMStreamHandlers,
    signal?: AbortSignal
  ): Promise<string> {
    const url = `${this.base()}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // LM Studio ignores auth, but sending a token keeps some proxies happy.
        headers: { "content-type": "application/json", authorization: "Bearer lm-studio" },
        signal,
        body: JSON.stringify({
          model: this.model || "local-model",
          temperature: 0.3,
          max_tokens: -1, // let the loaded model use its full context
          stream: true,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (err) {
      throw new Error(
        `Could not reach LM Studio at ${this.baseUrl}. In LM Studio, open the ` +
          `Developer tab, load a model and Start Server (default port 1234). ` +
          `(${err instanceof Error ? err.message : String(err)})`
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LM Studio error ${res.status}: ${detail || "no detail"}`);
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
        error?: { message?: string } | string;
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) {
        const msg = typeof evt.error === "string" ? evt.error : evt.error.message;
        throw new Error(`LM Studio error: ${msg ?? "unknown"}`);
      }
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
      if (reasoning) {
        sawReasoning = true;
        handlers?.onToken?.(reasoning);
      }
      if (choice?.delta?.content) {
        full += choice.delta.content;
        handlers?.onToken?.(choice.delta.content);
      }
    });

    if (!full.trim()) {
      throw new Error(
        "LM Studio returned no answer text" +
          (sawReasoning ? " (the model produced only reasoning)" : "") +
          (finishReason ? ` (finish_reason: ${finishReason})` : "") +
          ". Make sure a model is loaded in LM Studio, then try again."
      );
    }
    return full;
  }

  async test(signal?: AbortSignal) {
    try {
      const res = await fetch(`${this.base()}/models`, {
        headers: { authorization: "Bearer lm-studio" },
        signal,
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} from LM Studio.` };
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      if (!ids.length) {
        return { ok: true, message: "Connected to LM Studio, but no model is loaded yet. Load one in LM Studio." };
      }
      const match =
        !this.model || ids.some((id) => id === this.model || id.includes(this.model));
      return {
        ok: true,
        message: match
          ? `Connected — LM Studio has ${ids.length} model(s) loaded.`
          : `Connected, but "${this.model}" isn't loaded. Loaded: ${ids.slice(0, 3).join(", ")}.`,
      };
    } catch (err) {
      return {
        ok: false,
        message:
          `Could not reach LM Studio at ${this.baseUrl}. Start its server ` +
          `(Developer tab → Start Server). (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }
}
