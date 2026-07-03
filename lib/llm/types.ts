/**
 * Client-side LLM providers — one streaming interface, four implementations.
 *
 * Every call runs in the browser, so API keys never touch our server, there is
 * no serverless timeout on long analyses, and Ollama (which lives on the
 * visitor's own machine) works naturally.
 */

export interface LLMStreamHandlers {
  /** Called with each incremental text delta as it streams in. */
  onToken?: (delta: string) => void;
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
 */
export async function readSSE(
  res: Response,
  onEvent: (data: string) => void
): Promise<void> {
  if (!res.body) throw new Error("No response body to stream.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line.
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("data:")) {
          onEvent(trimmed.slice(5).trim());
        }
      }
    }
  }
  // Flush any trailing single-line event.
  const tail = buffer.trim();
  if (tail.startsWith("data:")) onEvent(tail.slice(5).trim());
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
