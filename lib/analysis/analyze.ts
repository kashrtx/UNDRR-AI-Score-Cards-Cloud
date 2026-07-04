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
}

function toReport(pack: DataPack, serviceUp: boolean): DataReport {
  return {
    serviceUp,
    located: pack.resolved?.displayName ?? null,
    dataPoints: pack.dataPoints,
    sources: pack.sources,
    warnings: pack.warnings,
  };
}

function extractJson(text: string): string {
  // Thinking models sometimes embed reasoning in <think>…</think> blocks —
  // strip them so we parse the answer, not the reasoning.
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();
  // Greedy match from the first "{" to the last "}" — the JSON object.
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
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
  const user = buildUserPrompt(scorecard, enrichment, reference);

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
        label: "Retrying without web search…",
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
    // ── 5. One repair attempt ───────────────────────────────
    onProgress?.({
      step: "validate",
      label: "Result needed fixing — asking the AI to correct it…",
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
      onProgress?.({ step: "done", label: "Using a basic fallback analysis.", pct: 100 });
      return { result: buildFallbackResult(scorecard), dataReport };
    }
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
