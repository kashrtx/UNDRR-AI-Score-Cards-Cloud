"use client";

/**
 * Action Plan — tabbed/filtered table showing Now / Next / Later actions.
 * Expandable rows with source references.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Target, Clock, Calendar } from "lucide-react";
import type { Action, Phase } from "@/lib/types";
import { ProvenanceBadge } from "./Provenance";

interface ActionPlanProps {
  actions: Action[];
}

const PHASE_CONFIG: Record<Phase, { icon: typeof Target; label: string; color: string }> = {
  Now: { icon: Target, label: "Do Now", color: "text-accent-400 bg-accent-500/10 border-accent-500/30" },
  Next: { icon: Clock, label: "Do Next", color: "text-warn-400 bg-warn-500/10 border-warn-500/30" },
  Later: { icon: Calendar, label: "Stage Later", color: "text-primary-300 bg-primary-500/10 border-primary-500/30" },
};

const COST_COLORS: Record<string, string> = {
  "$0–100k": "text-accent-400",
  "$100k–500k": "text-accent-500",
  "$500k–1M": "text-warn-400",
  "$1M–10M": "text-warn-500",
  ">$10M": "text-danger-400",
};

function ImpactBar({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <div
          key={i}
          className={`w-2 h-4 rounded-sm ${
            i < value ? "bg-accent-400" : "bg-surface-overlay"
          }`}
        />
      ))}
    </div>
  );
}

function ActionRow({ action }: { action: Action }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = expanded ? ChevronDown : ChevronRight;

  return (
    <>
      <tr
        className="border-b border-border/50 hover:bg-surface-overlay/30 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-3 px-3">
          <Icon size={14} className="text-text-secondary" />
        </td>
        <td className="py-3 px-2 font-mono text-xs text-primary-300">
          #{action.n}
        </td>
        <td className="py-3 px-2">
          <span className="text-sm font-medium text-text-primary">{action.title}</span>
        </td>
        <td className="py-3 px-2 text-xs font-mono text-text-secondary">
          E{action.essential}
        </td>
        <td className="py-3 px-2">
          <ImpactBar value={action.impact} />
        </td>
        <td className="py-3 px-2">
          <ImpactBar value={action.difficulty} />
        </td>
        <td className={`py-3 px-2 text-xs font-semibold ${COST_COLORS[action.costTier] || "text-text-secondary"}`}>
          {action.costTier}
        </td>
        <td className="py-3 px-2 text-xs font-mono text-accent-400">
          +{action.scoreDelta}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface-overlay/20">
          <td colSpan={8} className="py-3 px-8">
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-text-secondary">
                <span className="text-text-primary font-medium">Gap addressed:</span>{" "}
                {action.gap}
              </p>
              <div className="flex items-center gap-2">
                <span className="text-text-primary font-medium text-xs">Sources:</span>
                <ProvenanceBadge sourceRefs={action.sourceRefs} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ActionPlan({ actions }: ActionPlanProps) {
  const [activePhase, setActivePhase] = useState<Phase | "all">("all");

  const filtered =
    activePhase === "all"
      ? actions
      : actions.filter((a) => a.phase === activePhase);

  const phases: (Phase | "all")[] = ["all", "Now", "Next", "Later"];

  return (
    <div className="glass-card p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-1">
        Sequenced Action Plan
      </h2>
      <p className="text-sm text-text-secondary mb-4">
        Prioritized actions with cost tiers and projected score impact
      </p>

      {/* Phase tabs */}
      <div className="flex gap-2 mb-4">
        {phases.map((phase) => {
          const count =
            phase === "all" ? actions.length : actions.filter((a) => a.phase === phase).length;
          const isActive = activePhase === phase;
          const cfg = phase !== "all" ? PHASE_CONFIG[phase] : null;

          return (
            <button
              key={phase}
              onClick={() => setActivePhase(phase)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all
                ${isActive
                  ? (cfg?.color || "text-text-primary bg-surface-overlay border-border")
                  : "text-text-secondary bg-transparent border-transparent hover:bg-surface-overlay/50"
                }`}
            >
              {cfg && <cfg.icon size={12} />}
              {phase === "all" ? "All" : cfg?.label}
              <span className="ml-1 opacity-60">({count})</span>
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border text-xs text-text-secondary uppercase tracking-wider">
              <th className="py-2 px-3 w-8"></th>
              <th className="py-2 px-2">#</th>
              <th className="py-2 px-2">Action</th>
              <th className="py-2 px-2">Ess.</th>
              <th className="py-2 px-2">Impact</th>
              <th className="py-2 px-2">Difficulty</th>
              <th className="py-2 px-2">Cost</th>
              <th className="py-2 px-2">Score Δ</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((action) => (
              <ActionRow key={action.n} action={action} />
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-text-secondary text-sm py-8">
          No actions in this phase
        </p>
      )}
    </div>
  );
}