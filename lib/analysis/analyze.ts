/**
 * Analysis orchestrator (runs entirely in the browser).
 *
 * Flow:
 *   1. Fetch the open-data evidence bundle from /api/data/fetch
 *   2. Build the grounded system + user prompts
 *   3. Stream the completion from the selected LLM provider
 *   4. Extract JSON, validate against the AnalysisResult schema (Zod)
 *   5. One repair attempt if invalid; otherwise a deterministic fallback
 * Progress events feed the AnalysisProgress checklist; streamed tokens feed the
 * live narration.
 */

import { AnalysisResultSchema, type AnalysisResult } from "./schema";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { createProvider } from "@/lib/llm";
import { fetchDataPack, fetchReferenceFacts } from "@/lib/client/api";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import { providerSupportsWebSearch, getSearchKey, type AppSettings } from "@/lib/settings/store";
import type { DataPack, DataReport, NormalizedDatum, ProgressEvent, ReferenceFacts } from "@/lib/types";

export interface AnalyzeHandlers {
  onProgress?: (p: ProgressEvent) => void;
  onDataReport?: (d: DataReport) => void;
  onNarration?: (fullTextSoFar: string) => void;
  signal?: AbortSignal;
  /** Extra local facts/data the user supplied (e.g. via the copilot) to fold in. */
  extraContext?: string;
  /** The previous analysis summary, for continuity on a refine re-run. */
  priorSummary?: string;
}

function toReport(pack: DataPack, serviceUp: boolean): DataReport {
  return {
    serviceUp,
    located: pack.resolved?.displayName ?? null,
    dataPoints: pack.dataPoints,
    sources: pack.sources,
    warnings: pack.warnings,
    data: pack.data,
  };
}

