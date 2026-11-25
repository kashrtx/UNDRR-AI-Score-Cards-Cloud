"use client";

/**
 * The research view shown while "Fill it out for me" runs: the city (3D for
 * larger cities, 2D otherwise) with the Essential being worked on above it and
 * the facts the AI actually found for that Essential rotating below, each with
 * its source tag. Only retrieved facts or live status lines ("Searching for…",
 * "Thinking…") are shown; nothing here is made up.
 *
 * Clicking outside (or Escape, or the minimise button) shrinks it to a small
 * window at the bottom right; its X closes the view for the rest of the run.
 * It closes on its own when the fill finishes, pauses or fails.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, X, Map as MapIcon, Box, Image as ImageIcon } from "lucide-react";
import type { ResearchFact } from "@/lib/agent/agent";
import type { AreaSelection } from "@/lib/geo/area";
import { ESSENTIAL_NAMES } from "@/lib/scorecard/preliminaryTemplate";
import { ResearchMap, type MapMode } from "./ResearchMap";
import { cityPhotos, type CityPhoto } from "@/lib/geo/cityPhotos";

/** Photos of the place and its landmarks (Wikipedia / Wikimedia Commons), preloaded. */
function useCityPhotos(center: { lat: number; lon: number } | null, place: string, area: AreaSelection | null) {
  const [photos, setPhotos] = useState<CityPhoto[]>([]);
  const lat = center?.lat, lon = center?.lon;
  useEffect(() => {
    if (lat == null || lon == null) return;
    const ac = new AbortController();
    const parts = place.split(",").map((x) => x.trim()).filter(Boolean);
    const titles = [parts.slice(0, 2).join(", "), parts[0]];
    cityPhotos({ lat, lon }, titles, area, ac.signal)
      .then((list) => Promise.all(list.map((p) => new Promise<CityPhoto | null>((res) => {
        const img = new Image();
        img.onload = () => res(p);
        img.onerror = () => res(null);
        img.src = p.src;
      }))))
      .then((ok) => { if (!ac.signal.aborted) setPhotos(ok.filter((p): p is CityPhoto => !!p)); })
      .catch(() => { /* no photos: the map alone */ });
    return () => ac.abort();
  }, [lat, lon, place, area]);
  return photos;
}

/** How long each slide (the map, or a photo) stays. */
const SLIDE_MS = 10000;

/** Cities at or above this population get the 3D view (if enough buildings are mapped). */
const POP_3D = 100_000;

type CityRow = [name: string, lat: number, lon: number, pop: number, cc: string, capital: number];
let citiesPromise: Promise<CityRow[]> | null = null;
function loadCities(): Promise<CityRow[]> {
  citiesPromise ??= fetch("/cities.json").then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return citiesPromise;
}

/** The city's map point and population from the bundled city list (GeoNames). */
function useCityPoint(name: string, area: AreaSelection | null) {
  const [hit, setHit] = useState<{ lat: number; lon: number; pop: number } | null>(null);
  useEffect(() => {
    let live = true;
    const want = name.split(",")[0].trim().toLowerCase();
    loadCities().then((rows) => {
      if (!live || !rows.length) return;
      const near = (r: CityRow) => area ? Math.hypot(r[1] - area.centroid.lat, (r[2] - area.centroid.lon) * Math.cos((r[1] * Math.PI) / 180)) : 0;
      const named = want ? rows.filter((r) => r[0].toLowerCase() === want) : [];
      let best: CityRow | undefined = named.sort((a, b) => near(a) - near(b))[0];
      if (best && area && near(best) > 0.3) best = undefined; // same name, different place
      if (!best && area) best = rows.filter((r) => near(r) < 0.05).sort((a, b) => b[3] - a[3])[0];
      setHit(best ? { lat: best[1], lon: best[2], pop: best[3] } : null);
    });
    return () => { live = false; };
  }, [name, area]);
  return hit;
}

