/**
 * Open-Meteo — historical climate signal for hazard understanding.
 *
 * Free, no API key. Pulls the last 5 years of daily precipitation and
 * temperature and derives simple, decision-useful indicators (annual rainfall,
 * heavy-rain days, temperature extremes) that speak to Essential 2 (understand
 * risk) and Essential 9 (response readiness).
 */

import { buildUrl, getJson, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const BASE = "https://archive-api.open-meteo.com/v1/archive";

export const openMeteoSource: DataSource = {
  id: "open_meteo",
  name: "Open-Meteo (climate & elevation)",

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    if (loc.lat == null || loc.lon == null) return [];

    const end = new Date();
    const start = new Date();
    start.setFullYear(end.getFullYear() - 5);
    const iso = (d: Date) => d.toISOString().split("T")[0];

    const url = buildUrl(BASE, {
      latitude: loc.lat,
      longitude: loc.lon,
      start_date: iso(start),
      end_date: iso(end),
      daily: "precipitation_sum,temperature_2m_max,temperature_2m_min",
      timezone: "auto",
    });
    const prov = (desc: string) =>
      provenance("Open-Meteo", "Historical Weather API", desc, url);

    let data: {
      elevation?: number;
      daily?: {
        time?: string[];
        precipitation_sum?: (number | null)[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
      };
    };
    try {
      data = await getJson(url, { timeoutMs: 25000, retries: 1 });
    } catch (err) {
      return [
        {
          key: "climate_data_error",
          label: "Climate data unavailable",
          value: err instanceof Error ? err.message : String(err),
          essentialHint: 2,
          provenance: prov(`Climate query failed for ${loc.name}`),
        },
      ];
    }

    const out: NormalizedDatum[] = [];

    // Ground elevation comes back in the same response — a reliable coastal /
    // sea-level-rise exposure signal (no separate, flaky call needed).
    if (typeof data?.elevation === "number") {
      const e = Math.round(data.elevation);
      out.push({
        key: "ground_elevation",
        label: "Ground elevation at city center",
        value: e,
        unit: "m",
        essentialHint: 5,
        provenance: prov(`Ground elevation at ${loc.name}`),
      });
      if (data.elevation < 10) {
        out.push({
          key: "coastal_exposure",
          label: "Low-lying coastal exposure",
          value: `Very low elevation (${e} m) — high exposure to coastal flooding, storm surge and sea-level rise`,
          essentialHint: 5,
          provenance: prov(`Coastal exposure at ${loc.name}`),
        });
      }
    }

    const daily = data?.daily ?? {};
    const times = daily.time ?? [];
    if (!times.length) return out;

    const precip = (daily.precipitation_sum ?? []).filter(
      (v): v is number => v != null
    );
    if (precip.length) {
      out.push(
        {
          key: "avg_annual_precipitation",
          label: "Average annual precipitation (5-year)",
          value: Math.round(precip.reduce((a, b) => a + b, 0) / 5),
          unit: "mm/year",
          essentialHint: 2,
          provenance: prov(`Annual precipitation for ${loc.name}`),
        },
        {
          key: "max_daily_precipitation",
          label: "Maximum daily precipitation (5-year record)",
          value: Math.round(Math.max(...precip) * 10) / 10,
          unit: "mm",
          essentialHint: 2,
          provenance: prov(`Max daily precipitation for ${loc.name}`),
        },
        {
          key: "heavy_rain_days",
          label: "Days with >50mm rain (5-year total)",
          value: precip.filter((v) => v > 50).length,
          unit: "days",
          essentialHint: 9,
          provenance: prov(`Heavy-rain days for ${loc.name}`),
        },
        {
          key: "very_heavy_rain_days",
          label: "Days with >100mm rain (5-year total)",
          value: precip.filter((v) => v > 100).length,
          unit: "days",
          essentialHint: 9,
          provenance: prov(`Very-heavy-rain days for ${loc.name}`),
        }
      );
    }

    const tMax = (daily.temperature_2m_max ?? []).filter(
      (v): v is number => v != null
    );
    const tMin = (daily.temperature_2m_min ?? []).filter(
      (v): v is number => v != null
    );
    if (tMax.length) {
      out.push({
        key: "max_temperature_5yr",
        label: "Maximum recorded temperature (5-year)",
        value: Math.max(...tMax),
        unit: "\u00b0C",
        essentialHint: 2,
        provenance: prov(`Max temperature for ${loc.name}`),
      });
    }
    if (tMin.length) {
      out.push({
        key: "min_temperature_5yr",
        label: "Minimum recorded temperature (5-year)",
        value: Math.min(...tMin),
        unit: "\u00b0C",
        essentialHint: 2,
        provenance: prov(`Min temperature for ${loc.name}`),
      });
    }

    return out;
  },
};