function extractJson(text: string): string {
  let cleaned = text;
  // Reasoning models wrap their chain-of-thought in <think>…</think>. The real
  // answer is whatever comes AFTER the final </think>, so cut there first (this
  // also handles a truncated/unclosed opening <think> with content after it).
  if (/<\/think>/i.test(cleaned)) {
    cleaned = cleaned.split(/<\/think>/i).pop() ?? cleaned;
  }
  // Remove any remaining think blocks or stray tags.
  cleaned = cleaned
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
  // Prefer a fenced ```json block if present.
  const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();
  // Otherwise take the outermost { … } object.
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

/** Best-effort JSON parse: strict first, then a light repair pass. */
function looseParse(raw: string): unknown | null {
  const text = extractJson(raw);
  try {
    return JSON.parse(text);
  } catch {
    // Common model slips: trailing commas, smart quotes.
    const repaired = text
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

const COST_TIERS = ["$0–100k", "$100k–500k", "$500k–1M", "$1M–10M", ">$10M"];
const PHASES = ["Now", "Next", "Later"];
const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/**
 * Build a valid AnalysisResult from a possibly-partial or partly-broken object.
 * Whatever the model got right is kept; any missing or malformed section falls
 * back to the deterministic computed defaults, so one bad field never sinks the
 * whole report. Returns null only if there's nothing usable at all.
 */
function coerceResult(parsed: unknown, scorecard: NormalizedScorecard): AnalysisResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const base = buildFallbackResult(scorecard);

  const coerceStatements = (v: unknown): AnalysisResult["strengths"] | null => {
    if (!Array.isArray(v)) return null;
    const out = v
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const o = it as Record<string, unknown>;
        const text = typeof o.text === "string" ? o.text.trim() : "";
        if (!text) return null;
        const refs = Array.isArray(o.sourceRefs) ? o.sourceRefs.map((r) => String(r)) : [];
        const conf = o.confidence === "high" || o.confidence === "medium" || o.confidence === "low" ? o.confidence : undefined;
        return { text, sourceRefs: refs, confidence: conf };
      })
      .filter(Boolean) as AnalysisResult["strengths"];
    return out.length ? out : null;
  };

  const summary = typeof p.summary === "string" && p.summary.trim() ? p.summary.trim() : base.summary;

  let riskProfile = base.riskProfile;
  if (p.riskProfile && typeof p.riskProfile === "object") {
    const r = p.riskProfile as Record<string, unknown>;
    if (typeof r.hazard === "string" && typeof r.exposure === "string" && typeof r.vulnerability === "string") {
      riskProfile = { hazard: r.hazard, exposure: r.exposure, vulnerability: r.vulnerability };
    }
  }

  const strengths = coerceStatements(p.strengths) ?? base.strengths;
  const weaknesses = coerceStatements(p.weaknesses) ?? base.weaknesses;

  let actions = base.actions;
  if (Array.isArray(p.actions)) {
    const coerced = p.actions
      .map((it, idx): AnalysisResult["actions"][number] | null => {
        if (!it || typeof it !== "object") return null;
        const o = it as Record<string, unknown>;
        const title = typeof o.title === "string" ? o.title.trim() : "";
        if (!title) return null;
        const costTier = COST_TIERS.includes(String(o.costTier)) ? (o.costTier as AnalysisResult["actions"][number]["costTier"]) : "$100k–500k";
        const phase = PHASES.includes(String(o.phase)) ? (o.phase as AnalysisResult["actions"][number]["phase"]) : "Next";
        return {
          n: clampInt(o.n, 1, 999, idx + 1),
          title,
          essential: clampInt(o.essential, 1, 10, 1),
          gap: typeof o.gap === "string" ? o.gap : "",
          impact: clampInt(o.impact, 1, 5, 3) as AnalysisResult["actions"][number]["impact"],
          difficulty: clampInt(o.difficulty, 1, 5, 3) as AnalysisResult["actions"][number]["difficulty"],
          costTier,
          phase,
          scoreDelta: clampInt(o.scoreDelta, 0, 100, 1),
          sourceRefs: Array.isArray(o.sourceRefs) ? o.sourceRefs.map((r) => String(r)) : [],
        };
      })
      .filter(Boolean) as AnalysisResult["actions"];
    if (coerced.length) actions = coerced;
  }

  let projection = base.projection;
  if (p.projection && typeof p.projection === "object") {
    const pr = p.projection as Record<string, unknown>;
    const cur = typeof pr.current === "number" ? pr.current : scorecard.total;
    const pot = typeof pr.potential === "number" ? pr.potential : base.projection.potential;
    projection = { current: cur, potential: Math.max(cur, Math.min(scorecard.totalMax, pot)) };
  }

  return { summary, riskProfile, strengths, weaknesses, actions, projection };
}

