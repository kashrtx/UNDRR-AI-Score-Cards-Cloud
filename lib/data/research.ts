/**
 * City research (server-side RAG) — retrieves real, citable evidence and feeds
 * it to the model as cross-checked CONTEXT (never single-source "verified"
 * numbers).
 *
 * KEYLESS BY DEFAULT — works on Vercel with zero setup:
 *   1. Wikipedia: a multi-article search + full-article geography/hazard/climate
 *      extraction (bot-friendly, reliable from serverless). This is the core.
 *   2. Wikidata: population & area only (elevation is deliberately NOT surfaced —
 *      it's unreliable per-entity and produced a bogus figure before).
 *   3. DuckDuckGo (keyless, best-effort): a little general-web coverage. May be
 *      rate-limited/blocked from datacenter IPs, so it degrades silently.
 *
 * OPTIONAL UPGRADES (no per-query hassle, still no code changes):
 *   • SEARXNG_URL env  → query your own/self-hosted SearXNG JSON API (open source)
 *   • TAVILY_API_KEY env (or a key passed from Settings) → managed RAG search
 *
 * Everything is best-effort: any failure is skipped and analysis proceeds.
 */

import type { ReferenceFacts } from "@/lib/types";

const UA =
  "UNDRR-ARISE-Scorecard-Analyzer/1.0 (disaster-resilience research tool; +https://vercel.app)";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function req(url: string, init?: RequestInit, timeoutMs = 9000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 9000): Promise<T> {
  const res = await req(
    url,
    { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init?.headers || {}) } },
    timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function trunc(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Keywords that make a Wikipedia paragraph worth feeding to the model.
const GEO_KW =
  /\b(elevation|sea[- ]level|metres?|meters?|altitude|highest point|low[- ]lying|coast|geograph|terrain|climate|rainfall|precipitation|monsoon|cyclone|storm|flood|tsunami|earthquake|hazard|lagoon|reef|population)\b/i;

// ── Wikipedia + Wikidata (keyless, reliable) ─────────────────
const WIKI = "https://en.wikipedia.org/w/api.php";

async function wikiSearchTitles(query: string): Promise<string[]> {
  try {
    const params = new URLSearchParams({
      action: "query", list: "search", srsearch: query, srlimit: "3",
      srprop: "", format: "json",
    });
    const r = await getJson<{ query?: { search?: Array<{ title: string }> } }>(`${WIKI}?${params}`);
    return (r.query?.search ?? []).map((x) => x.title).filter(Boolean);
  } catch {
    return [];
  }
}

async function wikiArticle(title: string): Promise<{
  title: string; url: string; qid?: string; intro: string; geo: string;
} | null> {
  try {
    const params = new URLSearchParams({
      action: "query", prop: "extracts|pageprops|info", titles: title,
      explaintext: "1", inprop: "url", ppprop: "wikibase_item", redirects: "1", format: "json",
    });
    const r = await getJson<{
      query?: { pages?: Record<string, {
        title?: string; extract?: string; fullurl?: string; canonicalurl?: string;
        pageprops?: { wikibase_item?: string };
      }> };
    }>(`${WIKI}?${params}`);
    const page = Object.values(r.query?.pages ?? {})[0];
    if (!page?.title || !page.extract) return null;

    const url = page.fullurl || page.canonicalurl ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;

    // Split full plaintext into paragraphs; keep the intro + best geo/hazard paras.
    const paras = page.extract
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 50 && !/^=+.*=+$/.test(p));
    const intro = paras.slice(0, 2).join(" ");
    const scored = paras
      .slice(2)
      .map((p) => ({ p, score: (p.match(GEO_KW) || []).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.p);

    return {
      title: page.title,
      url,
      qid: page.pageprops?.wikibase_item,
      intro: trunc(intro, 900),
      geo: trunc(scored.join(" "), 1100),
    };
  } catch {
    return null;
  }
}

type WdStatement = {
  rank?: string;
  mainsnak?: { datavalue?: { value?: { amount?: string } } };
  qualifiers?: { P585?: Array<{ datavalue?: { value?: { time?: string } } }> };
};

/**
 * Choose the *current* numeric value from a Wikidata property's statements.
 * Wikidata keeps historical values (e.g. Toronto's population back to the
 * 1800s), so taking the first one is wrong. We drop deprecated statements,
 * prefer "preferred" rank, then pick the latest point-in-time (P585), and only
 * fall back to the largest value if nothing is dated.
 */
function pickCurrentAmount(statements?: WdStatement[]): number | null {
  const live = (statements ?? []).filter(
    (s) => s.rank !== "deprecated" && s.mainsnak?.datavalue?.value?.amount != null
  );
  if (!live.length) return null;
  const preferred = live.filter((s) => s.rank === "preferred");
  const pool = preferred.length ? preferred : live;
  const yearOf = (s: WdStatement) => {
    const t = s.qualifiers?.P585?.[0]?.datavalue?.value?.time;
    const m = t?.match(/([+-]?\d{4})/);
    return m ? parseInt(m[1], 10) : -Infinity;
  };
  const dated = pool.filter((s) => yearOf(s) !== -Infinity);
  if (dated.length) {
    dated.sort((a, b) => yearOf(b) - yearOf(a));
    return num(dated[0].mainsnak!.datavalue!.value!.amount);
  }
  // No dates: take the largest (best proxy for the most recent for a city).
  const amounts = pool.map((s) => num(s.mainsnak!.datavalue!.value!.amount)!).filter((n) => n != null);
  return amounts.length ? Math.max(...amounts) : null;
}

async function wikidataFacts(qid: string, facts: ReferenceFacts["facts"], sources: ReferenceFacts["sources"]) {
  const wdUrl = `https://www.wikidata.org/wiki/${qid}`;
  try {
    const wd = await getJson<{
      entities?: Record<string, { claims?: Record<string, WdStatement[]> }>;
    }>(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
    const claims = wd.entities?.[qid]?.claims ?? {};
    const pop = pickCurrentAmount(claims["P1082"]);
    if (pop != null && pop > 0) facts.push({ label: "Population", value: Math.round(pop).toLocaleString(), source: "Wikidata", url: wdUrl });
    const area = pickCurrentAmount(claims["P2046"]);
    if (area != null && area > 0) facts.push({ label: "Area", value: `${area} km²`, source: "Wikidata", url: wdUrl });
    if (pop != null || area != null) sources.push({ name: "Wikidata", url: wdUrl });
  } catch {
    /* optional */
  }
}

// ── Keyless general web search: DuckDuckGo (best-effort) ─────
function decodeDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith("//") ? "https:" + href : href;
}

async function duckduckgo(query: string): Promise<Array<{ title: string; url: string; content: string }>> {
  try {
    const res = await req(
      "https://lite.duckduckgo.com/lite/",
      {
        method: "POST",
        headers: {
          "user-agent": BROWSER_UA,
          "content-type": "application/x-www-form-urlencoded",
          "accept-language": "en-US,en;q=0.9",
        },
        body: `q=${encodeURIComponent(query)}`,
      },
      10000
    );
    if (!res.ok) return [];
    const html = await res.text();
    const links = [...html.matchAll(/<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gis)];
    const snips = [...html.matchAll(/<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/gis)].map((m) =>
      trunc(stripHtml(m[1]), 320)
    );
    const out: Array<{ title: string; url: string; content: string }> = [];
    for (let i = 0; i < links.length && out.length < 4; i++) {
      const url = decodeDdgHref(links[i][1]);
      const title = trunc(stripHtml(links[i][2]), 140);
      if (!/^https?:\/\//.test(url)) continue;
      out.push({ title: title || url, url, content: snips[i] || "" });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Optional SearXNG (open source, keyless) ──────────────────
async function searxng(baseUrl: string, query: string): Promise<Array<{ title: string; url: string; content: string }>> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
    const r = await getJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
      url, { headers: { "user-agent": BROWSER_UA } }, 12000
    );
    return (r.results ?? [])
      .filter((x) => x.url)
      .slice(0, 4)
      .map((x) => ({ title: x.title || x.url!, url: x.url!, content: trunc(x.content || "", 400) }));
  } catch {
    return [];
  }
}

// ── Optional Tavily (managed, keyed) ─────────────────────────
async function tavily(key: string, query: string): Promise<{ answer?: string; results: Array<{ title: string; url: string; content: string }> }> {
  const data = await getJson<{ answer?: string; results?: Array<{ title?: string; url?: string; content?: string }> }>(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, query, search_depth: "advanced", include_answer: "advanced", max_results: 5 }),
    },
    12000
  );
  return {
    answer: data.answer,
    results: (data.results ?? []).filter((r) => r.url && r.content).map((r) => ({
      title: r.title || r.url!, url: r.url!, content: r.content!,
    })),
  };
}

