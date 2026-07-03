/**
 * Parse a UNDRR Disaster Resilience Scorecard workbook (.xlsm / .xlsx / .xls)
 * into our NormalizedScorecard — robustly, across template versions.
 *
 * WHY THIS IS ROBUST
 * ------------------
 * Different versions of the official tool lay the data out differently:
 *
 *   • 2024 Preliminary (.xlsm): a "Results" sheet whose summary block lists,
 *     per indicator, the CODE (e.g. "P1.1"), the QUESTION text, and the final
 *     0–3 SCORE (a formula whose cached value is the score). It also has a
 *     second detail block and per-Essential answer sheets (E01…E10).
 *
 *   • 2023 Preliminary (.xlsx): no E-sheets at all — the same "Results" summary
 *     block holds the code, text and 0–3 score directly, plus a declared
 *     "overall score is 46 / 138" line.
 *
 * Rather than hard-coding cell addresses, we:
 *   1. Scan every sheet for rows that look like indicators (code = P<e>.<n>),
 *      keeping the sheet that yields the most (de-duplicated by code).
 *   2. Auto-detect which column holds the score (best numeric coverage, values
 *      in 0–4) and whether that column is a 0–3 SCORE or a 1–4 ANSWER index
 *      (score = 4 − answer). Disambiguation uses the workbook's own declared
 *      total when present (sum-match), else the value range.
 *   3. Read the declared total / max ("… is 46 / 138") when present and treat
 *      it as the authoritative headline; otherwise compute from the indicators.
 *   4. Read the city profile from the Info sheet by LABEL, not fixed cells.
 *
 * The result: Toronto (2024) → 120/141, Fuvahmulah (2023) → 46/138, both exact,
 * and unknown future layouts degrade gracefully instead of crashing.
 */

import * as XLSX from "xlsx";
import {
  type NormalizedScorecard,
  type Indicator,
  type EssentialSummary,
  ESSENTIAL_NAMES,
  NormalizedScorecardSchema,
} from "./schema";

// ── Regexes ──────────────────────────────────────────────────────────────────
const CODE_RE = /^[A-Za-z]{0,2}\s*(\d{1,2})\.(\d{1,2})[a-z]?$/;
const DECLARED_RE = /(?:overall|total)[^0-9]{0,60}?(\d{1,3})\s*\/\s*(\d{1,3})/i;

