/**
 * Hazard risk — location-specific hazard signals from reliable lat/lon APIs.
 *
 * This replaces low-value "filler" (country region/area) with data that
 * actually informs a resilience assessment:
 *   • River-flood proneness  — peak river discharge near the city (GloFAS via
 *     Open-Meteo Flood API). Speaks to Essential 2 (understand risk) & 9.
 *   • Coastal / sea-level exposure — ground elevation (Copernicus DEM via
 *     Open-Meteo). A very low elevation flags storm-surge / sea-level-rise
 *     exposure, which is decisive for island and coastal cities. Essential 5/8.
 *
 * (We deliberately use coordinate-based APIs rather than ThinkHazard!, whose API
 * needs admin-boundary IDs that can't be resolved from lat/lon without a brittle
 * extra lookup — these give a dependable, city-specific signal instead.)
 */

import { buildUrl, getJson, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const FLOOD = "https://flood-api.open-meteo.com/v1/flood";
const ELEVATION = "https://api.open-meteo.com/v1/elevation";

async function floodData(loc: LocationContext): Promise<NormalizedDatum[]> {
  const url = buildUrl(FLOOD, {
    latitude: loc.lat,
    longitude: loc.lon,
    daily: "river_discharge",
    past_days: 31,
    forecast_days: 1,
  });
  try {
    const d = await getJson<{ daily?: { river_discharge?: Array<number | null> } }>(url, {
      timeoutMs: 8000,
      retries: 0,
    });
    const arr = (d?.daily?.river_discharge ?? []).filter((x): x is number => typeof x === "number");
    if (!arr.length) return [];
    const max = Math.max(...arr);
    if (max <= 0) return []; // no significant river at this point
    return [
      {
        key: "river_discharge_max",
        label: "Peak river discharge near the city (last 31 days)",
        value: Math.round(max),
        unit: "m³/s",
        essentialHint: 2,
        provenance: provenance("Open-Meteo", "GloFAS Flood API", `river discharge near ${loc.name}`, url),
      },
    ];
  } catch {
    return [];
  }
}

async function elevationData(loc: LocationContext): Promise<NormalizedDatum[]> {
  const url = buildUrl(ELEVATION, { latitude: loc.lat, longitude: loc.lon });
  try {
    const d = await getJson<{ elevation?: number[] }>(url, { timeoutMs: 8000, retries: 0 });
    const e = d?.elevation?.[0];
    if (typeof e !== "number") return [];
    const prov = provenance("Open-Meteo", "Elevation API (Copernicus DEM)", `elevation at ${loc.name}`, url);
    const out: NormalizedDatum[] = [
      {
        key: "ground_elevation",
        label: "Ground elevation at city center",
        value: Math.round(e),
        unit: "m",
        essentialHint: 5,
        provenance: prov,
      },
    ];
    if (e < 10) {
      out.push({
        key: "coastal_exposure",
        label: "Low-lying coastal exposure",
        value: `Very low elevation (${Math.round(e)} m) — high exposure to coastal flooding, storm surge and sea-level rise`,
        essentialHint: 5,
        provenance: prov,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export const hazardRiskSource: DataSource = {
  id: "hazard_risk",
  name: "Hazard risk (flood & coastal elevation)",
  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    const [flood, elevation] = await Promise.all([floodData(loc), elevationData(loc)]);
    return [...flood, ...elevation];
  },
};
