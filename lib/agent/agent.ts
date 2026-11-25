/**
 * The fill-out agent.
 *
 * It helps a city complete the UNDRR ARISE Preliminary scorecard, either
 * autonomously ("fill it out for my city") or as a step-by-step chat. Because
 * our LLM providers expose a plain text `complete()` (not a provider-specific
 * function-calling API), the agent uses a simple, universal protocol: each turn
 * the model replies with ONE JSON action, we run it, feed back the result, and
 * loop. This works identically across Gemini, Claude, GLM, Llama, GPT, etc.
 *
 * Actions: research_city, web_search, set_scores, message (ask/tell the user and
 * wait), finish (all done).
 */

import type { LLMProvider } from "@/lib/llm";
import type { LLMUsage } from "@/lib/llm/types";
import { registerSource, registerAttachment, resolveSources, siteName, type SourceRegistry } from "./sources";
import { PRELIMINARY_INDICATORS, TOTAL_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";
import { ESSENTIAL_NAMES } from "@/lib/scorecard/schema";
import { dataSourcesPrompt, citedSources } from "@/lib/data/catalog";
import { applyScores, applyInfo, parseBasis, blankReason, filledCount, blankCount, resolvedCount, unfilledCodes, normalizeScoreUpdates, resolveCode, scoreProblem, type Draft, type CityInfo } from "./draft";
import { AREA_SPECIFIC_CODES } from "@/lib/geo/indicatorScope";
import { describeArea, ringBbox, simplifyRing, type AreaSelection } from "@/lib/geo/area";

export type TranscriptItem =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string };

export type AgentEvent =
  | { type: "thinking"; on: boolean }
  | { type: "stream"; text: string }
  | { type: "thought"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; label: string; detail?: string }
  | { type: "draft" }
  | { type: "info" }
  | { type: "done" }
  | { type: "stopped" }
  | { type: "error"; text: string; canContinue?: boolean }
  /** One model request finished: its tokens (and exact cost, where reported). */
  | { type: "usage"; usage: LLMUsage }
  /** The model that answered (first request of a run, then whenever it changes). */
  | { type: "model"; model: string; requested: string; reported: boolean };

export interface AgentContext {
  provider: LLMProvider;
  /** Optional data sources picked in Settings (lib/data/catalog.ts ids). */
  dataSources?: string[];
  /** The model the last request was answered by (set by the agent). */
  answeredBy?: string;
  transcript: TranscriptItem[];
  draft: Draft;
  info: CityInfo; // the City Information page (name, country + profile fields), mutated by set_info
  searchKey?: string | null;
  city?: string;
  country?: string;
  /** State/province, when the country has them (e.g. "Missouri" for Springfield). */
  region?: string;
  attachments?: Array<{ name: string; text: string }>;
  mode?: "autonomous" | "assist";
  drainInput?: () => string | null; // pull a queued user message (for mid-run steering)
  /** Set when the user drew (or loaded) an area instead of scoring a whole city. */
  area?: AreaSelection | null;
  /** Name of the Shapefile generated for that area (what the user can download). */
  areaFile?: string | null;
  /** Tagged sources ("S3") shown in research/search results, so scores can cite them. */
  sources?: SourceRegistry;
  /** Tags of the pages the provider's own web search used in the latest step. */
  lastCitations?: string[];
  /** Settings: may the AI make an educated guess where nothing supports an answer? */
  allowGuesses?: boolean;
  /** The county the place lies in, once research has found it (for county-level searches). */
  county?: string;
  /** Essentials whose guesses/blanks were already sent back for a search ("look before guessing"). */
  lookAsked?: Set<number>;
}

// A chat request stops after MAX_STEPS. A full fill ("Fill it out for me") takes
// more steps than that, so it keeps going as long as it is making progress (new
// scores or City Information) and only pauses after STALL_STEPS steps without
// any, or at the hard cap.
const MAX_STEPS = 16;
const AUTONOMOUS_MAX_STEPS = 80;
const STALL_STEPS = 12;
const STEP_PACING_MS = 700; // small gap between steps to ease free-tier rate limits
// During a full fill, research/search steps in a row without a new score before
// further research is refused and the model is told to score with what it has.
const RESEARCH_BUDGET = 6;
// Earlier lookups that may be re-read in a row before the run pauses as stuck
// (generous, since re-filling a cleared scorecard reuses many of them).
const REUSE_LIMIT = 12;
// The prompt keeps the task plus this many recent transcript entries.
const MAX_HISTORY = 24;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function isRateLimit(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b429\b|quota|rate.?limit|resource_exhausted|too many requests|overloaded|\b503\b/.test(m);
}

/**
 * The key's own spending limit, or the account's credit, is used up (e.g.
 * OpenRouter's "Key limit exceeded"): retrying can't work until it's raised.
 */
function isSpendingCap(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /key limit exceeded|insufficient (credits|balance|funds)|credit limit|spend(ing)? limit|\b402\b/.test(m);
}

/** A daily cap (e.g. OpenRouter's free-models-per-day): waiting a minute won't help. */
function isDailyCap(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /per.?day|daily/.test(m) && isRateLimit(err);
}

/** Worth retrying after a pause: rate limits, and busy free models that send back nothing. */
function isTransient(err: unknown): boolean {
  if (isDailyCap(err) || isSpendingCap(err)) return false;
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return isRateLimit(err) || /no answer text|busy|\b50[24]\b|timed? ?out|fetch failed|network/.test(m);
}

/**
 * Call the model, riding out the rate limits that free tiers (e.g. Gemini)
 * throw when the agent makes several quick calls. Waits and retries on 429-style
 * errors; other errors bubble up immediately.
 */
