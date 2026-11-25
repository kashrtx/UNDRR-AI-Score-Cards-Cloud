"use client";

/**
 * The Leaflet map behind the area picker (browser only, loaded with
 * next/dynamic + ssr:false). Draws rectangles and polygons with Leaflet-Geoman,
 * shows the current area, lets the user drag its corners to adjust it, and
 * flies to places the picker searches for. The area itself lives in the parent;
 * this component only reports shapes back and renders what it's given.
 *
 * City names: the basemaps are label-free and the map draws its own city
 * names (public/cities.json), so they can be hovered and clicked. Like any map
 * renderer, it shows only big cities when zoomed out and adds smaller ones as
 * you zoom in, skipping any name that would overlap a bigger one. Names are
 * clickable only when no drawing tool is active.
 */

import { useCallback, useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import { MAX_CIRCLE_RADIUS_KM, MIN_CIRCLE_RADIUS_KM, type AreaSelection, type LonLat } from "@/lib/geo/area";
import { enableSmoothWheelZoom } from "@/lib/geo/smoothWheelZoom";

export type Basemap = "map" | "topo" | "satellite";
export type DrawMode = "rectangle" | "polygon" | "circle" | null;

/** A labelled city: [name, lat, lon, population, countryCode, isCapital]. */
export type CityRow = [string, number, number, number, string, 0 | 1];

// Label-free tiles: the map draws its own (clickable) city names on top.
const CITY_CREDIT = 'Cities: <a href="https://www.geonames.org">GeoNames</a> (CC BY 4.0)';
const BASEMAPS: Record<Basemap, { url: string; attribution: string; maxZoom: number; maxNativeZoom?: number; subdomains?: string }> = {
  map: {
    // Esri's Light Gray Canvas base: roads and water, no place names, no key needed.
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors | " + CITY_CREDIT,
    maxZoom: 19,
    maxNativeZoom: 16,
  },
  topo: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri, USGS, NOAA | " + CITY_CREDIT,
    maxZoom: 18,
    maxNativeZoom: 13,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community | " + CITY_CREDIT,
    maxZoom: 19,
  },
};

/**
 * Tiles drawn 1px larger than their slot, so neighbours overlap slightly. At
 * in-between zoom levels (smooth wheel zoom) the browser scales each tile on
 * its own and leaves hairline gaps between them, which show up as a faint
 * white grid. The overlap hides those seams; the map imagery is unchanged.
 */
const SeamlessTileLayer = L.TileLayer.extend({
  _initTile(this: L.TileLayer, tile: HTMLElement) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (L.TileLayer.prototype as any)._initTile.call(this, tile);
    const size = this.getTileSize();
    tile.style.width = `${size.x + 1}px`;
    tile.style.height = `${size.y + 1}px`;
  },
}) as unknown as new (url: string, options?: L.TileLayerOptions) => L.TileLayer;

// Loaded once, the first time any map opens (≈450 KB over the network).
let citiesPromise: Promise<CityRow[]> | null = null;
function loadCities(): Promise<CityRow[]> {
  if (!citiesPromise) {
    citiesPromise = fetch("/cities.json")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => {
        citiesPromise = null; // let a later map try again
        return [];
      });
  }
  return citiesPromise;
}

