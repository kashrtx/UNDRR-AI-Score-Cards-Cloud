"use client";

/**
 * Radar Chart — Ten Essentials visualization.
 *
 * Matches the official UNDRR tool: it plots the RAW score per Essential on a
 * fixed 0–30 axis, with a grey "maximum possible" polygon behind the city's
 * actual (green) polygon. Because each Essential has a different number of
 * indicators (so a different max), plotting raw scores — not percentages — is
 * what makes this chart look the same as the one in the Excel tool.
 */

import {
  Radar,
  RadarChart as RechartsRadar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { EssentialSummary } from "@/lib/types";

interface RadarChartProps {
  essentials: EssentialSummary[];
}

// Fixed outer bound, same as the official tool's radar axis.
const AXIS_MAX = 30;

export function RadarChart({ essentials }: RadarChartProps) {
  const data = essentials.map((e) => ({
    name: `E${e.num}`,
    fullName: e.name,
    score: e.score,
    max: e.max,
    pct: e.max ? Math.round((e.score / e.max) * 100) : 0,
  }));

  return (
    <div className="glass-card p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-1">
        Ten Essentials Radar
      </h2>
      <p className="text-sm text-text-secondary mb-4">
        Score by Essential on a 0–30 scale (grey = maximum possible, green = this
        city). Matches the UNDRR tool.
      </p>

      <ResponsiveContainer width="100%" height={380}>
        <RechartsRadar data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke="oklch(0.28 0.02 250)" strokeDasharray="3 3" />
          <PolarAngleAxis
            dataKey="name"
            tick={{ fill: "oklch(0.70 0.01 250)", fontSize: 12, fontWeight: 500 }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, AXIS_MAX]}
            tickCount={7}
            tick={{ fill: "oklch(0.50 0.01 250)", fontSize: 10 }}
          />
          {/* Grey: each Essential's maximum possible score */}
          <Radar
            name="Maximum possible"
            dataKey="max"
            stroke="oklch(0.45 0.02 250)"
            fill="oklch(0.30 0.02 250)"
            fillOpacity={0.45}
          />
          {/* Green: the city's actual score */}
          <Radar
            name="City score"
            dataKey="score"
            stroke="oklch(0.65 0.20 160)"
            fill="oklch(0.65 0.20 160)"
            fillOpacity={0.4}
            strokeWidth={2}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0]?.payload;
              if (!d) return null;
              return (
                <div className="glass-card p-3 text-sm">
                  <p className="font-semibold text-text-primary">{d.fullName}</p>
                  <p className="text-accent-400">
                    {d.score}/{d.max} ({d.pct}%)
                  </p>
                </div>
              );
            }}
          />
        </RechartsRadar>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary">
        {essentials.map((e) => (
          <div key={e.num} className="flex items-center gap-1.5">
            <span className="font-mono text-primary-300">E{e.num}</span>
            <span className="truncate">{e.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}