"use client";

/**
 * The Leaflet map behind the area picker (browser only, loaded with
 * next/dynamic + ssr:false). Draws rectangles and polygons with Leaflet-Geoman,
 * shows the current area, lets the user drag its corners to adjust it, and
 * flies to places the picker searches for. The area itself lives in the parent;
 * this component only reports shapes back and renders what it's given.
 */

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import type { AreaSelection, LonLat } from "@/lib/geo/area";

export type Basemap = "map" | "topo" | "satellite";
export type DrawMode = "rectangle" | "polygon" | null;

const BASEMAPS: Record<Basemap, { url: string; attribution: string; maxZoom: number }> = {
  map: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxZoom: 17,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxZoom: 19,
  },
};

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
}: {
  area: AreaSelection | null;
  drawMode: DrawMode;
  basemap: Basemap;
  /** [south, north, west, east]; changes identity to trigger a fly. */
  flyTo: [number, number, number, number] | null;
  onShape: (ring: LonLat[], how: "rectangle" | "polygon" | "edit") => void;
  onDrawEnd: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tilesRef = useRef<L.TileLayer | null>(null);
  const shapeRef = useRef<L.Polygon | null>(null);
  // Keep the latest callbacks without re-binding map events.
  const onShapeRef = useRef(onShape);
  onShapeRef.current = onShape;
  const onDrawEndRef = useRef(onDrawEnd);
  onDrawEndRef.current = onDrawEnd;

  // Create the map once.
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, { worldCopyJump: true, zoomControl: true }).setView([20, 0], 2);
    mapRef.current = map;
    map.pm.setGlobalOptions({
      pathOptions: { color: DRAW_COLOR, weight: 2, fillOpacity: 0.12 },
      templineStyle: { color: DRAW_COLOR },
      hintlineStyle: { color: DRAW_COLOR, dashArray: "5,5" },
      snappable: false,
    } as L.PM.GlobalOptions);
    map.on("pm:create", (e: { layer: L.Layer; shape: string }) => {
      const ring = toRing(e.layer);
      map.removeLayer(e.layer); // the parent's area is the one source of truth
      onShapeRef.current(ring, e.shape === "Rectangle" ? "rectangle" : "polygon");
    });
    map.on("pm:drawend", () => onDrawEndRef.current());

    // The picker lives in a collapsible panel: re-measure whenever it resizes.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(boxRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Basemap
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tilesRef.current?.remove();
    const b = BASEMAPS[basemap];
    tilesRef.current = L.tileLayer(b.url, { attribution: b.attribution, maxZoom: b.maxZoom }).addTo(map);
  }, [basemap]);

  // Draw mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (drawMode === "rectangle") map.pm.enableDraw("Rectangle");
    else if (drawMode === "polygon") map.pm.enableDraw("Polygon", { finishOn: "dblclick" } as L.PM.DrawModeOptions);
    else map.pm.disableDraw();
  }, [drawMode]);

  // Render the current area (editable by dragging its corners).
  const ringKey = area ? JSON.stringify(area.ring) : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    shapeRef.current?.remove();
    shapeRef.current = null;
    if (!area || area.ring.length < 3) return;
    const poly = L.polygon(area.ring.map(([lon, lat]) => [lat, lon] as [number, number]), {
      color: DRAW_COLOR,
      weight: 2,
      fillOpacity: 0.15,
    }).addTo(map);
    shapeRef.current = poly;
    poly.pm.enable({ allowSelfIntersection: false, snappable: false } as L.PM.EditModeOptions);
    poly.on("pm:edit", () => onShapeRef.current(toRing(poly), "edit"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringKey]);

  // Fit to a new area the first time it appears (e.g. loaded from a file or restored).
  const fittedRef = useRef("");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !area || !ringKey || fittedRef.current === ringKey) return;
    const [s, n, w, e] = area.bbox;
    const shown = map.getBounds();
    const viewSpan = (shown.getNorth() - shown.getSouth()) * (shown.getEast() - shown.getWest());
    const tiny = (n - s) * (e - w) < viewSpan * 0.02; // e.g. a small file area on a wide view
    if (tiny || !shown.contains(L.latLngBounds([s, w], [n, e]))) {
      map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
    }
    fittedRef.current = ringKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringKey]);

  // Fly to a searched place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    const [s, n, w, e] = flyTo;
    map.fitBounds([[s, w], [n, e]], { padding: [10, 10], maxZoom: 14 });
  }, [flyTo]);

  return <div ref={boxRef} className="h-full w-full" />;
}
