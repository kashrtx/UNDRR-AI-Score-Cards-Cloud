/**
 * Data source contract — the "power socket" pattern.
 *
 * Every external open-data source implements `fetch(loc)` and returns
 * NormalizedDatum[]. Sources never throw for "no data" (they return []);
 * the registry catches unexpected errors so one bad source never stops the rest.
 */

import type { NormalizedDatum } from "@/lib/types";
import type { LonLat } from "@/lib/geo/area";

/** Everything a data source needs to know about the city being assessed. */
export interface LocationContext {
  name: string;
  country?: string;
  country_code?: string | null;
  lat: number;
  lon: number;
  /** [south, north, west, east] — as returned by geocode(). */
  bbox: [number, number, number, number];
  /** Set when the user drew an area: its outer boundary, [lon, lat]. Sources
   *  that can query an exact shape use it; the rest fall back to lat/lon/bbox. */
  polygon?: LonLat[];
  areaKm2?: number;
}

export interface DataSource {
  id: string;
  name: string;
  /** Optional: skip this source entirely for some locations (e.g. area-only sources). */
  appliesTo?(loc: LocationContext): boolean;
  /** Never throws for "no data"; returns [] instead. */
  fetch(loc: LocationContext): Promise<NormalizedDatum[]>;
}
