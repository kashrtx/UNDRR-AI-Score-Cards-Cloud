/**
 * City research (server-side) — credible, keyless factual grounding from
 * Wikipedia + Wikidata. This is the universal research step: it runs for EVERY
 * provider (including local models that can't browse), so the AI checks its
 * picture of the city against a real reference instead of hallucinating or
 * trusting coarse open-data grid artifacts (e.g. a "0 m" island elevation).
 *
 * Runs on the server (no browser CORS limits; a polite User-Agent as Wikimedia
 * asks). Entirely best-effort: any failure returns null and analysis proceeds.
 */

import type { ReferenceFacts } from "@/lib/types";

const UA =
  "UNDRR-ARISE-Scorecard-Analyzer/1.0 (disaster-resilience research tool; +https://vercel.app)";

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const WIKI = "https://en.wikipedia.org/w/api.php";

interface WikiPage {
  title?: string;
  extract?: string;
  pageprops?: { wikibase_item?: string };
  fullurl?: string;
  canonicalurl?: string;
}
interface WikiSearchResp {
  query?: { pages?: Record<string, WikiPage> };
}
interface WikidataResp {
  entities?: Record<
    string,
    { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>> }
  >;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function researchCity(
  city: string,
  country?: string
): Promise<ReferenceFacts | null> {
  const query = [city, country].filter(Boolean).join(", ");

  // 1) Best-matching Wikipedia page → intro extract + Wikidata id + canonical URL.
  let page: WikiPage | undefined;
  try {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrlimit: "1",
      prop: "extracts|pageprops|info",
      inprop: "url",
      exintro: "1",
      explaintext: "1",
      exsentences: "5",
      ppprop: "wikibase_item",
      redirects: "1",
      format: "json",
    });
    const resp = await getJson<WikiSearchResp>(`${WIKI}?${params.toString()}`);
    const pages = resp.query?.pages;
    if (pages) page = Object.values(pages)[0];
  } catch {
    return null; // Wikipedia unreachable → skip research entirely.
  }
  if (!page?.title) return null;

  const pageUrl =
    page.fullurl ||
    page.canonicalurl ||
    `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;

  const facts: ReferenceFacts["facts"] = [];

  // 2) Structured facts from Wikidata (best-effort; the summary alone is useful).
  const qid = page.pageprops?.wikibase_item;
  let wdUrl: string | undefined;
  if (qid) {
    wdUrl = `https://www.wikidata.org/wiki/${qid}`;
    try {
      const wd = await getJson<WikidataResp>(
        `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`
      );
      const claims = wd.entities?.[qid]?.claims ?? {};
      const claim = (p: string) =>
        claims[p]?.[0]?.mainsnak?.datavalue?.value as { amount?: string } | undefined;

      const elev = num(claim("P2044")?.amount); // elevation above sea level (m)
      if (elev != null)
        facts.push({
          label: "Elevation above sea level",
          value: `${elev} m`,
          source: "Wikidata (P2044)",
          url: wdUrl,
        });

      const pop = num(claim("P1082")?.amount); // population
      if (pop != null)
        facts.push({
          label: "Population",
          value: Math.round(pop).toLocaleString(),
          source: "Wikidata (P1082)",
          url: wdUrl,
        });

      const area = num(claim("P2046")?.amount); // area (usually km²)
      if (area != null)
        facts.push({
          label: "Area",
          value: `${area} km²`,
          source: "Wikidata (P2046)",
          url: wdUrl,
        });
    } catch {
      /* Wikidata optional */
    }
  }

  const summary = (page.extract || "").trim();
  if (!summary && facts.length === 0) return null;

  const sources: ReferenceFacts["sources"] = [
    { name: `Wikipedia — ${page.title}`, url: pageUrl },
  ];
  if (wdUrl) sources.push({ name: "Wikidata", url: wdUrl });

  return { title: page.title, summary: summary.slice(0, 1200), facts, sources };
}
