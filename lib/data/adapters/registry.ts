/**
 * Data registry — the one place that knows every data source.
 *
 * Two kinds of source end up in the same list:
 *   • "tricky" sources with real logic — climate stats, OSM counts, USGS,
 *     World Bank, ReliefWeb.
 *   • "simple" sources declared in data-sources.json (just a URL + which
 *     values to pick). Add one by editing that file — no code.
 *
 * `buildDataPack(city, country)` geocodes the city once, then runs every
 * enabled source and tags each value with where it came from. One bad source
 * never stops the rest.
 */

import { geocode } from "./geocode";
import { openMeteoSource } from "./openMeteo";
import { overpassOsmSource } from "./overpassOsm";
import { usgsSource } from "./usgs";
import { worldBankSource } from "./worldBank";
import { hazardRiskSource } from "./hazardRisk";
import { resolveIso2 } from "./countries";
import { loadConfigSources } from "./configSources";
import type { DataSource, LocationContext } from "./types";
import type { DataPack, NormalizedDatum } from "@/lib/types";

// NOTE: ReliefWeb (lib/data/adapters/reliefWeb.ts) is intentionally NOT included:
// as of 1 Nov 2025 its API requires a *pre-approved* appname (org registration),
// so it can't run out-of-the-box. Register an appname at
// https://apidoc.reliefweb.int/ and re-add reliefWebSource here to enable it.
const CODE_SOURCES: DataSource[] = [
  openMeteoSource,
  hazardRiskSource,
  overpassOsmSource,
  usgsSource,
  worldBankSource,
];

export function allSources(): DataSource[] {
  return [...CODE_SOURCES, ...loadConfigSources()];
}

/** Reject a promise if it doesn't settle within `ms` — bounds each source so
 *  one slow API can't blow the serverless time budget. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

/** Geocoding + every data source, for display / MCP list_sources. */
export function listSources(): Array<{ id: string; name: string; requiresKey: boolean }> {
  const out = [
    { id: "nominatim", name: "Nominatim (OpenStreetMap geocoding)", requiresKey: false },
  ];
  for (const s of allSources()) out.push({ id: s.id, name: s.name, requiresKey: false });
  return out;
}

export async function buildDataPack(
  city: string,
  country?: string
): Promise<DataPack> {
  let location;
  try {
    location = await geocode(city, country);
  } catch (err) {
    return {
      city,
      country,
      resolved: null,
      sources: [],
      dataPoints: 0,
      data: [],
      warnings: [
        `Could not look up '${city}'. The location service (OpenStreetMap ` +
          `Nominatim) was unreachable or refused the request: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          "Analysis will continue using the scorecard alone.",
      ],
    };
  }

  if (!location) {
    return {
      city,
      country,
      resolved: null,
      sources: [],
      dataPoints: 0,
      data: [],
      warnings: [`Could not locate '${city}'. Check the spelling or add the country.`],
    };
  }

  const loc: LocationContext = {
    name: city,
    country: location.country || country,
    country_code: resolveIso2(location.country || country, location.country_code),
    lat: location.lat,
    lon: location.lon,
    bbox: location.bbox,
  };

  const allData: NormalizedDatum[] = [];
  const sourceReport: DataPack["sources"] = [];
  const warnings: string[] = [];

  // Run sources in parallel; each is independently guarded.
  await Promise.all(
    allSources().map(async (source) => {
      try {
        const items = await withTimeout(source.fetch(loc), 24000, source.name);
        allData.push(...items);
        sourceReport.push({ id: source.id, name: source.name, points: items.length });
        if (!items.length) warnings.push(`${source.name}: no data for this location.`);
      } catch (err) {
        sourceReport.push({
          id: source.id,
          name: source.name,
          points: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        warnings.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  // Stable order for display.
  sourceReport.sort((a, b) => a.name.localeCompare(b.name));

  return {
    city,
    country: loc.country,
    resolved: {
      displayName: location.display_name,
      lat: loc.lat,
      lon: loc.lon,
      countryCode: loc.country_code ?? null,
    },
    sources: sourceReport,
    dataPoints: allData.length,
    data: allData,
    warnings,
  };
}
