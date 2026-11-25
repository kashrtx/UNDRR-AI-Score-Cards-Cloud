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
  pointInRing, ringAreaKm2, ringCentroid, samplePointsInRing, openRing, simplifyRing, circleRing, type LonLat,
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
  const hit = await findCity(city, country, countryCode, regionCode);
  return { found: !!hit, displayName: hit?.displayName ?? null };
}

/** The settlement checkCity matched: where it is and, if OpenStreetMap knows it, its population. */
interface CityHit {
  displayName: string;
  lat: number;
  lon: number;
  countryCode: string | null;
  population: number | null;
}

async function findCity(
  city: string,
  country?: string,
  countryCode?: string,
  regionCode?: string
): Promise<CityHit | null> {
  const url = buildUrl(`${NOMINATIM}/search`, {
    city,
    // The ISO code is unambiguous; the name is the fallback for unknown codes.
    countrycodes: countryCode ? countryCode.toLowerCase() : undefined,
    country: countryCode ? undefined : country || undefined,
    format: "json",
    addressdetails: 1,
    extratags: 1,
    limit: regionCode ? 10 : 1,
  });
  type Hit = { display_name: string; lat: string; lon: string; class?: string; address?: Address; extratags?: Record<string, string> };
  let data = await getJson<Hit[]>(url, { headers: { "Accept-Language": "en" } });
  if (!data?.length) {
    // The structured search only matches settlements. Before calling the place
    // missing, try a free-text search (municipalities like "General Plutarco
    // Elías Calles", alternative spellings), keeping only places and boundaries.
    await sleep(1100); // Nominatim asks for at most ~1 request per second
    const loose = await getJson<Hit[]>(
      buildUrl(`${NOMINATIM}/search`, {
        q: countryCode ? city : [city, country].filter(Boolean).join(", "),
        countrycodes: countryCode ? countryCode.toLowerCase() : undefined,
        format: "json", addressdetails: 1, extratags: 1, limit: 10,
      }),
      { headers: { "Accept-Language": "en" } }
    ).catch(() => [] as Hit[]);
    data = (loose || []).filter((r) => r.class === "place" || r.class === "boundary");
  }
  if (!data?.length) return null;
  const toHit = (r: Hit): CityHit => {
    const pop = Number(String(r.extratags?.population ?? "").replace(/[^0-9]/g, ""));
    return {
      displayName: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
      countryCode: (r.address?.country_code || countryCode || "").toUpperCase() || null,
      population: pop > 0 ? pop : null,
    };
  };
  if (!regionCode) return toHit(data[0]);
  const isoCodes = (a?: Address) =>
    Object.entries(a || {}).filter(([k]) => k.startsWith("ISO3166-2")).map(([, v]) => (v || "").toUpperCase());
  // If OpenStreetMap has no ISO codes for this country's divisions, we can't judge the state.
  if (!data.some((r) => isoCodes(r.address).length)) return toHit(data[0]);
  const match = data.find((r) => isoCodes(r.address).includes(regionCode.toUpperCase()));
  return match ? toHit(match) : null;
}

/**
 * A city typed by name (City / Country / State boxes), resolved the same way a
 * click on that city's label in "Draw an area" would be, so a city-name fill
 * gets the same boundary, Shapefile and area-measured open data as a map pick.
 * A place too small to have a label on the map gets a circle sized by its
 * population instead (flagged approximate).
 */
export async function cityBoundaryByName(
  city: string,
  country?: string,
  countryCode?: string,
  regionCode?: string
): Promise<{ found: false } | ({ found: true; lat: number; lon: number; cityRef: string | null } & CityBoundary)> {
  const hit = await findCity(city, country, countryCode, regionCode);
  if (!hit) return { found: false };
  const row = await mapCityRow(city, hit);
  if (row) {
    const [name, lat, lon, population, cc] = row;
    await sleep(1100); // Nominatim asks for at most ~1 request per second
    const b = await cityBoundary({ name, lat, lon, countryCode: cc, population });
    return { found: true, lat, lon, cityRef: `${name}|${lat}|${lon}`, ...b, city };
  }
  // Not on the map: a circle about the size of its built-up area.
  const pop = hit.population ?? 1000;
  const radiusKm = Math.min(20, Math.max(2, 1.5 + Math.sqrt(pop) / 180));
  await sleep(1100);
  const rev = await getJson<{ address?: Address }>(
    buildUrl(`${NOMINATIM}/reverse`, { lat: hit.lat, lon: hit.lon, format: "json", zoom: 10, addressdetails: 1 }),
    { headers: { "Accept-Language": "en" } }
  ).catch(() => null);
  const a = rev?.address || {};
  return {
    found: true, lat: hit.lat, lon: hit.lon, cityRef: null,
    ring: circleRing(hit.lat, hit.lon, radiusKm), approximate: true, city,
    country: a.country || null,
    countryCode: (a.country_code || hit.countryCode || "").toUpperCase() || null,
    regionName: a.state || a.province || null,
    regionCode: (a["ISO3166-2-lvl4"] || "").toUpperCase() || null,
  };
}

