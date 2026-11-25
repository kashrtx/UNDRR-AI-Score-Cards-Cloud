/**
 * Distance units for circle radii: miles or kilometres. The default follows
 * where the user is (miles where road distances are in miles: the US, UK,
 * Liberia and Myanmar), and a choice the user makes is remembered.
 */

export type DistanceUnit = "mi" | "km";

const KEY = "undrr.radiusUnit";
const KM_PER_MILE = 1.609344;
const MILE_COUNTRIES = new Set(["US", "GB", "LR", "MM"]);

/** The user's country from their browser language (e.g. "en-US" → "US"), if any. */
function userRegion(): string | null {
  try {
    const tags = [...(navigator.languages || []), navigator.language, Intl.DateTimeFormat().resolvedOptions().locale];
    for (const t of tags) {
      const region = t && new Intl.Locale(t).maximize().region;
      if (region) return region.toUpperCase();
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function defaultUnit(): DistanceUnit {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "mi" || saved === "km") return saved;
  } catch {
    /* storage unavailable: use the location default */
  }
  const region = userRegion();
  return region && MILE_COUNTRIES.has(region) ? "mi" : "km";
}

export function saveUnit(u: DistanceUnit): void {
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* non-fatal */
  }
}

export const toKm = (value: number, u: DistanceUnit) => (u === "mi" ? value * KM_PER_MILE : value);
export const fromKm = (km: number, u: DistanceUnit) => (u === "mi" ? km / KM_PER_MILE : km);

/** e.g. "11.1 mi" / "17.8 km" */
export function formatDistance(km: number, u: DistanceUnit, digits = 1): string {
  return `${fromKm(km, u).toFixed(digits)} ${u}`;
}
