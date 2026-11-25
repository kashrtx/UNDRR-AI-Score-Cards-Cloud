/**
 * Area selection — a polygon the user drew on the map (or loaded from a file)
 * instead of typing a city name. Pure geometry helpers, safe on client and
 * server alike: area, bounding box, centroid, simplification, and the size
 * limits that keep the free open-data APIs from timing out.
 *
 * Coordinates are [lon, lat] (GeoJSON order) throughout. A ring is the outer
 * boundary only, stored OPEN (the first point is not repeated at the end).
 */

export type LonLat = [number, number];

export interface AreaSelection {
  /** Outer boundary, [lon, lat], open ring. */
  ring: LonLat[];
  /** How the area was made. */
  /** "city" = a city's boundary picked by clicking its name on the map;
   *  "circle" = drawn with the Circle tool or entered as Lat/Lon + radius. */
  source: "rectangle" | "polygon" | "file" | "city" | "circle";
  /** Original file name, when loaded from a file. */
  fileName?: string;
  areaKm2: number;
  /** [south, north, west, east] — same order geocode() uses. */
  bbox: [number, number, number, number];
  centroid: { lat: number; lon: number };
  /** Friendly place label from reverse geocoding, e.g. "Downtown, Toronto". */
  label?: string;
  /** Share of the area (0-1) that falls outside the parent city's boundary, when known. */
  outsideCityFraction?: number;
  /** The parent city's own area in km², when known (for "covers N% of the city"). */
  cityAreaKm2?: number;
  /** ISO-2 country code from reverse geocoding, when known. */
  countryCode?: string;
  /** For a clicked city with no mapped boundary: a circle sized by population. */
  approximate?: boolean;
  /** For a clicked city: which map label it was ("name|lat|lon"), to highlight it. */
  cityRef?: string;
  /** For a circle: its centre and radius (the ring is a 64-point approximation). */
  circle?: { lat: number; lon: number; radiusKm: number };
}

/** Hard cap: bigger areas make Overpass and the other free APIs time out. */
export const MAX_AREA_KM2 = 1000;
/** Clicked city boundaries may be much bigger: some cities are whole
 *  provinces (Kinshasa ~10,800 km², Istanbul ~11,300 km² including its
 *  waters). The infrastructure counts still answer for these, if more slowly. */
export const MAX_CITY_AREA_KM2 = 12000;

export function maxAreaFor(source?: AreaSelection["source"]): number {
  return source === "city" ? MAX_CITY_AREA_KM2 : MAX_AREA_KM2;
}
/** Floor: tiny slivers return no useful data. */
export const MIN_AREA_KM2 = 0.1;
/** Circles follow the drawn-area limits: radius ≈17.8 km for 1,000 km². */
export const MAX_CIRCLE_RADIUS_KM = Math.floor(Math.sqrt(MAX_AREA_KM2 / Math.PI) * 10) / 10;
export const MIN_CIRCLE_RADIUS_KM = Math.ceil(Math.sqrt(MIN_AREA_KM2 / Math.PI) * 100) / 100;
/** Vertices kept when sending a polygon to the data APIs. */
export const MAX_RING_POINTS = 200;

const EARTH_RADIUS_M = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;

/** Drop a repeated closing point and any non-finite coordinates. */
export function openRing(ring: LonLat[]): LonLat[] {
  const r = ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (r.length > 1) {
    const a = r[0];
    const b = r[r.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) r.pop();
  }
  return r;
}

/** Geodesic area of a ring in km² (spherical approximation, as in geojson-area). */
export function ringAreaKm2(ring: LonLat[]): number {
  const r = openRing(ring);
  if (r.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < r.length; i++) {
    const [lon1, lat1] = r[i];
    const [lon2, lat2] = r[(i + 1) % r.length];
    total += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2) / 1e6;
}

export function ringBbox(ring: LonLat[]): [number, number, number, number] {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const [lon, lat] of ring) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  }
  return [s, n, w, e];
}

/** Area-weighted centroid of the ring; falls back to the vertex mean for degenerate shapes. */
export function ringCentroid(ring: LonLat[]): { lat: number; lon: number } {
  const r = openRing(ring);
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const lon = r.reduce((s, p) => s + p[0], 0) / (r.length || 1);
    const lat = r.reduce((s, p) => s + p[1], 0) / (r.length || 1);
    return { lat, lon };
  }
  a *= 0.5;
  return { lat: cy / (6 * a), lon: cx / (6 * a) };
}

