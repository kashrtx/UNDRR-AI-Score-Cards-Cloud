/**
 * Export a filled scorecard to a clean .xlsx the user can keep, share, or feed
 * straight back into the analyzer. It carries an Info sheet (city profile) and a
 * Results sheet (code, question, 0-3 score, comments) plus a declared total, so
 * the main parser can read it right back in.
 */

import * as XLSX from "xlsx";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import { ESSENTIAL_NAMES } from "@/lib/scorecard/schema";

export function exportScorecardXlsx(sc: NormalizedScorecard) {
  const totalLine = `Overall score is ${sc.total} / ${sc.totalMax}`;

  const info: (string | number)[][] = [
    ["UNDRR ARISE Preliminary Disaster Resilience Scorecard for Cities"],
    ["Draft prepared with the fill-out assistant. Review before official submission."],
    [],
    ["City name", sc.city.name],
    ["Country", sc.city.country],
    ["Date of assessment", sc.assessedDate || ""],
    ["Total population", sc.profile.population ?? ""],
    ["Most probable hazards", (sc.profile.hazards || []).join(", ")],
    ["Most severe hazard", sc.profile.mostSevere || ""],
    [],
    [totalLine],
  ];
  const wsInfo = XLSX.utils.aoa_to_sheet(info);
  wsInfo["!cols"] = [{ wch: 26 }, { wch: 60 }];

  const header = ["Code", "Essential", "Question", "Score (0-3)", "Comments"];
  const rows = sc.indicators.map((i) => [
    i.code,
    `E${i.essential} ${ESSENTIAL_NAMES[i.essential] ?? ""}`.trim(),
    i.text,
    i.score,
    i.notes || "",
  ]);
  const wsRes = XLSX.utils.aoa_to_sheet([header, ...rows, [], [totalLine]]);
  wsRes["!cols"] = [{ wch: 8 }, { wch: 30 }, { wch: 90 }, { wch: 11 }, { wch: 60 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsInfo, "Info");
  XLSX.utils.book_append_sheet(wb, wsRes, "Results");

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `UNDRR-ARISE-${(sc.city.name || "scorecard").replace(/\s+/g, "-")}-draft.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
