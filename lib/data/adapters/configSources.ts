/**
 * Config-driven data sources — add a REST API by editing a JSON file, no code.
 *
 * A "simple" data source is any free API where you call one URL and pick a few
 * values out of the JSON response. Those live in `data-sources.json` and are
 * loaded here. "Tricky" sources (Open-Meteo statistics, Overpass counts, etc.)
 * stay as their own modules. Both kinds end up in the same registry.
 *
 * ── The JSON spec (one object per source) ───────────────────────────────────
 * {
 *   "id": "restcountries",
 *   "name": "REST Countries",
 *   "enabled": true,
 *   "needs": ["country_code"],            // which location facts it requires
 *   "url": "https://.../{country_code}",  // {placeholders} filled per city
 *   "dataset": "REST Countries API",
 *   "records_path": "0",                  // dotted path; numbers index arrays
 *   "mode": "fields",                     // "fields" (pick values) | "collect"
 *   "fields": [
 *     { "key": "region", "label": "World region", "path": "region", "essentialHint": 2 }
 *   ],
 *   "collect": { "key": "events", "label": "Recent disasters",
 *                "item_path": "fields.name", "essentialHint": 2 }
 * }
 *
 * Placeholders usable in "url" and "label":
 *   {name} {country} {country_code} {lat} {lon}
 *   {bbox_south} {bbox_north} {bbox_west} {bbox_east} {today} {start_5y}
 */

import { getJson, provenance } from "../http";
import type { NormalizedDatum } from "@/lib/types";
import type { DataSource, LocationContext } from "./types";
import rawSpecs from "./data-sources.json";

interface FieldSpec {
  key: string;
  label?: string;
  path: string;
  unit?: string;
  essentialHint?: number;
}
interface CollectSpec {
  key: string;
  label?: string;
  item_path: string;
  unit?: string;
  essentialHint?: number;
}
interface SourceSpec {
  id: string;
  name?: string;
  enabled?: boolean;
  needs?: string[];
  url: string;
  dataset?: string;
  records_path?: string;
  mode?: "fields" | "collect";
  fields?: FieldSpec[];
  collect?: CollectSpec;
}

function placeholders(loc: LocationContext): Record<string, string> {
  const bbox = loc.bbox ?? [NaN, NaN, NaN, NaN];
  const today = new Date();
  const start5y = new Date();
  start5y.setFullYear(today.getFullYear() - 5);
  const iso = (d: Date) => d.toISOString().split("T")[0];
  return {
    name: String(loc.name ?? ""),
    country: String(loc.country ?? ""),
    country_code: String(loc.country_code ?? ""),
    lat: String(loc.lat ?? ""),
    lon: String(loc.lon ?? ""),
    bbox_south: String(bbox[0]),
    bbox_north: String(bbox[1]),
    bbox_west: String(bbox[2]),
    bbox_east: String(bbox[3]),
    today: iso(today),
    start_5y: iso(start5y),
  };
}

function fillTemplate(tpl: string, subs: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in subs ? subs[k] : `{${k}}`));
}

function resolvePath(node: unknown, path?: string): unknown {
  if (!path) return node;
  let cur: unknown = node;
  for (const seg of String(path).split(".")) {
    if (cur == null) return null;
    if (/^-?\d+$/.test(seg) && Array.isArray(cur)) {
      const idx = parseInt(seg, 10);
      cur = idx >= -cur.length && idx < cur.length ? cur[(idx + cur.length) % cur.length] : null;
    } else if (typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return cur;
}

class HttpJsonSource implements DataSource {
  id: string;
  name: string;
  private needs: string[];
  private spec: SourceSpec;

  constructor(spec: SourceSpec) {
    this.id = spec.id;
    this.name = spec.name ?? spec.id;
    this.needs = spec.needs ?? [];
    this.spec = spec;
  }

  private ready(loc: LocationContext): boolean {
    const subs = placeholders(loc);
    return this.needs.every((n) => (subs[n] ?? "") !== "" && subs[n] !== "NaN");
  }

  async fetch(loc: LocationContext): Promise<NormalizedDatum[]> {
    if (!this.ready(loc)) return [];
    const subs = placeholders(loc);
    const url = fillTemplate(this.spec.url, subs);

    let data: unknown;
    try {
      data = await getJson(url, { timeoutMs: 20000, retries: 1 });
    } catch {
      return [];
    }

    const prov = provenance(
      this.name,
      this.spec.dataset ?? "API",
      `${this.id} for ${loc.name}`,
      url
    );
    const root = resolvePath(data, this.spec.records_path);
    const mode = this.spec.mode ?? "fields";

    if (mode === "collect" && this.spec.collect) {
      const c = this.spec.collect;
      const items = Array.isArray(root) ? root : [];
      const values = items
        .map((it) => resolvePath(it, c.item_path))
        .filter((v) => v != null && v !== "");
      if (!values.length) return [];
      return [
        {
          key: c.key,
          label: fillTemplate(c.label ?? c.key, subs),
          value: values,
          unit: c.unit,
          essentialHint: c.essentialHint,
          provenance: prov,
        },
      ];
    }

    // mode "fields"
    const record = Array.isArray(root) && root.length ? root[0] : root;
    const out: NormalizedDatum[] = [];
    for (const f of this.spec.fields ?? []) {
      const value = resolvePath(record, f.path);
      if (value == null || value === "") continue;
      out.push({
        key: f.key,
        label: fillTemplate(f.label ?? f.key, subs),
        value,
        unit: f.unit,
        essentialHint: f.essentialHint,
        provenance: prov,
      });
    }
    return out;
  }
}

export function loadConfigSources(): DataSource[] {
  const specs = (rawSpecs as SourceSpec[]) ?? [];
  return specs
    .filter((s) => s && s.enabled !== false && s.url && s.id)
    .map((s) => new HttpJsonSource(s));
}
