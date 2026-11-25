"use client";

/**
 * The city view inside the research popup: a MapLibre map on free OpenFreeMap
 * tiles (OpenStreetMap data, no key). Larger cities get 3D buildings and a slow
 * orbit; small towns (or places with few mapped buildings) get a flat 2D map.
 * The map highlights what the current Essential is about: rivers and green
 * space for natural buffers, main roads and hospitals for infrastructure, and
 * so on. Purely decorative: it never feeds the AI.
 */

import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, LngLatBoundsLike, FilterSpecification } from "maplibre-gl";

let workerSet = false;
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const SRC = "openmaptiles";

export type MapMode = "3d" | "2d" | "none";

/** What each Essential lights up on the map. */
const GROUPS: Record<number, string[]> = {
  0: [],
  1: ["poi"],
  2: ["water"],
  3: ["poi"],
  4: ["landuse"],
  5: ["green", "water"],
  6: ["poi"],
  7: ["poi"],
  8: ["roads", "poi"],
  9: ["roads", "poi"],
  10: ["landuse"],
};
/** Point-of-interest classes (OpenMapTiles "poi" layer) per Essential. */
const POI: Record<number, string[]> = {
  1: ["town_hall"],
  3: ["bank", "town_hall"],
  6: ["town_hall", "police", "fire_station"],
  7: ["school", "college", "library", "place_of_worship", "town_hall"],
  8: ["hospital", "school", "college"],
  9: ["hospital", "police", "fire_station"],
};
const LAYER_GROUP: Record<string, string> = {
  "rv-water": "water", "rv-waterway": "water",
  "rv-green": "green", "rv-park": "green",
  "rv-roads": "roads", "rv-landuse": "landuse", "rv-poi": "poi",
};

