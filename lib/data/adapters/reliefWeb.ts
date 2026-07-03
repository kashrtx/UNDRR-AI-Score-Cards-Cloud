/**
 * ReliefWeb (UN OCHA) — recent recorded disasters in the country.
 *
 * Free, no API key. Lists recent disaster events (floods, cyclones,
 * earthquakes, droughts) that affected the country, giving the assessment real
 * historical grounding for Essential 2 (understand risk) and Essential 9
 * (response).
 */

import { getJson, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";

const BASE = "https://api.reliefweb.int/v1/disasters";

interface RWItem {
  fields?: { name?: string; type?: Array<{ name?: string }> };
}

export const reliefWebSource: DataSource = {
  id: "reliefweb",
  name: "ReliefWeb disaster history (UN OCHA)",

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    const country = loc.country;
    if (!country) return [];

    // `country` is the reference field; filtering it by name is the documented
    // way to get a country's disasters (country.name is NOT a valid filter field
    // — that was the bug that returned nothing).
    const build = (extra: Record<string, string>) => {
      const params = new URLSearchParams({
        appname: "undrr-arise-scorecard",
        profile: "list",
        limit: "15",
        "sort[]": "date:desc",
        ...extra,
      });
      return `${BASE}?${params.toString()}`;
    };
    const attempts = [
      build({ "filter[field]": "country", "filter[value]": country }),
      // Fallback: full-text search on the country name (tolerates naming diffs).
      build({ "query[value]": country, "query[fields][]": "country.name" }),
    ];

    let items: RWItem[] = [];
    let usedUrl = attempts[0];
    for (const url of attempts) {
      try {
        const data = await getJson<{ data?: RWItem[] }>(url, { timeoutMs: 8000, retries: 0 });
        if (data?.data?.length) {
          items = data.data;
          usedUrl = url;
          break;
        }
      } catch {
        /* try the next form */
      }
    }
    if (!items.length) return [];

    const events: string[] = [];
    const types: Record<string, number> = {};
    for (const it of items) {
      const name = it.fields?.name ?? "";
      if (name) events.push(name);
      for (const t of it.fields?.type ?? []) {
        const label = t.name ?? "Other";
        types[label] = (types[label] ?? 0) + 1;
      }
    }

    const prov = provenance(
      "ReliefWeb (UN OCHA)",
      "Disasters API",
      `recent disasters in ${country}`,
      usedUrl
    );
    const out: NormalizedDatum[] = [
      {
        key: "reliefweb_recent_disasters",
        label: `Recent recorded disasters in ${country}`,
        value: events,
        unit: "events",
        essentialHint: 2,
        provenance: prov,
      },
    ];
    if (Object.keys(types).length) {
      out.push({
        key: "reliefweb_disaster_types",
        label: "Disaster types recorded (count)",
        value: types,
        essentialHint: 9,
        provenance: prov,
      });
    }
    return out;
  },
};
