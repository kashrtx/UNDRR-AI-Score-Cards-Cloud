"use client";

/**
 * A shared chat bubble for the user's own messages, used by both the analysis advisor and
 * the Assistant. Short messages render as a normal bubble; long or multi-line
 * pastes are tidied and shown in a neat, scrollable, collapsible block so a big
 * copy-paste never makes the chat messy. An optional "Use in re-run" action lets
 * the advisor pull a paste's facts into the next analysis.
 */

import { useState } from "react";
import { FileText, Plus, Check } from "lucide-react";
import { tidyPaste, deEmDash } from "@/lib/ui/markdown";

export function UserMessageBubble({
  text,
  onAdd,
  added,
}: {
  text: string;
  onAdd?: () => void;
  added?: boolean;
}) {
  const tidy = tidyPaste(deEmDash(text));
  const lines = tidy.split("\n").length;
  // Treat as a data paste if it's long, has many lines, or looks structured
  // (tabs, CSV-ish commas, table pipes, or lots of numbers) so real data lands
  // in the neat collapsible block instead of a giant plain bubble.
  const looksTabular = /\t/.test(tidy) || /(,[^\n]*){2,}/.test(tidy) || /(\|[^\n]*){2,}/.test(tidy);
  const manyNumbers = (tidy.match(/\d+(?:[.,]\d+)?/g) || []).length >= 6;
  const isLong = tidy.length > 360 || lines > 6 || (lines >= 3 && (looksTabular || manyNumbers));
  const [open, setOpen] = useState(false);

  if (!isLong) {
    return (
      <div className="max-w-[90%] px-3.5 py-2.5 rounded-2xl rounded-br-sm text-sm leading-relaxed whitespace-pre-wrap bg-primary-500/15 border border-primary-500/25 text-text-primary">
        {tidy}
      </div>
    );
  }

  return (
    <div className="max-w-[92%] rounded-2xl rounded-br-sm bg-primary-500/10 border border-primary-500/25 overflow-hidden">
      <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-primary-300 flex items-center gap-1.5">
        <FileText size={12} /> Pasted text · {lines} lines
      </div>
      <pre
        className={`px-3.5 pb-2 text-[12px] leading-relaxed text-text-primary whitespace-pre-wrap font-mono overflow-y-auto transition-all ${open ? "max-h-[420px]" : "max-h-32"}`}
      >
        {tidy}
      </pre>
      <div className="flex items-center border-t border-primary-500/20 bg-primary-500/5">
        <button onClick={() => setOpen((v) => !v)} className="flex-1 text-[11px] text-primary-300 hover:text-text-primary py-1.5">
          {open ? "Show less" : "Show all"}
        </button>
        {onAdd && (
          <>
            <div className="w-px h-5 bg-primary-500/20" />
            <button
              onClick={onAdd}
              disabled={added}
              className={`flex-1 text-[11px] py-1.5 inline-flex items-center justify-center gap-1 ${added ? "text-accent-400" : "text-accent-300 hover:text-accent-200"}`}
              title={added ? "Added, it will be folded into the next re-run" : "Use these facts to improve the scorecard on the next re-run"}
            >
              {added ? <><Check size={12} /> Added to re-run</> : <><Plus size={12} /> Use in re-run</>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