async function completeWithRetry(
  ctx: AgentContext,
  user: string,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal
): Promise<string> {
  // Long enough to ride out a per-minute limit (OpenRouter's free models: 20 a minute).
  const waits = [5000, 15000, 30000, 60000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    let usage: LLMUsage | null = null;
    let reported: string | null = null;
    const cited = new Set<string>();
    const handlers = {
      onToken: (t: string) => onEvent({ type: "stream", text: t }),
      onUsage: (u: LLMUsage) => { usage = u; },
      // Pages the provider's own web search used: tag them so they can be linked.
      onCitations: (pages: Array<{ title: string; url: string }>) => {
        if (!ctx.sources) return;
        for (const p of pages) {
          const tag = registerSource(ctx.sources, p.url, p.title);
          if (tag) cited.add(tag);
        }
      },
      onModel: (m: string) => { reported = m; },
    };
    try {
      const out = await ctx.provider.complete(SYSTEM, user, handlers, signal);
      ctx.lastCitations = [...cited];
      onEvent({ type: "usage", usage: usage ?? { inputTokens: 0, outputTokens: 0, unreported: true } });
      const model: string = reported ?? ctx.provider.model;
      if (model !== ctx.answeredBy) {
        ctx.answeredBy = model;
        onEvent({ type: "model", model, requested: ctx.provider.model, reported: reported !== null });
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
      if (!isTransient(e) || attempt === waits.length) throw e;
      const s = Math.round(waits[attempt] / 1000);
      onEvent({ type: "tool", label: isRateLimit(e) ? `Model is rate-limited, waiting ${s}s and retrying…` : `Model is busy, waiting ${s}s and retrying…` });
      onEvent({ type: "thinking", on: false });
      await sleep(waits[attempt], signal);
      onEvent({ type: "thinking", on: true });
    }
  }
  throw lastErr;
}

// ── System prompt ────────────────────────────────────────────
function indicatorList(): string {
  const byE = new Map<number, string[]>();
  for (const ind of PRELIMINARY_INDICATORS) {
    if (!byE.has(ind.essential)) byE.set(ind.essential, []);
    byE.get(ind.essential)!.push(`  ${ind.code}: ${ind.text}`);
  }
  const parts: string[] = [];
  for (let e = 1; e <= 10; e++) {
    parts.push(`E${e}, ${ESSENTIAL_NAMES[e]}`);
    parts.push((byE.get(e) || []).join("\n"));
  }
  return parts.join("\n");
}

const SYSTEM = `You are a careful, friendly assistant that helps a city official complete the UNDRR ARISE "Disaster Resilience Scorecard for Cities" (Preliminary version). The scorecard has two parts you can fill:
  1. A CITY INFORMATION page (basic facts about the city).
  2. ${TOTAL_INDICATORS} scored indicators grouped under the Ten Essentials, each scored 0 to 3.

You are like a person with the real scorecard file open, filling it in as you go. Fill BOTH the City Information page and the indicators.

CITY INFORMATION FIELDS you can record with set_info:
  typeOfCity (e.g. "Municipality"), authorityTitle (e.g. "Mayor"), population (number),
  areaKm2 (number), density (per km², number), youthPct, seniorPct, femaleHeadedPct,
  literacyPct, povertyPct, incomeUsd (average household income), nonCitizenPct,
  hazards (list of the main hazards), mostLikelyHazard (the single most likely known hazard),
  mostSevere (the most severe disaster known, a short phrase).
  On a full fill, actively try to complete this profile: the demographic figures
  (population, youth %, senior %, literacy %, poverty %, average household income)
  are usually published in national census / city-statistics data, so look them
  up with web_search or research_city rather than skipping them. You do NOT need
  to send density, it is computed for you from population and area. For any
  single field you genuinely cannot find, leave it out; NEVER invent a number.

SCORING RUBRIC (0-3):
  0 = No / none / not in place at all.
  1 = Limited or ad hoc; early efforts only; major gaps.
  2 = Substantial but incomplete; in place with notable gaps.
  3 = Comprehensive; fully in place, resourced, and reviewed.

THE INDICATORS:
${indicatorList()}

HOW YOU WORK:
- You reply with EXACTLY ONE JSON object per turn and NOTHING else. No prose outside the JSON, no markdown fences.
- ALWAYS include a short "thought" field (one plain sentence) saying what you are doing and why, so the user can follow along.
- Choose the single best next action:
  {"thought":"...","action":"research_city","city":"<name>","country":"<name>"} , gather open data + web facts about the city (climate, hazards, infrastructure, population). Do this once early when you know the city.
  {"thought":"...","action":"web_search","query":"<query>"} , look up a specific fact (e.g. "Toronto emergency management office budget", "Toronto early warning system"). Use this for anything time-sensitive or current (recent hazards, ongoing wildfire/flood/air-quality alerts, latest plans) so your scoring reflects the situation now, not just older knowledge. Anything a search returns is added to our shared context, so prefer searching over relying on memory when unsure.
  {"thought":"...","action":"read_document","source":"S7","topic":"<what you need from it, e.g. early warning and evacuation>"} , read a tagged web page in full (e.g. a county hazard mitigation plan, a city general plan or an emergency management page) and get its passages most relevant to the topic. Use it on official plans and reports (web pages and PDFs) that likely answer several indicators: far better than judging from a search snippet. PDF passages come with page numbers; mention the page in your note.
  {"thought":"...","action":"set_info","profile":{"population":134000,"areaKm2":385,"mostLikelyHazard":"Earthquake","mostSevere":"2010 M7.0 earthquake","hazards":["Earthquake","Flooding","Hurricane"]}} , record City Information fields you have learned. Send only the fields you know.
  {"thought":"...","action":"set_scores","scores":[{"code":"P1.1","score":2,"note":"<one short sentence on the basis>","sources":["S3"]}, {"code":"P1.2","score":2,"note":"...","sources":[],"basis":"general"}, {"code":"P1.3","score":null,"blank":"<what you looked for, and why nothing covers it>"}, ...]} , fill one or more indicators. Include a note for EVERY indicator you score, and either the tags of the results it rests on in "sources" or a "basis". Where nothing supports a score, follow the EDUCATED GUESSES rule in the task.
  {"thought":"...","action":"message","text":"<what you want to say or ask the user>"} , talk to the user and WAIT for their reply. Use this to ask for information only the city would know, or when the city name is missing.
  {"thought":"...","action":"finish","text":"<friendly wrap-up>"} , only when the City Information you could find is recorded AND all ${TOTAL_INDICATORS} indicators have a score.

RULES:
- You need to know the target city. If no city has been provided, your FIRST action must be a "message" asking which city this scorecard is for. Do not guess a city.
- After researching, record what you learned about the city with set_info BEFORE or ALONGSIDE scoring, do not skip the City Information page. If the user ever asks about "the info page" or "city info", they mean this; use set_info.
- SCOPE: If the user asks for help with only specific indicators or a limited change ("help me with P3.2", "review Essential 5", "what about early warning?"), do ONLY that and then finish or ask a follow-up. Do NOT fill or re-score everything. Only complete the whole scorecard when the user clearly asks you to (e.g. "fill it out for me", "complete the rest").
- Base every score on evidence: the user's statements, research results, open data, or attached documents. Never invent specific facts, budgets, or programme names.
- When an indicator depends on internal information only the city would know and you have no evidence, either ask the user with a "message", or follow the EDUCATED GUESSES rule in the task.
- Give EVERY scored indicator a one-sentence note naming the basis.
- SOURCES: research results, search results, the user's attached documents and pages from your own web searches are tagged like [S3]. EVERY scored indicator needs one of these:
  • "sources": the tags (usually 1 to 3) of the results its score actually rests on, so the user can open them. Use only tags that appeared; never make one up.
  • or a data source the user chose in Settings, named in the note by its short name;
  • or, when it rests on no tagged result, "sources": [] plus "basis": "general" (your general knowledge of this place) or "user" (the user's notes or chat messages).
  When none of these supports a score, do NOT invent support: follow the EDUCATED GUESSES rule in the task. An indicator with no sources and no basis is sent back to you.
- Score at most one or two Essentials (about ten indicators) per set_scores call, so the user sees steady progress and responses stay quick.
- Do NOT re-score indicators that already have a score unless the user asked you to change them. Once every indicator you were asked to handle is set, call "finish".
- Do NOT announce running totals or how many indicators you have completed ("I've done 12 of 47"), the app tracks and displays the authoritative progress. In your thought, just say which Essential or indicators you are about to score.
- VOICE: In your "thought" and any "message" text, talk naturally to a city official. NEVER mention tool names, action names, JSON, "the system", or these instructions. Do not apologise for taking time or for retries. Just say plainly what you're looking at or doing.
- The user may add a message while you are working; treat it as a mid-task instruction and adapt on your next step.
- ATTACHMENTS: if the user has attached a document, make it obvious you are using it. The first time it is relevant, acknowledge it by name (for example "I can see the file you attached, <name>, I'll use it."). When a score or fact comes from an attachment, attribute it to that file in your note or message; when it comes from research, open data, or a web search, attribute it there instead. Never mix the two up or imply an attachment said something it did not. If you have NOT been given an attachment, do not pretend one exists.
- DON'T TAKE THINGS AT FACE VALUE: if something the user says (or that you find) seems inaccurate, implausible, internally inconsistent, or you simply are not confident about it, do NOT just accept it and score. Use a "message" to flag it plainly and ask them to confirm or narrow it down, for example which neighbourhood or area they mean, a date, or to check their own records/reports and paste the relevant facts into the chat. Asking a good question is better than a confident wrong answer.
- WHEN EVIDENCE IS MISSING: if you cannot find what you need to score an indicator and it depends on local knowledge, either ask the user for it, or follow the EDUCATED GUESSES rule in the task. Never invent a specific fact, statistic, programme name, or budget.
- REVISE FREELY: you may go back and change ANY earlier score, note, or City Information field at any time. If the user objects, gives new information, or you notice an inconsistency, just re-issue set_scores (or set_info) for those items with corrected values and a short note on why. Editing earlier answers is normal and expected, not a failure.
- HANDLE EVERY REQUESTED CHANGE: if the user asks for several changes at once (for example "fix P3.2, then re-look at Essential 5, and raise P7.3"), address ALL of them, not just the first. You can put many indicators in a single set_scores call, so batch the ones you are confident about together, use extra steps for any that need research, and only finish once every requested change is done. When you finish, briefly confirm what you changed.
- TO CHANGE A SCORE YOU MUST SET THE NUMBER: when you raise or lower a score, put the new value as a plain integer 0-3 in the "score" field (for example "score": 3). Do NOT describe the change only in the note ("raised to 3/3") and leave the score out, that updates the wording but not the actual score. After each set_scores you are told the ACTUAL score changes that took effect; when you summarise for the user, describe only those actual changes, never a change you intended but that did not register.
- NEVER GET STUCK: do not repeat the same action or the same question hoping for a different result. If a search or approach fails twice, say so plainly and either try a clearly different approach or ask the user how they'd like to proceed. If you are uncertain after one round of clarification, follow the EDUCATED GUESSES rule in the task and move on rather than looping.
- PLAN FIRST (autonomous runs): on your very first step of a full fill, make the "thought" a short plan in plain words (for example: "My plan: look up the city, fill in the basic City Information, then work through the Ten Essentials one by one.") and pair it with your first real action (usually research_city) in the SAME step, do not waste a turn. For small targeted requests, skip the plan and just do the task.
- SMALL PLACES AND COUNTY/STATE PLANS: many cities, especially small ones, are covered by county, regional or state plans (hazard mitigation plans, emergency management, early warning, building codes) instead of their own. Research names the county and state ("Covering jurisdictions"). When the city has nothing of its own for an indicator, look for and use the county or state plan that covers it, cite it, and say in the note that it is county- or state-level (e.g. "Gila County's multi-jurisdictional hazard mitigation plan, which covers Globe").
- LOOK BEFORE GUESSING: before giving an educated guess or leaving an indicator blank, run at least one web_search aimed at that indicator's topic (try the county or state as well as the city), or read_document an official plan with that topic. A guess or blank for an Essential you have not searched yet is sent back with a suggested search.
- Be efficient: research once, then fill. Do not repeat the same search or re-submit the same scores.`;

/**
 * Words that show a web search was aimed at an Essential's topic, and a search
 * to suggest when it wasn't ("look before guessing").
 */
const ESSENTIAL_SEARCH: Record<number, { words: RegExp; suggest: string }> = {
  1: { words: /governance|coordinat|resilience strateg|resilience plan|sendai|emergency management|disaster (risk )?(plan|office|commission)|organi[sz]/i, suggest: "disaster risk reduction plan emergency management coordination" },
  2: { words: /hazard|risk assessment|risk map|vulnerab|scenario|flood (map|zone)|mitigation plan|exposure/i, suggest: "hazard mitigation plan risk assessment" },
  3: { words: /budget|fund|financ|insurance|grant|capital (plan|improvement)|incentive/i, suggest: "budget disaster resilience funding grants" },
  4: { words: /land use|zoning|building code|general plan|urban plan|development code|construction standard/i, suggest: "building code zoning land use plan" },
  5: { words: /ecosystem|watershed|wetland|green infrastructure|forest|natural (buffer|area)|conservation|riparian/i, suggest: "watershed ecosystem green infrastructure" },
  6: { words: /capacity|training|staff|skills|data shar|institution|emergency manag(er|ement) (office|staff)|exercise/i, suggest: "emergency management staff training exercises" },
  7: { words: /communit|volunteer|ngo|nonprofit|preparedness|public education|awareness|outreach|cert\b|neighbo/i, suggest: "community preparedness volunteers public education" },
  8: { words: /infrastructure|utilit|water system|power|electric|road|bridge|hospital|school|critical facilit|dam|levee|drainage/i, suggest: "critical infrastructure water power resilience" },
  9: { words: /early warning|alert|response|evacuat|shelter|emergency operations|dispatch|911|first responder|fire department/i, suggest: "early warning alerts evacuation emergency response" },
  10: { words: /recover|reconstruct|build back|post-disaster|continuity|rebuild/i, suggest: "disaster recovery plan rebuilding" },
};

/** The Essentials the web searches so far in this conversation were aimed at. */
function searchedEssentials(transcript: TranscriptItem[]): Set<number> {
  const out = new Set<number>();
  for (const t of transcript) {
    if (t.role !== "tool") continue;
    const head = /^(web_search|read_document)\(([\s\S]*?)\):/.exec(t.content);
    if (!head) continue;
    const q = head[2];
    for (const [e, v] of Object.entries(ESSENTIAL_SEARCH)) if (v.words.test(q)) out.add(Number(e));
  }
  return out;
}

/** How a read is named in the transcript: "S7: early warning and evacuation". */
function readLabel(source: string | undefined, topic: string | undefined): string {
  const tag = (source || "?").trim().replace(/^\[|\]$/g, "").toUpperCase();
  return `${tag}: ${(topic || "").trim() || "general"}`;
}

/**
 * A nudge after research/search: the tagged results that look like official
 * documents worth reading in full (plans, reports, codes, PDFs; government sites).
 */
function readingHint(text: string, reg: SourceRegistry | undefined, canReadPdf = true): string {
  if (!reg) return "";
  const tags = [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]))];
  const docs = tags
    .map((t) => [t, reg.byTag[t]] as const)
    .filter(([, s]) => s && /^https?:/i.test(s.url) && (canReadPdf || !/\.pdf(\?|#|$)/i.test(s.url)))
    .filter(([, s]) => /plan|report|strateg|ordinance|code|assessment|mitigation|emergency|resilien|preparedness/i.test(s.title) || /\.(gov|us|int)(\/|$)|\.gov\.|\.mil(\/|$)|undrr|preventionweb/i.test(s.url))
    .slice(0, 3);
  return docs.length
    ? `\nWorth reading in full with read_document (official documents): ${docs.map(([t, s]) => `[${t}] ${squash(s.title, 70)}`).join("; ")}.`
    : "";
}

/** read_document: fetch the page and return its most relevant passages, tagged. */
async function documentTool(url: string, topic: string, tag: string, searchKey?: string | null): Promise<string> {
  try {
    const res = await fetch("/api/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, topic, searchApiKey: searchKey || undefined }),
    });
    const d = (await res.json()) as { ok: boolean; title?: string; totalChars?: number; passages?: Array<{ page?: number; text: string }>; error?: string; via?: string };
    if (!d.ok || !d.passages?.length) return `Couldn't read [${tag}]: ${d.error || "no readable text"}. Use its search snippet, or search for another version.`;
    const head = `[${tag}] ${d.title ? squash(d.title, 90) : siteName(url)} (${siteName(url)}${d.totalChars ? `, ${Math.round(d.totalChars / 1000)}k characters` : ""}). Passages most relevant to "${topic || "general"}":`;
    return [head, ...d.passages.map((p) => `- [${tag}]${p.page ? ` (p. ${p.page})` : ""} ${p.text.replace(/\s+/g, " ").slice(0, 1000)}`)].join("\n") +
      (d.error ? `\n(${d.error})` : "") +
      `\nCite this as "${tag}" in the sources of any score it supports.`;
  } catch (e) {
    return `Couldn't read [${tag}]: ${e instanceof Error ? e.message : String(e)}.`;
  }
}

/** The county the research found, from this context or an earlier research result. */
function countyOf(ctx: AgentContext): string | undefined {
  if (ctx.county) return ctx.county;
  for (const t of ctx.transcript) {
    const m = t.role === "tool" ? t.content.match(/Covering jurisdictions: .*? is in ([^,.]+)/) : null;
    if (m) return m[1].trim();
  }
  return undefined;
}

/** The user's Settings choice on educated guesses, as a rule in every prompt. */
function guessRule(allowed?: boolean): string {
  return allowed
    ? 'EDUCATED GUESSES: allowed. When nothing (no tagged result, none of the chosen data sources, nor your general knowledge) supports a score, you may give your best educated guess: "sources": [], "basis": "assumption", and say in the note that it is a guess and what it is based on.'
    : 'EDUCATED GUESSES: NOT allowed (the user turned them off). When nothing (no tagged result, none of the chosen data sources, nor your general knowledge) supports a score, do not guess: leave it blank with {"code":"…","score":null,"blank":"<what you looked for and why nothing covers it>"}. A blank with a clear reason is better than a guess.';
}

// ── Robust JSON extraction (mirrors the analyzer's) ──────────
function extractJson(text: string): string {
  let cleaned = text;
  if (/<\/think>/i.test(cleaned)) cleaned = cleaned.split(/<\/think>/i).pop() ?? cleaned;
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

interface AgentAction {
  thought?: string;
  action: string;
  city?: string;
  country?: string;
  query?: string;
  text?: string;
  scores?: Array<{ code?: string; score?: number; note?: string; sources?: unknown }>;
  /** read_document: the tag of the page to read ("S7"), and what to look for in it. */
  source?: string;
  topic?: string;
  profile?: Record<string, unknown>;
  info?: Record<string, unknown>;
}

function parseAction(raw: string): AgentAction | null {
  try {
    const obj = JSON.parse(extractJson(raw));
    if (obj && typeof obj.action === "string") return obj as AgentAction;
  } catch {
    /* ignore */
  }
  return null;
}

// ── Tools ────────────────────────────────────────────────────
/** Tags a source for the prompt ("[S3] "), or "" when it has no link. */
type Tagger = (url: string | undefined, title: string) => string;
const tagWith = (reg: SourceRegistry | undefined): Tagger => (url, title) => {
  const tag = reg ? registerSource(reg, url, title) : null;
  return tag ? `[${tag}] ` : "";
};

async function researchTool(
  city: string,
  country: string | undefined,
  searchKey?: string | null,
  area?: AreaSelection | null,
  tag: Tagger = () => ""
): Promise<{ text: string; method: string; county?: string }> {
  let county: string | undefined;
  try {
    const areaBody = area
      ? { ring: area.ring, label: area.label, countryCode: area.countryCode, source: area.source }
      : undefined;
    const [dataRes, refRes] = await Promise.allSettled([
      fetch("/api/data/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city, country, area: areaBody }),
      }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city, country, searchApiKey: searchKey || undefined }),
      }).then((r) => (r.ok ? r.json() : null)),
    ]);

    const lines: string[] = [];
    let method = "open data";
    if (dataRes.status === "fulfilled" && dataRes.value) {
      const dp = dataRes.value as {
        data?: Array<{ label: string; value: unknown; unit?: string; provenance?: { source?: string; dataset?: string; url?: string } }>;
      };
      const pts = (dp.data || [])
        .slice(0, area ? 26 : 18)
        .map((p) => {
          const pv = p.provenance;
          const t = tag(pv?.url, [pv?.source, pv?.dataset].filter(Boolean).join(": ") || p.label);
          return `- ${t}${p.label}: ${p.value}${p.unit ? " " + p.unit : ""}`;
        });
      if (pts.length) lines.push(area ? "Open data for the SELECTED AREA:" : "Open data:", ...pts);
    }
    if (refRes.status === "fulfilled" && refRes.value) {
      const rf = refRes.value as {
        answer?: string; passages?: Array<{ source?: string; url?: string; text: string }>; webSearchMethod?: string;
        jurisdictions?: { county?: string; state?: string };
      };
      if (rf.webSearchMethod) method = `${rf.webSearchMethod} + open data`;
      const j = rf.jurisdictions;
      if (j?.county || j?.state) {
        county = j.county;
        lines.push("", `Covering jurisdictions: ${city} is in ${[j.county, j.state].filter(Boolean).join(", ")}. ` +
          "Plans that cover it (hazard mitigation, emergency management, early warning, building codes) may be county or state level rather than the city's own.");
      }
      if (rf.answer) lines.push("", "Web summary:", rf.answer.slice(0, 900));
      // The general passages, then the county/state ones (labelled by level).
      const all = rf.passages || [];
      const isLevel = (p: { source?: string }) => /\((county|state) level\)/.test(p.source || "");
      for (const p of [...all.filter((p) => !isLevel(p)).slice(0, 4), ...all.filter(isLevel).slice(0, 4)]) {
        lines.push(`- ${tag(p.url, p.source || (p.url ? siteName(p.url) : "web page"))}${isLevel(p) ? `(${p.source!.split(":")[0]}) ` : ""}${p.text.slice(0, 240)}`);
      }
    }
    return { text: lines.length ? lines.join("\n") : "No open data or web results were found for that city.", method, county };
  } catch (e) {
    return { text: `Research failed: ${e instanceof Error ? e.message : String(e)}`, method: "failed" };
  }
}

