/**
 * Optional data sources the user can pick in Settings (Step 3). The list is the
 * datasets highlighted (red text) in a researcher's catalogue of free global
 * hazard, exposure and vulnerability data, grouped the way that catalogue
 * groups them. A picked source is handed to the AI helpers ("Fill it out for
 * me" and "Run analysis") as preferred evidence to look up, cross-check and
 * cite; the app itself does not download these datasets.
 */

export type DataSourceCategory =
  | "hazard"
  | "exposure"
  | "vulnerability"
  | "impacts"
  | "multiHazard"
  | "portal";

export interface DataSourceInfo {
  id: string;
  name: string;
  provider: string;
  category: DataSourceCategory;
  /** The hazard, for hazard datasets ("Drought", "Inland flood", …). */
  hazard?: string;
  /** What it provides, in a sentence. */
  provides: string;
  /** Coverage, resolution and period. */
  coverage: string;
  /** The main limitation or licence caveat to keep in mind. */
  caveat: string;
  url: string;
}

export const DATA_SOURCE_CATEGORIES: Array<{ id: DataSourceCategory; title: string; blurb: string }> = [
  { id: "hazard", title: "Hazard datasets", blurb: "Physical events, conditions, intensities or probabilities." },
  { id: "exposure", title: "Exposure datasets usable across the hazards", blurb: "Where people, buildings, infrastructure and other assets are." },
  { id: "vulnerability", title: "Vulnerability and coping-capacity datasets", blurb: "Social vulnerability and coping capacity, and physical damage functions." },
  { id: "impacts", title: "Historical impacts and event validation", blurb: "Recorded disasters and their losses, kept separate from hazard probability." },
  { id: "multiHazard", title: "Multi-hazard risk models", blurb: "Modelled risk combining hazards, exposure and vulnerability." },
  { id: "portal", title: "Catalogues and discovery portals", blurb: "Places to find further datasets, not one harmonised dataset." },
];

/** Hazard sub-groups, in the order the catalogue lists them. */
export const HAZARD_ORDER = [
  "Drought", "Wildfire", "Inland flood", "Earthquake", "Storm surge and coastal flooding",
  "Sea-level rise", "Severe weather (rain, wind, heat, cold)", "Hurricanes, typhoons and cyclones",
];

const GFDRR_HAZARD = "https://gfdrr.github.io/CCDR-tools/docs/global-hazard.html";

