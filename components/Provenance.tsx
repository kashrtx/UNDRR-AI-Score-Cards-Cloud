"use client";

/**
 * Provenance Tooltip — shows data source info on hover.
 * Reusable component for grounding every data point.
 */

import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";

interface ProvenanceProps {
  sourceRefs: string[];
  children?: ReactNode;
}

export function ProvenanceBadge({ sourceRefs }: { sourceRefs: string[] }) {
  const [open, setOpen] = useState(false);

  if (!sourceRefs.length) return null;

  return (
    <span className="relative inline-flex items-center">
      <button
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono
                   bg-primary-900/40 text-primary-300 rounded-md border border-primary-700/30
                   hover:bg-primary-800/50 transition-all cursor-help"
        aria-label="View sources"
      >
        <Info size={10} />
        <span>{sourceRefs.length} ref{sourceRefs.length > 1 ? "s" : ""}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-50 w-56 p-3
                        glass-card text-xs text-text-secondary shadow-2xl">
          <p className="font-semibold text-text-primary mb-1.5">Sources</p>
          <ul className="space-y-1">
            {sourceRefs.map((ref, i) => (
              <li key={i} className="font-mono text-primary-300">{ref}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

export function ProvenanceWrapper({ sourceRefs, children }: ProvenanceProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      <ProvenanceBadge sourceRefs={sourceRefs} />
    </span>
  );
}