/**
 * The map's own label for this city (GeoNames: cities.json for 15,000+ people,
 * the 5° detail tiles for 1,000-14,999), or null when the map has no label for it.
 */
type MapCityRow = [string, number, number, number, string, number];
let citiesCache: Promise<MapCityRow[]> | null = null;
const detailCache = new Map<string, Promise<MapCityRow[]>>();
function readPublicJson(rel: string): Promise<MapCityRow[]> {
  return import("node:fs/promises")
    .then((fs) => fs.readFile(`${process.cwd()}/public/${rel}`, "utf8"))
    .then((t) => JSON.parse(t) as MapCityRow[])
    .catch(() => []);
}
async function mapCityRow(city: string, hit: CityHit): Promise<MapCityRow | null> {
  if (!citiesCache) citiesCache = readPublicJson("cities.json");
  const tileKey = `${Math.floor(hit.lat / 5)}_${Math.floor(hit.lon / 5)}`;
  if (!detailCache.has(tileKey)) detailCache.set(tileKey, readPublicJson(`cities/detail/${tileKey}.json`));
  const want = normName(city);
  const rows = [...(await citiesCache), ...(await detailCache.get(tileKey)!)];
  return rows
    .filter((r) => (!hit.countryCode || r[4] === hit.countryCode) && normName(r[0]) === want && kmBetween({ lat: r[1], lon: r[2] }, hit) < 40)
    .sort((x, y) => kmBetween({ lat: x[1], lon: x[2] }, hit) - kmBetween({ lat: y[1], lon: y[2] }, hit))[0] ?? null;
}

function cityFrom(a: Address): string | null {
  return settlementFrom(a) || adminFrom(a);
}

/** The town itself (city, town, village…), when the address names one. */
function settlementFrom(a: Address): string | null {
  return a.city || a.town || a.village || a.hamlet || null;
}

