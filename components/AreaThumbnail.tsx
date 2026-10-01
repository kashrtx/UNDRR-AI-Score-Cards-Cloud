"use client";

/**
 * A tiny outline of the selected area for the draft header — plain SVG, no map
 * tiles, so it's instant and follows the light/dark theme.
 */

import type { AreaSelection } from "@/lib/geo/area";

export function AreaThumbnail({ area, size = 56 }: { area: AreaSelection; size?: number }) {
  const [s, n, w, e] = area.bbox;
  const k = Math.cos(((s + n) / 2) * (Math.PI / 180)); // shrink longitude so shapes aren't stretched
  const width = Math.max((e - w) * k, 1e-9);
  const height = Math.max(n - s, 1e-9);
  const scale = (size - 8) / Math.max(width, height);
  const ox = (size - width * scale) / 2;
  const oy = (size - height * scale) / 2;
  const d = area.ring
    .map(([lon, lat], i) => `${i ? "L" : "M"}${(ox + (lon - w) * k * scale).toFixed(1)},${(oy + (n - lat) * scale).toFixed(1)}`)
    .join(" ") + " Z";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Outline of the selected area"
      className="shrink-0 rounded-lg border border-border bg-surface-overlay/60">
      <path d={d} className="fill-accent-500/20 stroke-accent-400" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
