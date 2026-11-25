/**
 * Read a document in full (server-side) for the Assistant's read_document
 * step: fetch a web page an AI helper was shown, turn it into plain text, and
 * return the passages most relevant to what the helper is looking for. Search
 * snippets are a sentence or two; an official plan or report often answers
 * several scorecard indicators once it's actually read.
 *
 * Safety: only public http(s) addresses (no localhost / private networks, also
 * after redirects), a size cap and a time limit. The client only ever asks for
 * pages the helper was shown (by source tag), never an address it made up.
 *
 * PDFs are read directly with unpdf (PDF.js), page by page, so passages carry
 * page numbers. When a site refuses automated readers (many government sites
 * answer 403), or a PDF has no text layer (a scan) or is over the size cap, and
 * a Tavily key is in use, Tavily's Extract service gets the text instead.
 * Without Tavily, such documents can't be read and the helper is told why.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 4;
const PASSAGE_CHARS = 900;
const MAX_PDF_PAGES = 400;
const MAX_PASSAGES = 8;
const UA =
  "Mozilla/5.0 (compatible; UNDRR-ARISE-Scorecard-Analyzer/1.0; disaster-resilience research tool)";

export interface DocumentPassage {
  /** Page number, for documents that have pages. */
  page?: number;
  text: string;
}

export interface DocumentResult {
  ok: boolean;
  url: string;
  title?: string;
  kind?: "html" | "pdf" | "text";
  pages?: number;
  /** Characters of text in the whole document. */
  totalChars?: number;
  /** The most relevant passages, in document order. */
  passages: DocumentPassage[];
  error?: string;
  /** "Tavily Extract" when the text came through Tavily rather than directly. */
  via?: string;
}

// ── Safety ─────────────────────────────────────────────────
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") ||
    v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

async function assertPublic(u: URL): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only web (http/https) addresses can be read.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error("That address isn't on the public web.");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateAddress)) throw new Error("That address isn't on the public web.");
}

/** Fetch with redirects checked hop by hop, a time limit and a size cap. */
async function fetchPublic(url: string): Promise<{ res: Response; body: Uint8Array; finalUrl: string; truncated: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublic(current);
      const res = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location")!, current);
        continue;
      }
      if (!res.ok) throw new Error(`The site answered ${res.status}.`);
      // Read up to MAX_BYTES.
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { truncated = true; await reader.cancel(); break; }
          chunks.push(value);
        }
      }
      const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let off = 0;
      for (const c of chunks) { body.set(c, off); off += c.byteLength; }
      return { res, body, finalUrl: current.toString(), truncated };
    }
    throw new Error("Too many redirects.");
  } finally {
    clearTimeout(timer);
  }
}

// ── Text ───────────────────────────────────────────────────
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function htmlToText(html: string): { title?: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim() || undefined;
  const main = html.match(/<(main|article)[\s>][\s\S]*?<\/\1>/i)?.[0] ?? html;
  const text = decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
  return { title, text };
}

const STOP = new Set("the a an of in for and to on at by with is are was were be or as from that this it its their city county state plan".split(" "));
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Split into ~PASSAGE_CHARS passages on paragraph/sentence boundaries. */
function chunk(text: string, page?: number): DocumentPassage[] {
  const out: DocumentPassage[] = [];
  let buf = "";
  for (const para of text.split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    if (buf && buf.length + p.length > PASSAGE_CHARS) { out.push({ page, text: buf }); buf = ""; }
    buf = buf ? `${buf} ${p}` : p;
    while (buf.length > PASSAGE_CHARS * 1.5) {
      const cut = buf.lastIndexOf(". ", PASSAGE_CHARS) > PASSAGE_CHARS / 2 ? buf.lastIndexOf(". ", PASSAGE_CHARS) + 1 : PASSAGE_CHARS;
      out.push({ page, text: buf.slice(0, cut).trim() });
      buf = buf.slice(cut).trim();
    }
  }
  if (buf) out.push({ page, text: buf });
  return out;
}

/** The passages that best match the topic (by word overlap), in document order. */
function bestPassages(passages: DocumentPassage[], topic: string): DocumentPassage[] {
  const want = new Set(words(topic));
  if (!want.size) return passages.slice(0, MAX_PASSAGES);
  const scored = passages.map((p, i) => {
    const ws = words(p.text);
    const hits = new Set(ws.filter((w) => want.has(w)));
    let count = 0;
    for (const w of ws) if (want.has(w)) count++;
    return { i, p, score: hits.size * 3 + Math.min(count, 12) };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PASSAGES)
    .sort((a, b) => a.i - b.i)
    .map((s) => ({ ...s.p, text: s.p.text.slice(0, PASSAGE_CHARS + 200) }));
}

/** A PDF's text, page by page (null if it has no text layer, e.g. a scan). */
async function pdfPages(body: Uint8Array): Promise<{ pages: string[]; totalPages: number } | null> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(body);
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = text.slice(0, MAX_PDF_PAGES).map((t) => t.replace(/[ \t]+/g, " ").trim());
    return pages.join("").replace(/\s/g, "").length >= 200 ? { pages, totalPages } : null;
  } finally {
    // Free PDF.js memory (destroy() exists at runtime; unpdf's types omit it).
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
  }
}

