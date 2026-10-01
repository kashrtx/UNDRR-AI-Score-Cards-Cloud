/**
 * Place lookups for the area picker (server-side, Nominatim / OpenStreetMap).
 *
 *   • searchPlaces(q)   — jump the map to a place the user types.
 *   • describeArea(ring) — which city/country a drawn area sits in, a friendly
 *     label ("Downtown, Toronto"), the city's own area, and how much of the
 *     drawn area falls outside the city's boundary (for a warning, not a block).
 *
 * Nominatim asks for at most ~1 request per second, so describeArea spaces its
 * two calls out and the client only calls it once per finished drawing.
 */

import { buildUrl, getJson } from "@/lib/data/http";
import {
  pointInRing, ringAreaKm2, ringCentroid, samplePointsInRing, openRing, type LonLat,
} from "./area";

const NOMINATIM = "https://nominatim.openstreetmap.org";

export interface PlaceHit {
  label: string;
  lat: number;
  lon: number;
  /** [south, north, west, east] */
  bbox: [number, number, number, number];
}

export interface AreaDescription {
  city: string | null;
  country: string | null;
  countryCode: string | null;
  /** e.g. "Downtown, Toronto" */
  label: string | null;
  /** First-level division (state/province) the area sits in, as OpenStreetMap names it. */
  regionName: string | null;
  /** Its ISO 3166-2 code, e.g. "US-AZ", when OpenStreetMap has one. */
  regionCode: string | null;
  cityAreaKm2: number | null;
  /** 0-1 share of the drawn area outside the city's boundary; null when the boundary is unknown. */
  outsideCityFraction: number | null;
}

type Address = Record<string, string | undefined>;

export async function searchPlaces(q: string): Promise<PlaceHit[]> {
  const url = buildUrl(`${NOMINATIM}/search`, { q, format: "json", limit: 5 });
  const data = await getJson<Array<{ display_name: string; lat: string; lon: string; boundingbox?: string[] }>>(url, {
    headers: { "Accept-Language": "en" },
  });
  return (data || []).map((r) => ({
    label: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    bbox: (r.boundingbox || [r.lat, r.lat, r.lon, r.lon]).map(Number) as [number, number, number, number],
  }));
}

/**
 * Does this city (optionally in this country, and this state/province) exist?
 * Uses Nominatim's structured search, which matches the name as a settlement
 * rather than any text, so "Atlantis, Canada" or a misspelling comes back empty.
 * The state is checked by its ISO 3166-2 code ("US-AZ") against each match,
 * since state names differ between sources ("Aichi" vs "Aichi Prefecture");
 * "Springfield" has many matches, so the state also picks the right one.
 */
export async function checkCity(
  city: string,
  country?: string,
  countryCode?: string,
  regionCode?: string
): Promise<{ found: boolean; displayName: string | null }> {
  const url = buildUrl(`${NOMINATIM}/search`, {
    city,
    // The ISO code is unambiguous; the name is the fallback for unknown codes.
    countrycodes: countryCode ? countryCode.toLowerCase() : undefined,
    country: countryCode ? undefined : country || undefined,
    format: "json",
    addressdetails: 1,
    limit: regionCode ? 10 : 1,
  });
  const data = await getJson<Array<{ display_name: string; address?: Address }>>(url, { headers: { "Accept-Language": "en" } });
  if (!data?.length) return { found: false, displayName: null };
  if (!regionCode) return { found: true, displayName: data[0].display_name };
  const isoCodes = (a?: Address) =>
    Object.entries(a || {}).filter(([k]) => k.startsWith("ISO3166-2")).map(([, v]) => (v || "").toUpperCase());
  // If OpenStreetMap has no ISO codes for this country's divisions, we can't judge the state.
  if (!data.some((r) => isoCodes(r.address).length)) return { found: true, displayName: data[0].display_name };
  const match = data.find((r) => isoCodes(r.address).includes(regionCode.toUpperCase()));
  return { found: !!match, displayName: match?.display_name ?? null };
}

function cityFrom(a: Address): string | null {
  return a.city || a.town || a.village || a.municipality || a.county || null;
}

function districtFrom(a: Address): string | null {
  return a.suburb || a.city_district || a.quarter || a.neighbourhood || a.borough || null;
}

/** Outer rings of a (Multi)Polygon GeoJSON geometry. */
function boundaryRings(g: { type?: string; coordinates?: unknown } | undefined): LonLat[][] {
  if (!g) return [];
  if (g.type === "Polygon") return [((g.coordinates as number[][][])[0] || []).map((p) => [p[0], p[1]] as LonLat)];
  if (g.type === "MultiPolygon") {
    return (g.coordinates as number[][][][]).map((poly) => (poly[0] || []).map((p) => [p[0], p[1]] as LonLat));
  }
  return [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function describeArea(ringIn: LonLat[]): Promise<AreaDescription> {
  const ring = openRing(ringIn);
  const c = ringCentroid(ring);

  // 1) Neighbourhood-level lookup, for a friendly label.
  const fine = await getJson<{ address?: Address }>(
    buildUrl(`${NOMINATIM}/reverse`, { lat: c.lat, lon: c.lon, format: "json", zoom: 14, addressdetails: 1 }),
    { headers: { "Accept-Language": "en" } }
  ).catch(() => null);
  const addr = fine?.address || {};

  await sleep(1100); // be polite to Nominatim's 1 req/s policy

  // 2) City-level lookup, with the city's boundary polygon.
  const coarse = await getJson<{
    address?: Address;
    geojson?: { type?: string; coordinates?: unknown };
  }>(
    buildUrl(`${NOMINATIM}/reverse`, {
      lat: c.lat, lon: c.lon, format: "json", zoom: 10, addressdetails: 1,
      polygon_geojson: 1, polygon_threshold: 0.0005,
    }),
    { headers: { "Accept-Language": "en" }, timeoutMs: 12000 }
  ).catch(() => null);
  const cAddr = coarse?.address || {};

  const city = cityFrom(cAddr) || cityFrom(addr);
  const district = districtFrom(addr);
  const country = cAddr.country || addr.country || null;
  const cc = (cAddr.country_code || addr.country_code || "").toUpperCase() || null;

  let cityAreaKm2: number | null = null;
  let outsideCityFraction: number | null = null;
  const rings = boundaryRings(coarse?.geojson).filter((r) => r.length >= 3);
  if (rings.length) {
    cityAreaKm2 = rings.reduce((s, r) => s + ringAreaKm2(r), 0);
    const samples = samplePointsInRing(ring, 80);
    const outside = samples.filter(([lon, lat]) => !rings.some((r) => pointInRing(lon, lat, r))).length;
    outsideCityFraction = samples.length ? outside / samples.length : null;
  }

  const label = [district && district !== city ? district : null, city].filter(Boolean).join(", ") || null;
  const regionName = cAddr.state || cAddr.province || addr.state || addr.province || null;
  const regionCode = (cAddr["ISO3166-2-lvl4"] || addr["ISO3166-2-lvl4"] || "").toUpperCase() || null;
  return { city, country, countryCode: cc, label, regionName, regionCode, cityAreaKm2, outsideCityFraction };
}