export function ResearchMap({
  ring, center, prefer3d, essential, reduceMotion, onMode,
}: {
  /** The place's outline, [lon, lat] (open ring), when known. */
  ring?: Array<[number, number]>;
  /** Where to look: the city centre (3D orbits around it). */
  center: { lat: number; lon: number };
  prefer3d: boolean;
  essential: number;
  reduceMotion: boolean;
  onMode: (m: MapMode) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);
  const essentialRef = useRef(essential);
  essentialRef.current = essential;
  const motionRef = useRef(reduceMotion);
  motionRef.current = reduceMotion;
  const onModeRef = useRef(onMode);
  onModeRef.current = onMode;

  // Build the map once per place.
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let map: MLMap | null = null;
    (async () => {
      try {
        const mod = await import("maplibre-gl");
        const ml = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod;
        // MapLibre finds its web worker next to its own file, which bundling
        // breaks; point it at the worker file the bundler emits instead.
        if (!workerSet) {
          ml.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
          workerSet = true;
        }
        if (cancelled || !boxRef.current) return;
        const bounds = boundsOf(ring);
        const threeD = prefer3d;
        let spinning = threeD; // only the 3D view turns; a flat map stays still
        map = new ml.Map({
          container: boxRef.current,
          style: STYLE_URL,
          interactive: false,
          attributionControl: { compact: true },
          ...(threeD || !bounds
            ? { center: [center.lon, center.lat] as [number, number], zoom: threeD ? 15 : 12.5, pitch: threeD ? 58 : 0 }
            : { bounds, fitBoundsOptions: { padding: 22 } }),
        });
        mapRef.current = map;
        map.on("error", () => { /* a missing tile shouldn't break the view */ });
        map.on("load", () => {
          if (cancelled || !map) return;
          addLayers(map, ring);
          setMode(map, threeD);
          readyRef.current = true;
          highlight(map, essentialRef.current);
          onModeRef.current(threeD ? "3d" : "2d");
          if (threeD) {
            // Few mapped buildings here: a flat map reads better than a sparse 3D one.
            map.once("idle", () => {
              if (cancelled || !map) return;
              // Buildings in the loaded map data around the centre (not just what's drawn yet).
              const n = map.querySourceFeatures(SRC, { sourceLayer: "building" }).length;
              if (n < 15) {
                spinning = false;
                setMode(map, false);
                map.setBearing(0);
                if (bounds) map.fitBounds(bounds, { padding: 22, duration: 0 });
                onModeRef.current("2d");
              }
            });
          }
          // Slow orbit (3D only): a full turn every ~75 s; still when motion is reduced or the tab is hidden.
          let last = performance.now();
          const tick = (t: number) => {
            const dt = Math.min(100, t - last);
            last = t;
            if (map && spinning && !motionRef.current && !document.hidden) map.setBearing((map.getBearing() + dt * 0.0048) % 360);
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        });
      } catch {
        if (!cancelled) onModeRef.current("none"); // no WebGL, or the map library failed to load
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      readyRef.current = false;
      mapRef.current = null;
      try { map?.remove(); } catch { /* already gone */ }
    };
    // The place is fixed for a popup's life; essential/motion are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lat, center.lon, prefer3d, ring]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) highlight(map, essential);
  }, [essential]);

  // MapLibre makes its container position: relative, so size it through a wrapper.
  return (
    <div className="absolute inset-0" aria-hidden="true">
      <div ref={boxRef} className="w-full h-full" />
    </div>
  );
}

function boundsOf(ring?: Array<[number, number]>): LngLatBoundsLike | null {
  if (!ring || ring.length < 3) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [[w, s], [e, n]];
}

function setMode(map: MLMap, threeD: boolean) {
  if (map.getLayer("building-3d")) map.setLayoutProperty("building-3d", "visibility", threeD ? "visible" : "none");
  map.setPitch(threeD ? 58 : 0);
}

function addLayers(map: MLMap, ring?: Array<[number, number]>) {
  if (!map.getSource(SRC)) return;
  const before = map.getLayer("building") ? "building" : undefined;
  const hidden = { visibility: "none" as const };
  const inClass = (classes: string[]): FilterSpecification => ["match", ["get", "class"], classes, true, false];
  map.addLayer({ id: "rv-water", type: "fill", source: SRC, "source-layer": "water", layout: hidden, paint: { "fill-color": "#2f7fd8", "fill-opacity": 0.55 } }, before);
  map.addLayer({ id: "rv-waterway", type: "line", source: SRC, "source-layer": "waterway", layout: hidden,
    paint: { "line-color": "#2f7fd8", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 15, 4.5] } }, before);
  map.addLayer({ id: "rv-green", type: "fill", source: SRC, "source-layer": "landcover", filter: inClass(["wood", "grass", "wetland", "farmland"]), layout: hidden,
    paint: { "fill-color": "#1f9e6e", "fill-opacity": 0.45 } }, before);
  map.addLayer({ id: "rv-park", type: "fill", source: SRC, "source-layer": "park", layout: hidden, paint: { "fill-color": "#1f9e6e", "fill-opacity": 0.45 } }, before);
  map.addLayer({ id: "rv-landuse", type: "fill", source: SRC, "source-layer": "landuse", filter: inClass(["residential", "commercial", "industrial", "retail"]), layout: hidden,
    paint: { "fill-color": "#8b5cf6", "fill-opacity": 0.32 } }, before);
  map.addLayer({ id: "rv-roads", type: "line", source: SRC, "source-layer": "transportation", filter: inClass(["motorway", "trunk", "primary", "secondary"]), layout: hidden,
    paint: { "line-color": "#e08a1e", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 15, 5] } });
  map.addLayer({ id: "rv-poi", type: "circle", source: SRC, "source-layer": "poi", layout: hidden,
    paint: { "circle-radius": 5.5, "circle-color": "#c2410c", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 } });
  if (ring && ring.length >= 3) {
    map.addSource("rv-area", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } } });
    map.addLayer({ id: "rv-area-line", type: "line", source: "rv-area", paint: { "line-color": "#1f9e6e", "line-width": 2.5, "line-dasharray": [2, 1] } });
  }
}

function highlight(map: MLMap, essential: number) {
  const on = new Set(GROUPS[essential] ?? []);
  for (const [id, group] of Object.entries(LAYER_GROUP)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on.has(group) ? "visible" : "none");
  }
  const classes = POI[essential];
  if (classes && map.getLayer("rv-poi")) map.setFilter("rv-poi", ["match", ["get", "class"], classes, true, false]);
}