export const DATA_SOURCES: DataSourceInfo[] = [
  // ── Hazard ──
  {
    id: "aqueduct-water-risk", name: "Aqueduct Water Risk Atlas", provider: "WRI", category: "hazard", hazard: "Drought",
    provides: "Drought risk, water stress, depletion, variability and other water-risk indicators.",
    coverage: "Global, catchment-based; historical and selected future indicators.",
    caveat: "Distinguish the drought indicator from broader water stress and composite water-risk scores.",
    url: "https://aqueduct.wri.org/water-risk-atlas",
  },
  {
    id: "fao-asis", name: "Agricultural Stress Index System (ASIS)", provider: "FAO", category: "hazard", hazard: "Drought",
    provides: "Vegetation-health-based agricultural drought indicators and drought frequency over cropland.",
    coverage: "Global agricultural areas; about 1984–2024 by growing season.",
    caveat: "Suited to crop and agricultural exposure more than municipal water-supply drought.",
    url: "https://www.fao.org/giews/earthobservation/asis/",
  },
  {
    id: "fire-risk-climate", name: "Global Fire Risk under Climate Change", provider: "Knorr and colleagues", category: "hazard", hazard: "Wildfire",
    provides: "Modelled fire-risk products for baseline and future climate scenarios (SSP1-2.6, SSP5-8.5).",
    coverage: "Global, 0.5°.",
    caveat: "Coarse resolution: regional screening rather than individual sites.",
    url: GFDRR_HAZARD,
  },
  {
    id: "jrc-river-flood", name: "Global River Flood Hazard Maps", provider: "JRC / Copernicus", category: "hazard", hazard: "Inland flood",
    provides: "Modelled river-flood inundation depths for seven return periods.",
    coverage: "Global rivers, about 90 m; 2024 release, historical baseline.",
    caveat: "No substitute for a surface-water or urban-drainage flood model.",
    url: GFDRR_HAZARD,
  },
  {
    id: "aqueduct-floods-river", name: "Aqueduct Floods (riverine)", provider: "WRI", category: "hazard", hazard: "Inland flood",
    provides: "Riverine flood-depth maps for baseline and future conditions (2030, 2050, 2080).",
    coverage: "About 1 km; multiple return periods.",
    caveat: "Relatively coarse and based on CMIP5-era climate projections.",
    url: "https://www.wri.org/data/aqueduct-floods-hazard-maps",
  },
  {
    id: "unep-cdri-flood", name: "UNEP/CDRI global flood hazard layers", provider: "UNEP / CDRI", category: "hazard", hazard: "Inland flood",
    provides: "Riverine flood-depth scenarios from the global infrastructure-risk framework.",
    coverage: "About 90 m; nine return periods; baseline and long-term future.",
    caveat: "Part of the GIRI infrastructure-risk model; check which scenario is used.",
    url: "https://giri.unepgrid.ch",
  },
  {
    id: "gem-seismic-hazard", name: "GEM Global Seismic Hazard Map and Mosaic", provider: "Global Earthquake Model (GEM)", category: "hazard", hazard: "Earthquake",
    provides: "Probabilistic ground shaking (PGA, 10% in 50 years on rock) and the national/regional models behind it.",
    coverage: "Global; 2026.1 map.",
    caveat: "Licences vary; non-commercial terms apply to some open products.",
    url: "https://hazard.openquake.org/gem/models/mosaic/",
  },
  {
    id: "deltares-coastal", name: "Global Coastal Flood Maps", provider: "Deltares", category: "hazard", hazard: "Storm surge and coastal flooding",
    provides: "Modelled coastal inundation depths across return periods.",
    coverage: "About 90 m; baseline and CMIP6-based 2050.",
    caveat: "Global model; local defences may not be represented.",
    url: GFDRR_HAZARD,
  },
  {
    id: "aqueduct-floods-coastal", name: "Aqueduct Floods (coastal)", provider: "WRI", category: "hazard", hazard: "Storm surge and coastal flooding",
    provides: "Coastal flood depths under baseline and future sea-level conditions.",
    coverage: "About 1 km; multiple return periods and horizons.",
    caveat: "Coarse resolution and older climate scenarios.",
    url: "https://www.wri.org/data/aqueduct-floods-hazard-maps",
  },
  {
    id: "unep-cdri-coastal", name: "UNEP/CDRI coastal flood layers", provider: "UNEP / CDRI", category: "hazard", hazard: "Storm surge and coastal flooding",
    provides: "Coastal flood hazard scenarios for infrastructure-risk assessment.",
    coverage: "About 90 m; return periods 10–1,000 years; baseline and long-term.",
    caveat: "Part of the GIRI infrastructure-risk model.",
    url: "https://giri.unepgrid.ch",
  },
  {
    id: "copernicus-sea-level", name: "Copernicus / Deltares global sea-level products", provider: "Copernicus / Deltares", category: "hazard", hazard: "Sea-level rise",
    provides: "Sea-level time series and extreme water-level indicators combining tides, surge and sea-level change.",
    coverage: "Global coastlines; historical and future to 2050.",
    caveat: "Coastal water levels are not inland inundation depths.",
    url: "https://cds.climate.copernicus.eu/datasets/sis-water-level-change-indicators-cmip6?tab=overview",
  },
  {
    id: "era5", name: "ERA5 reanalysis", provider: "ECMWF / Copernicus", category: "hazard", hazard: "Severe weather (rain, wind, heat, cold)",
    provides: "Historical atmosphere, land and ocean-wave variables for deriving weather extremes.",
    coverage: "Global, 0.25°, hourly, 1940–present.",
    caveat: "Gridded reanalysis, not a catalogue of observed local storm events.",
    url: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=overview",
  },
  {
    id: "copernicus-utci", name: "Copernicus UTCI heat-stress products", provider: "Copernicus", category: "hazard", hazard: "Severe weather (rain, wind, heat, cold)",
    provides: "Thermal-stress (heat and cold) indices, historical and future.",
    coverage: "Global; resolution and period depend on the product.",
    caveat: "Similarly named products use different inputs; check the one used.",
    url: "https://cds.climate.copernicus.eu/datasets/derived-utci-historical?tab=overview",
  },
  {
    id: "storm-cyclones", name: "STORM synthetic cyclones", provider: "TU Delft and collaborators", category: "hazard", hazard: "Hurricanes, typhoons and cyclones",
    provides: "Synthetic cyclone tracks and probabilistic wind-hazard maps, including future climate.",
    coverage: "Cyclone basins worldwide; about 10 km; return periods 10–10,000 years.",
    caveat: "Note the baseline, scenario and wind-speed convention used.",
    url: GFDRR_HAZARD,
  },
  // ── Exposure ──
  {
    id: "ghsl", name: "Global Human Settlement Layer (GHSL)", provider: "European Commission JRC", category: "exposure",
    provides: "Population and built-up settlement layers.",
    coverage: "Global rasters; population grids at 100 m.",
    caveat: "Pick the right layer and reference year.",
    url: "https://human-settlement.emergency.copernicus.eu/",
  },
  {
    id: "wsf", name: "World Settlement Footprint (WSF)", provider: "DLR", category: "exposure",
    provides: "Where built-up settlement is.",
    coverage: "Global; WSF2019 at 10 m.",
    caveat: "Settlement presence only: no building value or structure type.",
    url: "https://geoservice.dlr.de/web/maps/eoc:wsf2019",
  },
  {
    id: "esa-worldcover", name: "WorldCover", provider: "ESA", category: "exposure",
    provides: "Land-cover classes, including agricultural and built-up areas.",
    coverage: "Global; 10 m.",
    caveat: "Land use, not an inventory of individual assets.",
    url: "https://esa-worldcover.org/",
  },
  {
    id: "cisi", name: "Global critical infrastructure / CISI", provider: "IVM (VU Amsterdam)", category: "exposure",
    provides: "Infrastructure quantities by type and the Critical Infrastructure Spatial Index.",
    coverage: "Global, aggregated at 0.1°.",
    caveat: "Regional screening, not individual facilities.",
    url: "https://gfdrr.github.io/CCDR-tools/docs/global-exposure.html",
  },
  {
    id: "gem-exposure", name: "GEM Global Exposure Model (open edition)", provider: "Global Earthquake Model (GEM)", category: "exposure",
    provides: "Building stock, occupants, construction attributes and replacement cost.",
    coverage: "Global; open edition aggregated to admin level 1.",
    caveat: "CC BY-NC-SA 4.0: non-commercial; finer resolution needs a licence.",
    url: "https://www.globalquakemodel.org/product/global-exposure-model",
  },
  // ── Vulnerability ──
  {
    id: "inform", name: "INFORM Risk Index", provider: "European Commission JRC and partners", category: "vulnerability",
    provides: "Social vulnerability, lack of coping capacity, and hazard/exposure indicators across hazards.",
    coverage: "Global, country level; source indicators downloadable.",
    caveat: "Use the relevant component, not the composite as pure vulnerability.",
    url: "https://drmkc.jrc.ec.europa.eu/inform-index/INFORM-Risk/Results-and-data",
  },
  {
    id: "tc-impact-functions", name: "Regional Tropical Cyclone Impact Functions", provider: "Eberenz and colleagues", category: "vulnerability",
    provides: "Physical/economic vulnerability to cyclone wind (damage functions).",
    coverage: "Regionally calibrated, applied across cyclone-prone regions.",
    caveat: "For loss modelling with compatible wind and exposure inputs.",
    url: "https://gfdrr.github.io/CCDR-tools/docs/global-vulnerability.html",
  },
  {
    id: "gem-vulnerability", name: "GEM Global Vulnerability Model", provider: "Global Earthquake Model (GEM)", category: "vulnerability",
    provides: "Earthquake building fragility, vulnerability and damage-to-loss relationships.",
    coverage: "Global framework linked to building classes.",
    caveat: "Licences differ between GEM products.",
    url: "https://docs.openquake.org/global_risk_model/",
  },
  {
    id: "gem-economic-vulnerability", name: "GEM Global Economic Vulnerability Map", provider: "Global Earthquake Model (GEM)", category: "vulnerability",
    provides: "Earthquake economic vulnerability, alongside GEM's hazard and exposure maps.",
    coverage: "Global.",
    caveat: "Check the current release, measure and reuse licence.",
    url: "https://www.globalquakemodel.org/products",
  },
  // ── Historical impacts ──
  {
    id: "emdat", name: "EM-DAT", provider: "CRED (UCLouvain)", category: "impacts",
    provides: "Disaster occurrences with reported deaths, people affected and economic losses since 1900.",
    coverage: "Global.",
    caveat: "Free for non-commercial use; records major disasters only.",
    url: "https://www.emdat.be/",
  },
  // ── Multi-hazard / portals (from PreventionWeb's global risk data sets) ──
  {
    id: "giri", name: "Global Infrastructure Risk Model and Index (GIRI)", provider: "UNEP/GRID-Geneva and partners", category: "multiHazard",
    provides: "Probabilistic infrastructure risk from major geological and climate-related hazards.",
    coverage: "Global.",
    caveat: "Keep hazard inputs, exposure inputs and modelled losses apart.",
    url: "https://giri.unepgrid.ch",
  },
  {
    id: "mapx", name: "MapX", provider: "UNEP/GRID-Geneva", category: "portal",
    provides: "About 2,000 public geospatial datasets (disaster risk, climate, land use, natural resources).",
    coverage: "Varies by layer.",
    caveat: "A discovery platform; check coverage and licence layer by layer.",
    url: "https://app.mapx.org/",
  },
];