/** The page's text via Tavily Extract (for sites that refuse direct reading, and PDFs). */
async function tavilyExtract(url: string, key: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ api_key: key, urls: [url], extract_depth: "advanced" }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const j = (await res.json()) as { results?: Array<{ url?: string; raw_content?: string }> };
    const text = j.results?.[0]?.raw_content?.replace(/\r/g, "").trim();
    return text && text.length >= 200 ? text : null;
  } catch {
    return null;
  }
}

/** A result from text that Tavily extracted. */
function fromExtract(url: string, text: string, topic: string, kind: DocumentResult["kind"], title?: string): DocumentResult {
  const passages = bestPassages(chunk(text), topic);
  return { ok: true, url, kind, title, totalChars: text.length, passages: passages.length ? passages : chunk(text).slice(0, 3), via: "Tavily Extract" };
}

export async function readDocument(url: string, topic: string, tavilyKey?: string): Promise<DocumentResult> {
  const key = tavilyKey?.trim() || process.env.TAVILY_API_KEY;
  try {
    await assertPublic(new URL(url));
  } catch (e) {
    return { ok: false, url, passages: [], error: e instanceof Error ? e.message : String(e) };
  }
  let direct: Awaited<ReturnType<typeof fetchPublic>> | null = null;
  let directError = "";
  try {
    direct = await fetchPublic(url);
  } catch (e) {
    directError = e instanceof Error ? (e.name === "AbortError" ? "The site took too long to answer." : e.message) : String(e);
  }
  // Refused or unreachable: try Tavily Extract.
  if (!direct) {
    const text = key ? await tavilyExtract(url, key) : null;
    if (text) return fromExtract(url, text, topic, /\.pdf(\?|#|$)/i.test(url) ? "pdf" : "html");
    return {
      ok: false, url, passages: [],
      error: `${directError}${/\b40[13]\b|429/.test(directError) ? " The site blocks automated readers." : ""}${key ? " Tavily couldn't read it either." : " With Tavily switched on (Settings, Step 4), the app can read such pages through Tavily."}`,
    };
  }
  try {
    const { res, body, finalUrl, truncated } = direct;
    const type = (res.headers.get("content-type") || "").toLowerCase();
    const isPdf = type.includes("pdf") || (body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46); // "%PDF"
    if (isPdf) {
      // Read it directly, page by page (unless it was cut off at the size cap).
      let why = truncated ? "it is over 15 MB" : "";
      if (!truncated) {
        try {
          const pdf = await pdfPages(body);
          if (pdf) {
            const all = pdf.pages.flatMap((t, i) => chunk(t, i + 1));
            const passages = bestPassages(all, topic);
            return {
              ok: true, url: finalUrl, kind: "pdf", pages: pdf.totalPages,
              totalChars: pdf.pages.reduce((n, t) => n + t.length, 0),
              passages: passages.length ? passages : all.slice(0, 3),
              ...(pdf.totalPages > MAX_PDF_PAGES ? { error: `Only the first ${MAX_PDF_PAGES} of ${pdf.totalPages} pages were read.` } : {}),
            };
          }
          why = "it has no text layer (it looks like a scan)";
        } catch {
          why = "its text couldn't be extracted";
        }
      }
      const text = key ? await tavilyExtract(finalUrl, key) : null;
      if (text) return fromExtract(finalUrl, text, topic, "pdf");
      return {
        ok: false, url: finalUrl, kind: "pdf", passages: [],
        error: `This PDF couldn't be read: ${why}.${key ? " Tavily couldn't extract it either." : " With Tavily switched on (Settings, Step 4), the app can try reading it through Tavily."} Use its search snippet, or look for another version.`,
      };
    }
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(body);
    const isHtml = type.includes("html") || /<html[\s>]|<body[\s>]/i.test(raw.slice(0, 5000));
    const { title, text } = isHtml ? htmlToText(raw) : { title: undefined, text: raw.replace(/\r/g, "") };
    if (text.length < 200) {
      const extracted = key ? await tavilyExtract(finalUrl, key) : null;
      if (extracted) return fromExtract(finalUrl, extracted, topic, "html", title);
      return { ok: false, url: finalUrl, kind: isHtml ? "html" : "text", title, passages: [], error: `The page has almost no readable text: it may need JavaScript, be behind a login, or the site may be showing a bot check instead of the document.${key ? " Tavily couldn't read it either." : " With Tavily switched on (Settings, Step 4), the app can try reading it through Tavily."}` };
    }
    const passages = bestPassages(chunk(text), topic);
    return {
      ok: true, url: finalUrl, kind: isHtml ? "html" : "text", title, totalChars: text.length,
      passages: passages.length ? passages : chunk(text).slice(0, 3),
      ...(truncated ? { error: "Only the first 15 MB were read." } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "The site took too long to answer." : e.message) : String(e);
    return { ok: false, url, passages: [], error: msg };
  }
}
