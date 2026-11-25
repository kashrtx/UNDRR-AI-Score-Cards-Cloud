"use client";

/**
 * "Draw an area" for the Assistant's setup panel, in the spirit of
 * OpenTopography's dataset selector: search for a place, draw a rectangle or
 * polygon on a basemap (or load one from a file), and see its size and where it
 * sits. The chosen area is validated against the size limits and checked
 * against the parent city's boundary (a warning, never a block).
 *
 * With no drawing tool active, city names on the map can be clicked: that
 * selects the city's official boundary (or an approximate one) as the area and
 * fills in City / Country / State. Drawing a new shape replaces it: the old
 * outline disappears at the first press on the map (and comes back if the
 * drawing is cancelled); the area itself changes once the new shape is done.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { Search, Square, Pentagon, Circle as CircleIcon, Crosshair, Upload, Trash2, Loader2, AlertTriangle, MapPin, Info, MousePointerClick, FileUp, Shapes, ChevronDown } from "lucide-react";
import {
  makeArea, makeCircleArea, validateArea, formatKm2, MAX_AREA_KM2, MIN_AREA_KM2, MAX_CIRCLE_RADIUS_KM, MIN_CIRCLE_RADIUS_KM,
  type AreaSelection, type LonLat,
} from "@/lib/geo/area";
import { defaultUnit, saveUnit, toKm, fromKm, formatDistance, type DistanceUnit } from "@/lib/geo/units";
import { AREA_FILE_ACCEPT, AREA_FILE_TYPES } from "@/lib/geo/parseAreaFile";
import type { Basemap, CityRow, DrawMode } from "./AreaMap";

interface CityBoundaryResult {
  ring: LonLat[];
  approximate: boolean;
  city: string;
  country: string | null;
  countryCode: string | null;
  regionName: string | null;
  regionCode: string | null;
}

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
  onClearPlace,
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
  /** Fired when a clicked city is erased, to blank City / Country / State too. */
  onClearPlace?: () => void;
  disabled?: boolean;
  initialQuery?: string;
}) {
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  // Circle radius unit: miles or km by location, then whatever the user last chose.
  const [unit, setUnitState] = useState<DistanceUnit>("km");
  useEffect(() => { setUnitState(defaultUnit()); }, []);
  const setUnit = useCallback((u: DistanceUnit) => { setUnitState(u); saveUnit(u); }, []);
  // "Lat/Lon" form, and the radius box shown under a drawn circle.
  const [latLonOpen, setLatLonOpen] = useState(false);
  const [llLat, setLlLat] = useState("");
  const [llLon, setLlLon] = useState("");
  const [llRadius, setLlRadius] = useState("");
  const [llError, setLlError] = useState<string | null>(null);
  const [radiusText, setRadiusText] = useState("");
  const [radiusError, setRadiusError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<Basemap>("map");
  const [query, setQuery] = useState(initialQuery);
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<Array<{ label: string; bbox: [number, number, number, number] }>>([]);
  const [flyTo, setFlyTo] = useState<[number, number, number, number] | null>(null);
  const [describing, setDescribing] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [fileNotes, setFileNotes] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // "Create Area" (top left of the map, beside the zoom buttons): opens the
  // area tools there, so they're always next to the map. A click anywhere
  // outside the panel (or Escape) closes it again.
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: PointerEvent) => { if (!toolsRef.current?.contains(e.target as Node)) setToolsOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setToolsOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [toolsOpen]);
  useEffect(() => { if (disabled) setToolsOpen(false); }, [disabled]);
  // Escape cancels a drawing in progress (the previous outline comes back).
  useEffect(() => {
    if (!drawMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawMode(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawMode]);
  // "Load area from file": the explainer popup, and why the last file was rejected.
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const describeSeq = useRef(0);
  // Cursor read-out: written straight to the DOM so moving the mouse doesn't re-render the panel.
  const latOut = useRef<HTMLSpanElement | null>(null);
  const lonOut = useRef<HTMLSpanElement | null>(null);
  const onCursor = useCallback((pos: { lat: number; lon: number } | null) => {
    if (latOut.current) latOut.current.textContent = pos ? pos.lat.toFixed(6) : "—";
    if (lonOut.current) lonOut.current.textContent = pos ? pos.lon.toFixed(6) : "—";
  }, []);
  // The city being looked up; the selected one is remembered with the area.
  const [cityLoading, setCityLoading] = useState<string | null>(null);
  const isCity = area?.source === "city";

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

  /** Problem with a radius (in km), worded in the user's unit; null if fine. */
  const radiusProblem = useCallback((km: number): string | null => {
    if (!Number.isFinite(km) || km <= 0) return "Enter a radius greater than 0.";
    if (km < MIN_CIRCLE_RADIUS_KM) return `The radius must be at least ${formatDistance(MIN_CIRCLE_RADIUS_KM, unit, 2)}.`;
    if (km > MAX_CIRCLE_RADIUS_KM) {
      return `The radius can be at most ${formatDistance(MAX_CIRCLE_RADIUS_KM, unit)} (a ${formatKm2(MAX_AREA_KM2)} circle), so the free data services can answer in time.`;
    }
    return null;
  }, [unit]);

  // Show a drawn circle's radius in the chosen unit (and follow unit switches).
  const circleKm = area?.source === "circle" ? area.circle?.radiusKm : undefined;
  useEffect(() => {
    if (circleKm != null) setRadiusText(fromKm(circleKm, unit).toFixed(2));
    setRadiusError(null);
  }, [circleKm, unit]);

  /** Make (or resize) a circle area, then look up where it is. */
  const placeCircle = useCallback((lat: number, lon: number, km: number, delayMs = 0) => {
    setMessage(null);
    setFileError(null);
    setFileNotes([]);
    const a = makeCircleArea(lat, lon, km);
    onAreaChange(a);
    setDrawMode(null);
    if (editTimer.current) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => void describe(a), delayMs);
  }, [onAreaChange, describe]);

  const applyRadius = useCallback(() => {
    if (!area?.circle) return;
    const km = toKm(Number(radiusText), unit);
    const problem = radiusProblem(km);
    setRadiusError(problem);
    if (problem || Math.abs(km - area.circle.radiusKm) < 1e-6) return;
    placeCircle(area.circle.lat, area.circle.lon, km, 600);
  }, [area?.circle, radiusText, unit, radiusProblem, placeCircle]);

  const drawLatLonCircle = useCallback(() => {
    const lat = Number(llLat.trim());
    const lon = Number(llLon.trim());
    if (!llLat.trim() || !Number.isFinite(lat) || lat < -90 || lat > 90) return setLlError("Latitude must be a number from -90 to 90.");
    if (!llLon.trim() || !Number.isFinite(lon) || lon < -180 || lon > 180) return setLlError("Longitude must be a number from -180 to 180.");
    const problem = radiusProblem(toKm(Number(llRadius.trim()), unit));
    if (!llRadius.trim() || problem) return setLlError(problem || "Enter a radius.");
    setLlError(null);
    placeCircle(lat, lon, toKm(Number(llRadius), unit));
    setToolsOpen(false); // drawn: back to just the "Create Area" button
  }, [llLat, llLon, llRadius, unit, radiusProblem, placeCircle]);

  const onShape = useCallback((ring: LonLat[], how: "rectangle" | "polygon" | "edit") => {
    setMessage(null);
    setFileError(null);
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

  // A rejected file leaves the current area alone and says why next to the button.
  const onFile = useCallback(async (file: File) => {
    setFileError(null);
    let parsed: { area: AreaSelection; notes: string[] };
    try {
      const { parseAreaFile, UnsupportedAreaFileError } = await import("@/lib/geo/parseAreaFile");
      try {
        parsed = await parseAreaFile(file);
      } catch (e) {
        setFileError(
          e instanceof UnsupportedAreaFileError
            ? `The file ${file.name} is not a supported file type.`
            : `The file ${file.name} does not have a valid area. ${e instanceof Error ? e.message : ""}`.trim()
        );
        return;
      }
    } catch {
      setFileError(`The file ${file.name} couldn't be read. Please try again.`);
      return;
    }
    const problem = validateArea(parsed.area);
    if (problem) {
      setFileError(`The file ${file.name} does not have a valid area. ${problem}`);
      return;
    }
    describeSeq.current++; // cancels a city lookup or area description still in flight
    setCityLoading(null);
    setMessage(null);
    if (area?.source === "city") onClearPlace?.(); // a clicked city's info goes with it
    setFileNotes(parsed.notes);
    onAreaChange(parsed.area);
    void describe(parsed.area);
  }, [area?.source, onAreaChange, onClearPlace, describe]);

  const clear = useCallback(() => {
    describeSeq.current++;
    setFileError(null);
    setDescribing(false);
    setCityLoading(null);
    setFileNotes([]);
    setMessage(null);
    if (area?.source === "city") onClearPlace?.(); // a clicked city's info goes with it
    onAreaChange(null);
  }, [area?.source, onAreaChange, onClearPlace]);

  // A city name on the map was clicked: fetch its boundary and fill the form.
  const onCityClick = useCallback(async (c: CityRow) => {
    const [name, lat, lon, population, countryCode] = c;
    const seq = ++describeSeq.current; // also cancels any area lookup in flight
    setMessage(null);
    setFileError(null);
    setFileNotes([]);
    setDescribing(false);
    setCityLoading(name);
    try {
      const b = await postArea<CityBoundaryResult>({ action: "cityBoundary", name, lat, lon, countryCode, population });
      if (seq !== describeSeq.current) return; // another click or option replaced this one
      const a = makeArea(b.ring, "city");
      onAreaChange({
        ...a,
        label: name,
        approximate: b.approximate || undefined,
        countryCode: b.countryCode || countryCode,
        outsideCityFraction: 0,
        cityAreaKm2: a.areaKm2,
        cityRef: `${name}|${lat}|${lon}`,
      });
      onPlaceResolved({
        city: name, country: b.country || "", countryCode: b.countryCode || countryCode,
        regionName: b.regionName, regionCode: b.regionCode,
      });
    } catch (e) {
      if (seq === describeSeq.current) {
        setMessage({ kind: "error", text: `Couldn't get the boundary of ${name}: ${e instanceof Error ? e.message : String(e)}` });
      }
    } finally {
      if (seq === describeSeq.current) setCityLoading(null);
    }
  }, [onAreaChange, onPlaceResolved]);

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

      {/* Live cursor position over the map */}
      <div className="flex items-center gap-4 px-1 text-xs text-text-secondary font-mono tabular-nums" aria-live="off">
        <span>Latitude <span ref={latOut} className="text-text-primary">—</span></span>
        <span>Longitude <span ref={lonOut} className="text-text-primary">—</span></span>
        <span className="font-sans text-[11px] opacity-70 hidden sm:inline">(cursor position)</span>
      </div>

      {/* Map (isolate keeps Leaflet's z-indexes below the app's dialogs) */}
      <div className="relative isolate h-[36rem] rounded-xl overflow-hidden border border-border bg-surface-overlay">
        <AreaMap
          area={area}
          drawMode={disabled ? null : drawMode}
          basemap={basemap}
          flyTo={flyTo}
          onShape={onShape}
          onDrawEnd={() => setDrawMode(null)}
          onCircle={(lat, lon, km) => placeCircle(lat, lon, Math.min(km, MAX_CIRCLE_RADIUS_KM))}
          onCursor={onCursor}
          cityPicking={!disabled && !drawMode}
          selectedCity={isCity ? area?.cityRef ?? null : null}
          onCityClick={(c) => void onCityClick(c)}
        />
        {cityLoading && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] px-2.5 py-1 rounded-full text-[11px] bg-surface/95 border border-border text-text-primary shadow inline-flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" /> Finding the boundary of {cityLoading}…
          </div>
        )}
        <div ref={toolsRef} className="absolute top-[10px] left-[54px] z-[1000]">
          <button onClick={() => setToolsOpen((o) => !o)} disabled={disabled}
            aria-expanded={toolsOpen} aria-haspopup="true"
            title="Draw or load the area to assess"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold shadow-md border disabled:opacity-50 disabled:cursor-not-allowed ${
              toolsOpen || drawMode ? "bg-accent-500 text-white border-accent-500" : "bg-surface-raised text-text-primary border-border hover:border-accent-500/60"
            }`}>
            <Shapes size={15} /> Create Area
            <ChevronDown size={14} className={`transition-transform ${toolsOpen ? "rotate-180" : ""}`} />
          </button>
          {toolsOpen && (
            <div role="dialog" aria-label="Create an area"
              className="mt-1.5 w-[19rem] max-w-[calc(100vw-6rem)] rounded-xl border border-border bg-surface-raised/97 backdrop-blur-xl shadow-xl p-2 space-y-1.5">
              <p className="px-1 text-[11px] text-text-secondary">Choose how to outline the area (up to {formatKm2(MAX_AREA_KM2)}):</p>
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => { setLatLonOpen(false); setToolsOpen(false); setDrawMode((m) => (m === "rectangle" ? null : "rectangle")); }} className={btn(drawMode === "rectangle")}>
                  <Square size={13} /> Rectangle
                </button>
                <button onClick={() => { setLatLonOpen(false); setToolsOpen(false); setDrawMode((m) => (m === "polygon" ? null : "polygon")); }} className={btn(drawMode === "polygon")}>
                  <Pentagon size={13} /> Polygon
                </button>
                <button onClick={() => { setLatLonOpen(false); setToolsOpen(false); setDrawMode((m) => (m === "circle" ? null : "circle")); }} className={btn(drawMode === "circle")}
                  title="Click a centre point, then drag out the radius">
                  <CircleIcon size={13} /> Circle
                </button>
                <button onClick={() => { setDrawMode(null); setLlError(null); setLatLonOpen((o) => !o); }} className={btn(latLonOpen)}
                  title="Draw a circle from a latitude, longitude and radius">
                  <Crosshair size={13} /> Lat/Lon
                </button>
                <button onClick={() => { setLatLonOpen(false); setDrawMode(null); setToolsOpen(false); setFileDialogOpen(true); }} className={`${btn(false)} col-span-2 justify-center`}
                  title="GeoJSON, KML/KMZ, a zipped Shapefile, or a GeoTIFF (its outline is used)">
                  <Upload size={13} /> Load area from file
                </button>
              </div>
              {latLonOpen && (
              <form className="rounded-lg border border-border bg-surface-overlay/40 p-2.5 space-y-2"
                        onSubmit={(e) => { e.preventDefault(); drawLatLonCircle(); }}>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label htmlFor="ll-lat" className="text-[11px] text-text-secondary">Latitude</label>
                            <input id="ll-lat" value={llLat} onChange={(e) => setLlLat(e.target.value)} inputMode="decimal" placeholder="e.g. 33.4255"
                              className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
                          </div>
                          <div>
                            <label htmlFor="ll-lon" className="text-[11px] text-text-secondary">Longitude</label>
                            <input id="ll-lon" value={llLon} onChange={(e) => setLlLon(e.target.value)} inputMode="decimal" placeholder="e.g. -111.9400"
                              className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
                          </div>
                          <div className="col-span-2">
                            <label htmlFor="ll-radius" className="text-[11px] text-text-secondary">Radius (max {formatDistance(MAX_CIRCLE_RADIUS_KM, unit)})</label>
                            <div className="mt-0.5 flex gap-1.5">
                              <input id="ll-radius" value={llRadius} onChange={(e) => setLlRadius(e.target.value)} inputMode="decimal" placeholder={unit === "mi" ? "e.g. 3" : "e.g. 5"}
                                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
                              <select aria-label="Radius unit" value={unit} onChange={(e) => setUnit(e.target.value as DistanceUnit)}
                            className="px-2 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm">
                            <option value="mi">miles</option>
                            <option value="km">km</option>
                          </select>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="submit" disabled={disabled} className={btn(false)}>
                            <CircleIcon size={13} /> Draw circle
                          </button>
                          {llError && <p className="flex items-start gap-1.5 text-xs text-danger-400"><AlertTriangle size={13} className="shrink-0 mt-0.5" />{llError}</p>}
                        </div>
                      </form>
              )}
            </div>
          )}
        </div>
        {drawMode && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] px-2.5 py-1 rounded-full text-[11px] bg-surface/95 border border-border text-text-primary shadow">
            {drawMode === "rectangle"
              ? "Click one corner, then click the opposite corner"
              : drawMode === "circle"
              ? `Click the centre, then drag outward and release (or click) to set the radius, up to ${formatDistance(MAX_CIRCLE_RADIUS_KM, unit)}`
              : "Click to add corners, double-click to finish"}
          </div>
        )}
      </div>

      {/* Below the map: a rejected file's reason, and Clear */}
      {(fileError || area) && (
        <div className="flex flex-wrap items-center gap-2">
          {fileError && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-danger-400 min-w-0">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />{fileError}
            </p>
          )}
          {area && (
            <button onClick={clear} disabled={disabled} className={`${btn(false)} ml-auto`}>
              <Trash2 size={13} /> Clear
            </button>
          )}
        </div>
      )}
      <input ref={fileRef} type="file" accept={AREA_FILE_ACCEPT} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.currentTarget.value = ""; }} />

      {/* A drawn circle's radius, editable */}
      {area?.source === "circle" && area.circle && (
        <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); applyRadius(); }}>
          <label htmlFor="circle-radius" className="text-text-secondary">Radius</label>
          <input id="circle-radius" value={radiusText} onChange={(e) => setRadiusText(e.target.value)} onBlur={applyRadius}
            inputMode="decimal" disabled={disabled}
            className="w-24 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
          <select aria-label="Radius unit" value={unit} onChange={(e) => setUnit(e.target.value as DistanceUnit)}
              className="px-2 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm">
              <option value="mi">miles</option>
              <option value="km">km</option>
            </select>
          <span className="text-text-secondary">
            centre {area.circle.lat.toFixed(4)}, {area.circle.lon.toFixed(4)} · max {formatDistance(MAX_CIRCLE_RADIUS_KM, unit)}
          </span>
          {radiusError && <p className="w-full flex items-start gap-1.5 text-danger-400"><AlertTriangle size={13} className="shrink-0 mt-0.5" />{radiusError}</p>}
        </form>
      )}

      {/* Status */}
      {!area && !message && (
        <p className="text-[11px] text-text-secondary flex items-start gap-1.5">
          <MousePointerClick size={12} className="shrink-0 mt-0.5" />
          <span>
            Click a city name on the map to use its boundary (zoom in to see smaller cities). Or press <strong className="text-text-primary">Create Area</strong>{" "}
            at the top left of the map to draw the area to assess (up to {formatKm2(MAX_AREA_KM2)}) as a rectangle, polygon or circle, enter a
            Lat/Lon and radius, or load a GeoJSON, KML/KMZ, zipped Shapefile or GeoTIFF. You can drag a drawn rectangle&apos;s or polygon&apos;s
            corners afterwards to adjust it.
          </span>
        </p>
      )}
      {area && (
        <div className="text-xs space-y-1">
          <p className="text-text-primary flex flex-wrap items-center gap-x-1.5">
            <span className="font-semibold">{formatKm2(area.areaKm2)}</span>
            {isCity && (
              <span className="text-text-secondary">
                · {area.approximate ? `approximate boundary of ${area.label} (no official boundary is mapped)` : `city boundary of ${area.label}`}
              </span>
            )}
            {area.fileName && <span className="text-text-secondary">· {area.fileName}</span>}
            {isCity ? null : describing ? (
              <span className="text-text-secondary inline-flex items-center gap-1">· <Loader2 size={11} className="animate-spin" /> finding where this is…</span>
            ) : area.label ? (
              <span className="text-text-secondary">· {area.label}</span>
            ) : null}
            {!isCity && coverPct != null && !problem && coverPct <= 100 && (
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

      {fileDialogOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
          onClick={() => setFileDialogOpen(false)} role="dialog" aria-modal="true" aria-labelledby="area-file-title"
          onKeyDown={(e) => { if (e.key === "Escape") setFileDialogOpen(false); }}>
          <div className="glass-sheet border border-border w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-3">
              <div className="p-2 rounded-lg bg-accent-500/15 text-accent-400 shrink-0"><FileUp size={18} /></div>
              <h2 id="area-file-title" className="text-base font-semibold text-text-primary flex-1 pt-1">Load an area from a file</h2>
            </div>
            <p className="text-sm text-text-secondary mb-2">The file needs an area boundary (a polygon), not just points or lines. Supported files:</p>
            <ul className="text-sm space-y-1.5 mb-3">
              {AREA_FILE_TYPES.map(([kind, note]) => (
                <li key={kind} className="leading-snug">
                  <span className="font-medium text-text-primary">{kind}</span>
                  <span className="text-text-secondary">: {note}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-text-secondary mb-5">
              If a file holds several polygons, the largest is used. The area must be between {formatKm2(MIN_AREA_KM2)} and {formatKm2(MAX_AREA_KM2)}.
            </p>
            <div className="flex items-center justify-between gap-2">
              <button onClick={() => setFileDialogOpen(false)}
                className="px-4 py-2 rounded-xl text-sm font-semibold border border-border text-text-secondary hover:text-text-primary">
                Cancel
              </button>
              <button autoFocus onClick={() => { setFileDialogOpen(false); fileRef.current?.click(); }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold btn-accent">
                <Upload size={14} /> Choose a file…
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