export async function runAnalysis(
  scorecard: NormalizedScorecard,
  settings: AppSettings,
  handlers: AnalyzeHandlers = {}
): Promise<{ result: AnalysisResult; dataReport: DataReport }> {
  const { onProgress, onDataReport, onNarration, signal } = handlers;

  // ── 1. Fetch open data ────────────────────────────────────
  onProgress?.({ step: "data", label: "Gathering free open data…", pct: 8 });
  let enrichment: NormalizedDatum[] = [];
  let dataReport: DataReport;
  try {
    const pack = await fetchDataPack(scorecard.city.name, scorecard.city.country);
    enrichment = pack.data;
    dataReport = toReport(pack, true);
  } catch (err) {
    dataReport = {
      serviceUp: false,
      located: null,
      dataPoints: 0,
      sources: [],
      warnings: [
        `Open-data lookup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Continuing with the scorecard alone.",
      ],
    };
  }
  onDataReport?.(dataReport);

  // ── 1b. Research step — verify the city against Wikipedia/Wikidata ──
  // Universal grounding that works for every provider (even local models that
  // can't browse). Best-effort: null on any failure.
  onProgress?.({
    step: "data-done",
    label: `Found ${dataReport.dataPoints} open-data point(s). Researching ${scorecard.city.name} on the web…`,
    pct: 30,
    indeterminate: true,
  });
  let reference: ReferenceFacts | null = null;
  try {
    // Only use the pasted Tavily key when the toggle is on; otherwise the
    // research step stays keyless (Wikipedia + DuckDuckGo / SearXNG env).
    const searchKey = settings.useTavily ? await getSearchKey() : null;
    reference = await fetchReferenceFacts(
      scorecard.city.name,
      scorecard.city.country,
      searchKey
    );
  } catch {
    reference = null;
  }
  if (reference) {
    dataReport = { ...dataReport, reference };
    onDataReport?.(dataReport);
  }
  const refMethod = reference?.webSearchMethod;
  const refCount = reference?.sources?.length ?? 0;
  onProgress?.({
    step: "research-done",
    label: refCount
      ? `Found ${refCount} reference source(s)${refMethod ? ` · web search: ${refMethod}` : ""}. Preparing the AI…`
      : "No extra references found. Preparing the AI…",
    pct: 40,
  });

  // ── 2. Build prompts ──────────────────────────────────────
  const system = buildSystemPrompt();
  const user = buildUserPrompt(scorecard, enrichment, reference, handlers.extraContext, handlers.priorSummary);

  // ── 3. Stream from the provider ───────────────────────────
  const provider = await createProvider(settings);
  onProgress?.({
    step: "llm",
    label: `${provider.name} is analysing${settings.webSearch && providerSupportsWebSearch(settings.provider) ? " (with web search)" : ""}…`,
    pct: 45,
    indeterminate: true,
  });

  let narration = "";
  const onToken = (delta: string) => {
    narration += delta;
    onNarration?.(narration);
  };

  let raw: string;
  try {
    raw = await provider.complete(system, user, { onToken }, signal);
  } catch (err) {
    // If web search was on, it may be the culprit — retry once WITHOUT it so
    // enabling search can never do worse than the plain call.
    if (
      !signal?.aborted &&
      settings.webSearch &&
      providerSupportsWebSearch(settings.provider)
    ) {
      onProgress?.({
        step: "llm",
        label: "Taking a second pass for reliability…",
        pct: 45,
        indeterminate: true,
      });
      narration = "";
      const plain = await createProvider(settings, { webSearch: false });
      raw = await plain.complete(system, user, { onToken }, signal);
    } else {
      throw err;
    }
  }

  // ── 4. Validate ───────────────────────────────────────────
  onProgress?.({ step: "validate", label: "Checking the AI's result…", pct: 85 });
  try {
    const parsed = JSON.parse(extractJson(raw));
    const result = AnalysisResultSchema.parse(parsed);
    onProgress?.({ step: "done", label: "Done.", pct: 100 });
    return { result, dataReport };
  } catch (firstErr) {
    const rawTrim = raw.trim();
    const looksComplete = rawTrim.endsWith("}") && rawTrim.includes('"projection"');

    if (looksComplete) {
      // ── 5. One repair attempt for a complete-but-malformed response ──
      onProgress?.({
        step: "validate",
        label: "Tidying up the AI's result…",
        pct: 90,
        indeterminate: true,
      });
      const repairPrompt =
        "Your previous response was not valid JSON matching the required schema.\n" +
        `Error: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}\n\n` +
        `Previous response:\n${raw}\n\n` +
        "Reply with ONLY the corrected JSON object (summary, strengths, weaknesses, actions, projection). No prose, no markdown.";
      try {
        const repairProvider = await createProvider(settings, { webSearch: false });
        const repaired = await repairProvider.complete(system, repairPrompt, undefined, signal);
        const parsed = JSON.parse(extractJson(repaired));
        const result = AnalysisResultSchema.parse(parsed);
        onProgress?.({ step: "done", label: "Done.", pct: 100 });
        return { result, dataReport };
      } catch {
        /* fall through to salvage */
      }
    }

    // ── 5b. SALVAGE: keep whatever parsed correctly, fill only the broken
    // parts with computed defaults. One bad field never sinks the whole report.
    const salvaged = coerceResult(looseParse(raw), scorecard);
    if (salvaged) {
      // Only flag a problem if a major section actually had to be defaulted.
      const baseCmp = buildFallbackResult(scorecard);
      const degraded =
        salvaged.summary === baseCmp.summary ||
        (salvaged.strengths === baseCmp.strengths && salvaged.weaknesses === baseCmp.weaknesses);
      if (degraded && salvaged.summary !== baseCmp.summary) {
        salvaged.summary =
          "Note: part of the AI's response could not be read, so a few sections below fall back to a basic computed version. The rest is the AI's own analysis. " +
          salvaged.summary;
      }
      onProgress?.({ step: "done", label: "Done (recovered a partial response).", pct: 100 });
      return { result: salvaged, dataReport };
    }

    // ── 6. Deterministic fallback (always returns a usable analysis) ──
    onProgress?.({ step: "done", label: "Using a basic fallback analysis.", pct: 100 });
    const fallback = buildFallbackResult(scorecard);
    if (!looksComplete) {
      fallback.summary =
        `The AI's response was cut off before it finished, so a basic analysis is shown instead. ` +
        `This usually means the model was too slow to finish within the hosting time limit, common with heavy "reasoning" models on a free plan. ` +
        `Try re-running, or pick a faster model (for example a non-reasoning model, or Gemini/OpenRouter which run without the proxy) in Settings. ` +
        fallback.summary;
    }
    return { result: fallback, dataReport };
  }
}