async function searchTool(query: string, searchKey?: string | null, tag: Tagger = () => ""): Promise<{ text: string; method: string }> {
  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, searchApiKey: searchKey || undefined }),
    });
    if (!res.ok) return { text: `Search failed (HTTP ${res.status}).`, method: "failed" };
    const r = (await res.json()) as { answer?: string; method?: string; results?: Array<{ title: string; url?: string; content: string }> };
    const lines: string[] = [];
    if (r.answer) lines.push(r.answer.slice(0, 800));
    for (const it of (r.results || []).slice(0, 5)) {
      lines.push(`- ${tag(it.url, it.title)}${it.title}${it.url ? ` (${siteName(it.url)})` : ""}: ${(it.content || "").slice(0, 200)}`);
    }
    return { text: lines.length ? lines.join("\n") : "No results.", method: r.method || "web" };
  } catch (e) {
    return { text: `Search failed: ${e instanceof Error ? e.message : String(e)}`, method: "failed" };
  }
}

// ── Prompt assembly ──────────────────────────────────────────
/**
 * The transcript entries sent with each step: the first user instruction (the
 * task) plus the most recent exchanges, so long runs don't balloon in cost or
 * overflow the model's context.
 */
function historyWindow(transcript: TranscriptItem[]): TranscriptItem[] {
  if (transcript.length <= MAX_HISTORY) return transcript;
  const firstUserIdx = transcript.findIndex((t) => t.role === "user");
  const recent = transcript.slice(-MAX_HISTORY);
  return firstUserIdx !== -1 && firstUserIdx < transcript.length - MAX_HISTORY ? [transcript[firstUserIdx], ...recent] : recent;
}

