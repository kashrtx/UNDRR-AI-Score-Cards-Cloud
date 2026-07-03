/**
 * World Bank Open Data — national context indicators.
 *
 * Free, no API key. Provides country-level signals that frame a city's
 * resilience: population, GDP per capita, urban-population share, poverty, and
 * access to electricity. These map to Essential 3 (financial capacity),
 * Essential 4 (urban development) and Essential 7/8 (societal & infrastructure).
 *
 * City-level data is always preferable; where it doesn't exist, national
 * figures are a clearly-labelled fallback (the label says "national").
 */

import { buildUrl, getJson, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const BASE = "https://api.worldbank.org/v2/country";

// World Bank indicator code -> [human label, unit, essential hint]
const INDICATORS: Record<string, [string, string, number]> = {
  "SP.POP.TOTL": ["National population", "people", 7],
  "NY.GDP.PCAP.CD": ["GDP per capita", "USD", 3],
  "SP.URB.TOTL.IN.ZS": ["Urban population share", "%", 4],
  "SI.POV.DDAY": ["Population in extreme poverty", "%", 7],
  "EG.ELC.ACCS.ZS": ["Access to electricity", "%", 8],
};

interface WBRow {
  value?: number | null;
  date?: string;
}

export const worldBankSource: DataSource = {
  id: "world_bank",
  name: "World Bank Open Data",

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    const code = (loc.country_code || "").trim();
    if (!code) return [];

    const out: NormalizedDatum[] = [];
    // Fetch all indicators in PARALLEL to stay within the serverless budget.
    await Promise.all(
      Object.entries(INDICATORS).map(async ([indicator, [label, unit, hint]]) => {
        const url = buildUrl(`${BASE}/${code}/indicator/${indicator}`, {
          format: "json",
          per_page: 60,
          mrnev: 1, // most recent non-empty value
        });
        let data: [unknown, WBRow[] | null] | unknown;
        try {
          data = await getJson(url, { timeoutMs: 9000, retries: 1 });
        } catch {
          return;
        }
        // World Bank returns [metadata, [rows]]
        if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1]) || !data[1].length) {
          return;
        }
        const row = data[1][0] as WBRow;
        if (row.value == null) return;
        out.push({
          key: `wb_${indicator.toLowerCase().replace(/\./g, "_")}`,
          label: `${label} (${row.date ?? "latest"}, national)`,
          value: row.value,
          unit,
          essentialHint: hint,
          provenance: provenance(
            "World Bank",
            "World Development Indicators",
            `${indicator} for ${code}`,
            url
          ),
        });
      })
    );
    return out;
  },
};
