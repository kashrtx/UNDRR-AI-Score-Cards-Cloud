"use client";

/**
 * Score Projection, interactive toggle showing how actions improve the score.
 * Check/uncheck actions to see projected score change.
 */

import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Cell,
  Tooltip as RechartsTooltip,
} from "recharts";
import { TrendingUp } from "lucide-react";
import type { Action } from "@/lib/types";

interface ScoreProjectionProps {
  currentScore: number;
  maxScore: number;
  potentialScore: number;
  actions: Action[];
}

export function ScoreProjection({
  currentScore,
  maxScore,
  potentialScore,
  actions,
}: ScoreProjectionProps) {
  const [selected, setSelected] = useState<Set<number>>(
    new Set(actions.map((a) => a.n))
  );

  const toggleAction = (n: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) {
        next.delete(n);
      } else {
        next.add(n);
      }
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(actions.map((a) => a.n)));
  const clearAll = () => setSelected(new Set());

  const selectedDelta = actions
    .filter((a) => selected.has(a.n))
    .reduce((sum, a) => sum + a.scoreDelta, 0);

  const projectedScore = Math.min(maxScore, currentScore + selectedDelta);
  const projectedPct = Math.round((projectedScore / maxScore) * 100);
  const currentPct = Math.round((currentScore / maxScore) * 100);

  const chartData = [
    { name: "Current", value: currentScore, pct: currentPct },
    { name: "Projected", value: projectedScore, pct: projectedPct },
    { name: "Maximum", value: maxScore, pct: 100 },
  ];

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <TrendingUp size={20} className="text-accent-400" />
          Score Projection
        </h2>
        <div className="flex gap-2">
          <button
            onClick={selectAll}
            className="text-xs text-primary-300 hover:text-primary-200 transition-colors"
          >
            Select all
          </button>
          <span className="text-border">|</span>
          <button
            onClick={clearAll}
            className="text-xs text-primary-300 hover:text-primary-200 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Toggle actions to see how the resilience score changes
      </p>

      {/* Big score display */}
      <div className="flex items-center justify-center gap-6 mb-6">
        <div className="text-center">
          <p className="text-4xl font-bold text-text-secondary">{currentScore}</p>
          <p className="text-xs text-text-secondary mt-1">Current</p>
        </div>
        <div className="text-3xl text-accent-400 animate-pulse">→</div>
        <div className="text-center">
          <p className="text-5xl font-bold text-accent-400">{projectedScore}</p>
          <p className="text-xs text-text-secondary mt-1">
            Projected ({projectedPct}%)
          </p>
        </div>
        <div className="text-center ml-4 pl-4 border-l border-border">
          <p className="text-2xl font-semibold text-text-secondary/50">{maxScore}</p>
          <p className="text-xs text-text-secondary mt-1">Maximum</p>
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={chartData} layout="vertical" barCategoryGap="20%">
          <XAxis type="number" domain={[0, maxScore]} hide />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: "oklch(0.70 0.01 250)", fontSize: 12 }}
            width={70}
          />
          <RechartsTooltip
            content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0]?.payload;
              return (
                <div className="glass-card p-2 text-sm">
                  <span className="text-text-primary font-medium">{d?.name}:</span>{" "}
                  <span className="text-accent-400">{d?.value}/{maxScore}</span>{" "}
                  <span className="text-text-secondary">({d?.pct}%)</span>
                </div>
              );
            }}
          />
          <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive={false}>
            {chartData.map((entry, index) => (
              <Cell
                key={index}
                fill={
                  index === 0
                    ? "oklch(0.40 0.10 250)"
                    : index === 1
                    ? "oklch(0.65 0.20 160)"
                    : "oklch(0.25 0.03 250)"
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Action toggles */}
      <div className="mt-4 max-h-52 overflow-y-auto space-y-1.5 pr-2">
        {actions.map((action) => {
          const isChecked = selected.has(action.n);
          return (
            <label
              key={action.n}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm
                ${isChecked
                  ? "bg-accent-500/10 border border-accent-500/30"
                  : "bg-surface-overlay/30 border border-transparent hover:border-border"
                }`}
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => toggleAction(action.n)}
                className="accent-accent-500 w-4 h-4"
              />
              <span className={`flex-1 ${isChecked ? "text-text-primary" : "text-text-secondary"}`}>
                {action.title}
              </span>
              <span className="text-xs font-mono text-accent-400">
                +{action.scoreDelta}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}