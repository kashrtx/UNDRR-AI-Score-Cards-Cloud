/**
 * The web pages, open datasets and attached documents an AI helper was shown
 * while filling a scorecard, each with a short tag ("S3"). Research and search results list
 * the tags next to each source; the helper names the tags its scores rest on,
 * and the Scorecard tab links them. Only tags handed out here resolve, so a
 * link always points at something the helper was actually given.
 */

export interface WebSource {
  title: string;
  /** A web address, or "attachment:<file name>" for a document the user attached. */
  url: string;
}

const ATTACHMENT = "attachment:";
export const isAttachment = (s: WebSource) => s.url.startsWith(ATTACHMENT);

export interface SourceRegistry {
  next: number;
  byTag: Record<string, WebSource>;
}

export const emptyRegistry = (): SourceRegistry => ({ next: 1, byTag: {} });

const MAX_SOURCES_PER_ANSWER = 6;

function normUrl(u: string): string {
  return u.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** The tag for this page (a new one, or the one it already has). */
export function registerSource(reg: SourceRegistry, url: string | undefined, title: string): string | null {
  if (!url || !(/^https?:\/\//i.test(url) || url.startsWith(ATTACHMENT))) return null;
  const key = normUrl(url);
  for (const [tag, s] of Object.entries(reg.byTag)) if (normUrl(s.url) === key) return tag;
  const tag = `S${reg.next++}`;
  reg.byTag[tag] = { title: (title || url).slice(0, 160), url };
  return tag;
}

/** The sources a score names: tags like "S3" / "[S3]", or a URL that was handed out. */
export function resolveSources(reg: SourceRegistry | undefined, refs: unknown): WebSource[] {
  if (!reg || !Array.isArray(refs)) return [];
  const out: WebSource[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (typeof r !== "string") continue;
    const tag = r.trim().replace(/^\[|\]$/g, "").toUpperCase();
    let src: WebSource | undefined = reg.byTag[tag];
    if (!src && /^https?:\/\//i.test(r)) {
      const key = normUrl(r);
      src = Object.values(reg.byTag).find((s) => normUrl(s.url) === key);
    }
    if (src && !seen.has(src.url)) {
      seen.add(src.url);
      out.push(src);
      if (out.length >= MAX_SOURCES_PER_ANSWER) break;
    }
  }
  return out;
}

/** The tag for a document the user attached. */
export function registerAttachment(reg: SourceRegistry, name: string): string {
  return registerSource(reg, `${ATTACHMENT}${name}`, name)!;
}

/** "fema.gov" for https://www.fema.gov/… (the file name for an attachment). */
export function siteName(url: string): string {
  if (url.startsWith(ATTACHMENT)) return url.slice(ATTACHMENT.length);
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
