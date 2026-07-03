/**
 * Geocoding — turn a city name into coordinates + bounding box.
 * Tries Nominatim (OpenStreetMap) first, then Open-Meteo geocoding as fallback.
 */

import { buildUrl, getJson, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OPEN_METEO_GEO = "https://geocoding-api.open-meteo.com/v1/search";

export interface GeoLocation {
  lat: number;
  lon: number;
  display_name: string;
  bbox: [number, number, number, number]; // [south, north, west, east]
  country?: string;
  country_code?: string;
  query: string;
  url: string;
}

async function fromNominatim(name: string, country?: string): Promise<GeoLocation | null> {
  const query = country ? `${name}, ${country}` : name;
  const url = buildUrl(NOMINATIM, { q: query, format: "json", limit: 1, addressdetails: 1 });
  const data = await getJson<
    Array<{
      lat: string;
      lon: string;
      display_name: string;
      boundingbox: string[];
      address?: Record<string, string>;
    }>
  >(url, { headers: { "Accept-Language": "en" } });
  if (!data?.length) return null;
  const r = data[0];
  const bbox = (r.boundingbox || ["0", "0", "0", "0"]).map(Number) as [number, number, number, number];
  const addr = r.address || {};
  return {
    lat: Number.parseFloat(r.lat),
    lon: Number.parseFloat(r.lon),
    display_name: r.display_name || query,
    bbox,
    country: addr.country || country,
    country_code: (addr.country_code || "").toUpperCase() || undefined,
    query,
    url,
  };
}

async function fromOpenMeteo(name: string, country?: string): Promise<GeoLocation | null> {
  const url = buildUrl(OPEN_METEO_GEO, { name, count: 5, language: "en", format: "json" });
  const data = await getJson<{
    results?: Array<{
      latitude: number;
      longitude: number;
      name?: string;
      admin1?: string;
      country?: string;
      country_code?: string;
    }>;
  }>(url);
  const results = data?.results || [];
  if (!results.length) return null;
  let pick = results[0];
  if (country) {
    const cl = country.trim().toLowerCase();
    for (const r of results) {
      if (cl === String(r.country || "").toLowerCase() || cl === String(r.country_code || "").toLowerCase()) {
        pick = r;
        break;
      }
    }
  }
  const lat = pick.latitude;
  const lon = pick.longitude;
  const pad = 0.2; // ~20 km half-box
  return {
    lat,
    lon,
    display_name: [pick.name, pick.admin1, pick.country].filter(Boolean).join(", "),
    bbox: [lat - pad, lat + pad, lon - pad, lon + pad],
    country: pick.country || country,
    country_code: (pick.country_code || "").toUpperCase() || undefined,
    query: country ? `${name}, ${country}` : name,
    url,
  };
}

/** Never throws — total failure returns null and the caller degrades gracefully. */
export async function geocode(name: string, country?: string): Promise<GeoLocation | null> {
  for (const finder of [fromNominatim, fromOpenMeteo]) {
    try {
      const result = await finder(name, country);
      if (result) return result;
    } catch {
      // try the next service
    }
  }
  return null;
}

export function geocodeData(g: GeoLocation): NormalizedDatum[] {
  const prov = provenance("Geocoding", "OpenStreetMap / Open-Meteo", g.query, g.url);
  return [
    { key: "geocode_lat", label: "Latitude", value: g.lat, unit: "degrees", provenance: prov },
    { key: "geocode_lon", label: "Longitude", value: g.lon, unit: "degrees", provenance: prov },
    { key: "geocode_display_name", label: "Full location name", value: g.display_name, provenance: prov },
  ];
}