/**
 * How a research_city lookup is named in the transcript: the city, or for an
 * area its size and centre too, so a different area in the same city is
 * researched afresh (its open data is measured inside that area).
 */
function researchLabel(ctx: AgentContext, cityName: string): string {
  if (!ctx.area) return cityName;
  const a = ctx.area;
  return `selected area in ${cityName}, ${a.areaKm2.toFixed(1)} km² around ${a.centroid.lat.toFixed(3)}, ${a.centroid.lon.toFixed(3)}`;
}

/** A research_city, web_search or read_document already run, read back from the transcript. */
interface ResearchDone {
  kind: "research" | "search" | "read";
  /** What was looked up: the city, or the search query. */
  what: string;
  /** Normalised, to spot the same lookup asked again in other words. */
  key: string;
  result: string;
  item: TranscriptItem;
}

const lookupKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !STOP_WORDS.has(w)).sort().join(" ");
/**
 * research_city lookups match on the city name alone ("New Orleans" and
 * "New Orleans, Louisiana, United States" are the same lookup); an area's label
 * (size and centre) is kept whole so a different area is researched afresh.
 */
const researchKey = (what: string) => {
  const w = what.trim().toLowerCase();
  return w.startsWith("selected area") ? w : w.split(",")[0].trim();
};
const STOP_WORDS = new Set(["the", "a", "an", "of", "in", "for", "and", "to", "on", "at", "by", "with", "city", "s"]);

/** Every research and search done so far in this scorecard's conversation. */
function researchDone(transcript: TranscriptItem[]): ResearchDone[] {
  const out: ResearchDone[] = [];
  for (const t of transcript) {
    if (t.role !== "tool") continue;
    const m = /^(research_city|web_search|read_document)\(([\s\S]*?)\):\n([\s\S]*)$/.exec(t.content);
    if (!m) continue;
    const kind = m[1] === "research_city" ? "research" : m[1] === "read_document" ? "read" : "search";
    const what = m[2].trim();
    out.push({ kind, what, key: `${kind}|${kind === "research" ? researchKey(what) : lookupKey(what)}`, result: m[3], item: t });
  }
  return out;
}

const squash = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/**
 * "WORK SO FAR": what has already been researched, so the model doesn't redo it
 * once the original results have scrolled out of the history window. Results
 * still in the window are just named; older ones carry a short excerpt.
 */
function workSoFar(transcript: TranscriptItem[], window: TranscriptItem[]): string {
  const done = researchDone(transcript);
  if (!done.length) return "";
  const inWindow = new Set(window);
  const research = done.filter((d) => d.kind === "research");
  const allSearches = done.filter((d) => d.kind === "search");
  const searches = allSearches.slice(-15);
  const reads = done.filter((d) => d.kind === "read").slice(-10);
  const line = (d: ResearchDone, n: number) => `  - ${d.what}${inWindow.has(d.item) ? " (full result above)" : `: ${squash(d.result, n)}`}`;
  return (
    "WORK SO FAR (already done; do NOT repeat any of these, use their results):\n" +
    (research.length ? `research_city done for:\n${research.map((d) => line(d, 700)).join("\n")}\n` : "research_city: not done yet.\n") +
    (searches.length ? `web_search already run (${allSearches.length} in all${searches.length < allSearches.length ? ", latest shown" : ""}):\n${searches.map((d) => line(d, 220)).join("\n")}\n` : "") +
    (reads.length ? `read_document already done (source: topic):\n${reads.map((d) => line(d, 400)).join("\n")}\n` : "")
  );
}

