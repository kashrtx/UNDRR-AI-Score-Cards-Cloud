/**
 * Usage log for comparing AI helpers: one record per helper per fill (from
 * "Fill it out for me", through any automatic or manual Continues and chat
 * turns, until the next fill). Kept in this browser; shown in the Cost
 * comparison window and downloadable as a CSV.
 */

import type { ProviderId } from "@/lib/settings/store";
import type { LLMUsage } from "@/lib/llm/types";
import { PROVIDER_LABEL } from "@/lib/settings/store";
import { costOf, emptyTotals, type PriceCatalog, type UsageTotals } from "@/lib/llm/pricing";

const LOG_KEY = "undrr.usage.v1";
const MAX_RECORDS = 500;

export interface FillRecord extends UsageTotals {
  id: string;
  startedAt: string;
  updatedAt: string;
  sessionId: string;
  /** "Tempe, Arizona, United States" or "Area · …". */
  place: string;
  provider: ProviderId;
  /** The model in use (the latest one, if it was changed mid-fill). */
  model: string;
  /** Time the helper spent working (not paused), in milliseconds. */
  activeMs: number;
  /** Indicators answered when the fill started, and now. */
  filledStart: number;
  filledEnd: number;
  status: "running" | "done" | "paused" | "stopped" | "error";
}

export function newFillRecord(p: { sessionId: string; place: string; provider: ProviderId; model: string; filled: number }): FillRecord {
  const now = new Date().toISOString();
  return {
    ...emptyTotals(),
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: now,
    updatedAt: now,
    sessionId: p.sessionId,
    place: p.place,
    provider: p.provider,
    model: p.model,
    activeMs: 0,
    filledStart: p.filled,
    filledEnd: p.filled,
    status: "running",
  };
}

/** Add one request's usage to a record. */
export function addUsage(r: FillRecord, u: LLMUsage): FillRecord {
  return {
    ...r,
    requests: r.requests + 1,
    inputTokens: r.inputTokens + (u.inputTokens || 0),
    outputTokens: r.outputTokens + (u.outputTokens || 0),
    billedUsd: r.billedUsd + (u.costUsd ?? 0),
    billedRequests: r.billedRequests + (u.costUsd != null ? 1 : 0),
    webSearches: r.webSearches + (u.webSearches ?? 0),
    unreported: (r.unreported ?? 0) + (u.unreported ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
}

export function loadUsageLog(): FillRecord[] {
  try {
    const list = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Save (or update) a record in the log, newest first. */
export function saveFillRecord(r: FillRecord): void {
  try {
    const list = loadUsageLog().filter((x) => x.id !== r.id);
    list.unshift(r);
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(0, MAX_RECORDS)));
  } catch {
    /* quota, non-fatal */
  }
}

export function deleteFillRecords(ids: string[]): FillRecord[] {
  const next = loadUsageLog().filter((x) => !ids.includes(x.id));
  try { localStorage.setItem(LOG_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The log as a CSV spreadsheet (one row per fill). */
export function usageCsv(records: FillRecord[], cat: PriceCatalog | null): string {
  const head = [
    "started", "place", "helper", "model", "status", "indicators_start", "indicators_end", "requests",
    "input_tokens", "output_tokens", "web_searches", "cost_usd", "cost_basis", "list_price_entry", "minutes_working",
  ];
  const rows = records.map((r) => {
    const c = costOf(r, r.provider, r.model, cat);
    return [
      r.startedAt, r.place, PROVIDER_LABEL[r.provider], r.model, r.status, r.filledStart, r.filledEnd, r.requests,
      r.inputTokens, r.outputTokens, r.webSearches, c.usd == null ? "" : c.usd.toFixed(6), c.basis, c.priceId ?? "",
      (r.activeMs / 60000).toFixed(2),
    ];
  });
  return [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
