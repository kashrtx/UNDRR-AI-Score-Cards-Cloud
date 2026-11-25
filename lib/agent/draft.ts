/**
 * The working "draft" the fill-out assistant builds: one entry per indicator,
 * with a 0-3 score (or null if not yet decided) and a short note. Helpers here
 * turn that draft into the same NormalizedScorecard the main analyzer consumes,
 * and merge a parsed (partial) upload into a draft.
 */

import type { WebSource } from "./sources";
import { PRELIMINARY_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";
import {
  ESSENTIAL_NAMES,
  NormalizedScorecardSchema,
  type NormalizedScorecard,
} from "@/lib/scorecard/schema";

export type Score = 0 | 1 | 2 | 3;
export interface DraftEntry {
  score: Score | null;
  note: string;
  /** Web pages / open datasets / attachments the AI said this answer rests on (see agent/sources). */
  sources?: WebSource[];
  /** What an answer without sources rests on (see ScoreBasis). */
  basis?: ScoreBasis;
  /**
   * Left blank on purpose, with the reason (nothing traceable supports a score
   * and educated guesses are off in Settings). Counts as handled, not as to-do.
   */
  blank?: string;
}

/**
 * The basis of an answer that cites no source: the AI's general knowledge, the
 * user's own notes or chat, or (only when allowed in Settings) an educated guess.
 */
export type ScoreBasis = "general" | "user" | "assumption";

export function parseBasis(v: unknown): ScoreBasis | null {
  const t = String(v ?? "").toLowerCase().trim();
  if (t === "general" || t === "user" || t === "assumption") return t;
  if (/assum|guess|verify|estimate/.test(t)) return "assumption";
  if (/\buser\b|\bnotes?\b|\bchat\b/.test(t)) return "user";
  if (/general|knowledge|background|common/.test(t)) return "general";
  return null;
}
export type Draft = Record<string, DraftEntry>;

export interface CityInfo {
  name: string;
  country: string;
  typeOfCity?: string;
  assessedDate?: string;
  authorityTitle?: string;
  population?: number;
  areaKm2?: number;
  density?: number;
  youthPct?: number;
  seniorPct?: number;
  femaleHeadedPct?: number;
  literacyPct?: number;
  povertyPct?: number;
  incomeUsd?: number;
  nonCitizenPct?: number;
  hazards?: string[];
  mostLikelyHazard?: string;
  mostSevere?: string;
}

const INFO_NUM_FIELDS = [
  "population", "areaKm2", "density", "youthPct", "seniorPct", "femaleHeadedPct",
  "literacyPct", "povertyPct", "incomeUsd", "nonCitizenPct",
] as const;
const INFO_STR_FIELDS = [
  "typeOfCity", "authorityTitle", "mostLikelyHazard", "mostSevere",
] as const;

/** Merge a patch of City-Information fields into the profile, coercing types. */
export function applyInfo(info: CityInfo, patch: Record<string, unknown>): { info: CityInfo; changed: number } {
  const next: CityInfo = { ...info };
  let changed = 0;
  for (const k of INFO_NUM_FIELDS) {
    const v = patch[k];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[, ]/g, ""));
    if (Number.isFinite(n)) { (next as unknown as Record<string, unknown>)[k] = n; changed++; }
  }
  for (const k of INFO_STR_FIELDS) {
    const v = patch[k];
    if (v == null || v === "") continue;
    (next as unknown as Record<string, unknown>)[k] = String(v).slice(0, 300); changed++;
  }
  if (Array.isArray(patch.hazards)) {
    const hs = (patch.hazards as unknown[]).map((h) => String(h).trim()).filter(Boolean).slice(0, 12);
    if (hs.length) { next.hazards = hs; changed++; }
  } else if (typeof patch.hazards === "string" && patch.hazards.trim()) {
    next.hazards = patch.hazards.split(/[,;]/).map((h) => h.trim()).filter(Boolean).slice(0, 12);
    changed++;
  }
  // Density is arithmetic, not a guess: derive it whenever we know both
  // population and area and it wasn't given directly.
  if (next.density == null && typeof next.population === "number" && typeof next.areaKm2 === "number" && next.areaKm2 > 0) {
    next.density = Math.round(next.population / next.areaKm2);
  }
  return { info: next, changed };
}

