"use client";

/**
 * Data Sources panel — shows, right in the dashboard, exactly what the data
 * engine found: whether the service is up, where the city was located, how many
 * data points each source returned, and any gaps. This is what you used to have
 * to read the terminal for.
 */

import { CheckCircle2, XCircle, AlertTriangle, Database, MapPin, BookCheck } from "lucide-react";
import type { DataReport } from "@/lib/types";

export function DataSourcesPanel({ report, live }: { report: DataReport | null; live?: boolean }) {
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
            This is usually a temporary network issue with the upstream free APIs — try running the analysis again.
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
            return (
              <div
                key={s.id}
                className={`flex items-center gap-2 p-2.5 rounded-lg border text-sm ${
                  ok
                    ? "bg-accent-500/5 border-accent-500/15"
                    : s.error
                    ? "bg-danger-500/5 border-danger-500/15"
                    : "bg-surface-overlay/40 border-border"
                }`}
                title={s.error || ""}
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

      {report.reference && (report.reference.facts.length > 0 || report.reference.summary) && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-sm font-medium text-text-primary flex items-center gap-1.5 mb-2">
            <BookCheck size={14} className="text-accent-400" /> Verified reference facts
          </p>
          {report.reference.facts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {report.reference.facts.map((f, i) => (
                <span
                  key={i}
                  className="text-xs px-2 py-1 rounded-lg bg-accent-500/5 border border-accent-500/15 text-text-secondary"
                >
                  <span className="text-text-primary">{f.label}:</span> {f.value}
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-text-secondary">
            Cross-checked against{" "}
            {report.reference.sources.map((s, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary-300 underline"
                >
                  {s.name}
                </a>
              </span>
            ))}
            .
          </p>
        </div>
      )}
    </div>
  );
}