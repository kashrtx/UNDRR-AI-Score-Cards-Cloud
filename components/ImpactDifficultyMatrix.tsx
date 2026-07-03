"use client";

/**
 * Impact vs Difficulty Matrix — scatter plot with 4 quadrants.
 * Actions are plotted as bubbles, colored by Essential, sized by cost tier.
 */

import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Label,
  ZAxis,
} from "recharts";
import type { Action, CostTier } from "@/lib/types";

interface MatrixProps {
  actions: Action[];
}

const COST_SIZE: Record<CostTier, number> = {
  "$0–100k": 80,
  "$100k–500k": 160,
  "$500k–1M": 280,
  "$1M–10M": 440,
  ">$10M": 640,
};

// Color by Essential (hue rotation)
function essentialColor(essential: number): string {
  const hue = ((essential - 1) * 36) % 360; // 10 essentials * 36 = full circle
  return `oklch(0.70 0.18 ${hue})`;
}

export function ImpactDifficultyMatrix({ actions }: MatrixProps) {
  const data = actions.map((a) => ({
    ...a,
    size: COST_SIZE[a.costTier] ?? 160,
    fill: essentialColor(a.essential),
  }));

  return (
    <div className="glass-card p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-1">
        Impact vs Difficulty
      </h2>
      <p className="text-sm text-text-secondary mb-4">
        Top-left = quick wins · Bottom-right = hard slogs · Bubble size = cost tier
      </p>

      <ResponsiveContainer width="100%" height={380}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="oklch(0.25 0.02 250)"
          />
          <XAxis
            type="number"
            dataKey="difficulty"
            domain={[0.5, 5.5]}
            ticks={[1, 2, 3, 4, 5]}
            tick={{ fill: "oklch(0.60 0.01 250)", fontSize: 12 }}
          >
            <Label
              value="Difficulty →"
              position="bottom"
              offset={10}
              style={{ fill: "oklch(0.60 0.01 250)", fontSize: 12 }}
            />
          </XAxis>
          <YAxis
            type="number"
            dataKey="impact"
            domain={[0.5, 5.5]}
            ticks={[1, 2, 3, 4, 5]}
            tick={{ fill: "oklch(0.60 0.01 250)", fontSize: 12 }}
          >
            <Label
              value="← Impact"
              angle={-90}
              position="insideLeft"
              offset={10}
              style={{ fill: "oklch(0.60 0.01 250)", fontSize: 12 }}
            />
          </YAxis>
          <ZAxis type="number" dataKey="size" range={[60, 600]} />

          {/* Quadrant dividers */}
          <ReferenceLine x={3} stroke="oklch(0.35 0.02 250)" strokeDasharray="6 6" />
          <ReferenceLine y={3} stroke="oklch(0.35 0.02 250)" strokeDasharray="6 6" />

          <Scatter data={data} fillOpacity={0.75} strokeWidth={1.5} stroke="oklch(0.90 0.005 250)">
            {data.map((entry, index) => (
              <circle key={index} fill={entry.fill} />
            ))}
          </Scatter>

          <Tooltip
            content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0]?.payload as Action & { fill: string };
              if (!d) return null;
              return (
                <div className="glass-card p-3 text-sm max-w-64">
                  <p className="font-semibold text-text-primary">{d.title}</p>
                  <div className="grid grid-cols-2 gap-x-3 mt-1 text-text-secondary">
                    <span>Impact: {d.impact}/5</span>
                    <span>Difficulty: {d.difficulty}/5</span>
                    <span>Cost: {d.costTier}</span>
                    <span>Phase: {d.phase}</span>
                    <span>Essential: E{d.essential}</span>
                    <span>Score +{d.scoreDelta}</span>
                  </div>
                </div>
              );
            }}
          />
        </ScatterChart>
      </ResponsiveContainer>

      {/* Quadrant labels */}
      <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-text-secondary">
        <div className="text-center p-1.5 rounded-lg bg-accent-500/10 border border-accent-500/20">
          ⭐ Quick Wins (high impact, low difficulty)
        </div>
        <div className="text-center p-1.5 rounded-lg bg-warn-500/10 border border-warn-500/20">
          🏗️ Major Programs (high impact, high difficulty)
        </div>
        <div className="text-center p-1.5 rounded-lg bg-primary-500/10 border border-primary-500/20">
          📋 Fill-ins (low impact, low difficulty)
        </div>
        <div className="text-center p-1.5 rounded-lg bg-danger-500/10 border border-danger-500/20">
          ⚠️ Hard Slogs (low impact, high difficulty)
        </div>
      </div>
    </div>
  );
}