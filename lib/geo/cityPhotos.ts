/**
 * Photos of a place and its landmarks for the research view: Wikipedia articles
 * near the city (or inside its outline) that have a freely licensed lead image
 * on Wikimedia Commons, each captioned with the article's title and short
 * description. Keyless, called from the browser (Wikipedia allows it with
 * origin=*). Decorative only: never given to the AI.
 */

import type { AreaSelection } from "./area";

export interface CityPhoto {
  /** Image URL (a Wikimedia thumbnail). */
  src: string;
  /** What it shows: the article's title. */
  title: string;
  /** The article's short description ("Public library in Calexico, California"). */
  description?: string;
  /** The image's page on Wikimedia Commons (licence and author). */
  credit: string;
  /** The Wikipedia article. */
  article: string;
}

const API = "https://en.wikipedia.org/w/api.php";
const MAX_PHOTOS = 10;
/** Lead images that are maps, logos, flags, diagrams and the like, not photos. */
const NOT_A_PHOTO = /\.(svg|pdf|gif|tiff?)$|logo|map|flag|seal|coat[_ ]of[_ ]arms|locator|location|incorporated|distrito|district|diagram|chart|icon|emblem|banner|signature|plan[_ .]/i;

interface Page {
  title: string;
  index?: number;
  description?: string;
  pageimage?: string;
  thumbnail?: { source: string; width: number; height: number };
  coordinates?: Array<{ lat: number; lon: number }>;
}

/** Ray casting: is [lon, lat] inside the ring? */
function inside(ring: Array<[number, number]>, lon: number, lat: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const kmBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180)) * 111;

function toPhoto(p: Page): CityPhoto | null {
  const t = p.thumbnail;
  if (!t || !p.pageimage || NOT_A_PHOTO.test(p.pageimage)) return null;
  if (t.width < 600 || t.width / t.height < 0.6 || t.width / t.height > 2.6) return null; // icons, slivers
  return {
    src: t.source,
    title: p.title,
    description: p.description,
    credit: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p.pageimage)}`,
    article: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
  };
}

const PLACE = /\b(city|town|village|capital|municipalit|census|county|borough|commune|metropol|settlement|suburb|neighbo|district|place)\b/i;
const QUERY = "&prop=pageimages%7Cdescription%7Ccoordinates&piprop=thumbnail%7Cname&pithumbsize=1280&pilicense=free&colimit=50";

/**
 * Up to ten photos: the place's own article first, then landmarks inside its
 * outline (or within 5 km of its centre when there is no outline), nearest first.
 */
export async function cityPhotos(
  center: { lat: number; lon: number },
  articleTitles: string[],
  area?: AreaSelection | null,
  signal?: AbortSignal
): Promise<CityPhoto[]> {
  const get = async (q: string): Promise<Page[]> => {
    const r = await fetch(`${API}?action=query&format=json&formatversion=2&origin=*${q}${QUERY}`, { signal });
    if (!r.ok) return [];
    const d = (await r.json()) as { query?: { pages?: Page[] } };
    return d.query?.pages ?? [];
  };
  const titles = [...new Set(articleTitles.filter(Boolean))].slice(0, 3);
  const [own, near] = await Promise.all([
    titles.length ? get(`&redirects=1&titles=${encodeURIComponent(titles.join("|"))}`).catch(() => []) : Promise.resolve([]),
    get(`&generator=geosearch&ggscoord=${center.lat}%7C${center.lon}&ggsradius=10000&ggslimit=50`).catch(() => []),
  ]);
  const ring = area?.ring as Array<[number, number]> | undefined;
  const within = (p: Page) => {
    const c = p.coordinates?.[0];
    if (!c) return false;
    return ring && ring.length >= 3 ? inside(ring, c.lon, c.lat) : kmBetween(center, c) <= 5;
  };
  const out: CityPhoto[] = [];
  const seen = new Set<string>();
  const add = (p: Page) => {
    const ph = toPhoto(p);
    if (!ph || seen.has(ph.src) || out.length >= MAX_PHOTOS) return;
    seen.add(ph.src);
    out.push(ph);
  };
  // The place's own article (titles tried in order), then nearby landmarks.
  // The requested titles (after redirects), only if they are about a place:
  // "Globe" alone is the sphere, not Globe, Arizona.
  own.filter((p) => PLACE.test(p.description ?? "")).slice(0, 1).forEach(add);
  near.filter(within).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).forEach(add);
  return out;
}
