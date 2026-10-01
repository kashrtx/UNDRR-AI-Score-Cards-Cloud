/**
 * Overpass (OpenStreetMap) — counts of resilience-relevant infrastructure
 * inside the city's bounding box (or, for a drawn area, inside the exact
 * polygon): hospitals, clinics, fire/police stations, schools, emergency
 * shelters, evacuation assembly points, bridges.
 *
 * Free, no API key. These counts speak to Essential 8 (infrastructure) and
 * Essential 9 (response). Coverage varies by city — where OSM is sparse the
 * count is simply low; the tool reports what it finds and never fabricates.
 */

import { postForm, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const ENDPOINT = "https://overpass-api.de/api/interpreter";

interface Feature {
  label: string;
  /** OSM tag filters; an element matching ANY of them counts once. */
  filters: string[];
  essential: number;
}

// Not ["amenity"="shelter"]: in OSM that is mostly bus-stop, picnic and weather
// shelters (hundreds per city), which would badly overstate shelter capacity.
const FEATURES: Record<string, Feature> = {
  hospitals: { label: "Hospitals", filters: ['["amenity"="hospital"]'], essential: 8 },
  clinics: { label: "Clinics", filters: ['["amenity"="clinic"]'], essential: 8 },
  fire_stations: { label: "Fire stations", filters: ['["amenity"="fire_station"]'], essential: 9 },
  police_stations: { label: "Police stations", filters: ['["amenity"="police"]'], essential: 9 },
  schools: { label: "Schools", filters: ['["amenity"="school"]'], essential: 8 },
  emergency_shelters: {
    label: "Emergency & social shelters (incl. homeless / crisis shelters)",
    filters: [
      '["social_facility"="shelter"]',
      '["emergency"="shelter"]',
      '["shelter_type"="emergency"]',
      '["emergency_shelter"="yes"]',
    ],
    essential: 9,
  },
  evacuation_assembly_points: {
    label: "Evacuation assembly points",
    filters: ['["emergency"="assembly_point"]'],
    essential: 9,
  },
  bridges: { label: "Bridges", filters: ['["bridge"="yes"]'], essential: 8 },
};

/**
 * All feature counts in ONE Overpass request: each statement ends in its own
 * `out count;`, and the counts come back in order. The public server allows
 * only ~2 concurrent requests per client, so firing one request per feature
 * got most of them rejected.
 */
async function runCounts(query: string, n: number): Promise<Array<number | null>> {
  // The public server often answers "busy" (429/504) within a few seconds, so
  // one retry is worth it — but only while the registry's 24 s budget allows.
  const started = Date.now();
  const BUDGET_MS = 22000;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = BUDGET_MS - (Date.now() - started);
    if (left < 6000) break;
    try {
      const res = await postForm<{
        elements?: Array<{ type?: string; tags?: { total?: string | number } }>;
      }>(ENDPOINT, `data=${encodeURIComponent(query)}`, attempt === 0 ? Math.min(left, 14000) : left);
      const counts = (res?.elements || []).filter((e) => e.type === "count");
      return Array.from({ length: n }, (_, i) => (counts[i] ? Number(counts[i].tags?.total) || 0 : null));
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return Array.from({ length: n }, () => null);
}

export const overpassOsmSource: DataSource = {
  id: "overpass_osm",
  name: "OpenStreetMap infrastructure (Overpass)",

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    const bbox = loc.bbox;
    let filter: string;
    if (loc.polygon && loc.polygon.length >= 3) {
      // Exact shape: Overpass takes "lat lon lat lon …".
      filter = `poly:"${loc.polygon.map(([lon, lat]) => `${lat.toFixed(5)} ${lon.toFixed(5)}`).join(" ")}"`;
    } else {
      if (!bbox || bbox.length !== 4) return [];
      // geocode bbox is [south, north, west, east]; Overpass wants south,west,north,east.
      const [south, north, west, east] = bbox;
      filter = `${south},${west},${north},${east}`;
    }
    const where = loc.polygon ? "inside the selected area" : `near ${loc.name}`;

    const out: NormalizedDatum[] = [];
    let anySucceeded = false;

    const entries = Object.entries(FEATURES);
    const q =
      "[out:json][timeout:20];" +
      entries
        .map(([, f]) => `(${f.filters.map((t) => `nwr${t}(${filter});`).join("")});out count;`)
        .join("");
    const counts = await runCounts(q, entries.length);

    entries.forEach(([key, f], i) => {
      const count = counts[i];
      if (count === null) return; // this feature failed; keep the others
      anySucceeded = true;
      out.push({
        key: `osm_${key}`,
        label: `${f.label} mapped in OpenStreetMap${loc.polygon ? " (inside the selected area)" : ""}`,
        value: count,
        unit: "count",
        essentialHint: f.essential,
        provenance: provenance(
          "OpenStreetMap",
          "Overpass API",
          `${key} ${where}`,
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
            `infrastructure ${where}`,
            ENDPOINT
          ),
        },
      ];
    }

    return out;
  },
};
