/**
 * Saved analyses library: every finished analysis is kept here (in this
 * browser), with the city it was for, the shape of the area that was used,
 * which AI helper wrote it, and when. The Analysis tab lists them so they can be
 * reopened, downloaded, or deleted, even after the Assistant has moved on to
 * another city.
 *
 * One analysis per helper per city and shape: re-running the same helper on the
 * same city and shape updates its entry. Analysing the same city with a
 * different shape asks whether to replace the earlier one or keep both.
 */

import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { AnalysisResult } from "./schema";
import type { DataReport } from "@/lib/types";
import type { ExportMeta } from "@/lib/export/report";
import type { ProviderId } from "@/lib/settings/store";
import { formatKm2, type AreaSelection } from "@/lib/geo/area";

const LIBRARY_KEY = "undrr.library.v1";

/** How the place was outlined, in plain words ("Point radius", "2.00 km radius · 12.6 km²"). */
export interface SavedShape {
  kind: string;
  detail: string;
}

export interface SavedAnalysis {
  id: string;
  savedAt: string;
  /** The city, whatever its outline ("tempe|arizona|united states"). */
  cityKey: string;
  /** The city and outline together; two entries with the same placeKey are the same analysis target. */
  placeKey: string;
  /** "Tempe, Arizona, United States" or "Area · Downtown, Tempe". */
  place: string;
  shape: SavedShape;
  /** The helper that wrote the analysis, and the helper whose scorecard it read. */
  provider: ProviderId;
  source: ProviderId;
  scorecard: NormalizedScorecard;
  result: AnalysisResult;
  dataReport: DataReport | null;
  meta: ExportMeta;
}

export function shapeOf(a: AreaSelection | null, areaMode: boolean): SavedShape {
  if (!a) return { kind: areaMode ? "Drawn area" : "City (no boundary found)", detail: "" };
  const size = formatKm2(a.areaKm2);
  switch (a.source) {
    case "city":
      return a.approximate
        ? { kind: "Approximate city circle", detail: `${size} (no official boundary is mapped)` }
        : { kind: "City boundary", detail: size };
    case "circle":
      return { kind: "Point radius", detail: a.circle ? `${a.circle.radiusKm.toFixed(2)} km radius · ${size}` : size };
    case "rectangle":
      return { kind: "Rectangle", detail: size };
    case "polygon":
      return { kind: "Drawn polygon", detail: size };
    case "file":
      return { kind: "Area from a file", detail: a.fileName ? `${a.fileName} · ${size}` : size };
    default:
      return { kind: "Area", detail: size };
  }
}

export function loadLibrary(): SavedAnalysis[] {
  try {
    const list = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
    return Array.isArray(list) ? list.filter((x) => x && x.result && x.scorecard) : [];
  } catch {
    return [];
  }
}

/** Write the library; false when the browser's storage is full. */
export function storeLibrary(list: SavedAnalysis[]): boolean {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Earlier analyses by this helper for this city, made with a different outline. */
export function otherShapes(list: SavedAnalysis[], entry: Pick<SavedAnalysis, "cityKey" | "placeKey" | "provider">): SavedAnalysis[] {
  return list.filter((x) => x.cityKey === entry.cityKey && x.provider === entry.provider && x.placeKey !== entry.placeKey);
}

/**
 * Add a finished analysis. Its own earlier version (same helper, city and
 * outline) is always replaced; with `replaceOtherShapes`, so are that helper's
 * analyses of the same city made with a different outline.
 */
export function addToLibrary(list: SavedAnalysis[], entry: SavedAnalysis, replaceOtherShapes: boolean): SavedAnalysis[] {
  const keep = list.filter(
    (x) => !(x.cityKey === entry.cityKey && x.provider === entry.provider && (x.placeKey === entry.placeKey || replaceOtherShapes))
  );
  return [entry, ...keep];
}

export function newLibraryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
