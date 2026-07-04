"use client";

/**
 * Impact vs Difficulty matrix. Each action is a dot placed by how much it helps
 * (impact) and how hard it is (difficulty). The dot's COLOUR is its quadrant
 * (matching the legend), and its SIZE is the cost tier. Four shaded zones make
 * the quadrants obvious.
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
  ReferenceArea,
  Label,
  ZAxis,
  Cell,
} from "recharts";
import type { Action, CostTier } from "@/lib/types";
import { useTheme } from "@/lib/theme";

interface MatrixProps {
  actions: Action[];
}

const COST_SIZE: Record<CostTier, number> = {
  "$0–100k": 90,
  "$100k–500k": 170,
  "$500k–1M": 280,
  "$1M–10M": 430,
  ">$10M": 620,
};

type QuadKey = "quick" | "major" | "fill" | "slog";

function quadOf(impact: number, difficulty: number): QuadKey {
  const hiImpact = impact > 3;
  const hiDiff = difficulty > 3;
  if (hiImpact) return hiDiff ? "major" : "quick";
  return hiDiff ? "slog" : "fill";
}

const QUAD_NAME: Record<QuadKey, string> = {
  quick: "Quick Win",
  major: "Major Program",
  fill: "Fill-in",
  slog: "Hard Slog",
};

export function ImpactDifficultyMatrix({ actions }: MatrixProps) {
  const { theme } = useTheme();
  const dark = theme === "dark";

  // Quadrant colours (dot = strong, zone = faint), matching the legend chips.
  const HUE = { quick: 160, major: 70, fill: 255, slog: 25 };
  const dot = (q: QuadKey) =>
    dark ? `oklch(0.75 0.17 ${HUE[q]})` : `oklch(0.55 0.17 ${HUE[q]})`;
  const zone = (q: QuadKey) =>
    dark ? `oklch(0.70 0.15 ${HUE[q]})` : `oklch(0.62 0.14 ${HUE[q]})`;

  const c = {
    grid: dark ? "oklch(0.32 0.02 260)" : "oklch(0.88 0.01 260)",
    axis: dark ? "oklch(0.80 0.01 260)" : "oklch(0.40 0.02 260)",
    divider: dark ? "oklch(0.45 0.02 260)" : "oklch(0.72 0.02 260)",
    dotStroke: dark ? "oklch(0.20 0.01 260)" : "oklch(1 0 0)",
  };

  const data = actions.map((a) => {
    const q = quadOf(a.impact, a.difficulty);
    return { ...a, size: COST_SIZE[a.costTier] ?? 170, fill: dot(q), quad: QUAD_NAME[q] };
  });

  return (
    <div className="glass-card p-6">
      <h2 className="text-xl font-bold text-text-primary mb-1">Impact vs Difficulty</h2>
      <p className="text-base text-text-secondary mb-4">
        Every dot is one action. Its colour is the quadrant it lands in, and its size is the cost.
        The green top-left corner is where the easy, high-impact wins live.
      </p>

      <ResponsiveContainer width="100%" height={400}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 34, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />

          {/* Faint quadrant zones (match the legend colours) */}
          <ReferenceArea x1={0.5} x2={3} y1={3} y2={5.5} fill={zone("quick")} fillOpacity={dark ? 0.1 : 0.09} stroke="none" />
          <ReferenceArea x1={3} x2={5.5} y1={3} y2={5.5} fill={zone("major")} fillOpacity={dark ? 0.1 : 0.09} stroke="none" />
          <ReferenceArea x1={0.5} x2={3} y1={0.5} y2={3} fill={zone("fill")} fillOpacity={dark ? 0.1 : 0.09} stroke="none" />
          <ReferenceArea x1={3} x2={5.5} y1={0.5} y2={3} fill={zone("slog")} fillOpacity={dark ? 0.1 : 0.09} stroke="none" />

          <XAxis
            type="number"
            dataKey="difficulty"
            domain={[0.5, 5.5]}
            ticks={[1, 2, 3, 4, 5]}
            tick={{ fill: c.axis, fontSize: 13, fontWeight: 600 }}
          >
            <Label value="Harder to do →" position="bottom" offset={12} style={{ fill: c.axis, fontSize: 13, fontWeight: 600 }} />
          </XAxis>
          <YAxis
            type="number"
            dataKey="impact"
            domain={[0.5, 5.5]}
            ticks={[1, 2, 3, 4, 5]}
            tick={{ fill: c.axis, fontSize: 13, fontWeight: 600 }}
          >
            <Label value="More impact →" angle={-90} position="insideLeft" offset={10} style={{ fill: c.axis, fontSize: 13, fontWeight: 600, textAnchor: "middle" }} />
          </YAxis>
          <ZAxis type="number" dataKey="size" range={[80, 620]} />

          <ReferenceLine x={3} stroke={c.divider} strokeDasharray="6 6" />
          <ReferenceLine y={3} stroke={c.divider} strokeDasharray="6 6" />

          <Scatter data={data} fillOpacity={0.85} strokeWidth={1.5} stroke={c.dotStroke} isAnimationActive={false}>
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.fill} />
            ))}
          </Scatter>

          <Tooltip
            content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0]?.payload as Action & { quad: string };
              if (!d) return null;
              return (
                <div className="glass-card p-3 text-sm max-w-64">
                  <p className="font-semibold text-text-primary">{d.title}</p>
                  <p className="text-accent-400 font-semibold mt-0.5">{d.quad}</p>
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

      {/* Quadrant legend (colours match the dots) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-sm">
        <div className="flex items-center gap-2 p-2 rounded-lg bg-accent-500/10 border border-accent-500/25">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: dot("quick") }} />
          <span className="text-text-secondary">Quick Wins, high impact and easy</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-lg bg-warn-500/10 border border-warn-500/25">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: dot("major") }} />
          <span className="text-text-secondary">Major Programs, high impact but hard</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-lg bg-primary-500/10 border border-primary-500/25">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: dot("fill") }} />
          <span className="text-text-secondary">Fill-ins, easy but lower impact</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-lg bg-danger-500/10 border border-danger-500/25">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: dot("slog") }} />
          <span className="text-text-secondary">Hard Slogs, hard and lower impact</span>
        </div>
      </div>
    </div>
  );
}
