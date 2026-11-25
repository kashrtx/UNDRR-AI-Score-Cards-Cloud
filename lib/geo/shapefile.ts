/**
 * Writes the selected area as a zipped ESRI Shapefile (browser or server):
 * one polygon in WGS84 latitude/longitude (EPSG:4326), with .shp, .shx, .dbf,
 * .prj and .cpg inside the zip. This is the file the Assistant offers for
 * download, and its exact geometry is what the open-data lookups and the AI's
 * instructions use when filling out a scorecard for a drawn area.
 *
 * Spec: ESRI Shapefile Technical Description (1998); dBASE III table.
 */

import { zipSync, strToU8 } from "fflate";
import { openRing, ringAreaKm2, type AreaSelection, type LonLat } from "./area";

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/** Shapefile outer rings run clockwise and repeat their first point at the end. */
function shapefileRing(ring: LonLat[]): LonLat[] {
  const r = openRing(ring);
  let twiceArea = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  const clockwise = twiceArea < 0;
  const ordered = clockwise ? r : [...r].reverse();
  return [...ordered, ordered[0]];
}

function bboxOf(pts: LonLat[]): [number, number, number, number] {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of pts) {
    if (x < xmin) xmin = x;
    if (y < ymin) ymin = y;
    if (x > xmax) xmax = x;
    if (y > ymax) ymax = y;
  }
  return [xmin, ymin, xmax, ymax];
}

/** The 100-byte main header shared by .shp and .shx. */
function writeHeader(dv: DataView, fileBytes: number, bbox: [number, number, number, number]) {
  dv.setInt32(0, 9994, false); // file code
  dv.setInt32(24, fileBytes / 2, false); // length in 16-bit words
  dv.setInt32(28, 1000, true); // version
  dv.setInt32(32, 5, true); // shape type: Polygon
  bbox.forEach((v, i) => dv.setFloat64(36 + i * 8, v, true));
}

/** A one-row dBASE III table: NAME, AREA_KM2, SOURCE, CREATED. */
function writeDbf(fields: { name: string; area: number; source: string; created: string }): Uint8Array {
  const defs: Array<{ name: string; type: "C" | "N"; len: number; dec: number; value: string }> = [
    { name: "NAME", type: "C", len: 100, dec: 0, value: fields.name },
    { name: "AREA_KM2", type: "N", len: 14, dec: 3, value: fields.area.toFixed(3) },
    { name: "SOURCE", type: "C", len: 20, dec: 0, value: fields.source },
    { name: "CREATED", type: "C", len: 10, dec: 0, value: fields.created },
  ];
  const headerLen = 32 + defs.length * 32 + 1;
  const recordLen = 1 + defs.reduce((n, d) => n + d.len, 0);
  const out = new Uint8Array(headerLen + recordLen + 1);
  const dv = new DataView(out.buffer);
  const now = new Date();
  dv.setUint8(0, 0x03); // dBASE III, no memo
  dv.setUint8(1, now.getUTCFullYear() - 1900);
  dv.setUint8(2, now.getUTCMonth() + 1);
  dv.setUint8(3, now.getUTCDate());
  dv.setUint32(4, 1, true); // one record
  dv.setUint16(8, headerLen, true);
  dv.setUint16(10, recordLen, true);
  defs.forEach((d, i) => {
    const o = 32 + i * 32;
    out.set(strToU8(d.name).slice(0, 10), o);
    dv.setUint8(o + 11, d.type.charCodeAt(0));
    dv.setUint8(o + 16, d.len);
    dv.setUint8(o + 17, d.dec);
  });
  dv.setUint8(headerLen - 1, 0x0d); // end of field descriptors
  let o = headerLen;
  out[o++] = 0x20; // record not deleted
  for (const d of defs) {
    const cell = new Uint8Array(d.len).fill(0x20);
    // UTF-8 (declared in the .cpg); cut on a character boundary so names stay valid.
    let chars = Array.from(d.value);
    let bytes = strToU8(d.value);
    while (bytes.length > d.len) {
      chars = chars.slice(0, -1);
      bytes = strToU8(chars.join(""));
    }
    if (d.type === "N") cell.set(bytes, d.len - bytes.length); // numbers are right-aligned
    else cell.set(bytes, 0);
    out.set(cell, o);
    o += d.len;
  }
  out[o] = 0x1a; // end of file
  return out;
}

export interface ShapefileBundle {
  /** Download name, e.g. "arise-area-tempe-2026-10-04.zip". */
  fileName: string;
  /** Base name of the files inside the zip (no extension). */
  layerName: string;
  zip: Uint8Array;
}

const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "selection";

/** File name for an area's Shapefile (stable for the same area and day). */
export function shapefileName(area: AreaSelection, place?: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `arise-area-${slug(area.label || place || "selection")}-${day}.zip`;
}

export function buildAreaShapefile(area: AreaSelection, place?: string): ShapefileBundle {
  const pts = shapefileRing(area.ring);
  const bbox = bboxOf(pts);

  // .shp: header + one polygon record (one part).
  const content = 4 + 32 + 4 + 4 + 4 + pts.length * 16; // shape type, bbox, numParts, numPoints, parts[0], points
  const shpLen = 100 + 8 + content;
  const shp = new ArrayBuffer(shpLen);
  let dv = new DataView(shp);
  writeHeader(dv, shpLen, bbox);
  dv.setInt32(100, 1, false); // record number
  dv.setInt32(104, content / 2, false); // content length in words
  let o = 108;
  dv.setInt32(o, 5, true); o += 4;
  bbox.forEach((v) => { dv.setFloat64(o, v, true); o += 8; });
  dv.setInt32(o, 1, true); o += 4; // parts
  dv.setInt32(o, pts.length, true); o += 4;
  dv.setInt32(o, 0, true); o += 4; // part 0 starts at point 0
  for (const [x, y] of pts) { dv.setFloat64(o, x, true); dv.setFloat64(o + 8, y, true); o += 16; }

  // .shx: header + one index entry.
  const shx = new ArrayBuffer(108);
  dv = new DataView(shx);
  writeHeader(dv, 108, bbox);
  dv.setInt32(100, 50, false); // offset of record 1, in words
  dv.setInt32(104, content / 2, false);

  const name = area.label || place || "Selected area";
  const dbf = writeDbf({
    name,
    area: ringAreaKm2(area.ring),
    source: area.source,
    created: new Date().toISOString().slice(0, 10),
  });

  const fileName = shapefileName(area, place);
  const layerName = fileName.replace(/\.zip$/, "");
  const zip = zipSync({
    [`${layerName}.shp`]: new Uint8Array(shp),
    [`${layerName}.shx`]: new Uint8Array(shx),
    [`${layerName}.dbf`]: dbf,
    [`${layerName}.prj`]: strToU8(WGS84_PRJ),
    [`${layerName}.cpg`]: strToU8("UTF-8"),
  });
  return { fileName, layerName, zip };
}
