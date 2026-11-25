"use client";

/**
 * Cost comparison of AI helpers (see lib/agent/usageLog.ts): what each fill of a
 * scorecard took (requests, tokens, time) and cost, plus the average per
 * completed fill for each model. Downloadable as a CSV for further analysis.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Coins, X, Download, Trash2, Info } from "lucide-react";
import { PROVIDER_LABEL } from "@/lib/settings/store";
import { TOTAL_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";
import { costOf, formatUsd, formatTokens, type CostEstimate } from "@/lib/llm/pricing";
import { loadUsageLog, deleteFillRecords, usageCsv, type FillRecord } from "@/lib/agent/usageLog";
import { usePriceCatalog } from "@/components/usePriceCatalog";

const BASIS_LABEL: Record<CostEstimate["basis"], string> = {
  billed: "billed", list: "list price", local: "local", unknown: "unknown",
};

function CostCell({ c }: { c: CostEstimate }) {
  return (
    <span title={[c.basis === "list" && c.priceId ? `List price of ${c.priceId}` : "", c.note ?? ""].filter(Boolean).join(". ") || undefined}>
      <span className="text-text-primary font-medium">{c.basis === "list" ? "≈ " : ""}{formatUsd(c.usd)}</span>
      <span className={`ml-1 text-[10px] px-1 py-0.5 rounded ${c.basis === "billed" ? "bg-accent-500/15 text-accent-300" : c.basis === "unknown" ? "bg-warn-500/15 text-warn-400" : "bg-surface-overlay text-text-secondary"}`}>
        {BASIS_LABEL[c.basis]}
      </span>
    </span>
  );
}

export function CostComparison({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cat = usePriceCatalog(open);
  const [records, setRecords] = useState<FillRecord[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => { if (open) { setRecords(loadUsageLog()); setConfirmClear(false); } }, [open]);
  if (!open || typeof document === "undefined") return null;

  const costs = new Map(records.map((r) => [r.id, costOf(r, r.provider, r.model, cat)]));

  // Average per COMPLETED fill (all 47 answered, started from blank), by helper + model.
  const groups = new Map<string, { provider: FillRecord["provider"]; model: string; items: FillRecord[] }>();
  for (const r of records) {
    if (r.filledEnd < TOTAL_INDICATORS || r.filledStart > 0 || r.status === "running") continue;
    const key = `${r.provider}|${r.model}`;
    if (!groups.has(key)) groups.set(key, { provider: r.provider, model: r.model, items: [] });
    groups.get(key)!.items.push(r);
  }
  const summary = [...groups.values()].map((g) => {
    const n = g.items.length;
    const avg = (f: (r: FillRecord) => number) => g.items.reduce((s, r) => s + f(r), 0) / n;
    const priced = g.items.map((r) => costs.get(r.id)!).filter((c) => c.usd != null);
    return {
      ...g, n,
      cost: priced.length ? priced.reduce((s, c) => s + (c.usd as number), 0) / priced.length : null,
      basis: priced[0]?.basis ?? "unknown",
      requests: avg((r) => r.requests),
      input: avg((r) => r.inputTokens),
      output: avg((r) => r.outputTokens),
      minutes: avg((r) => r.activeMs / 60000),
    };
  }).sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));

  const downloadCsv = () => {
    const blob = new Blob([usageCsv(records, cat)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `arise-ai-costs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const th = "text-left font-medium text-text-secondary px-2 py-1.5 whitespace-nowrap";
  const td = "px-2 py-1.5 whitespace-nowrap";

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="costs-title"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="glass-sheet border border-border w-full sm:max-w-5xl max-h-[90vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 p-5 pb-3 shrink-0">
          <div className="p-2 rounded-lg bg-accent-500/15 text-accent-400 shrink-0"><Coins size={18} /></div>
          <div className="flex-1 min-w-0">
            <h2 id="costs-title" className="text-base font-semibold text-text-primary">Cost comparison of AI helpers</h2>
            <p className="text-xs text-text-secondary">
              What each scorecard fill took and cost. Kept in this browser; download the CSV to analyse it further.
            </p>
          </div>
          <button autoFocus onClick={onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary p-1 -m-1"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto px-5 pb-5 space-y-5">
          <p className="text-xs text-text-secondary flex items-start gap-1.5 rounded-lg border border-border bg-surface-overlay/40 px-3 py-2">
            <Info size={13} className="shrink-0 mt-0.5 text-primary-300" />
            <span>
              <strong className="text-text-primary">billed</strong> is the exact charge OpenRouter reported.{" "}
              <strong className="text-text-primary">list price</strong> is the exact token counts the provider reported, priced at the
              model&apos;s list price from OpenRouter&apos;s public price list; a free tier (Gemini, NVIDIA credits) can make the real charge $0.{" "}
              <strong className="text-text-primary">local</strong> models run on this computer for free. Web searches that Gemini and
              OpenRouter bill separately aren&apos;t included; Claude&apos;s are ($0.01 each).
              {!cat && " The price list hasn't loaded yet, so list prices may show as unknown."}
            </span>
          </p>

          <section>
            <h3 className="text-sm font-semibold text-text-primary mb-1.5">Average per completed fill</h3>
            <p className="text-xs text-text-secondary mb-2">Fills that started from a blank scorecard and answered all {TOTAL_INDICATORS} indicators, cheapest first.</p>
            {summary.length === 0 ? (
              <p className="text-sm text-text-secondary">No completed fills yet. Press &ldquo;Fill it out for me&rdquo; and let a helper finish.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-overlay/60"><tr>
                    <th className={th}>Helper</th><th className={th}>Model</th><th className={th}>Fills</th>
                    <th className={th}>Avg cost</th><th className={th}>Avg requests</th><th className={th}>Avg tokens in / out</th><th className={th}>Avg time</th>
                  </tr></thead>
                  <tbody>
                    {summary.map((g) => (
                      <tr key={`${g.provider}|${g.model}`} className="border-t border-border">
                        <td className={`${td} text-text-primary`}>{PROVIDER_LABEL[g.provider]}</td>
                        <td className={`${td} font-mono`}>{g.model}</td>
                        <td className={td}>{g.n}</td>
                        <td className={td}><CostCell c={{ usd: g.cost, basis: g.basis }} /></td>
                        <td className={td}>{g.requests.toFixed(1)}</td>
                        <td className={td}>{formatTokens(Math.round(g.input))} / {formatTokens(Math.round(g.output))}</td>
                        <td className={td}>{g.minutes.toFixed(1)} min</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-text-primary mr-auto">Every fill ({records.length})</h3>
              <button onClick={downloadCsv} disabled={!records.length}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-border bg-surface-overlay text-text-primary hover:border-primary-500/40 disabled:opacity-50">
                <Download size={13} /> Download CSV
              </button>
              {confirmClear ? (
                <span className="inline-flex items-center gap-1">
                  <button onClick={() => { setRecords(deleteFillRecords(records.map((r) => r.id))); setConfirmClear(false); }}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-danger-500/15 text-danger-400 border border-danger-500/30 hover:bg-danger-500/25">
                    Clear the whole log
                  </button>
                  <button onClick={() => setConfirmClear(false)} className="text-xs px-1.5 py-1.5 text-text-secondary hover:text-text-primary">Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirmClear(true)} disabled={!records.length}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-danger-400 hover:bg-danger-500/10 disabled:opacity-50">
                  <Trash2 size={13} /> Clear log
                </button>
              )}
            </div>
            {records.length === 0 ? (
              <p className="text-sm text-text-secondary">Nothing logged yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-overlay/60"><tr>
                    <th className={th}>Started</th><th className={th}>Place</th><th className={th}>Helper · model</th><th className={th}>Indicators</th>
                    <th className={th}>Status</th><th className={th}>Requests</th><th className={th}>Tokens in / out</th><th className={th}>Cost</th><th className={th}>Time</th><th className={th}><span className="sr-only">Delete</span></th>
                  </tr></thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className={td}>{new Date(r.startedAt).toLocaleString()}</td>
                        <td className={`${td} max-w-[12rem] truncate`} title={r.place}>{r.place}</td>
                        <td className={td}><span className="text-text-primary">{PROVIDER_LABEL[r.provider]}</span> · <span className="font-mono">{r.model}</span></td>
                        <td className={td}>{r.filledStart} → {r.filledEnd}</td>
                        <td className={td}>{r.status}</td>
                        <td className={td}>{r.requests}</td>
                        <td className={td}>{formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}</td>
                        <td className={td}><CostCell c={costs.get(r.id)!} /></td>
                        <td className={td}>{(r.activeMs / 60000).toFixed(1)} min</td>
                        <td className={td}>
                          <button onClick={() => setRecords(deleteFillRecords([r.id]))} title="Delete this row" aria-label="Delete this row"
                            className="text-text-secondary hover:text-danger-400"><Trash2 size={12} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}