/**
 * Each dataset's short name (how the AI is asked to cite it) and the pattern
 * that spots it in a note, a search or a sourceRef. Acronyms that are also
 * ordinary words (INFORM, STORM, ASIS) only match in capitals.
 */
const CITE: Record<string, { short: string; match: RegExp }> = {
  "aqueduct-water-risk": { short: "Aqueduct Water Risk", match: /Aqueduct Water Risk|Aqueduct (drought|water[- ]stress)/i },
  "fao-asis": { short: "ASIS", match: /\bASIS\b|Agricultural Stress Index/ },
  "fire-risk-climate": { short: "Global Fire Risk", match: /Global Fire Risk|Knorr/i },
  "jrc-river-flood": { short: "JRC River Flood", match: /JRC (Global )?(River )?Flood/i },
  "aqueduct-floods-river": { short: "Aqueduct Floods (riverine)", match: /Aqueduct Floods?\b(?!\s*\(?coastal)|Aqueduct riverine/i },
  "unep-cdri-flood": { short: "UNEP/CDRI flood", match: /UNEP\s*\/\s*CDRI(?!\s+coastal)/i },
  "gem-seismic-hazard": { short: "GEM Seismic Hazard", match: /GEM (Global )?Seismic Hazard/i },
  "deltares-coastal": { short: "Deltares Coastal Flood", match: /Deltares (Global )?Coastal|Global Coastal Flood Maps/i },
  "aqueduct-floods-coastal": { short: "Aqueduct Floods (coastal)", match: /Aqueduct Floods?\s*\(?coastal|Aqueduct coastal/i },
  "unep-cdri-coastal": { short: "UNEP/CDRI coastal", match: /UNEP\s*\/\s*CDRI\s+coastal/i },
  "copernicus-sea-level": { short: "Copernicus sea level", match: /Copernicus[^.;]{0,25}sea[- ]level/i },
  era5: { short: "ERA5", match: /\bERA-?5\b/i },
  "copernicus-utci": { short: "UTCI", match: /\bUTCI\b/i },
  "storm-cyclones": { short: "STORM", match: /\bSTORM\b(?! surge)|STORM synthetic/ },
  ghsl: { short: "GHSL", match: /\bGHSL\b|Global Human Settlement/i },
  wsf: { short: "WSF", match: /\bWSF\b|World Settlement Footprint/i },
  "esa-worldcover": { short: "WorldCover", match: /WorldCover/i },
  cisi: { short: "CISI", match: /\bCISI\b/i },
  "gem-exposure": { short: "GEM Exposure", match: /GEM (Global )?Exposure/i },
  inform: { short: "INFORM", match: /\bINFORM\b|INFORM Risk Index/ },
  "tc-impact-functions": { short: "TC Impact Functions", match: /(TC|Tropical Cyclone) Impact Functions|Eberenz/i },
  "gem-vulnerability": { short: "GEM Vulnerability", match: /GEM (Global )?Vulnerability/i },
  "gem-economic-vulnerability": { short: "GEM Economic Vulnerability", match: /GEM (Global )?Economic Vulnerability/i },
  emdat: { short: "EM-DAT", match: /\bEM-?DAT\b/i },
  giri: { short: "GIRI", match: /\bGIRI\b|Global Infrastructure Risk Model/i },
  mapx: { short: "MapX", match: /\bMapX\b/i },
};

/** The name the AI cites a dataset by (falls back to the full name). */
export function shortName(d: DataSourceInfo): string {
  return CITE[d.id]?.short ?? d.name;
}

/**
 * The datasets a piece of text cites (a note, a search, a sourceRef), limited to
 * `ids` when given (the user's chosen sources), in catalogue order.
 */
export function citedSources(text: string | readonly string[] | undefined, ids?: readonly string[]): DataSourceInfo[] {
  const raw = Array.isArray(text) ? text.join(" \n ") : (text as string | undefined) ?? "";
  // "not covered by INFORM; based on …" names a dataset it did NOT use, so drop those phrases.
  const t = raw.replace(/\b(not (covered|available|listed|found|included) (by|in)|no (data|coverage|value) (in|from)|nothing (in|from)|missing from|absent from|lacking in)\s+[^;.,\n]*/gi, " ");
  if (!t.trim()) return [];
  const pool = ids ? selectedDataSources(ids) : DATA_SOURCES;
  return pool.filter((d) => {
    const c = CITE[d.id];
    return (c && c.match.test(t)) || t.toLowerCase().includes(d.name.toLowerCase());
  });
}

/** The picked sources, in catalogue order (unknown ids are ignored). */
export function selectedDataSources(ids: readonly string[] | undefined): DataSourceInfo[] {
  const want = new Set(ids || []);
  return DATA_SOURCES.filter((d) => want.has(d.id));
}

/** The picked sources as a prompt block for the AI (empty when none are picked). */
export function dataSourcesPrompt(ids: readonly string[] | undefined, use: "fill" | "analysis"): string {
  const picked = selectedDataSources(ids);
  if (!picked.length) return "";
  const lines = picked.map((d) =>
    `- ${shortName(d)} = ${d.name} (${d.provider}${d.hazard ? `; ${d.hazard} hazard` : ""}): ${d.provides} Coverage: ${d.coverage} Caveat: ${d.caveat} ${d.url}`
  );
  const rule =
    "PRIORITY RULE: these chosen datasets are your PRIMARY evidence. For every point they cover, base it on them first. " +
    "Use other sources (general web pages, the app's own open data, research summaries, your background knowledge) only to SUPPLEMENT them with detail they don't provide, " +
    "or INSTEAD of them where the chosen datasets have nothing usable on that point (no coverage of this place, wrong hazard, too coarse). " +
    "If a general source disagrees with a chosen dataset, go with the chosen dataset unless it is clearly outdated or off-topic, and say so. " +
    "Respect each caveat, and never invent a value you don't actually have.";
  const how =
    use === "fill"
      ? "When you research, look up what these say about this place first (for example a web_search naming the dataset and the city), before general searches. In each indicator's note, name the chosen dataset it rests on by the short name before the \"=\" (the app shows those names as links); when you had to fall back to a general source, say so briefly (e.g. \"not covered by INFORM; based on the city's flood plan\")."
      : "Ground the risk lens, weaknesses and actions in these datasets first, and put a dataset's short name (the part before the \"=\") in sourceRefs whenever a statement relies on it. Where you fall back to other evidence because a chosen dataset has nothing on that point, keep it clearly secondary.";
  return `DATA SOURCES THE USER CHOSE (the app does not download them, so rely on what you can find or know about them):\n${lines.join("\n")}\n${rule}\n${how}\n`;
}
