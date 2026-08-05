"use client";

/**
 * ConfirmModal, a small, mobile-friendly modal for confirmations
 * (e.g. "attaching a new file will clear the current results").
 */

import { AlertTriangle, X } from "lucide-react";
import type { ReactNode } from "react";

export interface ModalAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "danger" | "ghost";
}

export function ConfirmModal({
  open,
  title,
  children,
  actions,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: ModalAction[];
  onClose: () => void;
}) {
  if (!open) return null;

  const cls = (v: ModalAction["variant"]) =>
    v === "primary"
      ? "btn-accent"
      : v === "danger"
      ? "bg-danger-500/15 text-danger-400 border border-danger-500/30 hover:bg-danger-500/25"
      : "border border-border text-text-secondary hover:text-text-primary";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="glass-sheet border border-border w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="p-2 rounded-lg bg-warn-500/15 text-warn-400 shrink-0">
            <AlertTriangle size={18} />
          </div>
          <h2 className="text-base font-semibold text-text-primary flex-1 pt-1">{title}</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary p-1 -m-1">
            <X size={18} />
          </button>
        </div>
        <div className="text-sm text-text-secondary leading-relaxed mb-5">{children}</div>
        <div className="flex flex-col sm:flex-row-reverse gap-2">
          {actions.map((act, i) => (
            <button
              key={i}
              onClick={act.onClick}
              className={`px-4 py-2.5 sm:py-2 rounded-xl text-sm font-semibold transition-all active:scale-[0.98] ${cls(
                act.variant
              )}`}
            >
              {act.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
