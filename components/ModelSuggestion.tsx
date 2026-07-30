"use client";

/**
 * A gentle, dismissible suggestion bar, styled like the Settings save bar, that
 * nudges the user toward the model best suited to what they're doing (Gemini for
 * the Dashboard analysis, OpenRouter for the Assistant). It remembers a dismissal
 * so it never nags, and can be switched off with one tap.
 */

import { useState } from "react";
import { Sparkles, X, ArrowRight } from "lucide-react";

export function ModelSuggestion({
  show,
  title,
  body,
  cta,
  onUse,
  storageKey,
}: {
  show: boolean;
  title: string;
  body: string;
  cta: string;
  onUse: () => void;
  storageKey: string;
}) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  if (!show || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-accent-500/30 bg-accent-500/10 px-3.5 py-2.5 animate-fadeInUp">
      <span className="shrink-0 grid place-items-center w-8 h-8 rounded-lg bg-accent-500/20 text-accent-300">
        <Sparkles size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="text-xs text-text-secondary">{body}</p>
      </div>
      <button
        onClick={() => { onUse(); dismiss(); }}
        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold btn-accent active:scale-95 transition-all"
      >
        {cta} <ArrowRight size={14} />
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss this tip"
        title="Dismiss (won't show again)"
        className="shrink-0 p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay"
      >
        <X size={16} />
      </button>
    </div>
  );
}