// ── Cell helpers (SheetJS worksheet is a map of "A1" -> cell) ─────────────────
type WS = XLSX.WorkSheet;
function cellAt(ws: WS, r: number, c: number): XLSX.CellObject | undefined {
  return ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
}
function asStr(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const v = cell.w ?? cell.v;
  return v == null ? "" : String(v).trim();
}
function asNum(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (cleaned === "") return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function sheetRange(ws: WS): XLSX.Range | null {
  if (!ws || !ws["!ref"]) return null;
  try {
    return XLSX.utils.decode_range(ws["!ref"] as string);
  } catch {
    return null;
  }
}
function findSheet(wb: XLSX.WorkBook, pred: (name: string) => boolean): WS | undefined {
  const key = wb.SheetNames.find((n) => pred(n.trim().toLowerCase()));
  return key ? wb.Sheets[key] : undefined;
}

// ── Indicator detection ───────────────────────────────────────────────────────
interface RawIndicator {
  row: number;
  code: string;
  essential: number;
  text: string;
}

/** Collect indicator rows from one sheet (de-duplicated by code). */
function collectIndicators(ws: WS): RawIndicator[] {
  const range = sheetRange(ws);
  if (!range) return [];
  const maxCol = Math.min(range.e.c, 20);
  const out: RawIndicator[] = [];
  const seen = new Set<string>();

  for (let r = range.s.r; r <= range.e.r; r++) {
    let code: string | null = null;
    let codeCol = -1;
    let essential = 0;
    // Codes live in one of the first few columns.
    for (let c = range.s.c; c <= Math.min(range.s.c + 4, maxCol); c++) {
      const s = asStr(cellAt(ws, r, c));
      if (!s) continue;
      const m = s.match(CODE_RE);
      if (m) {
        code = s.replace(/\s+/g, "").toUpperCase();
        essential = parseInt(m[1], 10);
        codeCol = c;
        break;
      }
    }
    if (!code || essential < 1 || essential > 10 || seen.has(code)) continue;
    seen.add(code);

    // Question text = the longest string to the right of the code cell.
    let text = code;
    let best = 0;
    for (let c = codeCol + 1; c <= Math.min(codeCol + 8, maxCol); c++) {
      const s = asStr(cellAt(ws, r, c));
      if (s.length > best) {
        best = s.length;
        text = s;
      }
    }
    out.push({ row: r, code, essential, text });
  }
  return out;
}

/** Pick the score column: best numeric coverage across indicator rows, values 0–4. */
function detectScoreColumn(ws: WS, rows: RawIndicator[]): number | null {
  const range = sheetRange(ws);
  if (!range) return null;
  let bestCol: number | null = null;
  let bestCoverage = -1;
  for (let c = range.s.c; c <= Math.min(range.e.c, 20); c++) {
    let numeric = 0;
    let outOfRange = false;
    for (const row of rows) {
      const n = asNum(cellAt(ws, row.row, c)?.v);
      if (n === undefined) continue;
      if (n < 0 || n > 4) {
        outOfRange = true;
        break;
      }
      numeric++;
    }
    if (outOfRange) continue;
    // Need reasonable coverage to be the score column.
    if (numeric > bestCoverage && numeric >= rows.length * 0.4) {
      bestCoverage = numeric;
      bestCol = c;
    }
  }
  return bestCol;
}

const clamp03 = (n: number): 0 | 1 | 2 | 3 =>
  Math.max(0, Math.min(3, Math.round(n))) as 0 | 1 | 2 | 3;

// ── Declared total / max ("… is 46 / 138") ────────────────────────────────────
function findDeclaredTotal(wb: XLSX.WorkBook): { total: number; max: number } | null {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const range = sheetRange(ws);
    if (!range) continue;
    const rowLimit = Math.min(range.e.r, range.s.r + 80);
    for (let r = range.s.r; r <= rowLimit; r++) {
      for (let c = range.s.c; c <= Math.min(range.e.c, 20); c++) {
        const s = asStr(cellAt(ws, r, c));
        if (!s || s.length < 5) continue;
        const m = s.match(DECLARED_RE);
        if (m) {
          const total = parseInt(m[1], 10);
          const max = parseInt(m[2], 10);
          if (max >= 10 && max <= 300 && total <= max) return { total, max };
        }
      }
    }
  }
  return null;
}

// ── Info sheet (city profile) — label-based ───────────────────────────────────
function parseInfo(wb: XLSX.WorkBook): {
  city: { name: string; country: string };
  profile: {
    population?: number;
    incomeUsd?: number;
    hazards?: string[];
    mostSevere?: string;
  };
  assessedDate?: string;
} {
  const ws = findSheet(wb, (n) => n === "info") ?? findSheet(wb, (n) => n.includes("info"));
  const result = {
    city: { name: "Unknown", country: "Unknown" },
    profile: {} as {
      population?: number;
      incomeUsd?: number;
      hazards?: string[];
      mostSevere?: string;
    },
    assessedDate: undefined as string | undefined,
  };
  const range = ws ? sheetRange(ws) : null;
  if (!ws || !range) return result;
  const maxCol = Math.min(range.e.c, 12);

  const valueAfter = (r: number, labelCol: number): { raw: unknown; text: string } | null => {
    for (let c = labelCol + 1; c <= maxCol; c++) {
      const cell = cellAt(ws, r, c);
      const text = asStr(cell);
      if (text !== "") return { raw: cell?.v, text };
    }
    return null;
  };

  for (let r = range.s.r; r <= range.e.r; r++) {
    // Label = first non-empty cell in the row.
    let labelCol = -1;
    let label = "";
    for (let c = range.s.c; c <= maxCol; c++) {
      const s = asStr(cellAt(ws, r, c));
      if (s !== "") {
        labelCol = c;
        label = s;
        break;
      }
    }
    if (!label) continue;
    const L = label.toLowerCase();
    const val = valueAfter(r, labelCol);
    if (!val) continue;

    if (/city name/.test(L)) {
      result.city.name = val.text;
    } else if (/^countr(y|ies)\b/.test(L) && !/gdp/.test(L)) {
      result.city.country = val.text;
    } else if (/date of assessment/.test(L)) {
      result.assessedDate = val.text;
    } else if (/total.*population/.test(L)) {
      const n = asNum(val.raw ?? val.text);
      if (n !== undefined) result.profile.population = Math.round(n);
    } else if (/household income/.test(L)) {
      const n = asNum(val.raw ?? val.text);
      if (n !== undefined) result.profile.incomeUsd = Math.round(n);
    } else if (/most (probable|likely).*(hazard|disaster|risk)|most probable hazard/.test(L)) {
      const hazards = val.text
        .split(/[,;/]/)
        .map((h) => h.trim())
        .filter(Boolean);
      if (hazards.length) result.profile.hazards = hazards;
    } else if (/most severe/.test(L)) {
      result.profile.mostSevere = val.text;
    }
  }
  return result;
}

