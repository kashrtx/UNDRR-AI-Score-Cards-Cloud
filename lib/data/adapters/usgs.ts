/**
 * USGS Earthquakes — seismic hazard history near the city.
 *
 * Free, no API key. Summarises recorded earthquakes (magnitude 4+) within
 * ~300 km over the last 20 years: how many, and the largest. Speaks to
 * Essential 2 (understand risk) and Essential 9 (response). Where a region is
 * aseismic the counts are simply zero — reported honestly, never invented.
 */

import { buildUrl, getJson, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const BASE = "https://earthquake.usgs.gov/fdsnws/event/1/query";

export const usgsSource: DataSource = {
  id: "usgs_earthquakes",
  name: "USGS earthquake history",

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    if (loc.lat == null || loc.lon == null) return [];

    const start = new Date();
    start.setFullYear(start.getFullYear() - 20);
    const url = buildUrl(BASE, {
      format: "geojson",
      latitude: loc.lat,
      longitude: loc.lon,
      maxradiuskm: 300,
      starttime: start.toISOString().split("T")[0],
      minmagnitude: 4,
      orderby: "magnitude",
      limit: 500,
    });
    const prov = provenance(
      "USGS",
      "Earthquake Catalog (FDSN)",
      `M4+ within 300km of ${loc.name}`,
      url
    );

    let data: { features?: Array<{ properties?: { mag?: number } }> };
    try {
      data = await getJson(url, { timeoutMs: 25000, retries: 1 });
    } catch {
      return [];
    }

    const features = data?.features ?? [];
    if (!features.length) {
      return [
        {
          key: "usgs_earthquakes_m4",
          label: "Recorded M4+ earthquakes within 300 km (last 20 years)",
          value: 0,
          unit: "events",
          essentialHint: 2,
          provenance: prov,
        },
      ];
    }

    const mags = features
      .map((f) => f.properties?.mag)
      .filter((m): m is number => typeof m === "number");
    const largest = mags.length ? Math.max(...mags) : null;

    const out: NormalizedDatum[] = [
      {
        key: "usgs_earthquakes_m4",
        label: "Recorded M4+ earthquakes within 300 km (last 20 years)",
        value: features.length,
        unit: "events",
        essentialHint: 2,
        provenance: prov,
      },
    ];
    if (largest != null) {
      out.push({
        key: "usgs_largest_magnitude",
        label: "Largest recorded earthquake magnitude within 300 km (20 yr)",
        value: Math.round(largest * 10) / 10,
        unit: "Mw",
        essentialHint: 9,
        provenance: prov,
      });
    }
    return out;
  },
};
