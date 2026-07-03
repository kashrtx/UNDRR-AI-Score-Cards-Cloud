/**
 * Overpass (OpenStreetMap) — counts of resilience-relevant infrastructure
 * inside the city's bounding box: hospitals, clinics, fire/police stations,
 * schools, emergency shelters, bridges.
 *
 * Free, no API key. These counts speak to Essential 8 (infrastructure) and
 * Essential 9 (response). Coverage varies by city — where OSM is sparse the
 * count is simply low; the tool reports what it finds and never fabricates.
 */

import { postForm, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const ENDPOINT = "https://overpass-api.de/api/interpreter";

// label -> [osm filter, essential hint]
const FEATURES: Record<string, [string, number]> = {
  hospitals: ['["amenity"="hospital"]', 8],
  clinics: ['["amenity"="clinic"]', 8],
  fire_stations: ['["amenity"="fire_station"]', 9],
  police_stations: ['["amenity"="police"]', 9],
  schools: ['["amenity"="school"]', 8],
  emergency_shelters: ['["amenity"="shelter"]', 9],
  bridges: ['["bridge"="yes"]', 8],
};

async function runCount(query: string): Promise<number | null> {
  try {
    const res = await postForm<{
      elements?: Array<{ tags?: { total?: string | number } }>;
    }>(ENDPOINT, `data=${encodeURIComponent(query)}`, 60000);
    const total = res?.elements?.[0]?.tags?.total ?? 0;
    return Number(total) || 0;
  } catch {
    return null;
  }
}

export const overpassOsmSource: DataSource = {
  id: "overpass_osm",
  name: "OpenStreetMap infrastructure (Overpass)",

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    const bbox = loc.bbox;
    if (!bbox || bbox.length !== 4) return [];
    // geocode bbox is [south, north, west, east]; Overpass wants south,west,north,east.
    const [south, north, west, east] = bbox;
    const bboxStr = `${south},${west},${north},${east}`;

    const out: NormalizedDatum[] = [];
    let anySucceeded = false;

    // Run all feature counts in PARALLEL (serverless has a strict time budget).
    const entries = Object.entries(FEATURES);
    const counts = await Promise.all(
      entries.map(([key, [filt]]) => {
        const q = `[out:json][timeout:25];(node${filt}(${bboxStr});way${filt}(${bboxStr});relation${filt}(${bboxStr}););out count;`;
        return runCount(q);
      })
    );

    entries.forEach(([key, [, hint]], i) => {
      const count = counts[i];
      if (count === null) return; // this feature failed; keep the others
      anySucceeded = true;
      out.push({
        key: `osm_${key}`,
        label: `${key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} mapped in OpenStreetMap`,
        value: count,
        unit: "count",
        essentialHint: hint,
        provenance: provenance(
          "OpenStreetMap",
          "Overpass API",
          `${key} near ${loc.name}`,
          ENDPOINT
        ),
      });
    });

    if (!anySucceeded) {
      return [
        {
          key: "osm_infrastructure_error",
          label: "OpenStreetMap infrastructure counts unavailable",
          value: "Overpass API did not respond; try again later.",
          essentialHint: 8,
          provenance: provenance(
            "OpenStreetMap",
            "Overpass API",
            `infrastructure near ${loc.name}`,
            ENDPOINT
          ),
        },
      ];
    }

    return out;
  },
};