// ── Core ───────────────────────────────────────────────────────────────────
function parseWorkbook(wb: XLSX.WorkBook): NormalizedScorecard {
  const { city, profile, assessedDate } = parseInfo(wb);
  const declared = findDeclaredTotal(wb);

  // 1. Find the sheet with the most indicator rows (usually "Results").
  let bestWs: WS | null = null;
  let bestRows: RawIndicator[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = collectIndicators(ws);
    if (rows.length > bestRows.length) {
      bestRows = rows;
      bestWs = ws;
    }
  }

  if (!bestWs || bestRows.length < 20) {
    throw new Error(
      "Could not find the indicator table in this workbook. Please make sure it's " +
        "an official UNDRR Disaster Resilience Scorecard (Preliminary or Detailed)."
    );
  }

  // 2. Detect the score column and how to interpret it.
  const scoreCol = detectScoreColumn(bestWs, bestRows);
  const rawValues = new Map<number, number | undefined>();
  if (scoreCol !== null) {
    for (const row of bestRows) rawValues.set(row.row, asNum(cellAt(bestWs, row.row, scoreCol)?.v));
  }
  const present = [...rawValues.values()].filter((v): v is number => v !== undefined);
  const maxVal = present.length ? Math.max(...present) : 0;

  const scoreDirect = (v: number | undefined) => (v === undefined ? 0 : clamp03(v));
  const scoreInvert = (v: number | undefined) => (v === undefined ? 0 : clamp03(4 - v));

  let useInvert: boolean;
  if (declared) {
    const sumDirect = bestRows.reduce((s, row) => s + scoreDirect(rawValues.get(row.row)), 0);
    const sumInvert = bestRows.reduce((s, row) => s + scoreInvert(rawValues.get(row.row)), 0);
    useInvert = Math.abs(sumInvert - declared.total) < Math.abs(sumDirect - declared.total);
  } else {
    // Values above 3 can only be 1–4 answer indices, so invert them.
    useInvert = maxVal > 3;
  }
  const scoreOf = useInvert ? scoreInvert : scoreDirect;

  // 3. Build indicators.
  const indicators: Indicator[] = bestRows.map((row) => ({
    code: row.code,
    essential: row.essential,
    text: row.text,
    score: scoreOf(rawValues.get(row.row)),
    maxScore: 3 as const,
    notes: undefined,
  }));

  // 4. Per-Essential summaries (derived from the actual indicators).
  const essentials: EssentialSummary[] = [];
  for (let e = 1; e <= 10; e++) {
    const group = indicators.filter((ind) => ind.essential === e);
    essentials.push({
      num: e,
      name: ESSENTIAL_NAMES[e],
      score: group.reduce((s, ind) => s + ind.score, 0),
      max: group.length * 3,
    });
  }

  let total = essentials.reduce((s, e) => s + e.score, 0);
  let totalMax = essentials.reduce((s, e) => s + e.max, 0);

  // 5. Prefer the workbook's own declared total/max when present (authoritative
  //    headline — matches what the official Results page shows).
  if (declared) {
    total = declared.total;
    totalMax = declared.max;
  }

  return NormalizedScorecardSchema.parse({
    city,
    profile,
    assessedDate,
    indicators,
    essentials,
    total,
    totalMax,
  });
}

// ── Public API ───────────────────────────────────────────────────────────────
export function parseXlsmBuffer(buffer: ArrayBuffer | Uint8Array): NormalizedScorecard {
  const wb = XLSX.read(buffer, { type: "array", cellFormula: false, cellHTML: false });
  return parseWorkbook(wb);
}
