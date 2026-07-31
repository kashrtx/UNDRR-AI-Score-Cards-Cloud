"use client";

/**
 * A standalone, modern directory of free, credible places to get real data for
 * a city's resilience scorecard. Opens in its own tab. The whole point is to
 * encourage people to fact-check and paste real numbers into the copilot or the
 * Assistant, so this goes well beyond the four links we were first given.
 *
 * Static, curated content, client-side search + category filter, no fetching.
 */

import { useMemo, useState } from "react";
import { Search, ExternalLink, ArrowLeft, ClipboardCheck, Globe2 } from "lucide-react";

type Source = { name: string; url: string; what: string; free: string };
type Group = { category: string; blurb: string; sources: Source[] };

const GROUPS: Group[] = [
  {
    category: "Disaster losses & past events",
    blurb: "What has actually happened: historical disasters, damage and casualties.",
    sources: [
      { name: "EM-DAT (CRED)", url: "https://www.emdat.be/", what: "The international disaster database: events, deaths, people affected, economic losses by country.", free: "Free with a quick account" },
      { name: "DesInventar Sendai", url: "https://www.desinventar.net/", what: "National/sub-national disaster loss databases, often down to the municipality.", free: "Free" },
      { name: "ReliefWeb", url: "https://reliefweb.int/disasters", what: "UN OCHA situation reports and updates on current and past disasters.", free: "Free" },
      { name: "GDACS", url: "https://www.gdacs.org/", what: "Global Disaster Alert and Coordination System, real-time hazard alerts and impact estimates.", free: "Free" },
      { name: "NASA EONET", url: "https://eonet.gsfc.nasa.gov/", what: "Live natural-event feed (wildfires, storms, volcanoes) with locations.", free: "Free" },
    ],
  },
  {
    category: "Hazard & risk indices",
    blurb: "How exposed and at-risk a place is, ready-made risk scores and hazard maps.",
    sources: [
      { name: "ThinkHazard! (GFDRR)", url: "https://thinkhazard.org/", what: "Type a city and get its hazard levels (flood, quake, cyclone, wildfire, heat, and more) in plain language.", free: "Free" },
      { name: "INFORM Risk Index", url: "https://drmkc.jrc.ec.europa.eu/inform-index", what: "Country risk scores across hazards, vulnerability and coping capacity.", free: "Free" },
      { name: "UNDRR Risk Data Library", url: "https://riskdatalibrary.org/data/", what: "Standardized hazard, exposure and risk datasets from many providers.", free: "Free" },
      { name: "PreventionWeb risk data", url: "https://www.preventionweb.net/understanding-disaster-risk/disaster-losses-and-statistics/global-risk-data-sets", what: "UNDRR's curated catalogue of global risk data sets.", free: "Free" },
      { name: "Global Earthquake Model", url: "https://www.globalquakemodel.org/", what: "Seismic hazard and risk maps and tools worldwide.", free: "Free tools" },
    ],
  },
  {
    category: "Climate & weather",
    blurb: "Temperature, rainfall, sea level and future climate projections.",
    sources: [
      { name: "World Bank Climate Portal", url: "https://climateknowledgeportal.worldbank.org/", what: "Historical and projected climate by country and city, clear charts you can cite.", free: "Free" },
      { name: "Copernicus Climate (C3S)", url: "https://climate.copernicus.eu/", what: "European climate reanalysis and projections, very detailed.", free: "Free" },
      { name: "NOAA Climate Data", url: "https://www.ncei.noaa.gov/", what: "Global historical weather and climate records.", free: "Free" },
      { name: "Open-Meteo", url: "https://open-meteo.com/", what: "Free weather and climate API (already used by the analyzer under the hood).", free: "Free" },
    ],
  },
  {
    category: "People, buildings & exposure",
    blurb: "Who and what is in harm's way: population, settlements, infrastructure.",
    sources: [
      { name: "Humanitarian Data Exchange (HDX)", url: "https://data.humdata.org/", what: "Thousands of open datasets by country: population, infrastructure, admin boundaries.", free: "Free" },
      { name: "WorldPop", url: "https://www.worldpop.org/", what: "High-resolution population counts and age/sex breakdowns.", free: "Free" },
      { name: "Global Human Settlement (GHSL)", url: "https://ghsl.jrc.ec.europa.eu/", what: "Built-up area and population grids, great for exposure.", free: "Free" },
      { name: "OpenStreetMap", url: "https://www.openstreetmap.org/", what: "Community map of roads, hospitals, shelters, critical facilities.", free: "Free" },
      { name: "Kontur Population", url: "https://www.kontur.io/portfolio/population-dataset/", what: "Global population density in a clean hex grid.", free: "Free" },
    ],
  },
  {
    category: "Development & socioeconomic",
    blurb: "Poverty, health, economy and governance, useful context for vulnerability.",
    sources: [
      { name: "World Bank Open Data", url: "https://data.worldbank.org/", what: "The go-to for development indicators by country (already used by the analyzer).", free: "Free" },
      { name: "UN Data", url: "https://data.un.org/", what: "Statistics across UN agencies on population, economy and more.", free: "Free" },
      { name: "Our World in Data", url: "https://ourworldindata.org/", what: "Clear, well-sourced charts on almost any global topic.", free: "Free" },
      { name: "WHO Data", url: "https://www.who.int/data", what: "Health systems, mortality and emergency health data.", free: "Free" },
      { name: "OECD Data", url: "https://data.oecd.org/", what: "Rich socioeconomic data for member and partner countries.", free: "Free" },
    ],
  },
  {
    category: "Maps & emergency mapping",
    blurb: "Satellite and rapid-mapping products for events and infrastructure.",
    sources: [
      { name: "Copernicus Emergency Mapping", url: "https://emergency.copernicus.eu/", what: "Rapid satellite maps of floods, fires and other disasters.", free: "Free" },
      { name: "Humanitarian OpenStreetMap", url: "https://www.hotosm.org/", what: "Crowd-mapped data for vulnerable and disaster-affected areas.", free: "Free" },
      { name: "NASA FIRMS", url: "https://firms.modaps.eosdis.nasa.gov/", what: "Near real-time active fire and thermal detections.", free: "Free" },
    ],
  },
];

