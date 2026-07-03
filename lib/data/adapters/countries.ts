/**
 * Country resolver — turn a country NAME (or a code the geocoder gave us) into a
 * reliable ISO 3166-1 alpha-2 code, fully offline.
 *
 * The geocoder doesn't always return a country code (it did for Toronto, not for
 * Fuvahmulah), which starved the country-level data sources. We rebuild a
 * name→code map from the runtime's own ICU data via Intl.DisplayNames, so
 * "Maldives" → "MV", "Canada" → "CA", etc., with a handful of common aliases.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

let cache: Record<string, string> | null = null;

function buildMap(): Record<string, string> {
  if (cache) return cache;
  const map: Record<string, string> = {};
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a) + String.fromCharCode(b);
        let name: string | undefined;
        try {
          name = dn.of(code);
        } catch {
          name = undefined;
        }
        if (name && name !== code) map[norm(name)] = code;
      }
    }
  } catch {
    /* ICU may be limited — aliases + geocode code still cover common cases */
  }
  // Common short names / alternates the ICU canonical form doesn't match.
  const aliases: Record<string, string> = {
    usa: "US", unitedstatesofamerica: "US", america: "US",
    uk: "GB", greatbritain: "GB", england: "GB", scotland: "GB", wales: "GB",
    russia: "RU", southkorea: "KR", northkorea: "KP", iran: "IR", syria: "SY",
    vietnam: "VN", laos: "LA", bolivia: "BO", venezuela: "VE", tanzania: "TZ",
    moldova: "MD", czechrepublic: "CZ", czechia: "CZ", turkey: "TR", turkiye: "TR",
    capeverde: "CV", ivorycoast: "CI", cotedivoire: "CI", brunei: "BN",
    drcongo: "CD", democraticrepublicofthecongo: "CD", republicofthecongo: "CG",
    congo: "CG", swaziland: "SZ", eswatini: "SZ", macedonia: "MK",
    northmacedonia: "MK", palestine: "PS", southsudan: "SS", eastimor: "TL",
    timorleste: "TL", myanmar: "MM", burma: "MM",
  };
  for (const [k, v] of Object.entries(aliases)) if (!map[k]) map[k] = v;
  cache = map;
  return map;
}

/** Best-effort ISO alpha-2. Prefers a 2-letter code from the geocoder, else the name. */
export function resolveIso2(country?: string | null, geoCode?: string | null): string | null {
  const g = (geoCode ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(g)) return g;
  if (!country) return null;
  const map = buildMap();
  const key = norm(country);
  return map[key] ?? map[norm(country.replace(/^the\s+/i, ""))] ?? null;
}
