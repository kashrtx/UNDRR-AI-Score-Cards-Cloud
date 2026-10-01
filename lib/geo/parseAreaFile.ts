/**
 * Read an area boundary out of a file the user already has (browser only).
 *
 *   • GeoJSON (.geojson / .json) — Polygon or MultiPolygon, any Feature wrapper.
 *   • KML / KMZ — the first <Polygon>'s outer boundary.
 *   • Shapefile (.zip containing .shp/.dbf/.prj) — reprojected to lat/lon via its .prj.
 *   • GeoTIFF (.tif / .tiff) — only the raster's EXTENT becomes the area (first
 *     version); the pixel values are not read. WGS84, Web Mercator and UTM
 *     (WGS84 / NAD83) are reprojected; other projections explain themselves.
 *
 * When a file holds several polygons the largest one is used, and the caller is
 * told so. The heavy parsers are imported on demand so they don't weigh down
 * the page for people who never load a file.
 */

import { makeArea, ringAreaKm2, type AreaSelection, type LonLat } from "./area";

export const AREA_FILE_ACCEPT = ".geojson,.json,.kml,.kmz,.zip,.tif,.tiff";

export interface ParsedAreaFile {
  area: AreaSelection;
  /** Plain-language notes about what was done (e.g. "used the largest of 3 polygons"). */
  notes: string[];
}

type Geometry = { type: string; coordinates?: unknown; geometries?: Geometry[] };

/** Outer rings of every polygon in any GeoJSON object. */
function outerRings(obj: unknown): LonLat[][] {
  const rings: LonLat[][] = [];
  const visit = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const g = o as { type?: string; features?: unknown[]; geometry?: unknown; coordinates?: unknown; geometries?: unknown[] };
    switch (g.type) {
      case "FeatureCollection":
        (g.features || []).forEach(visit);
        break;
      case "Feature":
        visit(g.geometry);
        break;
      case "GeometryCollection":
        (g.geometries || []).forEach(visit);
        break;
      case "Polygon": {
        const c = g.coordinates as number[][][] | undefined;
        if (c?.[0]?.length) rings.push(c[0].map((p) => [p[0], p[1]] as LonLat));
        break;
      }
      case "MultiPolygon": {
        const c = g.coordinates as number[][][][] | undefined;
        for (const poly of c || []) if (poly?.[0]?.length) rings.push(poly[0].map((p) => [p[0], p[1]] as LonLat));
        break;
      }
    }
  };
  // shpjs returns an array of FeatureCollections when a zip holds several layers.
  if (Array.isArray(obj)) obj.forEach(visit);
  else visit(obj);
  return rings;
}

function pickLargest(rings: LonLat[][], what: string): { ring: LonLat[]; notes: string[] } {
  if (!rings.length) throw new Error(`No polygon was found in this ${what}. It needs an area boundary, not just points or lines.`);
  let best = rings[0];
  let bestA = ringAreaKm2(best);
  for (const r of rings.slice(1)) {
    const a = ringAreaKm2(r);
    if (a > bestA) { best = r; bestA = a; }
  }
  const notes = rings.length > 1 ? [`The file had ${rings.length} polygons, so the largest one was used.`] : [];
  return { ring: best, notes };
}

function looksGeographic(rings: LonLat[][]): boolean {
  return rings.every((r) => r.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90));
}

function parseGeoJson(text: string): { ring: LonLat[]; notes: string[] } {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid GeoJSON.");
  }
  const rings = outerRings(obj);
  if (rings.length && !looksGeographic(rings)) {
    throw new Error("This GeoJSON uses projected coordinates. Please export it in WGS84 (EPSG:4326, latitude/longitude).");
  }
  return pickLargest(rings, "GeoJSON file");
}

function parseKml(text: string): { ring: LonLat[]; notes: string[] } {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This KML file couldn't be read.");
  const rings: LonLat[][] = [];
  const polys = Array.from(doc.getElementsByTagNameNS("*", "Polygon"));
  for (const p of polys) {
    const outer = p.getElementsByTagNameNS("*", "outerBoundaryIs")[0] || p;
    const coordsEl = outer.getElementsByTagNameNS("*", "coordinates")[0];
    if (!coordsEl?.textContent) continue;
    const ring = coordsEl.textContent
      .trim()
      .split(/\s+/)
      .map((t) => t.split(",").map(Number))
      .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => [c[0], c[1]] as LonLat);
    if (ring.length >= 3) rings.push(ring);
  }
  return pickLargest(rings, "KML file");
}

async function parseKmz(buf: ArrayBuffer): Promise<{ ring: LonLat[]; notes: string[] }> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(new Uint8Array(buf));
  const name = Object.keys(files).find((n) => /\.kml$/i.test(n));
  if (!name) throw new Error("This KMZ doesn't contain a KML file.");
  return parseKml(strFromU8(files[name]));
}

