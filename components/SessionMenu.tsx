"use client";

/**
 * Chat history popup: a scrollable list of saved scorecards, each showing its
 * location, latest message, when it was updated, how many indicators are filled,
 * and a delete button (confirmed by the parent). Tap a row to open it.
 */

import { MapPin, Plus, Trash2, X, Check } from "lucide-react";
import type { SessionMeta } from "@/lib/agent/sessions";
import { TOTAL_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SessionMenu({
  open,
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  open: boolean;
  sessions: SessionMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[90] flex items-start sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full sm:max-w-lg sm:rounded-2xl rounded-b-2xl bg-surface border border-border shadow-2xl overflow-hidden flex flex-col max-h-[80vh] mt-0 sm:mt-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-text-primary flex-1">Your scorecards</h2>
          <button
            onClick={onNew}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium btn-accent"
          >
            <Plus size={15} /> New
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-2 min-h-0">
          {sessions.length === 0 && (
            <p className="text-sm text-text-secondary p-4 text-center">No saved scorecards yet.</p>
          )}
          {sessions.map((s) => {
            const active = s.id === activeId;
            return (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`group flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-colors ${
                  active ? "bg-primary-500/10 border border-primary-500/30" : "hover:bg-surface-overlay border border-transparent"
                }`}
              >
                <MapPin size={16} className={`mt-0.5 shrink-0 ${active ? "text-accent-400" : "text-text-secondary"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">{s.title}</span>
                    {active && <Check size={13} className="text-accent-400 shrink-0" />}
                  </div>
                  <p className="text-xs text-text-secondary truncate mt-0.5">{s.preview}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[11px] text-text-secondary">{relTime(s.updatedAt)}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-surface-overlay text-text-secondary">
                      {s.filled}/{TOTAL_INDICATORS}
                    </span>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                  className="shrink-0 p-1.5 rounded-lg text-text-secondary hover:text-danger-400 opacity-60 group-hover:opacity-100"
                  aria-label={`Delete ${s.title}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
