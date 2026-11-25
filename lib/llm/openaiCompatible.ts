/**
 * OpenAI-compatible providers routed through our /api/llm proxy: OpenAI (GPT),
 * xAI (Grok), z.AI (GLM), NVIDIA NIM, Meta (Llama), Perplexity, and ASU CreateAI.
 * One implementation, parameterised per provider.
 *
 * Thinking-model aware (this is the fix for the "empty answer" bug): reasoning
 * models put their chain-of-thought in a separate `delta.reasoning` /
 * `delta.reasoning_content` field, and the real answer in `delta.content`. We
 * stream reasoning to the live narration and keep only `content` as the answer.
 * Models that instead wrap reasoning in <think>…</think> inside content are
 * handled downstream by extractJson(). A generous max-token budget leaves room
 * for reasoning + answer, and finish_reason is surfaced if the output is empty.
 */

import { LLMProvider, LLMStreamHandlers, readSSE, fromOpenAIUsage, type OpenAIStyleUsage, citationsFrom, type UrlAnnotation } from "./types";

export type ProxyProviderId = "openai" | "xai" | "zai" | "nvidia" | "meta" | "perplexity" | "createai";

interface Cfg {
  label: string;
  /** Newer OpenAI + Meta reasoning models require max_completion_tokens; null = leave it to the model's default. */
  maxTokensParam: "max_tokens" | "max_completion_tokens" | null;
  /** OpenAI reasoning models reject a custom temperature; omit it there. */
  temperature: boolean;
  keyHint: string;
  /** Extra body fields (e.g. disable z.AI's thinking for reliable JSON). */
  extraBody?: Record<string, unknown>;
  /** Accepts stream_options.include_usage (token counts at the end of the stream). */
  streamUsage?: boolean;
}

const CFG: Record<ProxyProviderId, Cfg> = {
  openai: { label: "OpenAI", maxTokensParam: "max_completion_tokens", temperature: false, keyHint: "sk-...", streamUsage: true },
  xai: { label: "xAI (Grok)", maxTokensParam: "max_tokens", temperature: true, keyHint: "xai-...", streamUsage: true },
  // z.AI's GLM defaults to a long "thinking" pass; for a structured JSON task we
  // disable it so the model returns the answer directly (faster, no truncation).
  zai: { label: "z.AI (GLM)", maxTokensParam: "max_tokens", temperature: true, keyHint: "...", extraBody: { thinking: { type: "disabled" } }, streamUsage: true },
  nvidia: { label: "NVIDIA NIM", maxTokensParam: "max_tokens", temperature: true, keyHint: "nvapi-...", streamUsage: true },
  meta: { label: "Meta (Llama)", maxTokensParam: "max_completion_tokens", temperature: true, keyHint: "LLM|..." },
  perplexity: { label: "Perplexity (Sonar)", maxTokensParam: "max_tokens", temperature: true, keyHint: "pplx-..." },
  // ASU CreateAI fronts many vendors' models with very different output caps
  // (2,048 to 128,000 tokens), and some reject a temperature, so both are left
  // to each model's own defaults. It reports cost in its own `metadata`.
  createai: { label: "ASU CreateAI", maxTokensParam: null, temperature: false, keyHint: "your CreateAI project key" },
};

/** CreateAI's per-request report (in `metadata`, beside the usual OpenAI fields). */
interface CreateAIMetadata {
  usage_metric?: {
    input_token_count?: number;
    output_token_count?: number;
    total_token_cost?: number;
    cost_per_month?: number;
    cost_per_month_used?: number;
  };
  model_details?: { inference_provider?: string; inference_model?: string };
}

function createAIUsage(m: CreateAIMetadata | undefined): OpenAIStyleUsage | undefined {
  const u = m?.usage_metric;
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_token_count,
    completion_tokens: u.output_token_count,
    ...(typeof u.total_token_cost === "number" ? { cost: u.total_token_cost } : {}),
  };
}