/** The administrative area around it (municipality, county), as a fallback. */
function adminFrom(a: Address): string | null {
  return a.municipality || a.county || null;
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

export interface CityBoundary {
  /** Outer boundary, [lon, lat], simplified for display. */
  ring: LonLat[];
  /** True when no boundary is mapped and a population-sized circle stands in. */
  approximate: boolean;
  city: string;
  country: string | null;
  countryCode: string | null;
  regionName: string | null;
  regionCode: string | null;
}

const normName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const kmBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLon = (a.lon - b.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
};

// Plausible people per km² for a city's boundary. Denser than the max means the
// polygon is a small namesake inside the city (Kinshasa's 4 km² commune); for a
// containing area that doesn't share the city's name, sparser than the min means
// it's a county or province, not the city.
const MAX_DENSITY = 40_000;
const MIN_DENSITY_UNNAMED = 300;

/** Pick the ring to use: the part containing the click, else the largest. */
function pickRing(rings: LonLat[][], lon: number, lat: number): LonLat[] {
  return rings.find((r) => pointInRing(lon, lat, r)) || rings.reduce((big, r) => (ringAreaKm2(r) > ringAreaKm2(big) ? r : big));
}

/**
 * The boundary of a city the user clicked on the map, from OpenStreetMap:
 *
 *  1. A boundary mapped under the city's own name, near the click (Madrid,
 *     Tempe, Brazzaville). Rejected if implausibly small for the population.
 *  2. Many big cities are mapped as a point, with the city's boundary stored
 *     as the administrative area around it under another name ("City of Cape
 *     Town", "Lagos State", the Istanbul province, Banaadir for Mogadishu). So
 *     list the areas containing the city's point and take the most local one
 *     whose size fits the population, preferring ones that share its name.
 *  3. Otherwise a circle sized by population, flagged as approximate.
 */
export async function cityBoundary(p: {
  name: string; lat: number; lon: number; countryCode?: string; population?: number;
}): Promise<CityBoundary> {
  const here = { lat: p.lat, lon: p.lon };
  const pop = p.population || 50000;
  const want = normName(p.name);
  const nameMatches = (n?: string) => {
    const k = normName(n || "");
    return !!k && !!want && (k.includes(want) || want.includes(k));
  };
  const plausible = (areaKm2: number, named: boolean) =>
    areaKm2 >= pop / MAX_DENSITY && (named || areaKm2 <= pop / MIN_DENSITY_UNNAMED);

  type Geo = { type?: string; coordinates?: unknown };
  type Hit = {
    display_name: string; name?: string; lat: string; lon: string; class?: string;
    osm_type?: string; osm_id?: number; address?: Address; geojson?: Geo;
  };
  const hits = await getJson<Hit[]>(
    buildUrl(`${NOMINATIM}/search`, {
      city: p.name,
      countrycodes: p.countryCode ? p.countryCode.toLowerCase() : undefined,
      format: "json", addressdetails: 1, limit: 5,
      polygon_geojson: 1, polygon_threshold: 0.0008, // keeps big cities to a few hundred points
    }),
    { headers: { "Accept-Language": "en" }, timeoutMs: 12000 }
  ).catch(() => [] as Hit[]);
  const nearby = (hits || []).filter((h) => kmBetween(here, { lat: Number(h.lat), lon: Number(h.lon) }) < 40);

  const addressOf = (a: Address = {}) => ({
    country: a.country || null,
    countryCode: (a.country_code || p.countryCode || "").toUpperCase() || null,
    regionName: a.state || a.province || null,
    regionCode: (a["ISO3166-2-lvl4"] || "").toUpperCase() || null,
  });
  const address = nearby[0]?.address;

  // 1) A boundary under the city's own name, nearest the click first.
  const own = (hits || [])
    .map((h) => ({ h, rings: boundaryRings(h.geojson).filter((r) => r.length >= 3) }))
    .filter((c) => c.rings.length)
    .map((c) => {
      const containing = c.rings.find((r) => pointInRing(p.lon, p.lat, r));
      const ring = pickRing(c.rings, p.lon, p.lat);
      return { ...c, ring, dist: containing ? 0 : kmBetween(here, { lat: Number(c.h.lat), lon: Number(c.h.lon) }) };
    })
    .filter((c) => c.dist < 40 && plausible(ringAreaKm2(c.ring), true))
    .sort((a, b) => a.dist - b.dist);
  if (own[0]) {
    return { ring: simplifyRing(own[0].ring, 300), approximate: false, city: p.name, ...addressOf(own[0].h.address || address) };
  }

  // 2) The administrative areas containing the city's point.
  const node = nearby.find((h) => h.osm_type === "node" && h.class === "place");
  if (node?.osm_id) {
    await sleep(1100); // Nominatim asks for at most ~1 request per second
    const details = await getJson<{
      address?: Array<{ osm_type?: string; osm_id?: number; localname?: string; rank_address?: number }>;
    }>(
      buildUrl(`${NOMINATIM}/details`, { osmtype: "N", osmid: node.osm_id, addressdetails: 1, format: "json" }),
      { headers: { "Accept-Language": "en" } }
    ).catch(() => null);
    // State level (rank 8) down to city districts (rank 16); most local first.
    const around = (details?.address || [])
      .filter((a) => a.osm_type === "R" && a.osm_id && (a.rank_address ?? 0) >= 8 && (a.rank_address ?? 0) <= 16)
      .sort((a, b) => (b.rank_address ?? 0) - (a.rank_address ?? 0))
      .slice(0, 6);
    if (around.length) {
      await sleep(1100);
      const shapes = await getJson<Array<{ osm_type?: string; osm_id?: number; name?: string; geojson?: Geo }>>(
        buildUrl(`${NOMINATIM}/lookup`, {
          osm_ids: around.map((a) => `R${a.osm_id}`).join(","),
          format: "json", polygon_geojson: 1, polygon_threshold: 0.001,
        }),
        { headers: { "Accept-Language": "en" }, timeoutMs: 15000 }
      ).catch(() => []);
      const options = around
        .map((a) => {
          const shape = (shapes || []).find((x) => x.osm_id === a.osm_id);
          const rings = boundaryRings(shape?.geojson).filter((r) => r.length >= 3);
          if (!rings.length) return null;
          const ring = pickRing(rings, p.lon, p.lat);
          const named = nameMatches(a.localname) || nameMatches(shape?.name);
          return { ring, named, area: ringAreaKm2(ring) };
        })
        .filter((o): o is { ring: LonLat[]; named: boolean; area: number } => !!o && plausible(o.area, o.named));
      const pick = options.find((o) => o.named) || options[0]; // already most local first
      if (pick) {
        return { ring: simplifyRing(pick.ring, 300), approximate: false, city: p.name, ...addressOf(address) };
      }
    }
  }

  // 3) No usable boundary: a circle roughly the size of the built-up area.
  const radiusKm = Math.min(20, Math.max(2, 1.5 + Math.sqrt(pop) / 180));
  let addr = address;
  if (!addr) {
    const rev = await getJson<{ address?: Address }>(
      buildUrl(`${NOMINATIM}/reverse`, { lat: p.lat, lon: p.lon, format: "json", zoom: 10, addressdetails: 1 }),
      { headers: { "Accept-Language": "en" } }
    ).catch(() => null);
    addr = rev?.address;
  }
  return { ring: circleRing(p.lat, p.lon, radiusKm), approximate: true, city: p.name, ...addressOf(addr) };
}

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

  // A town named at either zoom level beats a municipality or county: towns
  // mapped only as a point (Sonoyta, Mexico) are missing from the coarse
  // lookup, which then names just the municipality around them.
  const city = settlementFrom(cAddr) || settlementFrom(addr) || adminFrom(cAddr) || adminFrom(addr);
  const district = districtFrom(addr);
  const country = cAddr.country || addr.country || null;
  const cc = (cAddr.country_code || addr.country_code || "").toUpperCase() || null;

  let cityAreaKm2: number | null = null;
  let outsideCityFraction: number | null = null;
  // The coarse boundary is only the city's if the coarse lookup is that city;
  // otherwise it's a municipality or county and "% of the city" would be wrong.
  const boundaryIsCity = !!city && (settlementFrom(cAddr) === city || (!settlementFrom(addr) && adminFrom(cAddr) === city));
  const rings = boundaryIsCity ? boundaryRings(coarse?.geojson).filter((r) => r.length >= 3) : [];
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
