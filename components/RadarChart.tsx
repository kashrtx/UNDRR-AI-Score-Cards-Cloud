"use client";

/**
 * Radar Chart, Ten Essentials visualization.
 *
 * Matches the official UNDRR tool: it plots the RAW score per Essential on a
 * fixed 0–30 axis, with a grey "maximum possible" polygon behind the city's
 * actual (green) polygon. Because each Essential has a different number of
 * indicators (so a different max), plotting raw scores, not percentages, is
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
import { useTheme } from "@/lib/theme";

interface RadarChartProps {
  essentials: EssentialSummary[];
}

// Fixed outer bound, same as the official tool's radar axis.
const AXIS_MAX = 30;

export function RadarChart({ essentials }: RadarChartProps) {
  const { theme } = useTheme();
  const dark = theme === "dark";

  // Theme-aware, high-contrast colours so labels stay readable in both modes.
  const c = {
    grid: dark ? "oklch(0.40 0.02 260)" : "oklch(0.85 0.01 260)",
    angleTick: dark ? "oklch(0.90 0.01 260)" : "oklch(0.30 0.02 260)",
    radiusTick: dark ? "oklch(0.72 0.01 260)" : "oklch(0.45 0.02 260)",
    maxStroke: dark ? "oklch(0.55 0.02 260)" : "oklch(0.70 0.02 260)",
    maxFill: dark ? "oklch(0.40 0.02 260)" : "oklch(0.82 0.015 260)",
    cityStroke: dark ? "oklch(0.80 0.19 160)" : "oklch(0.52 0.17 160)",
    cityFill: dark ? "oklch(0.68 0.20 160)" : "oklch(0.56 0.17 160)",
  };

  const data = essentials.map((e) => ({
    name: `E${e.num}`,
    fullName: e.name,
    score: e.score,
    max: e.max,
    pct: e.max ? Math.round((e.score / e.max) * 100) : 0,
  }));

  return (
    <div className="glass-card p-6">
      <h2 className="text-xl font-bold text-text-primary mb-1">Ten Essentials Radar</h2>
      <p className="text-base text-text-secondary mb-4">
        Score for each Essential on a 0 to 30 scale. Grey is the maximum possible, green is this city.
        It matches the UNDRR tool.
      </p>

      <ResponsiveContainer width="100%" height={400}>
        <RechartsRadar data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke={c.grid} strokeDasharray="3 3" />
          <PolarAngleAxis
            dataKey="name"
            tick={{ fill: c.angleTick, fontSize: 15, fontWeight: 700 }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, AXIS_MAX]}
            tickCount={7}
            tick={{ fill: c.radiusTick, fontSize: 12, fontWeight: 600 }}
          />
          <Radar
            name="Maximum possible"
            dataKey="max"
            stroke={c.maxStroke}
            fill={c.maxFill}
            fillOpacity={0.5}
          />
          <Radar
            name="City score"
            dataKey="score"
            stroke={c.cityStroke}
            fill={c.cityFill}
            fillOpacity={0.45}
            strokeWidth={2.5}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0]?.payload;
              if (!d) return null;
              return (
                <div className="glass-card p-3 text-sm">
                  <p className="font-semibold text-text-primary">{d.fullName}</p>
                  <p className="text-accent-400 font-semibold">
                    {d.score}/{d.max} ({d.pct}%)
                  </p>
                </div>
              );
            }}
          />
        </RechartsRadar>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm text-text-secondary">
        {essentials.map((e) => (
          <div key={e.num} className="flex items-center gap-1.5">
            <span className="font-mono font-semibold text-primary-300">E{e.num}</span>
            <span className="truncate">{e.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}