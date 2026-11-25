#!/usr/bin/env node
/**
 * Generates the places the area map labels and lets you click:
 *
 *   public/cities.json              every place with 15,000+ people, plus every
 *                                   national capital (loaded when the map opens)
 *   public/cities/detail/<la>_<lo>.json  smaller places (1,000-14,999 people),
 *                                   split into 5° tiles that load only when you
 *                                   zoom in close; index.json lists the tiles
 *
 *   npm run build:cities
 *
 * Source: the all-the-cities package (MIT), built from GeoNames
 * (https://www.geonames.org, CC BY 4.0).
 *
 * Format, sorted biggest first so the map can place big names before small:
 *   [[name, lat, lon, population, countryCode, isCapital(0|1)], ...]
 */

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cities = require("all-the-cities");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIN_POPULATION = 15000; // base file
const MIN_DETAIL_POPULATION = 1000; // detail tiles (the source's own floor)
const TILE_DEG = 5;
// Not cities in their own right: districts of a city (PPLX), and destroyed,
// abandoned or historical places (PPLW, PPLQ, PPLH).
const SKIP_CODES = new Set(["PPLX", "PPLW", "PPLQ", "PPLH"]);
const round = (n) => Math.round(n * 1000) / 1000; // ~100 m, plenty for a label

const toRow = (c) => [
  c.name,
  round(c.loc.coordinates[1]),
  round(c.loc.coordinates[0]),
  c.population,
  c.country,
  c.featureCode === "PPLC" ? 1 : 0,
];
const usable = cities
  .filter((c) => !SKIP_CODES.has(c.featureCode))
  .sort((a, b) => b.population - a.population);
const isBase = (c) => c.population >= MIN_POPULATION || c.featureCode === "PPLC";

const rows = usable.filter(isBase).map(toRow);
const file = path.join(ROOT, "public", "cities.json");
writeFileSync(file, JSON.stringify(rows));
console.log(`Wrote ${path.relative(ROOT, file)}: ${rows.length} cities.`);

// Detail tiles, keyed by the south-west corner's 5° band: "<floor(lat/5)>_<floor(lon/5)>".
const tiles = new Map();
for (const c of usable) {
  if (isBase(c) || c.population < MIN_DETAIL_POPULATION) continue;
  const key = `${Math.floor(c.loc.coordinates[1] / TILE_DEG)}_${Math.floor(c.loc.coordinates[0] / TILE_DEG)}`;
  if (!tiles.has(key)) tiles.set(key, []);
  tiles.get(key).push(toRow(c));
}
const dir = path.join(ROOT, "public", "cities", "detail");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [key, list] of tiles) writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(list));
writeFileSync(path.join(dir, "index.json"), JSON.stringify({ tileDeg: TILE_DEG, tiles: [...tiles.keys()].sort() }));
const total = [...tiles.values()].reduce((n, l) => n + l.length, 0);
console.log(`Wrote ${path.relative(ROOT, dir)}: ${total} smaller places in ${tiles.size} tiles.`);
