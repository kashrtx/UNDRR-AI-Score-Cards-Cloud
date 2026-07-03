/**
 * Parse a UNDRR Preliminary Scorecard .xlsm into our NormalizedScorecard.
 *
 * HOW THIS READS THE FILE (and why it's robust):
 *
 *   The workbook's hidden "Results" sheet is the single source of truth. From
 *   row 175 down it lists, for every indicator:
 *       column B -> Essential group   ("E1".."E10")
 *       column C -> indicator code     ("P1.1")
 *       column E -> the full question text
 *       column G -> a formula pointing at the answer cell, e.g.  ='E01'!$E$7
 *
 *   We read that map, then follow each G reference to the RAW answer cell on the
 *   E-sheet. The answer is an option index 1..4; the score is 4 - answer
 *   (answer 1 = best = 3 ; answer 4 = worst = 0 ; blank/0 = 0), exactly matching
 *   the workbook's own scoring formula =IF(G="",0,IF(G=0,0,4-G)).
 *
 *   Reading the map from the file (instead of hard-coding row numbers and
 *   per-Essential counts) means we adapt to the file itself and get the totals
 *   right — the official tool has 47 indicators, so the maximum score is 141.
 *   If the Results sheet is missing/renamed we fall back to the fixed Mar-2024
 *   layout. Missing sheets or cells become gaps, never crashes.
 */

import * as XLSX from "xlsx";
import {
  type NormalizedScorecard,
  type Indicator,
  type EssentialSummary,
  ESSENTIAL_NAMES,
  NormalizedScorecardSchema,
} from "./schema";

// ── Fallback layout (official Mar-2024 tool) ─────────────────────────────────
const FALLBACK_COUNTS: Record<number, number> = {
  1: 3, 2: 5, 3: 4, 4: 4, 5: 3, 6: 6, 7: 4, 8: 9, 9: 7, 10: 2,
};
const FIRST_ANSWER_ROW = 7;
const ROW_STEP = 11;

interface IndicatorRef {
  code: string;
  essential: number;
  question: string;
  sheet: string;
  cell: string;
}

// ── Cell helpers ─────────────────────────────────────────────────────────────
function cell(sheet: XLSX.WorkSheet | undefined, ref: string): XLSX.CellObject | undefined {
  return sheet ? (sheet[ref] as XLSX.CellObject | undefined) : undefined;
}
function cellStr(sheet: XLSX.WorkSheet | undefined, ref: string): string {
  const c = cell(sheet, ref);
  if (!c) return "";
  const v = c.w ?? c.v;
  return v != null ? String(v).trim() : "";
}
function cellNum(sheet: XLSX.WorkSheet | undefined, ref: string): number | undefined {
  const c = cell(sheet, ref);
  if (!c) return undefined;
  if (typeof c.v === "number") return c.v;
  if (typeof c.v === "string" && c.v.trim() !== "" && !isNaN(Number(c.v))) return Number(c.v);
  return undefined;
}
function cellFormula(sheet: XLSX.WorkSheet | undefined, ref: string): string {
  const c = cell(sheet, ref);
  return c?.f ? String(c.f) : "";
}

function answerToScore(answer: number | undefined): 0 | 1 | 2 | 3 {
  if (answer === undefined || answer < 1 || answer > 4) return 0;
  const s = 4 - Math.round(answer);
  return Math.max(0, Math.min(3, s)) as 0 | 1 | 2 | 3;
}

function findSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet | undefined {
  const key = wb.SheetNames.find((n) => n.trim().toLowerCase() === name.toLowerCase());
  return key ? wb.Sheets[key] : undefined;
}

// ── Layout: read the Results map, or fall back ──────────────────────────────
const REF_RE = /^='?([A-Za-z0-9_]+)'?!\$?([A-Z]+)\$?(\d+)/;