async function parseShapefileZip(buf: ArrayBuffer): Promise<{ ring: LonLat[]; notes: string[] }> {
  const { unzipSync } = await import("fflate");
  const names = Object.keys(unzipSync(new Uint8Array(buf.slice(0))));
  if (!names.some((n) => /\.shp$/i.test(n))) {
    throw new Error("This .zip doesn't contain a Shapefile (.shp). Zip the .shp, .shx, .dbf and .prj files together.");
  }
  const notes: string[] = [];
  if (!names.some((n) => /\.prj$/i.test(n))) {
    notes.push("The Shapefile has no .prj file, so its coordinates were assumed to be latitude/longitude (WGS84).");
  }
  const shp = (await import("shpjs")).default;
  const geo = await shp(buf);
  const rings = outerRings(geo);
  if (rings.length && !looksGeographic(rings)) {
    throw new Error("This Shapefile's coordinates couldn't be converted to latitude/longitude. Include its .prj file in the zip.");
  }
  const picked = pickLargest(rings, "Shapefile");
  return { ring: picked.ring, notes: [...notes, ...picked.notes] };
}

/** proj4 definition for the EPSG codes GeoTIFFs most often use. */
function projDefFor(epsg: number): string | null {
  if (epsg === 4326 || epsg === 4269 || epsg === 4258) return "+proj=longlat +datum=WGS84 +no_defs";
  if (epsg === 3857 || epsg === 900913 || epsg === 3785) return "EPSG:3857";
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 26901 && epsg <= 26923) return `+proj=utm +zone=${epsg - 26900} +datum=NAD83 +units=m +no_defs`;
  if (epsg >= 25828 && epsg <= 25838) return `+proj=utm +zone=${epsg - 25800} +ellps=GRS80 +units=m +no_defs`;
  return null;
}

async function parseGeoTiff(buf: ArrayBuffer): Promise<{ ring: LonLat[]; notes: string[] }> {
  const { fromArrayBuffer } = await import("geotiff");
  let image;
  try {
    const tiff = await fromArrayBuffer(buf);
    image = await tiff.getImage();
  } catch {
    throw new Error("This file couldn't be read as a GeoTIFF.");
  }
  let bbox: number[];
  try {
    bbox = image.getBoundingBox();
  } catch {
    throw new Error("This TIFF has no georeferencing, so it can't be placed on the map.");
  }
  const [minX, minY, maxX, maxY] = bbox;
  const keys = (image.getGeoKeys?.() || {}) as Record<string, number | undefined>;
  const epsg = keys.ProjectedCSTypeGeoKey && keys.ProjectedCSTypeGeoKey !== 32767
    ? keys.ProjectedCSTypeGeoKey
    : keys.GeographicTypeGeoKey || (keys.GTModelTypeGeoKey === 2 ? 4326 : undefined);

  // Densify the rectangle's edges so a projected extent keeps its true shape.
  const corners: LonLat[] = [];
  const N = 8;
  for (let i = 0; i < N; i++) corners.push([minX + ((maxX - minX) * i) / N, minY]);
  for (let i = 0; i < N; i++) corners.push([maxX, minY + ((maxY - minY) * i) / N]);
  for (let i = 0; i < N; i++) corners.push([maxX - ((maxX - minX) * i) / N, maxY]);
  for (let i = 0; i < N; i++) corners.push([minX, maxY - ((maxY - minY) * i) / N]);

  const notes = ["Only the GeoTIFF's outline (extent) was used as the area; its pixel values aren't read."];
  const geographic = looksGeographic([corners]);
  if (!epsg) {
    if (geographic) return { ring: corners, notes: [...notes, "The GeoTIFF didn't state its projection, so latitude/longitude was assumed."] };
    throw new Error("This GeoTIFF doesn't say which map projection it uses, so it can't be placed on the map.");
  }
  const def = projDefFor(epsg);
  if (!def) {
    throw new Error(`This GeoTIFF uses projection EPSG:${epsg}, which isn't supported yet. Reproject it to WGS84 (EPSG:4326) or UTM and try again.`);
  }
  if (def.startsWith("+proj=longlat")) return { ring: corners, notes };
  const proj4 = (await import("proj4")).default;
  const ring = corners.map((c) => proj4(def, "EPSG:4326", c) as LonLat);
  return { ring, notes };
}

export async function parseAreaFile(file: File): Promise<ParsedAreaFile> {
  const name = file.name.toLowerCase();
  let parsed: { ring: LonLat[]; notes: string[] };
  if (/\.(geo)?json$/.test(name)) parsed = parseGeoJson(await file.text());
  else if (name.endsWith(".kml")) parsed = parseKml(await file.text());
  else if (name.endsWith(".kmz")) parsed = await parseKmz(await file.arrayBuffer());
  else if (name.endsWith(".zip")) parsed = await parseShapefileZip(await file.arrayBuffer());
  else if (/\.tiff?$/.test(name)) parsed = await parseGeoTiff(await file.arrayBuffer());
  else {
    throw new Error("Supported area files: GeoJSON, KML/KMZ, a zipped Shapefile, or a GeoTIFF.");
  }
  return { area: makeArea(parsed.ring, "file", file.name), notes: parsed.notes };
}