export default function DataSourcesPage() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");

  const query = q.trim().toLowerCase();
  const groups = useMemo(() => {
    return GROUPS
      .filter((g) => cat === "All" || g.category === cat)
      .map((g) => ({
        ...g,
        sources: g.sources.filter(
          (s) => !query || s.name.toLowerCase().includes(query) || s.what.toLowerCase().includes(query)
        ),
      }))
      .filter((g) => g.sources.length > 0);
  }, [query, cat]);

  const total = GROUPS.reduce((n, g) => n + g.sources.length, 0);

  return (
    <div className="min-h-screen bg-surface text-text-primary">
      {/* Hero */}
      <header className="border-b border-border bg-gradient-to-b from-accent-500/10 to-transparent">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          <a href="/" className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary mb-5 transition-colors">
            <ArrowLeft size={15} /> Back to the analyzer
          </a>
          <div className="flex items-center gap-3 mb-2">
            <span className="grid place-items-center w-11 h-11 rounded-2xl bg-accent-500/20 text-accent-300">
              <Globe2 size={24} />
            </span>
            <h1 className="text-2xl sm:text-3xl font-bold">Find real data, from sources you can trust</h1>
          </div>
          <p className="text-text-secondary max-w-2xl leading-relaxed">
            The best scorecards are backed by real numbers. Here are {total} free, credible places to look, from the UN,
            World Bank, NASA, Copernicus and more. Find something relevant, copy it, and paste it into the copilot on the
            Dashboard or into the Assistant. The AI will fold it in and tell you how it changes the picture.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 text-sm text-accent-300 bg-accent-500/10 border border-accent-500/25 rounded-xl px-3.5 py-2">
            <ClipboardCheck size={16} /> Tip: fact-check the AI, then paste what you find. Real local data beats any guess.
          </div>
        </div>
      </header>

      {/* Controls */}
      <div className="sticky top-0 z-10 bg-surface/90 backdrop-blur-xl border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search sources (e.g. flood, population, climate)…"
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-surface-overlay border border-border text-sm focus:outline-none focus:border-primary-500/50"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["All", ...GROUPS.map((g) => g.category)].map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                  cat === c
                    ? "bg-accent-500 text-white border-accent-500"
                    : "bg-surface-overlay border-border text-text-secondary hover:text-text-primary"
                }`}
              >
                {c === "All" ? "All" : c.split(" ")[0]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Directory */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {groups.length === 0 && (
          <p className="text-center text-text-secondary py-12">No sources match &quot;{q}&quot;. Try a broader word.</p>
        )}
        {groups.map((g) => (
          <section key={g.category}>
            <h2 className="text-lg font-semibold mb-1">{g.category}</h2>
            <p className="text-sm text-text-secondary mb-3">{g.blurb}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {g.sources.map((s) => (
                <a
                  key={s.name}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="lift group block p-4 rounded-xl border border-border bg-surface-raised/60 hover:border-accent-500/50"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-text-primary group-hover:text-accent-300 transition-colors">{s.name}</h3>
                    <ExternalLink size={13} className="text-text-secondary shrink-0" />
                    <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent-500/15 text-accent-300 shrink-0">{s.free}</span>
                  </div>
                  <p className="text-sm text-text-secondary leading-relaxed">{s.what}</p>
                </a>
              ))}
            </div>
          </section>
        ))}
      </main>

      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 text-xs text-text-secondary text-center">
          These are independent third-party sources; always check each one&apos;s own terms and how current its data is.
          When in doubt, prefer official national statistics offices and your city&apos;s own open-data portal.
        </div>
      </footer>
    </div>
  );
}