export function emptyDraft(): Draft {
  const d: Draft = {};
  for (const ind of PRELIMINARY_INDICATORS) d[ind.code] = { score: null, note: "" };
  return d;
}

/** Indicators with a score. */
export function filledCount(draft: Draft): number {
  return PRELIMINARY_INDICATORS.filter((i) => draft[i.code]?.score != null).length;
}

/** Indicators left blank on purpose, with a reason. */
export function blankCount(draft: Draft): number {
  return PRELIMINARY_INDICATORS.filter((i) => draft[i.code]?.score == null && !!draft[i.code]?.blank).length;
}

/** Indicators handled: scored, or left blank with a reason. */
export function resolvedCount(draft: Draft): number {
  return filledCount(draft) + blankCount(draft);
}

/** Indicators still to do (neither scored nor left blank with a reason). */
export function unfilledCodes(draft: Draft): string[] {
  return PRELIMINARY_INDICATORS.filter((i) => draft[i.code]?.score == null && !draft[i.code]?.blank).map((i) => i.code);
}

const clamp03 = (n: number): Score => Math.max(0, Math.min(3, Math.round(n))) as Score;

/**
 * Parse a score that a model may emit in several shapes: a number (3), a string
 * ("3"), a fraction ("3/3"), or a labelled value ("3 · Comprehensive"). Returns
 * null only when there's no usable number, so a genuine score change is never
 * silently dropped into a note-only update.
 */
