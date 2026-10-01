#!/usr/bin/env node
/**
 * Generates lib/geo/regions.json: every country, and for countries whose
 * first-level divisions are states or provinces, the list of them (for the
 * Assistant's Country and "State or Province" dropdowns).
 *
 *   npm run build:regions
 *
 * Sources (both MIT): iso3166-2-db (countries + first-level subdivisions,
 * UN view of disputed areas) and iso-3166-2 (subdivision types, used only to
 * decide whether a country's first-level divisions are states/provinces).
 * Country names come from the runtime's standard English names (ICU).
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const countryList = require("iso3166-2-db/countryList/dispute/UN/en.json");
const iso = require("iso-3166-2");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const display = new Intl.DisplayNames(["en"], { type: "region" });
const collator = new Intl.Collator("en", { sensitivity: "base" });

// ICU's short names read oddly in a form and can confuse place lookups.
const NAME_OVERRIDES = {
  CD: "Democratic Republic of the Congo",
  CG: "Republic of the Congo",
  HK: "Hong Kong",
  MO: "Macau",
  MM: "Myanmar",
  PS: "Palestine",
};
const tidy = (name) => name.replace(/ & /g, " and ").replace(/^St\. /, "Saint ");

// Kosovo isn't in ISO 3166-1 but is widely used (XK).
const codes = [...new Set([...Object.keys(countryList), "XK"])];

const countries = codes
  .map((code) => {
    let name = code;
    try { name = display.of(code) || countryList[code]?.name || code; } catch { name = countryList[code]?.name || code; }
    if (name === code) return null; // not a real region code
    name = NAME_OVERRIDES[code] || tidy(name);

    let regions;
    try {
      regions = require(`iso3166-2-db/regions/${code}/dispute/UN/en.json`);
    } catch {
      regions = [];
    }
    const types = (iso.country(code)?.sub) || {};
    const typeOf = (r) => types[`${code}-${r.iso}`]?.type || "";
    // States/provinces and their local equivalents (German/Austrian Länder,
    // Swiss cantons, Japanese prefectures, UAE emirates). Plain "regions",
    // "counties" or "departments" don't get the dropdown.
    const hasStatesOrProvinces = regions.some((r) =>
      /\b(state|province|l(ä|a)nder|prefecture|canton|emirate)\b/i.test(typeOf(r))
    );

    const out = { code, name };
    if (hasStatesOrProvinces) {
      out.regions = regions
        .filter((r) => r.name)
        .map((r) => ({ code: `${code}-${r.iso}`, name: r.name }))
        .sort((a, b) => collator.compare(a.name, b.name));
    }
    return out;
  })
  .filter(Boolean)
  .sort((a, b) => collator.compare(a.name, b.name));

const file = path.join(ROOT, "lib", "geo", "regions.json");
writeFileSync(file, JSON.stringify({ countries }) + "\n");
const withRegions = countries.filter((c) => c.regions);
console.log(
  `Wrote ${path.relative(ROOT, file)}: ${countries.length} countries, ` +
  `${withRegions.length} with states/provinces (${withRegions.reduce((n, c) => n + c.regions.length, 0)} in total).`
);
