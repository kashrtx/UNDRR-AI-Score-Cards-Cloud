"use client";

/**
 * Small linked chips for the datasets (chosen in Settings, Step 3) that a note,
 * search or analysis statement cites, so it's visible which answers rest on the
 * user's own data sources and which fell back to general evidence.
 */

import { Database, Globe, Paperclip } from "lucide-react";
import { citedSources, selectedDataSources, shortName, type DataSourceInfo } from "@/lib/data/catalog";
import { siteName, isAttachment, type WebSource } from "@/lib/agent/sources";
import type { ScoreBasis } from "@/lib/agent/draft";
import type { AnalysisResult } from "@/lib/analysis/schema";

export function DataSourceChips({ sources, size = "sm" }: { sources: DataSourceInfo[]; size?: "sm" | "xs" }) {
  if (!sources.length) return null;
  const text = size === "xs" ? "text-[10px]" : "text-[11px]";
  return (
    <span className="inline-flex flex-wrap gap-1">
      {sources.map((d) => (
        <a
          key={d.id}
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`${d.name} (${d.provider}), one of your chosen data sources. Opens the dataset.`}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md ${text} font-medium
                      bg-accent-500/10 text-accent-400 border border-accent-500/25 hover:bg-accent-500/20`}
        >
          <Database size={size === "xs" ? 9 : 10} />
          {shortName(d)}
        </a>
      ))}
    </span>
  );
}

/**
 * Blue linked chips for the web pages and open datasets an answer rests on
 * (found by the AI's research and searches, not one of the sources chosen in
 * Settings, which are green).
 */
export function WebSourceChips({ sources, size = "sm" }: { sources: WebSource[]; size?: "sm" | "xs" }) {
  if (!sources.length) return null;
  const text = size === "xs" ? "text-[10px]" : "text-[11px]";
  return (
    <span className="inline-flex flex-wrap gap-1">
      {sources.map((s) => isAttachment(s) ? (
        <span
          key={s.url}
          title={`${s.title}: a document you attached.`}
          className={`inline-flex items-center gap-1 max-w-[16rem] px-1.5 py-0.5 rounded-md ${text} font-medium
                      bg-primary-500/10 text-primary-300 border border-primary-500/25`}
        >
          <Paperclip size={size === "xs" ? 9 : 10} className="shrink-0" />
          <span className="truncate">{siteName(s.url)}</span>
        </span>
      ) : (
        <a
          key={s.url}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`${s.title}\n${s.url}\nFound by the AI's research (not one of your chosen data sources). Opens the page.`}
          className={`inline-flex items-center gap-1 max-w-[16rem] px-1.5 py-0.5 rounded-md ${text} font-medium
                      bg-primary-500/10 text-primary-300 border border-primary-500/25 hover:bg-primary-500/20`}
        >
          <Globe size={size === "xs" ? 9 : 10} className="shrink-0" />
          <span className="truncate">{siteName(s.url)}</span>
        </a>
      ))}
    </span>
  );
}

const BASIS: Record<ScoreBasis | "none", { label: string; title: string; cls: string }> = {
  general: {
    label: "AI general knowledge",
    title: "The AI based this on its own background knowledge, which has no source it can point to. Worth checking.",
    cls: "bg-surface-overlay border-border text-text-secondary",
  },
  user: {
    label: "from your notes or chat",
    title: "The AI based this on what you wrote in the setup notes or the chat.",
    cls: "bg-surface-overlay border-border text-text-secondary",
  },
  assumption: {
    label: "AI's educated guess",
    title: "Nothing traceable supported this answer, so the AI made an educated guess (educated guesses are turned on in Settings). Check it against local knowledge.",
    cls: "bg-warn-500/10 border-warn-500/25 text-warn-400",
  },
  none: {
    label: "no source cited",
    title: "This answer names no source or basis (answers from before sources were tracked, uploaded from a file, or edited by hand).",
    cls: "bg-surface-overlay border-border text-text-secondary",
  },
};

/** What an answer that cites no source rests on. */
export function BasisTag({ basis }: { basis?: ScoreBasis | null }) {
  const b = BASIS[basis ?? "none"];
  return (
    <span title={b.title} className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${b.cls}`}>
      {b.label}
    </span>
  );
}

/**
 * Analysis tab: the data sources chosen for this run and where the analysis
 * cites them (sourceRefs and text of the risk lens, strengths, weaknesses and
 * actions), so it's explicit whether the AI actually used them.
 */
export function AnalysisSourceUse({ result }: { result: AnalysisResult }) {
  const chosen = selectedDataSources(result.dataSources);
  if (!chosen.length) return null;
  const items: string[][] = [
    ...(result.riskProfile ? [[result.riskProfile.hazard, result.riskProfile.exposure, result.riskProfile.vulnerability]] : []),
    ...result.strengths.map((s) => [s.text, ...s.sourceRefs]),
    ...result.weaknesses.map((w) => [w.text, ...w.sourceRefs]),
    ...result.actions.map((a) => [a.title, a.gap, ...a.sourceRefs]),
  ];
  const count = new Map<string, number>();
  let citing = 0;
  for (const it of items) {
    const cited = citedSources(it, result.dataSources);
    if (cited.length) citing++;
    for (const d of cited) count.set(d.id, (count.get(d.id) ?? 0) + 1);
  }
  return (
    <div className="mt-5 rounded-xl border border-accent-500/25 bg-accent-500/5 p-3 text-xs">
      <h3 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-1.5">
        <Database size={14} className="text-accent-400" /> Your data sources
      </h3>
      <p className="text-text-secondary mb-2">
        {citing === 0
          ? "This analysis was asked to rely on these first, but none of its statements cite them, so it rests on general evidence. Try re-running, or a stronger model."
          : `${citing} of ${items.length} statements (risk lens, strengths, weaknesses and actions) cite one of the sources you chose in Settings (Step 3). Look for the green links next to each statement.`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {chosen.map((d) => {
          const n = count.get(d.id) ?? 0;
          return (
            <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer" title={`${d.name} (${d.provider})`}
              className={`px-1.5 py-0.5 rounded-md border ${n ? "bg-accent-500/10 text-accent-400 border-accent-500/25" : "bg-surface-overlay text-text-secondary border-border"}`}>
              {shortName(d)} · {n ? `cited ${n}×` : "not cited"}
            </a>
          );
        })}
      </div>
    </div>
  );
}
