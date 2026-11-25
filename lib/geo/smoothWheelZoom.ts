/**
 * Smooth, continuous mouse-wheel zoom for a Leaflet map (browser only).
 *
 * Leaflet's built-in wheel zoom waits for a burst of wheel events and then
 * animates one jump, which feels slow and visibly stepped. This replaces it:
 * every wheel event moves a target zoom, and each animation frame eases the map
 * toward it while keeping the point under the cursor fixed. Same approach as
 * the popular Leaflet.SmoothWheelZoom plugin (MIT), using Leaflet's own
 * internal move steps so only one "moveend" fires when the zoom settles.
 *
 * Needs the map to allow fractional zoom (zoomSnap 0 or small).
 */

import L from "leaflet";

type MapInternals = L.Map & {
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): L.Map;
  _move(center: L.LatLng, zoom: number): L.Map;
  _moveEnd(zoomChanged: boolean): L.Map;
};

/** About 0.8 of a zoom level per mouse-wheel notch (100 px); trackpads glide. */
const ZOOM_PER_PIXEL = 0.008;
/** Trackpad pinch arrives as tiny ctrl+wheel steps, so it gets a higher rate. */
const PINCH_ZOOM_PER_PIXEL = 0.02;
/** Cap per event, so one huge "page" scroll can't fling the map. */
const MAX_STEP = 2;

/**
 * Scroll distance in CSS pixels, up = positive. Deliberately not Leaflet's
 * getWheelDelta: on macOS that divides by 3 × devicePixelRatio (6 on Retina),
 * which is what made wheel zoom feel so slow there.
 */
function wheelPixels(e: WheelEvent): number {
  const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
  return -d;
}
/** Share of the remaining distance covered each frame (higher = snappier). */
const EASE = 0.28;

export function enableSmoothWheelZoom(map: L.Map): () => void {
  const m = map as MapInternals;
  map.scrollWheelZoom.disable();
  const container = map.getContainer();

  let zooming = false;
  let goal = 0;
  let zoom = 0;
  let mousePoint = L.point(0, 0); // cursor, in container pixels
  let mouseLatLng = L.latLng(0, 0); // the place under the cursor when it moved
  let frame = 0;

  const step = () => {
    const size = map.getSize();
    zoom += (goal - zoom) * EASE;
    const done = Math.abs(goal - zoom) < 0.002;
    if (done) zoom = goal;
    // Keep mouseLatLng under the cursor at the new zoom.
    const offset = mousePoint.subtract(size.divideBy(2));
    const center = map.unproject(map.project(mouseLatLng, zoom).subtract(offset), zoom);
    m._move(center, zoom);
    if (done) {
      zooming = false;
      frame = 0;
      m._moveEnd(true);
    } else {
      frame = requestAnimationFrame(step);
    }
  };

  const onWheel = (e: WheelEvent) => {
    const px = wheelPixels(e);
    if (!px) return;
    const delta = Math.max(-MAX_STEP, Math.min(MAX_STEP, px * (e.ctrlKey ? PINCH_ZOOM_PER_PIXEL : ZOOM_PER_PIXEL)));
    e.preventDefault();
    if (!zooming) {
      map.stop(); // cancel any pan/zoom animation in flight
      zooming = true;
      zoom = goal = map.getZoom();
      m._moveStart(true, false);
    }
    mousePoint = map.mouseEventToContainerPoint(e as unknown as MouseEvent);
    mouseLatLng = map.containerPointToLatLng(mousePoint);
    goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), goal + delta));
    if (!frame) frame = requestAnimationFrame(step);
  };

  container.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    container.removeEventListener("wheel", onWheel);
    if (frame) cancelAnimationFrame(frame);
  };
}
