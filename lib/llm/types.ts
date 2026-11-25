/**
 * Client-side LLM providers — one streaming interface, four implementations.
 *
 * Every call runs in the browser, so API keys never touch our server, there is
 * no serverless timeout on long analyses, and Ollama (which lives on the
 * visitor's own machine) works naturally.
 */

export interface LLMStreamHandlers {
  /** Called with each incremental text delta of the ANSWER as it streams in. */
  onToken?: (delta: string) => void;
  /**
   * Called with a thinking-model's internal reasoning, separately from the
   * answer. If a caller provides this, providers send reasoning here instead of
   * to onToken, so a chat UI can show a discreet "thinking" indicator without
   * leaking the model's scratchpad into the visible message. Callers that don't
   * provide it keep the old behaviour (reasoning flows into onToken) so the
   * analysis narration still shows life while a reasoning model works.
   */
  onReasoning?: (delta: string) => void;
  /**
   * Called once per completed request with the token counts the provider
   * reported (and, where the provider bills it directly, e.g. OpenRouter, the
   * exact cost). Used for the cost comparison of AI helpers.
   */
  onUsage?: (usage: LLMUsage) => void;
  /**
   * Called with the web pages the provider's own web search used (Gemini
   * grounding, Claude web search, OpenRouter ":online", Perplexity), when the
   * provider reports them. May be called several times per request.
   */
  onCitations?: (pages: Array<{ title: string; url: string }>) => void;
  /**
   * Called with the model that actually answered, when the provider reports it
   * (OpenRouter, ASU CreateAI, LM Studio and the other OpenAI-style APIs). It can
   * differ from the model asked for: CreateAI may use the project's own model.
   */
  onModel?: (model: string) => void;
}

/** The `usage` block OpenAI-style APIs send at the end of a stream. */
export interface OpenAIStyleUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenRouter only: what the request actually cost, in US dollars. */
  cost?: number;
}

export function fromOpenAIUsage(u: OpenAIStyleUsage): LLMUsage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    ...(typeof u.cost === "number" ? { costUsd: u.cost } : {}),
  };
}

/** An OpenAI-style "url_citation" annotation (OpenRouter ":online", OpenAI web search). */
export interface UrlAnnotation {
  type?: string;
  url_citation?: { url?: string; title?: string };
}

export function citationsFrom(annotations: UrlAnnotation[]): Array<{ title: string; url: string }> {
  return annotations
    .filter((a) => a.type === "url_citation" && a.url_citation?.url)
    .map((a) => ({ url: a.url_citation!.url!, title: a.url_citation!.title || a.url_citation!.url! }));
}

/** One request's usage, as reported by the provider. */
export interface LLMUsage {
  inputTokens: number;
  /** Output tokens, including any "thinking" tokens the provider bills as output. */
  outputTokens: number;
  /** The exact amount charged, in US dollars, when the provider reports it. */
  costUsd?: number;
  /** Provider-side web searches billed per search (Claude). */
  webSearches?: number;
  /** The provider didn't report usage for this request (counted, but not priced). */
  unreported?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /** Stream a completion; resolves with the full concatenated text. */
  complete(
    system: string,
    user: string,
    handlers?: LLMStreamHandlers,
    signal?: AbortSignal
  ): Promise<string>;
  /** Lightweight connectivity/credential check for the Settings "Test" button. */
  test(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
}

/**
 * Read a fetch Response body as Server-Sent Events, invoking `onEvent` with the
 * raw `data:` payload of each event (already stripped of the "data:" prefix).
 *
 * Robust to both `\n\n` and `\r\n\r\n` event separators (Google's streaming
 * endpoints use CRLF), and to `data:` payloads split across network chunks.
 */
export async function readSSE(
  res: Response,
  onEvent: (data: string) => void
): Promise<void> {
  if (!res.body) throw new Error("No response body to stream.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushEvent = (raw: string) => {
    // An event may have multiple `data:` lines; join them per the SSE spec.
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trim());
    }
    if (dataLines.length) onEvent(dataLines.join("\n"));
  };

  const boundary = /\r?\n\r?\n/;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let m: RegExpExecArray | null;
    while ((m = boundary.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      flushEvent(rawEvent);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flushEvent(buffer);
}

/** Read a newline-delimited JSON stream (used by Ollama). */
export async function readNdjson(
  res: Response,
  onObject: (obj: unknown) => void
): Promise<void> {
  if (!res.body) throw new Error("No response body to stream.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          onObject(JSON.parse(line));
        } catch {
          /* ignore partial/non-JSON lines */
        }
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      onObject(JSON.parse(tail));
    } catch {
      /* ignore */
    }
  }
}