// ── Deterministic fallback if the model can't return valid JSON ──
export function buildFallbackResult(scorecard: NormalizedScorecard): AnalysisResult {
  const weakest = [...scorecard.essentials]
    .sort((a, b) => a.score / a.max - b.score / b.max)
    .slice(0, 3);
  const strongest = [...scorecard.essentials]
    .sort((a, b) => b.score / b.max - a.score / a.max)
    .slice(0, 2);
  const zero = scorecard.indicators.filter((i) => i.score === 0);

  return {
    summary:
      `${scorecard.city.name} scored ${scorecard.total}/${scorecard.totalMax} ` +
      `(${Math.round((scorecard.total / scorecard.totalMax) * 100)}%) on the Disaster Resilience Scorecard. ` +
      "This is a basic analysis generated because the AI model did not return a valid structured response. " +
      "Please retry, or check your provider/API key in Settings.",
    strengths: strongest.map((e) => ({
      text: `Essential ${e.num} (${e.name}) is the strongest area at ${Math.round((e.score / e.max) * 100)}%.`,
      sourceRefs: scorecard.indicators
        .filter((i) => i.essential === e.num && i.score >= 2)
        .map((i) => i.code),
    })),
    weaknesses: [
      ...weakest.map((e) => ({
        text: `Essential ${e.num} (${e.name}) is weak at ${Math.round((e.score / e.max) * 100)}%.`,
        sourceRefs: scorecard.indicators
          .filter((i) => i.essential === e.num && i.score <= 1)
          .map((i) => i.code),
      })),
      ...zero.map((i) => ({
        text: `Indicator ${i.code} (${i.text}) scored 0/3 — a critical gap.`,
        sourceRefs: [i.code],
      })),
    ],
    actions: zero.slice(0, 5).map((ind, idx) => ({
      n: idx + 1,
      title: `Address critical gap: ${ind.text}`,
      essential: ind.essential,
      gap: `${ind.code} scored 0/3`,
      impact: 4,
      difficulty: 3,
      costTier: "$100k–500k" as const,
      phase: idx < 2 ? ("Now" as const) : idx < 4 ? ("Next" as const) : ("Later" as const),
      scoreDelta: 2,
      sourceRefs: [ind.code],
    })),
    projection: {
      current: scorecard.total,
      potential: Math.min(scorecard.totalMax, scorecard.total + zero.length * 2),
    },
  };
}
