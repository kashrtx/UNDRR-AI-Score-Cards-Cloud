"use client";

/**
 * Data Sources panel, shows, right in the dashboard, exactly what the data
 * engine found: whether the service is up, where the city was located, how many
 * data points each source returned, and, on click, the actual values used.
 */

import { useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Database, MapPin, BookCheck, ChevronDown, ExternalLink } from "lucide-react";
import type { DataReport, NormalizedDatum } from "@/lib/types";

function fmtValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

function DataRow({ d }: { d: NormalizedDatum }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-text-primary flex-1 min-w-0">
        {d.label}
        {d.provenance.url && (
          <a href={d.provenance.url} target="_blank" rel="noreferrer" className="text-primary-300 inline-flex items-center gap-0.5 ml-1 align-middle" title="Open the source">
            <ExternalLink size={10} />
          </a>
        )}
      </span>
      <span className="text-text-secondary shrink-0 text-right">
        {fmtValue(d.value)}{d.unit ? ` ${d.unit}` : ""}
      </span>
    </div>
  );
}

export function DataSourcesPanel({ report, live }: { report: DataReport | null; live?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!report) {
    if (!live) return null;
    return (
      <div className="glass-card p-5">
        <h2 className="text-base font-semibold text-text-primary flex items-center gap-2 mb-1">
          <Database size={16} className="text-primary-300" /> Open data
        </h2>
        <p className="text-sm text-text-secondary">Contacting the data service…</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <Database size={16} className="text-primary-300" /> Open data used for this analysis
        </h2>
        <span className="text-xs text-text-secondary">{report.dataPoints} data point(s)</span>
      </div>

      {!report.serviceUp && (
        <div className="flex items-start gap-2 text-sm text-warn-400 bg-warn-500/10 border border-warn-500/20 rounded-lg p-3 mb-3">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>
            The open-data service couldn&apos;t be reached, so the analysis used the scorecard alone.
            This is usually a temporary network issue with the upstream free APIs, try running the analysis again.
          </span>
        </div>
      )}

      {report.located && (
        <p className="text-xs text-text-secondary flex items-center gap-1.5 mb-3">
          <MapPin size={12} className="text-primary-300" /> Located as: {report.located}
        </p>
      )}

      {report.sources.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          {report.sources.map((s) => {
            const ok = s.points > 0;
            const rows = (report.data || []).filter(
              (d) => d.provenance.source === s.id || d.provenance.source === s.name || d.provenance.dataset === s.id || d.provenance.dataset === s.name
            );
            const canOpen = rows.length > 0;
            const isOpen = openId === s.id;
            return (
              <div key={s.id} className="sm:col-span-1">
                <button
                  type="button"
                  onClick={() => canOpen && setOpenId(isOpen ? null : s.id)}
                  aria-expanded={isOpen}
                  disabled={!canOpen}
                  className={`w-full flex items-center gap-2 p-2.5 rounded-lg border text-sm text-left ${
                    ok
                      ? "bg-accent-500/5 border-accent-500/15"
                      : s.error
                      ? "bg-danger-500/5 border-danger-500/15"
                      : "bg-surface-overlay/40 border-border"
                  } ${canOpen ? "hover:border-accent-500/40 cursor-pointer" : "cursor-default"}`}
                  title={s.error || (canOpen ? "Click to see the actual data" : "")}
                >
                  {ok ? (
                    <CheckCircle2 size={15} className="text-accent-400 shrink-0" />
                  ) : (
                    <XCircle size={15} className={s.error ? "text-danger-400 shrink-0" : "text-text-secondary/50 shrink-0"} />
                  )}
                  <span className="flex-1 text-text-secondary truncate">{s.name}</span>
                  <span className={`text-xs ${ok ? "text-accent-400" : "text-text-secondary"}`}>
                    {s.error ? "failed" : `${s.points}`}
                  </span>
                  {canOpen && <ChevronDown size={14} className={`text-text-secondary shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />}
                </button>
                {isOpen && (
                  <div className="mt-1 rounded-lg border border-border bg-surface-overlay/30 p-2.5 space-y-1">
                    {rows.map((d, i) => (
                      <DataRow key={i} d={d} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {report.warnings.length > 0 && (
        <ul className="space-y-1">
          {report.warnings.map((w, i) => (
            <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
              <AlertTriangle size={12} className="text-warn-400 shrink-0 mt-0.5" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {report.reference &&
        (report.reference.facts.length > 0 ||
          report.reference.answer ||
          report.reference.passages.length > 0) && (
          <div className="mt-3 pt-3 border-t border-border">
            <p className="text-sm font-medium text-text-primary flex items-center gap-1.5 mb-2">
              <BookCheck size={14} className="text-accent-400" /> Web research (cross-checked)
              {report.reference.webSearchMethod && (
                <span className="text-[11px] font-normal text-text-secondary bg-surface-overlay/60 border border-border rounded-full px-2 py-0.5">
                  web search: {report.reference.webSearchMethod}
                </span>
              )}
            </p>
            {report.reference.facts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {report.reference.facts.map((f, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-1 rounded-lg bg-accent-500/5 border border-accent-500/15 text-text-secondary"
                  >
                    <span className="text-text-primary">{f.label}:</span> {f.value}{" "}
                    <span className="text-text-secondary/70">· {f.source}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-text-secondary">
              Grounded in retrieved evidence from{" "}
              {report.reference.sources.slice(0, 6).map((s, i) => (
                <span key={i}>
                  {i > 0 && ", "}
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-primary-300 underline">
                    {s.name.length > 40 ? s.name.slice(0, 40) + "…" : s.name}
                  </a>
                </span>
              ))}
              . The AI is instructed to cross-check these and cite them, not to trust any single figure.
            </p>
          </div>
        )}
    </div>
  );
}