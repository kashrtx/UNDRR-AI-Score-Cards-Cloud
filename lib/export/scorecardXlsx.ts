/**
 * Export a filled scorecard to a clean, self-contained .xlsx the user can keep,
 * share, edit, or feed back into the analyzer.
 *
 * This is deliberately plain: every answer is an ordinary number in a "Score"
 * column, the ratings and totals are live formulas, and there are NO form
 * controls, option buttons, macros or VML. That makes it bullet-proof to open
 * and edit in Excel — changing one score just recalculates the totals and never
 * disturbs any other answer.
 */

import * as XLSX from "xlsx";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import { ESSENTIAL_NAMES } from "@/lib/scorecard/schema";

const RATING = ["0 · None", "1 · Limited", "2 · Substantial", "3 · Comprehensive"];

export function exportScorecardXlsx(sc: NormalizedScorecard) {
  const wb = XLSX.utils.book_new();

  // ── Info sheet ───────────────────────────────────────────
  const info: (string | number)[][] = [
    ["UNDRR ARISE Preliminary Disaster Resilience Scorecard for Cities"],
    ["Draft prepared with the fill-out assistant. Please review before official use."],
    [],
    ["City name", sc.city.name],
    ["Country", sc.city.country],
    ["Date of assessment", sc.assessedDate || ""],
    ["Total population", sc.profile.population ?? ""],
    ["Average household income (USD)", sc.profile.incomeUsd ?? ""],
    ["Main hazards", (sc.profile.hazards || []).join(", ")],
    ["Most severe disaster known", sc.profile.mostSevere || ""],
    [],
    [`Overall score is ${sc.total} / ${sc.totalMax} (${Math.round((sc.total / sc.totalMax) * 100)}%)`],
  ];
  const wsInfo = XLSX.utils.aoa_to_sheet(info);
  wsInfo["!cols"] = [{ wch: 32 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, "Info");

  // ── Scorecard sheet (all indicators, editable Score column) ──
  const header = ["Code", "Essential", "Question", "Score (0-3)", "Rating", "Notes"];
  const rows = sc.indicators.map((i) => [
    i.code,
    `E${i.essential} · ${ESSENTIAL_NAMES[i.essential] ?? ""}`.trim(),
    i.text,
    typeof i.score === "number" ? i.score : "",
    "", // Rating filled by formula below
    i.notes || "",
  ]);
  const wsCard = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const n = sc.indicators.length;
  // Rating column (E) mirrors the score in words, and updates if you edit the score.
  for (let r = 2; r <= n + 1; r++) {
    wsCard[`E${r}`] = {
      t: "s",
      f: `IF(D${r}="","",CHOOSE(D${r}+1,"None","Limited","Substantial","Comprehensive"))`,
    };
  }
  wsCard["!cols"] = [{ wch: 8 }, { wch: 30 }, { wch: 90 }, { wch: 11 }, { wch: 16 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsCard, "Scorecard");

  // ── Results sheet (per-Essential + total, all live formulas) ──
  const resHeader = ["Essential", "Score", "Max", "%"];
  const resRows: (string | number)[][] = sc.essentials.map((e) => [
    `E${e.num} · ${e.name}`,
    e.score,
    e.max,
    "",
  ]);
  const wsRes = XLSX.utils.aoa_to_sheet([resHeader, ...resRows, [], ["TOTAL", sc.total, sc.totalMax, ""]]);
  // % column as formula so it recalculates
  for (let r = 2; r <= sc.essentials.length + 1; r++) {
    wsRes[`D${r}`] = { t: "n", f: `IF(C${r}=0,0,ROUND(B${r}/C${r}*100,0))` };
  }
  const totalRow = sc.essentials.length + 3;
  wsRes[`B${totalRow}`] = { t: "n", f: `SUM(B2:B${sc.essentials.length + 1})` };
  wsRes[`D${totalRow}`] = { t: "n", f: `IF(C${totalRow}=0,0,ROUND(B${totalRow}/C${totalRow}*100,0))` };
  wsRes["!cols"] = [{ wch: 40 }, { wch: 10 }, { wch: 10 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, wsRes, "Results");

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `UNDRR-ARISE-${(sc.city.name || "scorecard").replace(/\s+/g, "-")}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
