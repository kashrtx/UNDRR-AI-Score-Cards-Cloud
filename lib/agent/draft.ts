/**
 * The working "draft" the fill-out assistant builds: one entry per indicator,
 * with a 0-3 score (or null if not yet decided) and a short note. Helpers here
 * turn that draft into the same NormalizedScorecard the main analyzer consumes,
 * and merge a parsed (partial) upload into a draft.
 */

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
}
export type Draft = Record<string, DraftEntry>;

export interface CityInfo {
  name: string;
  country: string;
  population?: number;
  hazards?: string[];
  mostSevere?: string;
}

export function emptyDraft(): Draft {
  const d: Draft = {};
  for (const ind of PRELIMINARY_INDICATORS) d[ind.code] = { score: null, note: "" };
  return d;
}

export function filledCount(draft: Draft): number {
  return PRELIMINARY_INDICATORS.filter((i) => draft[i.code]?.score != null).length;
}

export function unfilledCodes(draft: Draft): string[] {
  return PRELIMINARY_INDICATORS.filter((i) => draft[i.code]?.score == null).map((i) => i.code);
}

const clamp03 = (n: number): Score => Math.max(0, Math.min(3, Math.round(n))) as Score;

/** Apply a batch of {code, score, note} updates. Returns how many were applied. */
export function applyScores(
  draft: Draft,
  updates: Array<{ code?: string; score?: number; note?: string }>
): number {
  let n = 0;
  for (const u of updates || []) {
    const code = (u.code || "").toUpperCase().replace(/\s+/g, "");
    if (!code || !(code in draft)) continue;
    if (typeof u.score === "number" && Number.isFinite(u.score)) {
      draft[code] = { score: clamp03(u.score), note: (u.note ?? draft[code].note ?? "").toString().slice(0, 400) };
      n++;
    } else if (u.note != null) {
      draft[code] = { ...draft[code], note: u.note.toString().slice(0, 400) };
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
    },
    assessedDate: new Date().toISOString().slice(0, 10),
    indicators,
    essentials,
    total,
    totalMax,
  });
}