/** Even-odd point-in-polygon test. */
export function pointInRing(lon: number, lat: number, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Keep at most `max` vertices by even decimation (good enough for query polygons). */
export function simplifyRing(ring: LonLat[], max = MAX_RING_POINTS): LonLat[] {
  const r = openRing(ring);
  if (r.length <= max) return r;
  const step = r.length / max;
  const out: LonLat[] = [];
  for (let i = 0; i < max; i++) out.push(r[Math.floor(i * step)]);
  return out;
}

/** Up to `max` sample points spread evenly inside the ring (grid over its bbox). */
export function samplePointsInRing(ring: LonLat[], max = 60): LonLat[] {
  const [s, n, w, e] = ringBbox(ring);
  const out: LonLat[] = [];
  // Grow the grid until it yields enough interior points (odd shapes waste cells).
  for (let side = Math.ceil(Math.sqrt(max)); side <= Math.ceil(Math.sqrt(max)) * 4; side += 2) {
    out.length = 0;
    for (let i = 0; i < side; i++) {
      for (let j = 0; j < side; j++) {
        const lon = w + ((i + 0.5) / side) * (e - w);
        const lat = s + ((j + 0.5) / side) * (n - s);
        if (pointInRing(lon, lat, ring)) out.push([lon, lat]);
      }
    }
    if (out.length >= max * 0.6) break;
  }
  if (!out.length) {
    const c = ringCentroid(ring);
    out.push([c.lon, c.lat]);
  }
  return out.slice(0, max);
}

/** Build a full AreaSelection from a raw ring. */
export function makeArea(
  ring: LonLat[],
  source: AreaSelection["source"],
  fileName?: string
): AreaSelection {
  const r = openRing(ring).map(([lon, lat]) => [round6(lon), round6(lat)] as LonLat);
  return {
    ring: r,
    source,
    fileName,
    areaKm2: ringAreaKm2(r),
    bbox: ringBbox(r),
    centroid: ringCentroid(r),
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Returns a human-readable problem with the area, or null when it is usable. */
export function validateArea(a: Pick<AreaSelection, "ring" | "areaKm2" | "bbox"> & { source?: AreaSelection["source"] }): string | null {
  if (!a.ring || a.ring.length < 3) return "An area needs at least three corners.";
  const [s, n, w, e] = a.bbox;
  if (s < -90 || n > 90 || w < -180 || e > 180) return "The area's coordinates are outside the valid latitude/longitude range.";
  const max = maxAreaFor(a.source);
  if (a.areaKm2 > max) {
    return a.source === "city"
      ? `This city's boundary is ${formatKm2(a.areaKm2)}, more than the ${formatKm2(max)} the free data services can handle. Draw a smaller area inside it, or use "By city name".`
      : `This area is ${formatKm2(a.areaKm2)}. The limit is ${formatKm2(max)}, so the free data services can answer in time. Try a smaller area.`;
  }
  if (a.areaKm2 < MIN_AREA_KM2) {
    return `This area is only ${formatKm2(a.areaKm2)}. Please make it at least ${formatKm2(MIN_AREA_KM2)} so there is data to find.`;
  }
  return null;
}

export function formatKm2(km2: number): string {
  if (km2 >= 100) return `${Math.round(km2).toLocaleString()} km²`;
  if (km2 >= 1) return `${km2.toFixed(1)} km²`;
  return `${km2.toFixed(2)} km²`;
}

/** A one-line description for prompts, chat, and headers. */
export function describeArea(a: AreaSelection): string {
  if (a.source === "city") {
    return `${formatKm2(a.areaKm2)} ${a.approximate ? "approximate boundary" : "city boundary"} of ${a.label || "the city"}`;
  }
  const where = a.label ? ` around ${a.label}` : "";
  if (a.source === "circle" && a.circle) {
    return `${formatKm2(a.areaKm2)} circle of radius ${a.circle.radiusKm.toFixed(2)} km${where}`;
  }
  return `${formatKm2(a.areaKm2)} ${a.source === "file" ? "area loaded from a file" : "area drawn on the map"}${where}`;
}

/** A circle area (Circle tool or Lat/Lon), with its centre and radius kept. */
export function makeCircleArea(lat: number, lon: number, radiusKm: number): AreaSelection {
  return { ...makeArea(circleRing(lat, lon, radiusKm, 64), "circle"), circle: { lat, lon, radiusKm } };
}

/** A circle as a ring (also stands in for cities with no mapped boundary). */
export function circleRing(lat: number, lon: number, radiusKm: number, points = 48): LonLat[] {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.05, Math.cos(rad(lat))));
  return Array.from({ length: points }, (_, i) => {
    const t = (i / points) * 2 * Math.PI;
    return [lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)] as LonLat;
  });
}
