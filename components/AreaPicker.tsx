"use client";

/**
 * "Draw an area" for the Assistant's setup panel, in the spirit of
 * OpenTopography's dataset selector: search for a place, draw a rectangle or
 * polygon on a basemap (or load one from a file), and see its size and where it
 * sits. The chosen area is validated against the size limits and checked
 * against the parent city's boundary (a warning, never a block).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Search, Square, Pentagon, Upload, Trash2, Loader2, AlertTriangle, MapPin, Info } from "lucide-react";
import {
  makeArea, validateArea, formatKm2, MAX_AREA_KM2, type AreaSelection, type LonLat,
} from "@/lib/geo/area";
import { AREA_FILE_ACCEPT } from "@/lib/geo/parseAreaFile";
import type { Basemap, DrawMode } from "./AreaMap";

const AreaMap = dynamic(() => import("./AreaMap"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center text-xs text-text-secondary">
      <Loader2 size={14} className="animate-spin mr-1.5" /> Loading map…
    </div>
  ),
});

interface Described {
  city: string | null;
  country: string | null;
  countryCode: string | null;
  label: string | null;
  regionName: string | null;
  regionCode: string | null;
  cityAreaKm2: number | null;
  outsideCityFraction: number | null;
}

async function postArea<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/area", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || res.statusText);
  return json as T;
}

export function AreaPicker({
  area,
  onAreaChange,
  onPlaceResolved,
  onPlaceNotFound,
  disabled = false,
  initialQuery = "",
}: {
  area: AreaSelection | null;
  onAreaChange: (a: AreaSelection | null) => void;
  /** Fired when the area's city/country/state are looked up, to fill the form. */
  onPlaceResolved: (p: {
    city: string; country: string; countryCode?: string | null; regionName?: string | null; regionCode?: string | null;
  }) => void;
  /** Fired when a searched place doesn't exist (the search box is cleared). */
  onPlaceNotFound?: (query: string) => void;
  disabled?: boolean;
  initialQuery?: string;
}) {
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  const [basemap, setBasemap] = useState<Basemap>("map");
  const [query, setQuery] = useState(initialQuery);
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<Array<{ label: string; bbox: [number, number, number, number] }>>([]);
  const [flyTo, setFlyTo] = useState<[number, number, number, number] | null>(null);
  const [describing, setDescribing] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [fileNotes, setFileNotes] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const describeSeq = useRef(0);

  const problem = area ? validateArea(area) : null;

  // Look up which city the area is in (and how much spills outside it).
  const describe = useCallback(async (a: AreaSelection) => {
    if (validateArea(a)) return;
    const seq = ++describeSeq.current;
    setDescribing(true);
    try {
      const d = await postArea<Described>({ action: "describe", ring: a.ring });
      if (seq !== describeSeq.current) return; // a newer shape replaced this one
      onAreaChange({
        ...a,
        label: d.label || undefined,
        outsideCityFraction: d.outsideCityFraction ?? undefined,
        cityAreaKm2: d.cityAreaKm2 ?? undefined,
        countryCode: d.countryCode || undefined,
      });
      if (d.city || d.country) {
        onPlaceResolved({
          city: d.city || "", country: d.country || "", countryCode: d.countryCode,
          regionName: d.regionName, regionCode: d.regionCode,
        });
      }
    } catch {
      if (seq === describeSeq.current) {
        setMessage({ kind: "info", text: "Couldn't look up which city this area is in. Type the City and Country above yourself." });
      }
    } finally {
      if (seq === describeSeq.current) setDescribing(false);
    }
  }, [onAreaChange, onPlaceResolved]);

  // Debounce corner-dragging so Nominatim is only asked once the user lets go.
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (editTimer.current) clearTimeout(editTimer.current); }, []);

  const onShape = useCallback((ring: LonLat[], how: "rectangle" | "polygon" | "edit") => {
    setMessage(null);
    const source = how === "edit" ? area?.source ?? "polygon" : how;
    const next = makeArea(ring, source, how === "edit" ? area?.fileName : undefined);
    if (how !== "edit") setFileNotes([]);
    onAreaChange(next);
    setDrawMode(null);
    if (editTimer.current) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => void describe(next), how === "edit" ? 900 : 0);
  }, [area?.source, area?.fileName, onAreaChange, describe]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setHits([]);
    try {
      const { results } = await postArea<{ results: Array<{ label: string; bbox: [number, number, number, number] }> }>({ action: "search", q });
      if (!results.length) {
        setQuery("");
        if (onPlaceNotFound) onPlaceNotFound(q);
        else setMessage({ kind: "info", text: `No place found for "${q}".` });
      }
      else if (results.length === 1) setFlyTo([...results[0].bbox]);
      else setHits(results);
    } catch (e) {
      setMessage({ kind: "error", text: `Search failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSearching(false);
    }
  }, [query, onPlaceNotFound]);

  // Jump to the typed city the first time the map opens with no area yet.
  const didInitialFly = useRef(false);
  useEffect(() => {
    if (didInitialFly.current || area || !initialQuery.trim()) return;
    didInitialFly.current = true;
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = useCallback(async (file: File) => {
    setMessage(null);
    setFileNotes([]);
    try {
      const { parseAreaFile } = await import("@/lib/geo/parseAreaFile");
      const { area: a, notes } = await parseAreaFile(file);
      setFileNotes(notes);
      onAreaChange(a);
      void describe(a);
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }, [onAreaChange, describe]);

  const clear = useCallback(() => {
    describeSeq.current++;
    setDescribing(false);
    setFileNotes([]);
    setMessage(null);
    onAreaChange(null);
  }, [onAreaChange]);

  const btn = (active: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 ${
      active ? "border-accent-500/60 bg-accent-500/15 text-text-primary" : "border-border bg-surface-overlay text-text-primary hover:border-primary-500/40"
    }`;

  const outsidePct = area?.outsideCityFraction != null ? Math.round(area.outsideCityFraction * 100) : null;
  const coverPct = area?.cityAreaKm2 ? Math.round((area.areaKm2 / area.cityAreaKm2) * 100) : null;

  return (
    <div className="space-y-2">
      {/* Search + basemap */}
      <div className="flex flex-wrap gap-2 items-center">
        <form
          className="flex-1 min-w-[12rem] flex items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); void runSearch(); }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a place, e.g. Tempe, Arizona"
            aria-label="Find a place on the map"
            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm"
          />
          <button type="submit" disabled={searching || !query.trim()} className={btn(false)} aria-label="Search">
            {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          </button>
        </form>
        <div className="flex rounded-lg border border-border overflow-hidden text-xs" role="group" aria-label="Basemap">
          {(["map", "topo", "satellite"] as Basemap[]).map((b) => (
            <button key={b} onClick={() => setBasemap(b)}
              className={`px-2 py-1.5 capitalize ${basemap === b ? "bg-accent-500/15 text-text-primary font-medium" : "bg-surface-overlay text-text-secondary hover:text-text-primary"}`}>
              {b}
            </button>
          ))}
        </div>
      </div>

      {hits.length > 1 && (
        <ul className="rounded-lg border border-border bg-surface divide-y divide-border text-xs max-h-40 overflow-y-auto">
          {hits.map((h, i) => (
            <li key={i}>
              <button onClick={() => { setFlyTo([...h.bbox]); setHits([]); }}
                className="w-full text-left px-2.5 py-1.5 hover:bg-surface-overlay text-text-primary flex items-start gap-1.5">
                <MapPin size={12} className="mt-0.5 shrink-0 text-text-secondary" /> <span className="truncate">{h.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Map (isolate keeps Leaflet's z-indexes below the app's dialogs) */}
      <div className="relative isolate h-96 rounded-xl overflow-hidden border border-border bg-surface-overlay">
        <AreaMap
          area={area}
          drawMode={disabled ? null : drawMode}
          basemap={basemap}
          flyTo={flyTo}
          onShape={onShape}
          onDrawEnd={() => setDrawMode(null)}
        />
        {drawMode && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] px-2.5 py-1 rounded-full text-[11px] bg-surface/95 border border-border text-text-primary shadow">
            {drawMode === "rectangle" ? "Click one corner, then click the opposite corner" : "Click to add corners, double-click to finish"}
          </div>
        )}
      </div>

      {/* Tools */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setDrawMode((m) => (m === "rectangle" ? null : "rectangle"))} disabled={disabled} className={btn(drawMode === "rectangle")}>
          <Square size={13} /> Rectangle
        </button>
        <button onClick={() => setDrawMode((m) => (m === "polygon" ? null : "polygon"))} disabled={disabled} className={btn(drawMode === "polygon")}>
          <Pentagon size={13} /> Polygon
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={disabled} className={btn(false)}
          title="GeoJSON, KML/KMZ, a zipped Shapefile, or a GeoTIFF (its outline is used)">
          <Upload size={13} /> Load area from file
        </button>
        <input ref={fileRef} type="file" accept={AREA_FILE_ACCEPT} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.currentTarget.value = ""; }} />
        {area && (
          <button onClick={clear} disabled={disabled} className={`${btn(false)} ml-auto`}>
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>

      {/* Status */}
      {!area && !message && (
        <p className="text-[11px] text-text-secondary">
          Draw the area to assess (up to {formatKm2(MAX_AREA_KM2)}), or load a GeoJSON, KML/KMZ, zipped Shapefile or GeoTIFF. You can drag its corners afterwards to adjust it.
        </p>
      )}
      {area && (
        <div className="text-xs space-y-1">
          <p className="text-text-primary flex flex-wrap items-center gap-x-1.5">
            <span className="font-semibold">{formatKm2(area.areaKm2)}</span>
            {area.fileName && <span className="text-text-secondary">· {area.fileName}</span>}
            {describing ? (
              <span className="text-text-secondary inline-flex items-center gap-1">· <Loader2 size={11} className="animate-spin" /> finding where this is…</span>
            ) : area.label ? (
              <span className="text-text-secondary">· {area.label}</span>
            ) : null}
            {coverPct != null && !problem && coverPct <= 100 && (
              <span className="text-text-secondary">· about {coverPct < 1 ? "<1" : coverPct}% of the city</span>
            )}
          </p>
          {problem && (
            <p className="flex items-start gap-1.5 text-danger-400"><AlertTriangle size={13} className="shrink-0 mt-0.5" />{problem}</p>
          )}
          {!problem && outsidePct != null && outsidePct >= 10 && (
            <p className="flex items-start gap-1.5 text-warn-400">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              About {outsidePct}% of this area lies outside the city boundary. That&apos;s fine for areas like a watershed, but city-wide answers will describe the city named above.
            </p>
          )}
        </div>
      )}
      {fileNotes.map((n, i) => (
        <p key={i} className="flex items-start gap-1.5 text-[11px] text-text-secondary"><Info size={12} className="shrink-0 mt-0.5" />{n}</p>
      ))}
      {message && (
        <p className={`flex items-start gap-1.5 text-xs ${message.kind === "error" ? "text-danger-400" : "text-text-secondary"}`}>
          {message.kind === "error" ? <AlertTriangle size={13} className="shrink-0 mt-0.5" /> : <Info size={13} className="shrink-0 mt-0.5" />}
          {message.text}
        </p>
      )}
    </div>
  );
}