/** "openai/gpt4_1-mini" from CreateAI's model details, to compare with the model asked for. */
function createAIModelUsed(m: CreateAIMetadata | undefined): string | null {
  const d = m?.model_details;
  return d?.inference_model ? `${d.inference_provider ? d.inference_provider + "/" : ""}${d.inference_model}` : null;
}

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
    };
    if (cfg.maxTokensParam) body[cfg.maxTokensParam] = maxTokens;
    if (cfg.temperature) body.temperature = 0.3;
    if (cfg.extraBody) Object.assign(body, cfg.extraBody);
    // Ask for the token counts at the end of the stream (Perplexity sends them
    // anyway; Meta's API isn't known to accept the option, so it's left alone).
    if (stream && cfg.streamUsage) body.stream_options = { include_usage: true };
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
      throw new Error(`${cfg.label} error ${res.status}: ${explain(this.providerId, res.status, detail)}`);
    }

    // A provider that ignores `stream` answers with one JSON object instead of events.
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      const j = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        usage?: OpenAIStyleUsage;
        metadata?: CreateAIMetadata;
        model?: string;
      };
      const msg = j.choices?.[0]?.message;
      const real = createAIModelUsed(j.metadata) ?? j.model;
      if (real) handlers?.onModel?.(real);
      const text = msg?.content || msg?.reasoning_content || "";
      const u = createAIUsage(j.metadata) ?? j.usage;
      if (u) handlers?.onUsage?.(fromOpenAIUsage(u));
      if (!text.trim()) throw new Error(`${cfg.label} returned no text. Try again, or pick another model.`);
      handlers?.onToken?.(text);
      return text;
    }

    let full = "";
    let reasoningFull = "";
    let answeredBy: string | undefined;
    let realReported = false;
    let finishReason: string | undefined;
    let usage: OpenAIStyleUsage | undefined;

    await readSSE(res, (data) => {
      if (data === "[DONE]") return;
      let evt: {
        choices?: Array<{
          delta?: { content?: string; reasoning?: string; reasoning_content?: string; annotations?: UrlAnnotation[] };
          finish_reason?: string;
        }>;
        usage?: OpenAIStyleUsage;
        /** Perplexity: the pages its search used. */
        search_results?: Array<{ title?: string; url?: string }>;
        citations?: string[];
        error?: { message?: string };
        metadata?: CreateAIMetadata;
        model?: string;
      };
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) throw new Error(`${cfg.label} error: ${evt.error.message ?? "unknown"}`);
      if (evt.usage) usage = evt.usage;
      const pages = [
        ...citationsFrom(evt.choices?.[0]?.delta?.annotations ?? []),
        ...(evt.search_results ?? []).filter((r) => r.url).map((r) => ({ url: r.url!, title: r.title || r.url! })),
        ...(evt.search_results?.length ? [] : (evt.citations ?? []).map((u) => ({ url: u, title: u }))),
      ];
      if (pages.length) handlers?.onCitations?.(pages);
      const billed = createAIUsage(evt.metadata);
      if (billed) usage = billed;
      // CreateAI echoes the requested id in `model`; its metadata names the real one.
      const real = createAIModelUsed(evt.metadata);
      if (real) { answeredBy = real; realReported = true; } else if (evt.model && !realReported) answeredBy = evt.model;
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        reasoningFull += reasoning;
        if (handlers?.onReasoning) handlers.onReasoning(reasoning); else handlers?.onToken?.(reasoning);
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
    if (usage) handlers?.onUsage?.(fromOpenAIUsage(usage));
    if (answeredBy) handlers?.onModel?.(answeredBy);

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
      if (res.ok) {
        if (this.providerId === "createai") {
          const j = (await res.json().catch(() => null)) as { metadata?: CreateAIMetadata } | null;
          const used = createAIModelUsed(j?.metadata);
          const u = j?.metadata?.usage_metric;
          const budget = u && typeof u.cost_per_month === "number"
            ? ` Monthly budget: $${(u.cost_per_month_used ?? 0).toFixed(2)} of $${u.cost_per_month.toFixed(2)} used.`
            : "";
          if (used && !sameModel(used, this.model)) {
            return {
              ok: true,
              message: `Connected, but CreateAI answered with ${used} (your project's model) instead of ${this.model}. To use another model, change it on your project's Basic tab at platform.aiml.asu.edu.${budget}`,
            };
          }
          return { ok: true, message: `Connected — ${cfg.label} key works${used ? ` (model: ${used})` : ""}.${budget}` };
        }
        return { ok: true, message: `Connected — ${cfg.label} key looks valid.` };
      }
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `HTTP ${res.status}: ${explain(this.providerId, res.status, detail)}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "openai/gpt4_1-mini" vs "openai/gpt4_1-mini" or just "gpt4_1-mini". */
const sameModel = (used: string, asked: string) => norm(used.split("/").pop() || used) === norm(asked.split("/").pop() || asked);

/** Plain-words versions of the errors people actually hit. */
function explain(id: ProxyProviderId, status: number, detail: string): string {
  if (id === "createai") {
    if (status === 401 || status === 403) return "CreateAI didn't accept this key. Check it's your project's API key from platform.aiml.asu.edu (Behaviors → Project API Keys).";
    if (status === 429 || /rate_limit/i.test(detail)) return "CreateAI's rate limit or your project's monthly budget has been reached. Wait a minute (or until next month's budget) and press Continue.";
  }
  return truncate(detail);
}

export interface CreateAIModel {
  id: string;
  name: string;
  /** US dollars per million tokens. */
  inPerM: number;
  outPerM: number;
}

/** The models a CreateAI key can use, cheapest first (through our proxy). */
export async function listCreateAIModels(apiKey: string, signal?: AbortSignal): Promise<CreateAIModel[]> {
  const res = await fetch("/api/llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({ provider: "createai", apiKey, list: true }),
  });
  if (!res.ok) throw new Error(explain("createai", res.status, await res.text().catch(() => "")));
  const j = (await res.json()) as {
    data?: Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string } }>;
  };
  return (j.data || [])
    .map((m) => ({ id: m.id, name: m.name || m.id, inPerM: Number(m.pricing?.prompt) * 1e6, outPerM: Number(m.pricing?.completion) * 1e6 }))
    .sort((a, b) => a.inPerM + a.outPerM - (b.inPerM + b.outPerM));
}

function truncate(s: string, n = 240): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
