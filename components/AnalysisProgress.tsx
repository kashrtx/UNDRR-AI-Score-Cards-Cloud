"use client";

/**
 * Analysis Progress — replaces the plain spinner with a live checklist so you
 * can see exactly which step the software is on and how long the AI step is
 * taking (its duration is unpredictable, so we show an elapsed timer).
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Circle } from "lucide-react";
import type { ProgressEvent } from "@/lib/types";

const STEPS = [
  { key: "data", label: "Gathering free open data" },
  { key: "llm", label: "AI is analysing the scorecard" },
  { key: "validate", label: "Checking the result" },
  { key: "done", label: "Finishing up" },
];

// which named events mean a given step is complete
const DONE_AT: Record<string, number> = {
  start: 0,
  data: 0,
  "data-done": 1,
  llm: 1,
  validate: 2,
  done: 4,
};

export function AnalysisProgress({ progress }: { progress: ProgressEvent | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const completed = progress ? DONE_AT[progress.step] ?? 0 : 0;
  const pct = progress?.pct ?? 5;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="glass-card p-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-text-primary">Analysing scorecard…</h2>
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
      <p className="text-sm text-accent-400 mb-5">{progress?.label ?? "Starting…"}</p>

      {/* Step checklist */}
      <ul className="space-y-2.5">
        {STEPS.map((s, i) => {
          const isDone = completed > i;
          const isActive = completed === i;
          return (
            <li key={s.key} className="flex items-center gap-2.5 text-sm">
              {isDone ? (
                <CheckCircle2 size={16} className="text-accent-400 shrink-0" />
              ) : isActive ? (
                <Loader2 size={16} className="animate-spin text-accent-400 shrink-0" />
              ) : (
                <Circle size={16} className="text-text-secondary/40 shrink-0" />
              )}
              <span className={isDone || isActive ? "text-text-primary" : "text-text-secondary"}>
                {s.label}
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