function buildUser(ctx: AgentContext): string {
  const items = historyWindow(ctx.transcript);
  const history = items
    .map((t) =>
      t.role === "user" ? `USER: ${t.content}` : t.role === "assistant" ? `YOU: ${t.content}` : `TOOL RESULT: ${t.content}`
    )
    .join("\n\n");

  const filled = filledCount(ctx.draft);
  const blanks = blankCount(ctx.draft);
  const unfilled = unfilledCodes(ctx.draft);
  const draftLines = PRELIMINARY_INDICATORS.filter((i) => ctx.draft[i.code]?.score != null)
    .map((i) => `${i.code}=${ctx.draft[i.code].score}`)
    .join(", ");

  const cityName = ctx.city && ctx.city.trim()
    ? [ctx.city.trim(), ctx.region?.trim(), ctx.country?.trim()].filter(Boolean).join(", ")
    : "";
  const cityLine = ctx.area
    ? areaBlock(ctx.area, cityName) + areaGeometryBlock(ctx.area, ctx.areaFile)
    : cityName
    ? `Target city: ${cityName}.`
    : "No city has been provided yet, ask the user which city this is for before scoring.";

  const atts = ctx.attachments || [];
  const attBlock = atts.length
    ? `DOCUMENTS THE USER ATTACHED (${atts.map((a) => a.name).join(", ")}). These are the USER'S OWN uploaded files. Treat them as user-provided evidence and keep them DISTINCT from anything you find via research_city, web_search, or open data. When you rely on one, say so and name it (for example: "Based on the file you attached, <name>, ..."). Do not blend attachment facts with web/open-data facts or misattribute one as the other; if they conflict, say which is which.\n` +
      atts.map((a) => `--- ${ctx.sources ? `[${registerAttachment(ctx.sources, a.name)}] ` : ""}${a.name} (user attachment) ---\n${a.text.slice(0, 4000)}${a.text.length > 4000 ? "\n…(truncated)" : ""}`).join("\n\n") +
      "\n\n"
    : "";

  const modeLine =
    ctx.mode === "autonomous"
      ? "TASK: complete the ENTIRE scorecard, record the City Information you can find (set_info) AND score all indicators."
      : "TASK: respond to the user's specific request only; do not fill or change everything unless they asked.";

  // Summarise what the City Information page already holds, and what's still blank.
  const info = ctx.info || ({} as CityInfo);
  const infoParts: string[] = [];
  if (info.population != null) infoParts.push(`population ${info.population}`);
  if (info.areaKm2 != null) infoParts.push(`area ${info.areaKm2} km²`);
  if (info.incomeUsd != null) infoParts.push(`income $${info.incomeUsd}`);
  if (info.mostLikelyHazard) infoParts.push(`most-likely hazard "${info.mostLikelyHazard}"`);
  if (info.mostSevere) infoParts.push(`most-severe "${info.mostSevere}"`);
  if (info.hazards && info.hazards.length) infoParts.push(`hazards ${info.hazards.join("/")}`);
  const infoLine = infoParts.length
    ? `CITY INFORMATION recorded so far: ${infoParts.join("; ")}.`
    : "CITY INFORMATION page is still EMPTY, record what you can with set_info.";

  const work = workSoFar(ctx.transcript, items);
  const sources = dataSourcesPrompt(ctx.dataSources, "fill");

  return `${attBlock}${history || "(no messages yet)"}

${work}${sources}${cityLine}
${modeLine}
${infoLine}
${guessRule(ctx.allowGuesses)}
CURRENT DRAFT: ${filled}/${TOTAL_INDICATORS} scored${blanks ? `, ${blanks} left blank with a reason` : ""}.${draftLines ? ` Scores so far: ${draftLines}.` : ""}
${unfilled.length ? `Still unfilled: ${unfilled.join(", ")}.` : "All indicators are handled."}

Output ONLY the next action as a single JSON object (remember the "thought" field).`;
}

/** Instructions for an area (sub-city or cross-boundary) fill. */
/**
 * The selected area's exact geometry, as saved in its generated Shapefile, so
 * the model reasons about the real boundary rather than just a place name.
 * Kept short (≤40 vertices at ~10 m precision) because it's sent every step.
 */
function areaGeometryBlock(area: AreaSelection, fileName?: string | null): string {
  const pts = simplifyRing(area.ring, 40);
  const [s, n, w, e] = ringBbox(area.ring);
  const f = (v: number) => v.toFixed(4);
  const wkt = [...pts, pts[0]].map(([lon, lat]) => `${f(lon)} ${f(lat)}`).join(", ");
  return `
SELECTED AREA FILE: ${fileName ? `the user's selection is saved as the Shapefile "${fileName}"` : "the user's selection"} (one polygon, WGS84 / EPSG:4326). All open data from research_city is measured inside exactly this boundary.
  centre ${f(area.centroid.lat)}, ${f(area.centroid.lon)}; bounding box lat ${f(s)} to ${f(n)}, lon ${f(w)} to ${f(e)}; ${area.areaKm2.toFixed(1)} km²
  boundary (lon lat, ${pts.length} vertices): POLYGON((${wkt}))
Use these coordinates to judge which neighbourhoods, districts, rivers, coastlines, major roads, and facilities fall inside the area when you research or web_search, and name them in your notes where relevant. Anything the user wrote about the area is first-hand local knowledge: weigh it alongside the data.`;
}

function areaBlock(area: AreaSelection, cityName: string): string {
  if (area.source === "city") {
    // A whole city (clicked on the map or typed by name): its boundary, so nothing is "area vs city".
    const name = cityName || area.label || "the city";
    return `Target city: ${name}. Its boundary has been looked up, so research_city returns open data measured inside ${
      area.approximate ? "an approximate circle around the city (no official boundary is mapped)" : "the city's official boundary"
    } (${describeArea(area)}): infrastructure counts inside it and its elevation profile, plus web context about the city. Score the whole city as usual.`;
  }
  const areaCodes = PRELIMINARY_INDICATORS.filter((i) => AREA_SPECIFIC_CODES.has(i.code)).map((i) => i.code);
  const parent = cityName || "the city it sits in";
  const outside = area.outsideCityFraction != null && area.outsideCityFraction > 0.1
    ? ` About ${Math.round(area.outsideCityFraction * 100)}% of it lies outside ${parent}'s boundary, so it also covers neighbouring jurisdictions; mention that where it matters.`
    : "";
  return `TARGET AREA: this scorecard is for a SPECIFIC AREA, not a whole city: a ${describeArea(area)}, within ${parent}.${outside}
research_city returns open data measured for exactly this area (infrastructure counts inside it, its elevation profile, climate at its centre), plus general web context about ${parent}.
- AREA-SPECIFIC indicators, score them from THIS AREA's own situation (its hazards, terrain, infrastructure, services, and communities), and name the area evidence in the note: ${areaCodes.join(", ")}.
- Every other indicator is CITY-WIDE (governance, plans, budgets, institutions apply to the whole jurisdiction): score it for ${parent} as a whole, and don't pretend the area has its own policy.
- The City Information page describes ${parent} (the official form is per jurisdiction). When you finish, say plainly that the result covers the selected area.`;
}

// ── The turn loop ────────────────────────────────────────────
/** How one attempt ended. A "pause" can be retried; the rest are final. */
type Outcome =
  | { kind: "done" }
  | { kind: "waiting" } // the model asked the user something
  | { kind: "aborted" }
  | {
      kind: "pause";
      text: string;
      /** Show as "I couldn't keep going: …" rather than a plain pause message. */
      asError?: boolean;
      /** Retrying now is pointless (e.g. the daily limit is used up). */
      final?: boolean;
      /** The model's last unreadable reply, to correct the next prompt with. */
      badReply?: string;
    };

/** Automatic retries before a full fill hands Continue back to the user. */
const MAX_FAILED_ATTEMPTS = 3;
const MAX_AUTO_CONTINUES = 12; // overall safety cap per run, even while progressing

/**
 * Runs the agent until it needs the user (message), finishes, or stops.
 * Mutates ctx.transcript and ctx.draft. Emits events for the UI.
 *
 * During a full fill, a pause or error is retried automatically (after a short
 * wait); the user only has to press Continue after MAX_FAILED_ATTEMPTS attempts
 * in a row end without adding any scores.
 */
export async function runAgentTurn(
  ctx: AgentContext,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const autonomous = ctx.mode === "autonomous";
  let failed = 0;
  let autoContinues = 0;
  let badReply: string | undefined;
  for (;;) {
    const before = resolvedCount(ctx.draft);
    const out = await runAgentAttempt(ctx, onEvent, signal, badReply);
    if (out.kind === "aborted") { onEvent({ type: "stopped" }); return; }
    if (out.kind === "done") { onEvent({ type: "done" }); return; }
    if (out.kind === "waiting") return;

    failed = resolvedCount(ctx.draft) > before ? 1 : failed + 1;
    if (!autonomous || out.final || failed >= MAX_FAILED_ATTEMPTS || autoContinues >= MAX_AUTO_CONTINUES) {
      if (out.asError) {
        onEvent({ type: "error", canContinue: true, text: out.text });
      } else {
        ctx.transcript.push({ role: "assistant", content: out.text });
        onEvent({ type: "assistant", text: out.text });
        onEvent({ type: "stopped" });
      }
      return;
    }
    autoContinues++;
    badReply = out.badReply;
    const waitS = 5 * failed;
    onEvent({
      type: "tool",
      label: `Continuing automatically in ${waitS}s`,
      detail: `attempt ${failed + 1} of ${MAX_FAILED_ATTEMPTS}${out.badReply ? ", asking for a cleaner reply" : ""}`,
    });
    try {
      await sleep(waitS * 1000, signal);
    } catch {
      onEvent({ type: "stopped" });
      return;
    }
    ctx.transcript.push({
      role: "user",
      content: "Continue from where you left off. Do not redo research listed under WORK SO FAR; score the indicators that are still unfilled.",
    });
  }
}

/**
 * The note added to the prompt after an unreadable reply: it quotes how that
 * reply began and spells out exactly what to send next. If the reply looks cut
 * off (usually a set_scores that ran out of output room), it asks for a
 * smaller batch.
 */
