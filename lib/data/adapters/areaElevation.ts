/**
 * Area elevation profile — only runs when the user drew an area.
 *
 * Samples the terrain at up to ~80 points spread evenly inside the polygon
 * (Open-Meteo Elevation API, Copernicus 90 m DEM, free, no key) and reports the
 * range, the average, and how much of the area is low-lying. Low-lying land is a
 * simple, honest proxy for coastal/river flood exposure: it speaks to Essential 2
 * (understand risk) and Essential 5 (natural buffers). A city-name run gets a
 * single elevation point from the climate source instead.
 */

import { buildUrl, getJson, provenance } from "../http";
import { samplePointsInRing } from "@/lib/geo/area";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const BASE = "https://api.open-meteo.com/v1/elevation";
const MAX_POINTS = 80; // API allows 100 per call

export const areaElevationSource: DataSource = {
  id: "area_elevation",
  name: "Open-Meteo elevation across the selected area",

  appliesTo: (loc) => !!loc.polygon && loc.polygon.length >= 3,

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    if (!loc.polygon || loc.polygon.length < 3) return [];
    const pts = samplePointsInRing(loc.polygon, MAX_POINTS);
    const url = buildUrl(BASE, {
      latitude: pts.map((p) => p[1].toFixed(5)).join(","),
      longitude: pts.map((p) => p[0].toFixed(5)).join(","),
    });
    const prov = provenance(
      "Open-Meteo",
      "Elevation API (Copernicus DEM GLO-90)",
      `${pts.length} points sampled inside the selected area`,
      BASE
    );

    let data: { elevation?: Array<number | null> };
    try {
      data = await getJson(url, { timeoutMs: 20000, retries: 1 });
    } catch {
      return [];
    }
    const elev = (data?.elevation || []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (!elev.length) return [];

    const min = Math.min(...elev);
    const max = Math.max(...elev);
    const mean = elev.reduce((a, b) => a + b, 0) / elev.length;
    const pctBelow = (m: number) => Math.round((elev.filter((v) => v <= m).length / elev.length) * 100);
    const r1 = (n: number) => Math.round(n * 10) / 10;

    return [
      { key: "area_elevation_mean", label: "Average ground elevation across the area", value: r1(mean), unit: "m", essentialHint: 2, provenance: prov },
      { key: "area_elevation_min", label: "Lowest sampled ground elevation in the area", value: r1(min), unit: "m", essentialHint: 2, provenance: prov },
      { key: "area_elevation_max", label: "Highest sampled ground elevation in the area", value: r1(max), unit: "m", essentialHint: 2, provenance: prov },
      { key: "area_relief", label: "Elevation range (relief) across the area", value: r1(max - min), unit: "m", essentialHint: 2, provenance: prov },
      { key: "area_low_lying_5m", label: "Share of the area at or below 5 m elevation (low-lying, flood-prone proxy)", value: pctBelow(5), unit: "%", essentialHint: 5, provenance: prov },
      { key: "area_low_lying_10m", label: "Share of the area at or below 10 m elevation", value: pctBelow(10), unit: "%", essentialHint: 5, provenance: prov },
    ];
  },
};