export function ResearchVisual({
  state, place, cityName, helper, area, focus, facts, status, essentialDone, reduceMotion,
  onMinimize, onRestore, onClose,
}: {
  state: "open" | "min";
  place: string;
  cityName: string;
  helper: string;
  area: AreaSelection | null;
  focus: number;
  facts: ResearchFact[];
  status: string;
  /** Index 1–10: every indicator of that Essential is answered (or left blank with a reason). */
  essentialDone: boolean[];
  reduceMotion: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const point = useCityPoint(cityName, area);
  const [mode, setMode] = useState<MapMode | null>(null);

  // Facts for the Essential in focus (newest first), rotating every few seconds;
  // during the city overview, everything found so far.
  const shown = useMemo(() => (focus ? facts.filter((f) => f.essential === focus) : [...facts]).reverse().slice(0, 12), [facts, focus]);
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [focus]);
  useEffect(() => {
    if (shown.length < 2) return;
    const t = setInterval(() => setIdx((i) => i + 1), reduceMotion ? 6500 : 4500);
    return () => clearInterval(t);
  }, [shown.length, reduceMotion]);
  const fact = shown.length ? shown[idx % shown.length] : null;

  useEffect(() => {
    if (state !== "open") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onMinimize(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onMinimize]);

  const ring = area?.ring as Array<[number, number]> | undefined;
  const center = point ?? (area ? area.centroid : null);
  // The visual cycles: the map, then each photo, then back to the map.
  const photos = useCityPhotos(center, place, area);
  const [slide, setSlide] = useState(0); // 0 = the map, n = photos[n - 1]
  useEffect(() => {
    if (state !== "open" || !photos.length) return;
    const t = setTimeout(() => setSlide((n) => (n + 1) % (photos.length + 1)), SLIDE_MS);
    return () => clearTimeout(t);
  }, [slide, photos.length, state]);
  const prefer3d = !!point && point.pop >= POP_3D || (!point && !!area && area.areaKm2 >= 150);
  const heading = focus ? ESSENTIAL_NAMES[focus] : `Getting to know ${place}`;
  const sub = focus ? `Essential ${focus} of 10` : "City overview";
  const anim = reduceMotion ? "" : "rv-in";

  if (typeof document === "undefined") return null;

  if (state === "min") {
    return createPortal(
      <div className="fixed right-4 bottom-20 z-[80] w-60" role="region" aria-label="Research progress">
        <div className="flex justify-end mb-1">
          <button
            onClick={onClose}
            aria-label="Close the research view"
            title="Close the research view"
            className="w-6 h-6 rounded-full bg-surface-raised border border-border shadow text-text-secondary hover:text-text-primary flex items-center justify-center"
          >
            <X size={13} />
          </button>
        </div>
        <button
          onClick={onRestore}
          className="w-full text-left rounded-2xl bg-surface-raised border border-border shadow-lg p-3 hover:border-accent-500/50 transition-colors"
          title="Open the research view"
        >
          <div className="text-[11px] text-text-secondary truncate">{helper} · {place}</div>
          <div className="text-sm font-semibold text-text-primary truncate">{focus ? `Essential ${focus} of 10` : "City overview"}</div>
          <div className={`text-xs text-text-secondary truncate ${reduceMotion ? "" : "animate-pulse"}`}>{status || "Working…"}</div>
          <Segments done={essentialDone} focus={focus} />
        </button>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-black/35 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onMinimize(); }}
    >
      <div
        role="dialog"
        aria-label={`Researching ${place}`}
        className="w-full max-w-[920px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-surface-raised border border-border shadow-2xl"
      >
        <div className="px-6 pt-5 pb-2 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-secondary">{place} · {helper} · {sub}</div>
            <div key={focus} className={`text-2xl font-semibold text-text-primary leading-tight mt-0.5 ${anim}`}>{heading}</div>
          </div>
          {slide > 0 && photos[slide - 1] ? (
            <span className="shrink-0 mt-1 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-primary-500/10 text-primary-300">
              <ImageIcon size={12} /> Photo {slide} of {photos.length}
            </span>
          ) : mode && mode !== "none" && (
            <span className="shrink-0 mt-1 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-primary-500/10 text-primary-300">
              {mode === "3d" ? <Box size={11} /> : <MapIcon size={11} />} {mode === "3d" ? "3D city" : "2D map"}
            </span>
          )}
          <button
            onClick={onMinimize}
            aria-label="Minimise the research view"
            title="Minimise"
            className="shrink-0 w-8 h-8 rounded-lg border border-border text-text-secondary hover:text-text-primary flex items-center justify-center"
          >
            <Minus size={16} />
          </button>
        </div>
        <div className="px-6 pb-4"><Segments done={essentialDone} focus={focus} /></div>

        <div className="relative h-[min(440px,46vh)] bg-surface-overlay overflow-hidden">
          {center && mode !== "none" ? (
            <ResearchMap
              ring={ring}
              center={center}
              prefer3d={prefer3d}
              essential={focus}
              reduceMotion={reduceMotion}
              onMode={setMode}
            />
          ) : (
            <OutlineFallback ring={ring} />
          )}
          {photos.map((p, i) => (
            <figure
              key={p.src}
              aria-hidden={slide !== i + 1}
              className={`absolute inset-0 z-10 m-0 transition-opacity ${reduceMotion ? "duration-0" : "duration-700"} ${slide === i + 1 ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.src} alt={p.title} className="w-full h-full object-cover" />
              <figcaption className="absolute inset-x-0 bottom-0 px-5 pt-10 pb-3 bg-gradient-to-t from-black/80 via-black/45 to-transparent text-white">
                <div className="text-base font-semibold leading-snug">{p.title}</div>
                {p.description && <div className="text-sm text-white/90">{p.description}</div>}
                <div className="text-[11px] text-white/75 mt-1">
                  Photo: <a href={p.credit} target="_blank" rel="noreferrer" className="underline hover:text-white">Wikimedia Commons</a>
                  {" · "}<a href={p.article} target="_blank" rel="noreferrer" className="underline hover:text-white">Wikipedia</a>
                </div>
              </figcaption>
            </figure>
          ))}
          {photos.length > 0 && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/35">
              {[0, ...photos.map((_, i) => i + 1)].map((n) => (
                <button
                  key={n}
                  onClick={() => setSlide(n)}
                  aria-label={n === 0 ? "Show the map" : `Show photo ${n}: ${photos[n - 1].title}`}
                  className={`rounded-full transition-all ${slide === n ? "w-4 h-2 bg-white" : "w-2 h-2 bg-white/55 hover:bg-white/80"}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="px-6 pt-4 min-h-[84px]">
          {fact ? (
            <div key={`${focus}-${idx % Math.max(1, shown.length)}`} className={`rounded-xl border border-border px-4 py-3 text-base text-text-primary leading-snug ${anim}`}>
              {fact.text}{" "}
              {(fact.tag || fact.site) && (
                <span className="text-sm text-primary-300 whitespace-nowrap">[{[fact.tag, fact.site].filter(Boolean).join(" · ")}]</span>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border px-4 py-3 text-base text-text-secondary">
              {status || "Getting started…"}
            </div>
          )}
          {shown.length > 1 && (
            <div className="text-xs text-text-secondary mt-1 text-right">{(idx % shown.length) + 1} of {shown.length} found</div>
          )}
        </div>
        <div className="px-6 pt-1 pb-4 flex items-center gap-2 text-sm text-text-secondary">
          <span className={`w-2 h-2 rounded-full bg-primary-400 shrink-0 ${reduceMotion ? "" : "animate-pulse"}`} />
          <span className="truncate">{status || "Working…"}</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Segments({ done, focus }: { done: boolean[]; focus: number }) {
  return (
    <div className="flex gap-[3px] mt-1.5" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((e) => (
        <span
          key={e}
          title={`Essential ${e}`}
          className={`flex-1 h-1 rounded-full ${done[e] ? "bg-accent-500" : e === focus ? "bg-primary-400" : "bg-border"}`}
        />
      ))}
    </div>
  );
}

/** No map available (no WebGL, or no location yet): the outline alone, or a quiet placeholder. */
function OutlineFallback({ ring }: { ring?: Array<[number, number]> }) {
  if (!ring || ring.length < 3) {
    return <div className="absolute inset-0 flex items-center justify-center text-text-secondary"><MapIcon size={28} /></div>;
  }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const W = (e - w) * k || 1, H = n - s || 1;
  const d = ring.map(([x, y], i) => `${i ? "L" : "M"}${(((x - w) * k) / W) * 100},${((n - y) / H) * 100}`).join(" ") + "Z";
  return (
    <svg viewBox="-6 -6 112 112" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 w-full h-full">
      <path d={d} fill="rgba(31,158,110,0.12)" stroke="#1f9e6e" strokeWidth="1" strokeDasharray="3 1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