export async function researchCity(
  city: string,
  country?: string,
  searchApiKey?: string
): Promise<ReferenceFacts | null> {
  const query = [city, country].filter(Boolean).join(", ");
  const passages: ReferenceFacts["passages"] = [];
  const facts: ReferenceFacts["facts"] = [];
  const sources: ReferenceFacts["sources"] = [];
  let answer: string | undefined;
  let title = city;
  let summary = "";

  // 1) Wikipedia (keyless core): top articles + full-article geo extraction.
  const titles = await wikiSearchTitles(query);
  const primary = titles[0] ? await wikiArticle(titles[0]) : null;
  if (primary) {
    title = primary.title;
    summary = primary.intro;
    if (primary.intro) passages.push({ source: `Wikipedia — ${primary.title}`, url: primary.url, text: primary.intro });
    if (primary.geo) passages.push({ source: `Wikipedia — ${primary.title} (geography & hazards)`, url: primary.url, text: primary.geo });
    sources.push({ name: `Wikipedia — ${primary.title}`, url: primary.url });
    if (primary.qid) await wikidataFacts(primary.qid, facts, sources);
  }
  // Pull one more related article's intro (e.g. "Geography of <country>").
  for (const t of titles.slice(1, 2)) {
    const a = await wikiArticle(t);
    if (a?.intro) {
      passages.push({ source: `Wikipedia — ${a.title}`, url: a.url, text: a.intro });
      sources.push({ name: `Wikipedia — ${a.title}`, url: a.url });
    }
  }

  // 2) General WEB SEARCH across several angles, so the model gets a rounded
  //    picture: location & climate, hazards & disaster history, recent
  //    initiatives & successes, and current challenges. Exactly ONE provider
  //    runs (Tavily → SearXNG → env Tavily → DuckDuckGo); Wikipedia above
  //    always runs too.
  const topics = [
    `${query} geography climate weather patterns rainfall sea level`,
    `${query} natural disasters flooding storms cyclone tsunami history`,
    `${query} climate resilience adaptation project initiative recent success`,
    `${query} current challenges infrastructure water waste problems`,
  ];
  const userKey = searchApiKey && searchApiKey.trim();
  const envKey = process.env.TAVILY_API_KEY;
  const searxUrl = process.env.SEARXNG_URL;

  const merge = (batches: Array<{ title: string; url: string; content: string }>[]) => {
    const seen = new Set<string>();
    const out: Array<{ title: string; url: string; content: string }> = [];
    for (const batch of batches) {
      for (const r of batch) {
        if (!r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
      }
    }
    return out;
  };

  let web: Array<{ title: string; url: string; content: string }> = [];
  let webSearchMethod: string | undefined;
  try {
    if (userKey || (!searxUrl && envKey)) {
      const key = (userKey || envKey) as string;
      webSearchMethod = "Tavily";
      const settled = await Promise.allSettled(topics.map((q) => tavily(key, q)));
      const ok = settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof tavily>>>).value);
      answer = ok.find((r) => r.answer)?.answer;
      if (answer) answer = trunc(answer, 1200);
      web = merge(ok.map((r) => r.results));
    } else if (searxUrl) {
      webSearchMethod = "SearXNG";
      const settled = await Promise.allSettled(topics.slice(0, 3).map((q) => searxng(searxUrl, q)));
      web = merge(settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<Array<{ title: string; url: string; content: string }>>).value));
    } else {
      webSearchMethod = "DuckDuckGo";
      const settled = await Promise.allSettled(topics.slice(0, 2).map((q) => duckduckgo(q)));
      web = merge(settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<Array<{ title: string; url: string; content: string }>>).value));
    }
  } catch {
    web = [];
  }
  for (const r of web.slice(0, 8)) {
    if (r.content || r.title) {
      passages.push({ source: r.title, url: r.url, text: r.content || r.title });
      sources.push({ name: r.title, url: r.url });
    }
  }

  if (!answer && passages.length === 0 && facts.length === 0) return null;
  return { title, summary, answer, passages, facts, sources, webSearchMethod };
}
