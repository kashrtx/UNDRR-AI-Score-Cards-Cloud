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
 * never stops the rest. Pass a drawn `area` polygon instead and the name lookup
 * is skipped: every source gets the area's centre, bounding box and outline.
 */

import { geocode } from "./geocode";
import { openMeteoSource } from "./openMeteo";
import { overpassOsmSource } from "./overpassOsm";
import { usgsSource } from "./usgs";
import { worldBankSource } from "./worldBank";
import { resolveIso2 } from "./countries";
import { loadConfigSources } from "./configSources";
import { areaElevationSource } from "./areaElevation";
import { makeArea, simplifyRing, validateArea, formatKm2, type LonLat } from "@/lib/geo/area";
import type { DataSource, LocationContext } from "./types";
import type { DataPack, NormalizedDatum } from "@/lib/types";
import { provenance } from "../http";

// Coastal/elevation exposure now rides along with the climate call (Open-Meteo
// returns elevation in the same response), which is far more reliable than a
// separate elevation/flood endpoint. ReliefWeb is omitted (needs a pre-approved
// appname since Nov 2025 — see reliefWeb.ts).
const CODE_SOURCES: DataSource[] = [
  openMeteoSource,
  overpassOsmSource,
  usgsSource,
  worldBankSource,
  areaElevationSource, // only returns data when an area polygon is given
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

/** A drawn area as sent by the browser: just its outline, everything else is recomputed here. */
export interface AreaInput {
  ring: LonLat[];
  label?: string;
  countryCode?: string | null;
  /** "city" for a clicked city boundary (allowed to be larger than a drawn area). */
  source?: string;
}

export async function buildDataPack(
  city: string,
  country?: string,
  areaIn?: AreaInput
): Promise<DataPack> {
  if (areaIn?.ring?.length) return buildAreaPack(city, country, areaIn);
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

  const { data, sources, warnings } = await runSources(loc);
  return {
    city,
    country: loc.country,
    resolved: {
      displayName: location.display_name,
      lat: loc.lat,
      lon: loc.lon,
      countryCode: loc.country_code ?? null,
    },
    sources,
    dataPoints: data.length,
    data,
    warnings,
  };
}

/** Same as the city path, but the location comes from the drawn polygon. */
async function buildAreaPack(city: string, country: string | undefined, areaIn: AreaInput): Promise<DataPack> {
  const area = makeArea(simplifyRing(areaIn.ring), areaIn.source === "city" ? "city" : "polygon");
  const problem = validateArea(area);
  if (problem) {
    return {
      city, country, resolved: null, sources: [], dataPoints: 0, data: [],
      warnings: [`The selected area can't be used: ${problem}`],
    };
  }
  const loc: LocationContext = {
    name: areaIn.label || city || "the selected area",
    country,
    country_code: resolveIso2(country, areaIn.countryCode ?? null),
    lat: area.centroid.lat,
    lon: area.centroid.lon,
    bbox: area.bbox,
    polygon: area.ring,
    areaKm2: area.areaKm2,
  };
  const { data, sources, warnings } = await runSources(loc);
  data.unshift({
    key: "area_size",
    label: "Size of the selected area",
    value: Math.round(area.areaKm2 * 100) / 100,
    unit: "km²",
    provenance: provenance("User selection", "Area drawn or loaded in the Assistant", loc.name, ""),
  });
  return {
    city,
    country,
    resolved: {
      displayName: `${formatKm2(area.areaKm2)} selected area${areaIn.label ? ` around ${areaIn.label}` : ""}`,
      lat: loc.lat,
      lon: loc.lon,
      countryCode: loc.country_code ?? null,
    },
    area: { areaKm2: area.areaKm2, bbox: area.bbox, points: area.ring.length },
    sources,
    dataPoints: data.length,
    data,
    warnings,
  };
}

async function runSources(
  loc: LocationContext
): Promise<{ data: NormalizedDatum[]; sources: DataPack["sources"]; warnings: string[] }> {
  const allData: NormalizedDatum[] = [];
  const sourceReport: DataPack["sources"] = [];
  const warnings: string[] = [];

  // Run sources in parallel; each is independently guarded.
  await Promise.all(
    allSources().filter((s) => !s.appliesTo || s.appliesTo(loc)).map(async (source) => {
      try {
        const items = await withTimeout(source.fetch(loc), 24000, source.name);
        for (const it of items) (it as { sourceId?: string }).sourceId = source.id;
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
  return { data: allData, sources: sourceReport, warnings };
}