// Smaller places (1,000-14,999 people) come in 5° tiles, fetched only for the
// area in view once you zoom in close. Shared across maps for the session.
const DETAIL_ZOOM = 10;
let detailIndex: Promise<{ tileDeg: number; tiles: Set<string> } | null> | null = null;
const detailTiles = new Map<string, Promise<CityRow[]>>();
function loadDetailIndex() {
  if (!detailIndex) {
    detailIndex = fetch("/cities/detail/index.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { tileDeg: number; tiles: string[] } | null) => (j ? { tileDeg: j.tileDeg, tiles: new Set(j.tiles) } : null))
      .catch(() => {
        detailIndex = null;
        return null;
      });
  }
  return detailIndex;
}
function loadDetailTile(key: string): Promise<CityRow[]> {
  let p = detailTiles.get(key);
  if (!p) {
    p = fetch(`/cities/detail/${key}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => {
        detailTiles.delete(key); // retry next time
        return [];
      });
    detailTiles.set(key, p);
  }
  return p;
}

/** Smallest population labelled at each zoom; overlaps thin it out further. */
function minPopulation(zoom: number): number {
  if (zoom <= 2) return 5_000_000;
  if (zoom <= 3) return 2_000_000;
  if (zoom <= 4) return 800_000;
  if (zoom <= 5) return 400_000;
  if (zoom <= 6) return 200_000;
  if (zoom <= 7) return 100_000;
  if (zoom <= 8) return 50_000;
  if (zoom <= 9) return 30_000;
  if (zoom <= 10) return 15_000;
  if (zoom <= 11) return 7_000;
  if (zoom <= 12) return 3_000;
  return 1_000;
}
/** The zoom level at which a city first gets a label (its "rank"). */
function appearZoom(pop: number): number {
  for (let z = 2; z < 13; z++) if (pop >= minPopulation(z)) return z;
  return 13;
}
// Text size by that rank: cities that appear further out read clearly bigger,
// e.g. Chicago (zoom 3) > Fort Wayne (zoom 6), Los Angeles (3) > San Diego (4).
const LABEL_STYLE: Record<number, { px: number; weight: number; dot: number }> = {
  2: { px: 21, weight: 700, dot: 9 },
  3: { px: 18, weight: 700, dot: 8 },
  4: { px: 16, weight: 600, dot: 7 },
  5: { px: 14.5, weight: 600, dot: 7 },
  6: { px: 13, weight: 600, dot: 6 },
  7: { px: 12, weight: 500, dot: 6 },
  8: { px: 11, weight: 500, dot: 5 },
  9: { px: 10.5, weight: 500, dot: 5 },
  10: { px: 10, weight: 500, dot: 5 },
  11: { px: 9.5, weight: 500, dot: 4 },
  12: { px: 9.5, weight: 400, dot: 4 },
  13: { px: 9.5, weight: 400, dot: 4 },
};
const MAX_LABELS = 220;

// Real rendered text widths (cached), so labels pack as tightly as they fit.
let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
function textWidth(text: string, px: number, weight: number, family: string): number {
  const key = `${weight}|${px}|${text}`;
  const hit = widthCache.get(key);
  if (hit != null) return hit;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * px * 0.58; // no canvas: rough estimate
  measureCtx.font = `${weight} ${px}px ${family}`;
  const w = measureCtx.measureText(text).width;
  widthCache.set(key, w);
  return w;
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const cityKey = (c: CityRow) => `${c[0]}|${c[1]}|${c[2]}`;

const DRAW_COLOR = "#10b981";

function toRing(layer: L.Layer): LonLat[] {
  const ll = (layer as L.Polygon).getLatLngs();
  const outer = (Array.isArray(ll[0]) ? ll[0] : ll) as L.LatLng[];
  return outer.map((p) => [p.lng, p.lat] as LonLat);
}

export default function AreaMap({
  area,
  drawMode,
  basemap,
  flyTo,
  onShape,
  onDrawEnd,
  onCircle,
  onCursor,
  cityPicking = false,
  selectedCity = null,
  onCityClick,
}: {
  area: AreaSelection | null;
  drawMode: DrawMode;
  basemap: Basemap;
  /** [south, north, west, east]; changes identity to trigger a fly. */
  flyTo: [number, number, number, number] | null;
  onShape: (ring: LonLat[], how: "rectangle" | "polygon" | "edit") => void;
  onDrawEnd: () => void;
  /** A circle was drawn with the Circle tool. */
  onCircle?: (lat: number, lon: number, radiusKm: number) => void;
  /** The cursor moved over the map (null when it leaves). */
  onCursor?: (pos: { lat: number; lon: number } | null) => void;
  /** City names can be hovered and clicked (no drawing tool active). */
  cityPicking?: boolean;
  /** cityKey() of the selected city, shown highlighted. */
  selectedCity?: string | null;
  onCityClick?: (city: CityRow) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tilesRef = useRef<L.TileLayer | null>(null);
  const shapeRef = useRef<L.Polygon | null>(null);
  // While a new shape is being drawn, the current area's outline is taken off
  // the map from the first press on the map, and put back if the drawing is
  // cancelled instead of finished.
  const drawModeRef = useRef<DrawMode>(drawMode);
  drawModeRef.current = drawMode;
  const prevHiddenRef = useRef(false);
  const createdRef = useRef(false);
  const labelsRef = useRef<L.LayerGroup | null>(null);
  const citiesRef = useRef<CityRow[]>([]);
  /** Smaller places from the detail tiles loaded so far, biggest first. */
  const detailRef = useRef<CityRow[]>([]);
  const loadedTilesRef = useRef<Set<string>>(new Set());
  // Keep the latest callbacks without re-binding map events.
  const onShapeRef = useRef(onShape);
  onShapeRef.current = onShape;
  const onCircleRef = useRef(onCircle);
  onCircleRef.current = onCircle;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onDrawEndRef = useRef(onDrawEnd);
  onDrawEndRef.current = onDrawEnd;
  const onCityClickRef = useRef(onCityClick);
  onCityClickRef.current = onCityClick;
  const pickingRef = useRef(cityPicking);
  pickingRef.current = cityPicking;
  const selectedRef = useRef(selectedCity);
  selectedRef.current = selectedCity;

  /** Lay out the city names for the current view: biggest first, no overlaps. */
  const renderLabels = useCallback(() => {
    const map = mapRef.current;
    const layer = labelsRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const zoom = map.getZoom();
    const minPop = minPopulation(zoom);
    const view = map.getBounds().pad(0.05);
    const size = map.getSize();
    const placed: Array<[number, number, number, number]> = [];
    const picking = pickingRef.current;
    const family = getComputedStyle(map.getContainer()).fontFamily || "sans-serif";
    let count = 0;
    // Base cities are all bigger than detail places, so this is biggest-first overall.
    const lists = zoom >= DETAIL_ZOOM ? [citiesRef.current, detailRef.current] : [citiesRef.current];
    outer: for (const list of lists) for (const c of list) {
      const [name, lat, lon, pop, , capital] = c;
      if (pop < minPop && !(capital && zoom >= 4)) continue;
      if (!view.contains([lat, lon])) continue;
      const pt = map.latLngToContainerPoint([lat, lon]);
      if (pt.x < -50 || pt.y < -20 || pt.x > size.x + 50 || pt.y > size.y + 20) continue;
      const style = LABEL_STYLE[appearZoom(pop)];
      const fs = style.px;
      // Label box: a dot on the city, the name to its right, plus a small gap.
      const w = textWidth(name, fs, style.weight, family);
      const box: [number, number, number, number] = [
        pt.x - style.dot / 2 - 3, pt.y - fs / 2 - 2, pt.x + style.dot / 2 + 4 + w + 3, pt.y + fs / 2 + 2,
      ];
      if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push(box);
      const key = cityKey(c);
      const selected = key === selectedRef.current;
      const marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: "city-label-icon",
          html: `<div class="city-label${selected ? " selected" : ""}" style="transform:translate(-${style.dot / 2}px,-50%)" title="${picking ? `Select ${escapeHtml(name)}` : ""}"><span class="city-dot" style="width:${style.dot}px;height:${style.dot}px"></span><span class="city-name" style="font-size:${fs}px;font-weight:${style.weight}">${escapeHtml(name)}</span></div>`,
          iconSize: [0, 0],
        }),
        interactive: picking,
        keyboard: false,
        riseOnHover: true,
      });
      if (picking) marker.on("click", () => onCityClickRef.current?.(c));
      marker.addTo(layer);
      if (++count >= MAX_LABELS) break outer;
    }
  }, []);

  /** Zoomed in close: fetch the detail tiles covering the view, then re-label. */
  const loadDetailForView = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < DETAIL_ZOOM) return;
    const index = await loadDetailIndex();
    if (!index || mapRef.current !== map) return; // the map was rebuilt or removed meanwhile
    const b = map.getBounds();
    const d = index.tileDeg;
    const keys: string[] = [];
    for (let la = Math.floor(b.getSouth() / d); la <= Math.floor(b.getNorth() / d); la++) {
      for (let lo = Math.floor(b.getWest() / d); lo <= Math.floor(b.getEast() / d); lo++) {
        const key = `${la}_${lo}`;
        if (index.tiles.has(key) && !loadedTilesRef.current.has(key)) keys.push(key);
      }
    }
    if (!keys.length || keys.length > 12) return; // nothing new, or far too wide a view
    const lists = await Promise.all(keys.map(loadDetailTile));
    if (mapRef.current !== map) return;
    keys.forEach((k) => loadedTilesRef.current.add(k));
    detailRef.current = detailRef.current.concat(...lists).sort((a, b) => b[3] - a[3]);
    renderLabels();
  }, [renderLabels]);

  // Create the map once.
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    // Continuous zoom: smooth wheel zooming, and a clicked city's boundary can
    // fill the view exactly. The +/- buttons still move one whole level.
    const map = L.map(boxRef.current, { worldCopyJump: true, zoomControl: true, zoomSnap: 0, zoomDelta: 1 }).setView([20, 0], 2);
    const disableSmoothWheel = enableSmoothWheelZoom(map);
    mapRef.current = map;
    map.pm.setGlobalOptions({
      pathOptions: { color: DRAW_COLOR, weight: 2, fillOpacity: 0.12 },
      templineStyle: { color: DRAW_COLOR },
      hintlineStyle: { color: DRAW_COLOR, dashArray: "5,5" },
      snappable: false,
    } as L.PM.GlobalOptions);
    // First press with a drawing tool: the previous outline disappears.
    map.on("mousedown", () => {
      const prev = shapeRef.current;
      if (!drawModeRef.current || prevHiddenRef.current || !prev) return;
      prevHiddenRef.current = true;
      prev.pm?.disable();
      map.removeLayer(prev);
    });
    map.on("pm:create", (e: { layer: L.Layer; shape: string }) => {
      createdRef.current = true;
      map.removeLayer(e.layer); // the parent's area is the one source of truth
      if (e.shape === "Circle") {
        const c = e.layer as L.Circle;
        const { lat, lng } = c.getLatLng();
        onCircleRef.current?.(lat, lng, c.getRadius() / 1000);
        return;
      }
      onShapeRef.current(toRing(e.layer), e.shape === "Rectangle" ? "rectangle" : "polygon");
    });
    map.on("pm:drawend", () => {
      // Cancelled (no shape made): bring the previous outline back.
      const prev = shapeRef.current;
      if (prevHiddenRef.current && !createdRef.current && prev && !map.hasLayer(prev)) {
        prev.addTo(map);
        const a = areaRef.current;
        if (a && a.source !== "city" && a.source !== "circle") {
          prev.pm.enable({ allowSelfIntersection: false, snappable: false } as L.PM.EditModeOptions);
        }
      }
      prevHiddenRef.current = false;
      createdRef.current = false;
      onDrawEndRef.current();
    });
    // Live cursor position (wrapped to -180..180 when the world repeats).
    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      const p = e.latlng.wrap();
      onCursorRef.current?.({ lat: p.lat, lon: p.lng });
    });
    map.on("mouseout", () => onCursorRef.current?.(null));

    // City names sit above the area outline, re-laid out after every pan/zoom.
    labelsRef.current = L.layerGroup().addTo(map);
    map.on("moveend", renderLabels);
    map.on("moveend", () => void loadDetailForView());
    void loadCities().then((rows) => {
      citiesRef.current = rows;
      renderLabels();
    });

    // The picker lives in a collapsible panel: re-measure whenever it resizes,
    // and finish a fit that had to wait for the map to have a size.
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      fitToAreaRef.current();
    });
    ro.observe(boxRef.current);
    return () => {
      ro.disconnect();
      disableSmoothWheel();
      map.remove();
      mapRef.current = null;
      labelsRef.current = null;
      fittedRef.current = ""; // a re-created map (e.g. React Strict Mode) must fit again
    };
  }, [renderLabels, loadDetailForView]);

  // Re-draw names when they become (non-)clickable or the selection changes.
  useEffect(() => { renderLabels(); }, [cityPicking, selectedCity, renderLabels]);

  // Basemap
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tilesRef.current?.remove();
    const b = BASEMAPS[basemap];
    tilesRef.current = new SeamlessTileLayer(b.url, {
      attribution: b.attribution,
      maxZoom: b.maxZoom,
      ...(b.maxNativeZoom ? { maxNativeZoom: b.maxNativeZoom } : {}),
      ...(b.subdomains ? { subdomains: b.subdomains } : {}),
    }).addTo(map);
    boxRef.current?.classList.toggle("basemap-satellite", basemap === "satellite");
  }, [basemap]);

  // Draw mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (drawMode === "rectangle") map.pm.enableDraw("Rectangle");
    else if (drawMode === "polygon") map.pm.enableDraw("Polygon", { finishOn: "dblclick" } as L.PM.DrawModeOptions);
    else if (drawMode === "circle") {
      map.pm.enableDraw("Circle", {
        minRadiusCircle: MIN_CIRCLE_RADIUS_KM * 1000,
        maxRadiusCircle: MAX_CIRCLE_RADIUS_KM * 1000,
      } as L.PM.DrawModeOptions);
    } else map.pm.disableDraw();
    // While drawing a circle, a press-and-drag sizes it instead of panning the map.
    if (drawMode === "circle") map.dragging.disable();
    else map.dragging.enable();
    // While drawing, the current outline lets clicks through to the map (so the
    // first press inside it starts the new shape) and its corners can't be dragged.
    const prev = shapeRef.current;
    if (prev) {
      const el = prev.getElement() as HTMLElement | undefined;
      if (el) el.style.pointerEvents = drawMode ? "none" : "";
      const a = areaRef.current;
      if (drawMode) prev.pm?.disable();
      else if (map.hasLayer(prev) && a && a.source !== "city" && a.source !== "circle") {
        prev.pm.enable({ allowSelfIntersection: false, snappable: false } as L.PM.EditModeOptions);
      }
    }
  }, [drawMode]);

  // Render the current area (editable by dragging its corners; a clicked
  // city's official boundary is shown as-is).
  const ringKey = area ? JSON.stringify(area.ring) : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    shapeRef.current?.remove();
    shapeRef.current = null;
    prevHiddenRef.current = false;
    if (!area || area.ring.length < 3) return;
    const poly = L.polygon(area.ring.map(([lon, lat]) => [lat, lon] as [number, number]), {
      color: DRAW_COLOR,
      weight: 2,
      fillOpacity: 0.15,
    }).addTo(map);
    shapeRef.current = poly;
    if (area.source !== "city" && area.source !== "circle") { // circles resize via their radius box
      poly.pm.enable({ allowSelfIntersection: false, snappable: false } as L.PM.EditModeOptions);
      poly.on("pm:edit", () => onShapeRef.current(toRing(poly), "edit"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringKey]);

  // Fit to a new area the first time it appears (e.g. loaded from a file or
  // restored). Waits until the map has a size: fitting a 0×0 map does nothing.
  const fittedRef = useRef("");
  const areaRef = useRef(area);
  areaRef.current = area;
  const fitToArea = useCallback(() => {
    const map = mapRef.current;
    const area = areaRef.current;
    const ringKey = area ? JSON.stringify(area.ring) : "";
    if (!map || !area || !ringKey || fittedRef.current === ringKey) return;
    const sz = map.getSize();
    if (sz.x < 50 || sz.y < 50) return;
    const [s, n, w, e] = area.bbox;
    const shown = map.getBounds();
    const viewSpan = (shown.getNorth() - shown.getSouth()) * (shown.getEast() - shown.getWest());
    const tiny = (n - s) * (e - w) < viewSpan * 0.02; // e.g. a small file area on a wide view
    if (area.source === "city") {
      // Zoom in as far as possible while keeping the whole boundary in view.
      map.fitBounds([[s, w], [n, e]], { padding: [8, 8] });
    } else if (tiny || !shown.contains(L.latLngBounds([s, w], [n, e]))) {
      map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
    }
    fittedRef.current = ringKey;
  }, []);
  const fitToAreaRef = useRef(fitToArea);
  fitToAreaRef.current = fitToArea;
  useEffect(() => { fitToArea(); }, [ringKey, fitToArea]);

  // Fly to a searched place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    const [s, n, w, e] = flyTo;
    map.fitBounds([[s, w], [n, e]], { padding: [10, 10], maxZoom: 14 });
  }, [flyTo]);

  return <div ref={boxRef} className="h-full w-full" />;
}