function readLayout(wb: XLSX.WorkBook): { refs: IndicatorRef[]; source: string } {
  const results = findSheet(wb, "Results");
  if (results) {
    const refs: IndicatorRef[] = [];
    let started = false;
    for (let r = 2; r <= 1200; r++) {
      const code = cellStr(results, `C${r}`);
      const formula = cellFormula(results, `G${r}`);
      const ess = cellStr(results, `B${r}`);
      if (!(code.toUpperCase().startsWith("P") && formula.includes("!"))) {
        if (started && code === "" && formula === "") break;
        continue;
      }
      const m = ("=" + formula).match(REF_RE) ?? formula.match(REF_RE);
      if (!m) continue;
      const digits = (ess.replace(/\D/g, "") || code.slice(1).replace(/\D.*/, ""));
      const essential = parseInt(digits, 10);
      if (!(essential >= 1 && essential <= 10)) continue;
      started = true;
      refs.push({
        code: normaliseCode(code),
        essential,
        question: cellStr(results, `E${r}`) || code,
        sheet: m[1],
        cell: `${m[2]}${m[3]}`,
      });
    }
    if (refs.length) return { refs, source: "Results sheet" };
  }

  // Fallback: fixed layout.
  const refs: IndicatorRef[] = [];
  for (let e = 1; e <= 10; e++) {
    const sheet = `E${String(e).padStart(2, "0")}`;
    for (let i = 0; i < FALLBACK_COUNTS[e]; i++) {
      const row = FIRST_ANSWER_ROW + i * ROW_STEP;
      refs.push({ code: `P${e}.${i + 1}`, essential: e, question: `P${e}.${i + 1}`, sheet, cell: `E${row}` });
    }
  }
  return { refs, source: "fallback (Mar-2024 fixed layout)" };
}

function normaliseCode(code: string): string {
  let c = code.trim().toUpperCase().replace(/-/g, ".").replace(/_/g, ".");
  if (!c.startsWith("P")) c = "P" + c;
  return c;
}

// ── Info sheet (city profile) ────────────────────────────────────────────────
function parseInfo(wb: XLSX.WorkBook) {
  const sheet = findSheet(wb, "Info");
  const name = cellStr(sheet, "D4") || "Unknown";
  const country = cellStr(sheet, "D6") || "Unknown";
  const assessedDate = cellStr(sheet, "D7") || undefined;
  const population = cellNum(sheet, "C11");
  const incomeUsd = cellNum(sheet, "C19");
  const hazardStr = cellStr(sheet, "C21");
  const hazards = hazardStr
    ? hazardStr.split(/[,;]/).map((h) => h.trim()).filter(Boolean)
    : undefined;
  const mostSevere = cellStr(sheet, "C22") || undefined;
  return { city: { name, country }, profile: { population, incomeUsd, hazards, mostSevere }, assessedDate };
}

// ── Core ─────────────────────────────────────────────────────────────────────
function parseWorkbook(wb: XLSX.WorkBook): NormalizedScorecard {
  const { city, profile, assessedDate } = parseInfo(wb);
  const { refs } = readLayout(wb);

  const indicators: Indicator[] = refs.map((ref) => {
    const sheet = findSheet(wb, ref.sheet);
    const answer = cellNum(sheet, ref.cell);
    const noteRef = ref.cell.replace("E", "C"); // means-of-verification note sits in column C
    const notes = cellStr(sheet, noteRef) || undefined;
    return {
      code: ref.code,
      essential: ref.essential,
      text: ref.question,
      score: answerToScore(answer),
      maxScore: 3 as const,
      notes,
    };
  });

  const essentials: EssentialSummary[] = [];
  for (let e = 1; e <= 10; e++) {
    const group = indicators.filter((ind) => ind.essential === e);
    essentials.push({
      num: e,
      name: ESSENTIAL_NAMES[e],
      score: group.reduce((s, ind) => s + ind.score, 0),
      max: group.length * 3, // derived, not hard-coded → always correct
    });
  }

  const total = essentials.reduce((s, e) => s + e.score, 0);
  const totalMax = essentials.reduce((s, e) => s + e.max, 0);

  return NormalizedScorecardSchema.parse({
    city, profile, assessedDate, indicators, essentials, total, totalMax,
  });
}

// ── Public API ───────────────────────────────────────────────────────────────
// cellFormula:true so we can read the Results-sheet answer-cell references.
const READ_OPTS: XLSX.ParsingOptions = { type: "array", cellFormula: true, cellHTML: false };

export function parseXlsmBuffer(buffer: ArrayBuffer | Uint8Array): NormalizedScorecard {
  return parseWorkbook(XLSX.read(buffer, READ_OPTS));
}
