"use client";

/**
 * Analysis Progress, a live, self-narrating checklist. Each step shows a
 * dynamic sub-line reflecting what actually happened (open-data points found,
 * which web-search method ran and how many sources, etc.) so the user is always
 * in the loop, no static placeholders.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Circle } from "lucide-react";
import type { ProgressEvent, DataReport } from "@/lib/types";

const STEPS = [
  { key: "data", label: "Gathering free public data about the city" },
  { key: "research", label: "Reading up on the city online" },
  { key: "llm", label: "The AI is working through the scorecard" },
  { key: "validate", label: "Double-checking what it found" },
  { key: "done", label: "Finishing up" },
];

// which named events mean a given step is complete
const DONE_AT: Record<string, number> = {
  start: 0,
  data: 0,
  "data-done": 1,
  research: 1,
  "research-done": 2,
  llm: 2,
  validate: 3,
  done: 5,
};

export function AnalysisProgress({
  progress,
  dataReport,
  tavilyOn = false,
  hasContext = false,
}: {
  progress: ProgressEvent | null;
  dataReport?: DataReport | null;
  tavilyOn?: boolean;
  hasContext?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // On a refine re-run, show the user's added data as the first step so it's
  // obvious their facts are being folded in.
  const steps = hasContext ? [{ key: "context", label: "Folding in the data you added" }, ...STEPS] : STEPS;
  const offset = hasContext ? 1 : 0;
  const completed = (progress ? (DONE_AT[progress.step] ?? 0) + offset : 0);
  const pct = progress?.pct ?? 5;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const ref = dataReport?.reference;

  // Dynamic sub-line for each step, based on real state.
  const detailFor = (key: string, isDone: boolean, isActive: boolean): string | null => {
    if (key === "data") {
      if (isDone) return `${dataReport?.dataPoints ?? 0} open-data point(s) found`;
      if (isActive) return "contacting open-data sources…";
    }
    if (key === "research") {
      // Wikipedia + Wikidata are only used on the keyless path. When a live web
      // RAG (Tavily / SearXNG) is on, it's the sole source, so don't imply
      // Wikipedia was used.
      if (ref) {
        const m = ref.webSearchMethod;
        const label =
          m === "Tavily" || m === "SearXNG"
            ? m
            : m === "DuckDuckGo"
            ? "Wikipedia + DuckDuckGo"
            : "Wikipedia";
        return `${label} · ${ref.sources.length} source(s)`;
      }
      if (isActive) return tavilyOn ? "searching the live web (Tavily)…" : "searching Wikipedia + web…";
      if (isDone) return tavilyOn ? "Tavily" : "Wikipedia";
    }
    if (key === "llm") {
      if (isActive) return "streaming the analysis… (this is the long part)";
    }
    return null;
  };

  return (
    <div className="glass-card p-6 sm:p-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent-500" />
          </span>
          Analysing scorecard…
        </h2>
        <span className="text-sm font-mono text-text-secondary" aria-label="elapsed time">
          {mm}:{ss}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-surface-overlay overflow-hidden mb-5">
        <div
          className="h-full bg-gradient-to-r from-accent-500 to-accent-400 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Live message */}
      <p className="text-sm text-accent-400 mb-5 min-h-[1.25rem] transition-all">
        {progress?.label ?? "Starting…"}
      </p>

      {/* Step checklist with dynamic detail */}
      <ul className="space-y-3">
        {steps.map((s, i) => {
          const isDone = completed > i;
          const isActive = completed === i;
          const detail = detailFor(s.key, isDone, isActive);
          return (
            <li key={s.key} className="flex items-start gap-2.5 text-sm">
              {isDone ? (
                <CheckCircle2 size={16} className="text-accent-400 shrink-0 mt-0.5" />
              ) : isActive ? (
                <Loader2 size={16} className="animate-spin text-accent-400 shrink-0 mt-0.5" />
              ) : (
                <Circle size={16} className="text-text-secondary/40 shrink-0 mt-0.5" />
              )}
              <span className="flex-1">
                <span className={isDone || isActive ? "text-text-primary" : "text-text-secondary"}>
                  {s.label}
                </span>
                {detail && (
                  <span className="block text-xs text-text-secondary mt-0.5">{detail}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-text-secondary mt-5">
        This usually takes <strong className="text-text-primary">about 5 minutes or less</strong>,
        depending on the AI model. It can take longer with a local model, or when a cloud provider is
        busy or under heavy demand. You can leave this running.
      </p>
    </div>
  );
}