function parseScore(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/-?\d+/);
    if (m) {
      const n = parseInt(m[0], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** Apply a batch of {code, score, note} updates. Returns how many were applied. */
/**
 * The indicator code a model meant: "P1.1" as written, or the common variants
 * small models produce ("1.1", "p1-1", "P01.1", "E1.1", "Essential 1.1").
 * Null when it matches no indicator.
 */
export function resolveCode(draft: Draft, raw: unknown): string | null {
  const c = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  if (!c) return null;
  if (c in draft) return c;
  const m = /(\d+)\D+(\d+)/.exec(c);
  if (!m) return null;
  const guess = `P${parseInt(m[1], 10)}.${parseInt(m[2], 10)}`;
  return guess in draft ? guess : null;
}

export interface ScoreUpdate { code?: string; score?: unknown; note?: string; sources?: unknown; basis?: unknown; blank?: unknown }

/**
 * Accept the shapes models actually send for set_scores: the documented list of
 * {code, score, note}, a map {"P1.1": 2} or {"P1.1": {score, note}}, or
 * [["P1.1", 2, "note"]] pairs.
 */
export function normalizeScoreUpdates(raw: unknown): ScoreUpdate[] {
  if (Array.isArray(raw)) {
    return raw.map((r) =>
      Array.isArray(r) ? { code: String(r[0] ?? ""), score: r[1], note: r[2] != null ? String(r[2]) : undefined }
      : r && typeof r === "object" ? (r as ScoreUpdate)
      : {}
    );
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([code, v]) =>
      v && typeof v === "object" ? { code, ...(v as ScoreUpdate) } : { code, score: v }
    );
  }
  return [];
}

/** Why an update can't be applied, or null when it can ("score 5 is not 0-3"). */
export function scoreProblem(draft: Draft, u: ScoreUpdate): string | null {
  if (!resolveCode(draft, u.code)) return `"${u.code ?? ""}" is not an indicator code (codes look like P1.1 to P10.2)`;
  if (u.score == null || u.score === "") return u.note != null || blankReason(u) ? null : "no score given";
  const n = parseScore(u.score);
  if (n == null) return `score "${String(u.score).slice(0, 20)}" is not a number`;
  if (n < 0 || n > 3) return `score ${n} is outside 0-3`;
  return null;
}

/** The reason an update leaves its indicator blank ("blank": "<why>"), if it does. */
export function blankReason(u: ScoreUpdate): string | null {
  if (typeof u.blank === "string" && u.blank.trim()) return u.blank.trim();
  if (u.blank === true) return (u.note ?? "").toString().trim() || "No traceable source was found.";
  return null;
}

export function applyScores(
  draft: Draft,
  updates: ScoreUpdate[],
  /** Turns an update's "sources" (tags like "S3") into linked sources. */
  resolveSources?: (refs: unknown) => WebSource[]
): number {
  let n = 0;
  for (const u of updates || []) {
    const code = resolveCode(draft, u.code);
    if (!code) continue;
    // An update that names sources replaces them; one that doesn't keeps the old ones.
    const sources = u.sources !== undefined && resolveSources ? resolveSources(u.sources) : draft[code].sources;
    const basis = u.basis !== undefined ? parseBasis(u.basis) : draft[code].basis;
    const withSources = { ...(sources?.length ? { sources } : {}), ...(basis ? { basis } : {}) };
    const parsed = parseScore(u.score);
    const blank = parsed == null ? blankReason(u) : null;
    if (parsed != null) {
      draft[code] = { score: clamp03(parsed), note: (u.note ?? draft[code].note ?? "").toString().slice(0, 400), ...withSources };
      n++;
    } else if (blank) {
      // Left blank on purpose: no score, and why.
      draft[code] = { score: null, note: (u.note ?? "").toString().slice(0, 400), blank: blank.slice(0, 400), ...withSources };
      n++;
    } else if (u.note != null) {
      const { sources: _old, basis: _oldBasis, ...rest } = draft[code];
      draft[code] = { ...rest, note: u.note.toString().slice(0, 400), ...withSources };
    }
  }
  return n;
}

/**
 * Pre-fill a draft from a parsed (possibly partial) scorecard upload. Only
 * indicators the file actually answered are loaded; blank ones stay unfilled so
 * the assistant knows what is left to complete. Returns the merged draft and how
 * many answers were loaded.
 */
export function mergeScorecardIntoDraft(
  draft: Draft,
  sc: NormalizedScorecard
): { draft: Draft; loaded: number } {
  const next = { ...draft };
  let loaded = 0;
  for (const ind of sc.indicators) {
    if (ind.answered === false) continue; // blank in the source → leave unfilled
    const code = ind.code.toUpperCase().replace(/\s+/g, "");
    if (code in next) {
      next[code] = { score: ind.score, note: ind.notes || next[code]?.note || "" };
      loaded++;
    }
  }
  return { draft: next, loaded };
}

/** Turn the draft into the analyzer's NormalizedScorecard (unfilled → 0). */
export function draftToScorecard(draft: Draft, city: CityInfo): NormalizedScorecard {
  const indicators = PRELIMINARY_INDICATORS.map((t) => ({
    code: t.code,
    essential: t.essential,
    text: t.text,
    score: (draft[t.code]?.score ?? 0) as Score,
    maxScore: 3 as const,
    notes: draft[t.code]?.note || undefined,
    // Blank in the draft: counted as 0 in the totals, but not a real answer.
    answered: draft[t.code]?.score != null,
  }));

  const essentials = [];
  for (let e = 1; e <= 10; e++) {
    const group = indicators.filter((i) => i.essential === e);
    essentials.push({
      num: e,
      name: ESSENTIAL_NAMES[e],
      score: group.reduce((s, i) => s + i.score, 0),
      max: group.length * 3,
    });
  }
  const total = essentials.reduce((s, e) => s + e.score, 0);
  const totalMax = essentials.reduce((s, e) => s + e.max, 0);

  return NormalizedScorecardSchema.parse({
    city: { name: city.name || "Unknown", country: city.country || "Unknown" },
    profile: {
      population: city.population,
      hazards: city.hazards && city.hazards.length ? city.hazards : undefined,
      mostSevere: city.mostSevere || undefined,
      incomeUsd: city.incomeUsd,
    },
    assessedDate: city.assessedDate || new Date().toISOString().slice(0, 10),
    indicators,
    essentials,
    total,
    totalMax,
  });
}