function formatCorrection(raw: string, ctx: AgentContext): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const opened = text.indexOf("{");
  const truncated = opened !== -1 && text.lastIndexOf("}") <= opened;
  const excerpt = text.slice(0, 160).replace(/\s+/g, " ");
  const remaining = unfilledCodes(ctx.draft);
  const example = remaining.length
    ? `{"thought":"Scoring ${remaining[0]} to ${remaining[Math.min(4, remaining.length - 1)]}.","action":"set_scores","scores":[{"code":"${remaining[0]}","score":2,"note":"one short sentence"}]}`
    : '{"thought":"Everything is scored.","action":"finish","text":"short wrap-up"}';
  return (
    `FORMAT PROBLEM: your last reply could not be read${excerpt ? ` (it began: "${excerpt}${text.length > 160 ? "…" : ""}")` : " (it was empty)"}. ` +
    (truncated
      ? "It looks cut off before the JSON was closed, so keep this reply SHORT: score at most 5 indicators, with notes under 15 words. "
      : "") +
    `Reply with ONE JSON object and nothing else: no prose, no markdown fences, no comments. Use double quotes. For example: ${example}`
  );
}

/** One run of the step loop; see runAgentTurn for how its outcome is handled. */
async function runAgentAttempt(
  ctx: AgentContext,
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal | undefined,
  lastBadReply?: string
): Promise<Outcome> {
  if (lastBadReply !== undefined) ctx.transcript.push({ role: "tool", content: formatCorrection(lastBadReply, ctx) });
  let parseFailures = 0;
  const basisAsked = new Set<string>(); // indicators already sent back for lacking sources/basis
  let prevFilled = resolvedCount(ctx.draft);
  let stagnantScores = 0; // consecutive set_scores that add nothing
  let stagnantInfo = 0;   // consecutive set_info calls that change nothing
  let lastSig = "";       // signature of the previous action
  let sigRepeat = 0;      // how many times the exact same action has repeated
  let infoNudged = false;
  const autonomous = ctx.mode === "autonomous";
  const maxSteps = autonomous ? AUTONOMOUS_MAX_STEPS : MAX_STEPS;
  let lastProgressStep = 0; // last step that added a score or City Information
  let repeatNudges = 0;     // times the model was told to stop repeating itself
  let researchRun = 0;      // research/search steps in a row without a new score or City Information
  let refusedLookups = 0;   // lookups declined in a row (over the research budget)
  let reusedLookups = 0;    // earlier lookups handed back in a row without scoring anything

  for (let step = 0; step < maxSteps; step++) {
    if (autonomous && step - lastProgressStep >= STALL_STEPS) break;
    if (signal?.aborted) return { kind: "aborted" };
    // Gentle pacing between steps: spread calls out a little so a fast autonomous
    // run doesn't hammer free-tier rate limits in bursts. Abortable.
    if (step > 0) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, STEP_PACING_MS);
        signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
      });
      if (signal?.aborted) return { kind: "aborted" };
    }
    // Let the user steer mid-run: pull in anything they typed while we were
    // working and fold it into the conversation before the next decision.
    if (ctx.drainInput) {
      let extra = ctx.drainInput();
      while (extra) {
        ctx.transcript.push({ role: "user", content: extra });
        extra = ctx.drainInput();
      }
    }
    onEvent({ type: "thinking", on: true });

    let raw = "";
    try {
      raw = await completeWithRetry(ctx, buildUser(ctx), onEvent, signal);
    } catch (e) {
      onEvent({ type: "thinking", on: false });
      if (signal?.aborted) return { kind: "aborted" };
      if (isSpendingCap(e)) {
        return {
          kind: "pause", asError: true, final: true,
          text:
            "this AI's API key has reached its spending limit (OpenRouter: \"Key limit exceeded\"), so it refuses further requests. Raise or reset the key's credit limit on the provider's website (OpenRouter: Settings → API Keys → edit the key), then press Continue. " +
            "With OpenRouter, a :free model costs nothing, so check the model in Settings ends in :free",
        };
      }
      if (isDailyCap(e)) {
        return {
          kind: "pause", asError: true, final: true,
          text:
            "the model's daily request limit is used up (OpenRouter's free models allow 50 a day, or 1,000 a day once $10 of credit has been bought). Press Continue tomorrow, or switch model in Settings and then Continue",
        };
      }
      if (isRateLimit(e)) {
        return {
          kind: "pause", asError: true,
          text:
            "the model hit its rate limit or quota. Free tiers (like Gemini) allow only a few calls a minute, and the assistant makes several. Wait a minute and press Continue, or switch to a model with more headroom in Settings and then Continue",
        };
      }
      return {
        kind: "pause", asError: true,
        text: (e instanceof Error ? e.message : String(e)) + ", you can press Continue to retry, or switch model in Settings first",
      };
    }
    onEvent({ type: "thinking", on: false });

    // Pages the provider's own web search used this step: list their tags so
    // later scores can cite them.
    const nativeTags = ctx.lastCitations ?? [];
    if (nativeTags.length && ctx.sources) {
      const list = nativeTags.slice(0, 8).map((t) => `[${t}] ${ctx.sources!.byTag[t].title} (${siteName(ctx.sources!.byTag[t].url)})`).join("; ");
      ctx.transcript.push({ role: "tool", content: `Pages your own web search used in that step (cite them by tag): ${list}.` });
    }

    const action = parseAction(raw);
    if (!action) {
      parseFailures++;
      if (parseFailures >= 3) {
        return {
          kind: "pause", asError: true, badReply: raw,
          text: "the model kept replying in a format I couldn't read. Press Continue to retry, or switch to another model in Settings",
        };
      }
      ctx.transcript.push({ role: "tool", content: formatCorrection(raw, ctx) });
      continue;
    }
    parseFailures = 0;
    if (action.thought) onEvent({ type: "thought", text: action.thought });

    // Loop guard: fingerprint the action (ignoring the free-text thought). If the
    // model repeats the exact same action several times, we'll stop rather than
    // spin, which some models (especially search-focused ones) are prone to.
    const sig = JSON.stringify([
      action.action,
      action.scores ?? null,
      action.profile ?? action.info ?? null,
      action.query ?? null,
      action.source ?? null,
      action.topic ?? null,
      (action.city ?? "") + "|" + (action.country ?? ""),
    ]);
    if (sig === lastSig) sigRepeat++; else sigRepeat = 0;
    lastSig = sig;

    // Research guard: a lookup that was already done (in this run, or an earlier
    // one, e.g. before the scorecard was cleared) hands back its saved result in
    // full instead of running again; reusing is normal, not a refusal. During a
    // full fill, once RESEARCH_BUDGET new lookups in a row have added nothing,
    // further research is declined so the model scores with what it has.
    if (action.action === "research_city" || action.action === "web_search" || action.action === "read_document") {
      const isResearch = action.action === "research_city";
      const isRead = action.action === "read_document";
      const what = isResearch ? researchLabel(ctx, action.city || ctx.city || "")
        : isRead ? readLabel(action.source, action.topic)
        : (action.query || "");
      const key = `${isResearch ? "research" : isRead ? "read" : "search"}|${isResearch ? researchKey(what) : lookupKey(what)}`;
      const earlier = researchDone(ctx.transcript).find((d) => d.key === key);
      const remaining = unfilledCodes(ctx.draft);
      const next = remaining.slice(0, 10).join(", ");
      let refusal = "";
      if (earlier) {
        reusedLookups++;
        // Loop protection: many reuses in a row with no scoring means it's stuck.
        if (reusedLookups > REUSE_LIMIT) {
          return {
            kind: "pause",
            text: "I keep re-reading earlier lookups instead of scoring, so I'll stop here rather than loop. Press Continue to let me try again, or tell me what you'd like to change. If this keeps happening, try a different model in Settings.",
          };
        }
        const full = earlier.result.length > (isResearch ? 8000 : 4000)
          ? earlier.result.slice(0, isResearch ? 8000 : 4000) + "…"
          : earlier.result;
        ctx.transcript.push({
          role: "tool",
          content:
            // Not prefixed "research_city(…)"/"web_search(…)", so researchDone() doesn't count it as a new lookup.
            `Saved result reused (not run again) for ${isResearch ? "research_city" : isRead ? "read_document" : "web_search"} "${earlier.what}":\n${full}\n` +
            (remaining.length ? `Use it to score: ${next} with set_scores.` : "Use it, then finish."),
        });
        onEvent({ type: "tool", label: "Reused an earlier lookup", detail: squash(earlier.what, 60) });
        continue;
      } else if (autonomous && remaining.length && researchRun >= RESEARCH_BUDGET) {
        refusal =
          `Research limit reached: ${researchRun} lookups in a row without scoring anything, so this one was not run. ` +
          `Score now with what you already know (see WORK SO FAR): ${next}. Where nothing supports a score, follow the EDUCATED GUESSES rule in the task.`;
        onEvent({ type: "tool", label: "Enough research for now", detail: `scoring the next ${Math.min(10, remaining.length)} indicators` });
      }
      if (refusal) {
        ctx.transcript.push({ role: "tool", content: refusal });
        refusedLookups++;
        if (refusedLookups >= 4) {
          return {
            kind: "pause",
            text: "I keep trying to look things up instead of scoring, so I'll stop here rather than loop. Press Continue to let me try again, or tell me what you'd like to change. If this keeps happening, try a different model in Settings.",
          };
        }
        continue;
      }
      refusedLookups = 0;
      researchRun++;
    }

    switch (action.action) {
      case "research_city": {
        const cityName = action.city || ctx.city || "";
        // Look the city up with its state so "Springfield" finds the right one.
        const sameCity = !action.city || action.city.trim().toLowerCase() === (ctx.city || "").trim().toLowerCase();
        const lookupName = sameCity && ctx.region ? `${cityName}, ${ctx.region}` : cityName;
        const what = ctx.area ? "the selected area" : cityName || "the city";
        onEvent({ type: "tool", label: `Researching ${what}…` });
        const { text, method, county } = await researchTool(lookupName, action.country || ctx.country, ctx.searchKey, ctx.area, tagWith(ctx.sources));
        if (county) ctx.county = county;
        ctx.transcript.push({ role: "tool", content: `research_city(${researchLabel(ctx, cityName)}):\n${text}${readingHint(text, ctx.sources)}` });
        onEvent({ type: "tool", label: `Researched ${what}`, detail: method });
        stagnantScores = 0; stagnantInfo = 0;
        break;
      }
      case "read_document": {
        const label = readLabel(action.source, action.topic);
        const tag = (action.source || "").trim().replace(/^\[|\]$/g, "").toUpperCase();
        const src = ctx.sources?.byTag[tag];
        let text: string;
        if (!src) {
          text = `There is no source tagged "${action.source ?? ""}". Read a tag that appeared in research or search results (like S3).`;
        } else if (src.url.startsWith("attachment:")) {
          text = `[${tag}] is a document the user attached: its text is already in DOCUMENTS THE USER ATTACHED above. Use that.`;
        } else {
          onEvent({ type: "tool", label: "Reading in full", detail: `${siteName(src.url)}: ${squash(src.title, 50)}` });
          text = await documentTool(src.url, action.topic || "", tag, ctx.searchKey);
          onEvent({ type: "tool", label: text.startsWith("Couldn't") ? "Couldn't read it" : "Read the document", detail: siteName(src.url) });
        }
        ctx.transcript.push({ role: "tool", content: `read_document(${label}):\n${text}` });
        stagnantScores = 0; stagnantInfo = 0;
        break;
      }
      case "web_search": {
        const q = action.query || "";
        onEvent({ type: "tool", label: "Searching the web for", detail: q.slice(0, 70) });
        const { text, method } = await searchTool(q, ctx.searchKey, tagWith(ctx.sources));
        ctx.transcript.push({ role: "tool", content: `web_search(${q}):\n${text}${readingHint(text, ctx.sources)}` });
        onEvent({ type: "tool", label: `Searched (${method})`, detail: q.slice(0, 60) });
        stagnantScores = 0; stagnantInfo = 0;
        break;
      }
      case "set_scores": {
        // Fix up variant codes ("1.1" → "P1.1") and shapes, and keep back what
        // can't be used so the model is told exactly why instead of guessing.
        const rejected: string[] = [];
        // Look before guessing: a guess or blank for an Essential with no
        // targeted search yet is sent back once (per Essential) with a search to
        // try, unless the research limit is reached or the provider searched itself.
        const searched = searchedEssentials(ctx.transcript);
        const lookAsked = (ctx.lookAsked ??= new Set<number>());
        const mustLookFirst = (code: string): string | null => {
          const e = PRELIMINARY_INDICATORS.find((i) => i.code === code)?.essential;
          if (!e || searched.has(e) || lookAsked.has(e) || nativeTags.length || researchRun >= RESEARCH_BUDGET) return null;
          lookAsked.add(e);
          const place = [ctx.city, ctx.region].filter(Boolean).join(" ") || "the city";
          const cty = countyOf(ctx);
          const terms = ESSENTIAL_SEARCH[e].suggest;
          return `web_search "${place} ${terms}"${cty ? ` or "${cty} ${terms}"` : ""}`;
        };
        const lookFirst = (r: { code: string; score?: unknown; blank?: unknown; basis?: unknown }, outcome: "guess" | "blank") => {
          const q = mustLookFirst(r.code);
          if (!q) return false;
          rejected.push(`${r.code}: before ${outcome === "guess" ? "guessing" : "leaving it blank"}, search for it first: ${q}`);
          return true;
        };
        const reqs = normalizeScoreUpdates(action.scores).flatMap((r) => {
          const problem = scoreProblem(ctx.draft, r);
          if (problem) { rejected.push(`${r.code ?? "?"}: ${problem}`); return []; }
          const code = resolveCode(ctx.draft, r.code)!;
          if (r.score == null || r.score === "") {
            // Left blank (with a reason) or a note-only edit; a blank must follow a search first.
            if (blankReason(r) && lookFirst({ ...r, code }, "blank")) return [];
            return [{ ...r, code }];
          }
          // Every answer must be traceable: tagged sources, a chosen data source
          // named in the note, or a basis of general knowledge / the user's words.
          // A guess ("assumption") only when the user allowed guesses. Pages the
          // provider's own web search used in this step count as sources.
          // Anything else is sent back once, then left blank (or, with guesses
          // allowed, kept as a labelled guess).
          const basis = parseBasis(r.basis);
          const traceable =
            resolveSources(ctx.sources, r.sources).length > 0 ||
            citedSources(r.note ?? "", ctx.dataSources).length > 0 ||
            basis === "general" || basis === "user" ||
            (basis === "assumption" && !!ctx.allowGuesses);
          if (traceable) {
            if (basis === "assumption" && lookFirst({ ...r, code }, "guess")) return [];
            return [{ ...r, code }];
          }
          if (nativeTags.length && basis !== "assumption") return [{ ...r, code, sources: nativeTags.slice(0, 3) }];
          if (!basisAsked.has(code)) {
            basisAsked.add(code);
            rejected.push(
              basis === "assumption"
                ? `${code}: educated guesses are turned off, so cite "sources" (tags like S3), name a chosen data source, use "basis": "general" or "user", or leave it blank with "score": null and "blank": "<reason>"`
                : `${code}: give "sources" (tags like S3) or "basis" ("general" or "user"${ctx.allowGuesses ? ', or "assumption" for an educated guess' : ""}), or leave it blank with "score": null and "blank": "<reason>"`
            );
            return [];
          }
          return ctx.allowGuesses
            ? [{ ...r, code, basis: "assumption" }]
            : [{ ...r, code, score: null, basis: null, blank: `No traceable source was given for this answer${r.note ? ` (the AI's note: ${String(r.note).slice(0, 200)})` : ""}.` }];
        });
        const norm = (c?: string) => (c || "").toUpperCase().replace(/\s+/g, "");
        const before = new Map<string, number | null>();
        const wasBlank = new Set<string>();
        for (const r of reqs) {
          const c = norm(r.code);
          if (c in ctx.draft) before.set(c, ctx.draft[c].score);
          if (ctx.draft[c]?.blank) wasBlank.add(c);
        }
        const n = applyScores(ctx.draft, reqs, (refs) => resolveSources(ctx.sources, refs));
        // Build an ACCURATE list of what actually changed, so the model's own
        // summary reflects reality instead of what it intended.
        const scoreChanges: string[] = [];
        for (const r of reqs) {
          const c = norm(r.code);
          if (!(c in ctx.draft)) continue;
          const oldv = before.has(c) ? before.get(c)! : null;
          const newv = ctx.draft[c].score;
          if (oldv !== newv) scoreChanges.push(`${c} ${oldv ?? "unscored"}→${newv ?? "left blank"}`);
          else if (newv == null && ctx.draft[c].blank && !wasBlank.has(c)) scoreChanges.push(`${c} left blank (${ctx.draft[c].blank!.slice(0, 60)})`);
        }
        onEvent({ type: "draft" });
        const nowFilled = resolvedCount(ctx.draft);
        const nowBlank = blankCount(ctx.draft);
        const added = Math.max(0, nowFilled - prevFilled); // newly-filled indicators
        ctx.transcript.push({
          role: "tool",
          content:
            `Applied ${n} score(s). ${nowFilled - nowBlank}/${TOTAL_INDICATORS} scored${nowBlank ? `, ${nowBlank} left blank with a reason` : ""}. ` +
            `Actual score changes: ${scoreChanges.length ? scoreChanges.join(", ") : "none (notes only or values unchanged)"}. ` +
            (rejected.length
              ? `NOT APPLIED (fix these, don't resend them as they were): ${rejected.slice(0, 10).join("; ")}. Each score must be a whole number 0-3 with a code from the list, plus "sources" (tags) or a "basis", e.g. {"code":"P1.1","score":2,"note":"...","sources":["S3"]} or {"code":"P1.1","score":2,"note":"...","sources":[],"basis":"general"}; or leave it blank: {"code":"P1.1","score":null,"blank":"<reason>"}. `
              : "") +
            (scoreChanges.length === 0 && unfilledCodes(ctx.draft).length
              ? `Nothing new was scored. Still unfilled: ${unfilledCodes(ctx.draft).slice(0, 10).join(", ")}. Score those next, not ones already filled. `
              : "") +
            "When you summarise, describe ONLY these actual changes.",
        });
        onEvent({
          type: "tool",
          label: `${nowFilled - nowBlank}/${TOTAL_INDICATORS} indicators filled${nowBlank ? ` · ${nowBlank} left blank` : ""}`,
          detail: added > 0 ? `+${added} just now` : scoreChanges.length ? `revised ${scoreChanges.length}` : rejected.length ? `${rejected.length} not usable, asked to fix` : "no score change",
        });

        if (nowFilled <= prevFilled) stagnantScores++;
        else { stagnantScores = 0; lastProgressStep = step; researchRun = 0; refusedLookups = 0; reusedLookups = 0; }
        prevFilled = nowFilled;

        if (nowFilled === TOTAL_INDICATORS) {
          ctx.transcript.push({ role: "tool", content: "Every indicator is now scored or left blank with a reason. Call finish now (do not re-score existing answers unless the user asks or you find new evidence)." });
        }
        if (stagnantScores >= 3 && !(autonomous && nowFilled < TOTAL_INDICATORS && repeatNudges < 2)) {
          const done = nowFilled === TOTAL_INDICATORS;
          const msg = done
            ? "All indicators are filled. I'll stop here so you can review, tell me if you'd like any specific changes."
            : "I'm not making further progress on my own. I'll pause so you can tell me what to adjust or what information to use.";
          if (!done) return { kind: "pause", text: msg };
          ctx.transcript.push({ role: "assistant", content: msg });
          onEvent({ type: "assistant", text: msg });
          return { kind: "done" };
        }
        break;
      }
      case "set_info": {
        const patch = (action.profile || action.info || {}) as Record<string, unknown>;
        const { info, changed } = applyInfo(ctx.info || ({ name: ctx.city || "", country: ctx.country || "" } as CityInfo), patch);
        ctx.info = info;
        onEvent({ type: "info" });
        const keys = Object.keys(patch).filter((k) => patch[k] != null && patch[k] !== "");
        ctx.transcript.push({ role: "tool", content: `Recorded City Information: ${keys.join(", ") || "(nothing usable)"}.` });
        onEvent({ type: "tool", label: "City information updated", detail: keys.slice(0, 6).join(", ") });
        stagnantScores = 0;
        if (changed) { stagnantInfo = 0; lastProgressStep = step; researchRun = 0; refusedLookups = 0; reusedLookups = 0; } else stagnantInfo++;
        break;
      }
      case "message": {
        const text = action.text || "…";
        ctx.transcript.push({ role: "assistant", content: text });
        onEvent({ type: "assistant", text });
        return { kind: "waiting" }; // wait for the user
      }
      case "finish": {
        const remaining = unfilledCodes(ctx.draft);
        if (autonomous && remaining.length > 0) {
          onEvent({ type: "tool", label: `Not done yet, ${remaining.length} still to fill`, detail: "completing them" });
          ctx.transcript.push({
            role: "tool",
            content: `You cannot finish yet: ${remaining.length} indicator(s) are still unfilled: ${remaining.join(", ")}. Handle every one of them now: score it from your sources or general knowledge, or (where nothing supports a score) follow the EDUCATED GUESSES rule in the task. Then finish.`,
          });
          break;
        }
        // One-time nudge: don't finish an autonomous run while required City
        // Information fields are still blank. List exactly what's missing so the
        // agent researches and fills what it can (leaving truly-unknown blank).
        const info = ctx.info || ({} as CityInfo);
        const wantStr: Array<[keyof CityInfo, string]> = [
          ["typeOfCity", "type of city"], ["authorityTitle", "title of highest authority"],
          ["mostLikelyHazard", "most likely hazard"], ["mostSevere", "most severe disaster"],
        ];
        const wantNum: Array<[keyof CityInfo, string]> = [
          ["population", "population"], ["areaKm2", "area (km²)"], ["youthPct", "youth %"],
          ["seniorPct", "senior %"], ["literacyPct", "literacy %"], ["povertyPct", "poverty %"],
          ["incomeUsd", "average household income"],
        ];
        const missing = [
          ...wantStr.filter(([k]) => !info[k]).map(([, l]) => l),
          ...wantNum.filter(([k]) => info[k] == null).map(([, l]) => l),
        ];
        if (autonomous && missing.length >= 2 && !infoNudged) {
          infoNudged = true;
          onEvent({ type: "tool", label: "Filling in the city profile", detail: `${missing.length} field(s) still blank` });
          ctx.transcript.push({
            role: "tool",
            content:
              `The City Information page still has blank fields: ${missing.join(", ")}. ` +
              `Look these up (census / city statistics / reliable sources) and record them with set_info. ` +
              `For any value you genuinely cannot find, leave it out, do NOT invent a number. Then finish.`,
          });
          break;
        }
        const text = action.text || "Done. Review the draft, then load it into the analyzer or download it.";
        ctx.transcript.push({ role: "assistant", content: text });
        onEvent({ type: "assistant", text });
        return { kind: "done" };
      }
      default:
        ctx.transcript.push({ role: "tool", content: `Unknown action "${action.action}". Use research_city, web_search, set_info, set_scores, message, or finish.` });
    }

    // Global loop guard: if the model keeps repeating the same action, or keeps
    // re-recording City Information (or scores) that change nothing, first tell
    // it plainly what to do next; only stop if it still doesn't move on.
    if (sigRepeat >= 2 || stagnantInfo >= 3 || (autonomous && stagnantScores >= 3)) {
      // Name the step, so the chat (and anyone debugging) can see what looped.
      const stuckOn =
        stagnantScores >= 3 ? "set_scores that changed nothing"
        : stagnantInfo >= 3 ? "set_info with nothing usable"
        : action.action === "finish" ? "finish while indicators are still unfilled"
        : action.action;
      if (repeatNudges < 2) {
        repeatNudges++;
        sigRepeat = 0; stagnantInfo = 0; stagnantScores = 0;
        const remaining = unfilledCodes(ctx.draft);
        ctx.transcript.push({
          role: "tool",
          content:
            `You have repeated the same step (${stuckOn}) without changing anything. Do NOT repeat it again. ` +
            (remaining.length
              ? `Move on: score these unfilled indicators next with set_scores: ${remaining.slice(0, 10).join(", ")}. ` +
                "Where nothing supports a score, follow the EDUCATED GUESSES rule in the task. " +
                `Reply with exactly this shape: {"thought":"Scoring ${remaining[0]}${remaining.length > 1 ? ` to ${remaining[Math.min(4, remaining.length - 1)]}` : ""}.","action":"set_scores","scores":[${remaining.slice(0, 5).map((c) => `{"code":"${c}","score":<0-3>,"note":"<short reason>"}`).join(",")}]}`
              : "Every indicator is scored. Call finish now."),
        });
        onEvent({ type: "tool", label: "Getting back on track", detail: remaining.length ? `${remaining.length} still to fill` : "wrapping up" });
        continue;
      }
      const msg =
        `I seem to be repeating the same step (${stuckOn}) without making progress, so I'll stop here rather than loop. Press Continue to let me try again, or tell me what you'd like to change or any details you have. If this keeps happening, try a different model in Settings.`;
      return { kind: "pause", text: msg };
    }
  }

  const remaining = unfilledCodes(ctx.draft).length;
  const msg =
    remaining > 0 && autonomous
      ? `I've paused with ${remaining} indicator(s) still to go. Press Continue and I'll keep filling them.`
      : "Pausing here, review the draft, and tell me anything you'd like to change.";
  if (remaining > 0) return { kind: "pause", text: msg };
  ctx.transcript.push({ role: "assistant", content: msg });
  onEvent({ type: "assistant", text: msg });
  return { kind: "done" };
}
