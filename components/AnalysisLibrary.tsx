"use client";

/**
 * The saved analyses library (see lib/analysis/library.ts), as a dialog on the
 * Analysis tab: saved analyses grouped by city, newest first, each with its
 * outline, AI helper, date and score, and buttons to open, download or delete it.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { Library, X, Eye, Download, FileJson, Trash2, MapPin, Bot } from "lucide-react";
import { PROVIDER_LABEL } from "@/lib/settings/store";
import type { SavedAnalysis } from "@/lib/analysis/library";

export function AnalysisLibrary({
  open,
  entries,
  viewingId,
  onOpen,
  onDownloadReport,
  onDownloadData,
  onDelete,
  onClose,
}: {
  open: boolean;
  entries: SavedAnalysis[];
  viewingId: string | null;
  onOpen: (e: SavedAnalysis) => void;
  onDownloadReport: (e: SavedAnalysis) => void;
  onDownloadData: (e: SavedAnalysis) => void;
  onDelete: (e: SavedAnalysis) => void;
  onClose: () => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!open || typeof document === "undefined") return null;

  // Group by city, cities with the newest analysis first.
  const groups: Array<{ cityKey: string; title: string; items: SavedAnalysis[] }> = [];
  for (const e of [...entries].sort((a, b) => b.savedAt.localeCompare(a.savedAt))) {
    let g = groups.find((x) => x.cityKey === e.cityKey);
    if (!g) groups.push((g = { cityKey: e.cityKey, title: e.scorecard.city.name && e.scorecard.city.name !== "Unknown" ? `${e.scorecard.city.name}${e.scorecard.city.country && e.scorecard.city.country !== "Unknown" ? `, ${e.scorecard.city.country}` : ""}` : e.place, items: [] }));
    g.items.push(e);
  }

  const btn = "inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border bg-surface-overlay text-text-primary hover:border-primary-500/40";

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="library-title"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="glass-sheet border border-border w-full sm:max-w-2xl max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 p-5 pb-3 shrink-0">
          <div className="p-2 rounded-lg bg-accent-500/15 text-accent-400 shrink-0"><Library size={18} /></div>
          <div className="flex-1 min-w-0">
            <h2 id="library-title" className="text-base font-semibold text-text-primary">Saved analyses</h2>
            <p className="text-xs text-text-secondary">
              Every finished analysis is kept here, in this browser. Download a report to share one or keep it elsewhere.
            </p>
          </div>
          <button autoFocus onClick={onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary p-1 -m-1">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 pb-5 space-y-4">
          {groups.length === 0 && (
            <p className="text-sm text-text-secondary py-6 text-center">
              No saved analyses yet. They appear here as soon as an analysis finishes.
            </p>
          )}
          {groups.map((g) => (
            <section key={g.cityKey}>
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-1.5 mb-1.5">
                <MapPin size={14} className="text-primary-300" /> {g.title}
                <span className="text-xs font-normal text-text-secondary">· {g.items.length} saved</span>
              </h3>
              <ul className="space-y-1.5">
                {g.items.map((e) => {
                  const pct = Math.round((e.scorecard.total / e.scorecard.totalMax) * 100);
                  const viewing = e.id === viewingId;
                  return (
                    <li key={e.id} className={`rounded-xl border p-3 ${viewing ? "border-accent-500/50 bg-accent-500/5" : "border-border bg-surface-overlay/30"}`}>
                      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-text-primary flex items-center gap-1.5">
                            <Bot size={13} className="text-accent-400 shrink-0" />
                            <span className="font-medium">{PROVIDER_LABEL[e.provider]}</span>
                            {e.source !== e.provider && <span className="text-xs text-text-secondary">on {PROVIDER_LABEL[e.source]}&apos;s scorecard</span>}
                            {viewing && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-500/20 text-accent-300">open</span>}
                          </p>
                          <p className="text-xs text-text-secondary mt-0.5">
                            <span className="text-text-primary">{e.shape.kind}</span>{e.shape.detail ? ` · ${e.shape.detail}` : ""}
                          </p>
                          <p className="text-xs text-text-secondary">
                            {new Date(e.savedAt).toLocaleString()} · score {e.scorecard.total}/{e.scorecard.totalMax} ({pct}%) · <span className="font-mono">{e.meta.model}</span>
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button onClick={() => onOpen(e)} className={btn} title="Show this analysis on the Analysis tab (read-only)">
                            <Eye size={12} /> Open
                          </button>
                          <button onClick={() => onDownloadReport(e)} className={btn} title="Download a printable report (HTML)">
                            <Download size={12} /> Report
                          </button>
                          <button onClick={() => onDownloadData(e)} className={btn} title="Download the raw analysis (JSON)">
                            <FileJson size={12} /> Data
                          </button>
                          {confirmId === e.id ? (
                            <span className="inline-flex items-center gap-1">
                              <button onClick={() => { setConfirmId(null); onDelete(e); }}
                                className="text-xs px-2 py-1 rounded-lg bg-danger-500/15 text-danger-400 border border-danger-500/30 hover:bg-danger-500/25">
                                Delete
                              </button>
                              <button onClick={() => setConfirmId(null)} className="text-xs px-1.5 py-1 text-text-secondary hover:text-text-primary">Cancel</button>
                            </span>
                          ) : (
                            <button onClick={() => setConfirmId(e.id)} title="Delete this saved analysis"
                              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg text-text-secondary hover:text-danger-400 hover:bg-danger-500/10">
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
