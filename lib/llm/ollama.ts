/**
 * Ollama — the visitor's own local model. The browser calls
 * http://localhost:11434 directly (on the visitor's machine, not our server),
 * so the model stays fully private and free.
 *
 * For the browser to be allowed to call Ollama, the visitor must start it with
 * their app origin allowed, e.g.:
 *   OLLAMA_ORIGINS="https://your-deployment.vercel.app" ollama serve
 */

import { LLMProvider, LLMStreamHandlers, readNdjson } from "./types";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  constructor(
    readonly model: string,
    private baseUrl: string = "http://localhost:11434"
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
    const url = `${this.base()}/api/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          options: { temperature: 0.3, num_predict: 4096 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (err) {
      throw new Error(
        `Could not reach Ollama at ${this.baseUrl}. Is it running, and did you ` +
          `start it with OLLAMA_ORIGINS set to this site's address? ` +
          `(${err instanceof Error ? err.message : String(err)})`
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Ollama error ${res.status}: ${detail || "no detail"}. ` +
          `Have you run: ollama pull ${this.model}?`
      );
    }

    let full = "";
    await readNdjson(res, (obj) => {
      const o = obj as { message?: { content?: string }; error?: string };
      if (o.error) throw new Error(`Ollama error: ${o.error}`);
      const c = o.message?.content;
      if (c) {
        full += c;
        handlers?.onToken?.(c);
      }
    });

    if (!full.trim()) throw new Error("Ollama returned an empty response.");
    return full;
  }

  async test(signal?: AbortSignal) {
    try {
      const res = await fetch(`${this.base()}/api/tags`, { signal });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} from Ollama.` };
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (data.models ?? []).map((m) => m.name).filter(Boolean) as string[];
      const hasModel = names.some((n) => n === this.model || n.startsWith(this.model + ":"));
      if (hasModel) return { ok: true, message: `Connected — ${this.model} is available.` };
      return {
        ok: true,
        message:
          `Connected to Ollama, but "${this.model}" isn't pulled yet. ` +
          `Run: ollama pull ${this.model}`,
      };
    } catch (err) {
      return {
        ok: false,
        message:
          `Could not reach Ollama at ${this.baseUrl}. Start it with ` +
          `OLLAMA_ORIGINS set to this site's address. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }
}
