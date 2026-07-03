/**
 * Data source contract — the "power socket" pattern.
 *
 * Every external open-data source implements `fetch(loc)` and returns
 * NormalizedDatum[]. Sources never throw for "no data" (they return []);
 * the registry catches unexpected errors so one bad source never stops the rest.
 */

import type { NormalizedDatum } from "@/lib/types";

/** Everything a data source needs to know about the city being assessed. */
export interface LocationContext {
  name: string;
  country?: string;
  country_code?: string | null;
  lat: number;
  lon: number;
  /** [south, north, west, east] — as returned by geocode(). */
  bbox: [number, number, number, number];
}

export interface DataSource {
  id: string;
  name: string;
  /** Never throws for "no data"; returns [] instead. */
  fetch(loc: LocationContext): Promise<NormalizedDatum[]>;
}
