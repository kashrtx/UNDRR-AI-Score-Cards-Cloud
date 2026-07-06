"use client";

/**
 * A live text stream box (model output / narration). It:
 *   • shows the full text, scrollable, and sticks to the bottom as new text
 *     arrives (so nothing looks like it's being "erased"),
 *   • lets the user scroll up to read earlier text (auto-scroll pauses),
 *   • can be collapsed/expanded.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function LiveStream({
  text,
  label = "Live AI output",
  defaultOpen = true,
}: {
  text: string;
  label?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLPreElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [text, open]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
  };

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {label}
      </button>
      {open && (
        <pre
          ref={ref}
          onScroll={onScroll}
          className="mt-1 text-[11px] font-mono text-text-secondary/80 bg-surface-overlay/50 border border-border rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words"
        >
          {text}
        </pre>
      )}
    </div>
  );
}
