/**
 * Export, turn a finished analysis into downloadable artifacts, entirely in
 * the browser:
 *   • a self-contained, printable HTML report (open it and Ctrl/Cmd-P → PDF)
 *   • the raw structured data as JSON
 *
 * No server, no dependencies, just a Blob + an <a download>.
 */

import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { AnalysisResult } from "@/lib/analysis/schema";
import type { DataReport } from "@/lib/types";

export interface ExportMeta {
  provider: string;
  model: string;
  generatedAt: string; // ISO
}

export interface ExportPayload {
  scorecard: NormalizedScorecard;
  analysis: AnalysisResult;
  dataReport: DataReport | null;
  meta: ExportMeta;
}

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "city";
}

function triggerDownload(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── JSON export ──────────────────────────────────────────────
export function downloadJson(p: ExportPayload) {
  const name = `UNDRR-ARISE-${slug(p.scorecard.city.name)}-${p.meta.generatedAt.slice(0, 10)}.json`;
  triggerDownload(name, "application/json", JSON.stringify(p, null, 2));
}

// ── HTML report export ───────────────────────────────────────
export function downloadReport(p: ExportPayload) {
  const name = `UNDRR-ARISE-${slug(p.scorecard.city.name)}-${p.meta.generatedAt.slice(0, 10)}.html`;
  triggerDownload(name, "text/html", buildReportHtml(p));
}

export function buildReportHtml(p: ExportPayload): string {
  const { scorecard: sc, analysis: a, dataReport: dr, meta } = p;
  const pct = Math.round((sc.total / sc.totalMax) * 100);
  const when = new Date(meta.generatedAt).toLocaleString();

  const essentialRows = sc.essentials
    .map((e) => {
      const p = Math.round((e.score / e.max) * 100);
      return `<tr>
        <td class="mono">E${e.num}</td>
        <td>${esc(e.name)}</td>
        <td class="num">${e.score}/${e.max}</td>
        <td><div class="bar"><span style="width:${p}%"></span></div></td>
        <td class="num">${p}%</td>
      </tr>`;
    })
    .join("");

  const confLabel = (c?: string) =>
    c ? ` <span class="conf conf-${esc(c)}">${esc(c)} confidence</span>` : "";
  const list = (items: { text: string; sourceRefs: string[]; confidence?: string }[]) =>
    items
      .map(
        (i) =>
          `<li>${esc(i.text)}${confLabel(i.confidence)}${
            i.sourceRefs?.length ? ` <span class="refs">[${i.sourceRefs.map(esc).join(", ")}]</span>` : ""
          }</li>`
      )
      .join("");

  const phaseOrder = ["Now", "Next", "Later"];
  const actionRows = [...a.actions]
    .sort((x, y) => phaseOrder.indexOf(x.phase) - phaseOrder.indexOf(y.phase) || x.n - y.n)
    .map(
      (ac) => `<tr>
        <td class="num">${ac.n}</td>
        <td><strong>${esc(ac.title)}</strong><div class="gap">${esc(ac.gap)}</div>
            ${ac.sourceRefs?.length ? `<div class="refs">${ac.sourceRefs.map(esc).join(", ")}</div>` : ""}</td>
        <td class="mono">E${ac.essential}</td>
        <td><span class="phase phase-${ac.phase}">${ac.phase}</span></td>
        <td class="num">${ac.impact}/5</td>
        <td class="num">${ac.difficulty}/5</td>
        <td>${esc(ac.costTier)}</td>
        <td class="num">+${ac.scoreDelta}</td>
      </tr>`
    )
    .join("");

  const sourceRows =
    dr && dr.sources.length
      ? dr.sources
          .map(
            (s) =>
              `<tr><td>${esc(s.name)}</td><td class="num">${
                s.error ? "failed" : s.points
              }</td></tr>`
          )
          .join("")
      : `<tr><td colspan="2">No open data was used for this analysis.</td></tr>`;

  const hazards =
    sc.profile.hazards && sc.profile.hazards.length
      ? `<p><strong>Known hazards:</strong> ${sc.profile.hazards.map(esc).join(", ")}</p>`
      : "";
  const severe = sc.profile.mostSevere
    ? `<p><strong>Most severe:</strong> ${esc(sc.profile.mostSevere)}</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UNDRR ARISE Report, ${esc(sc.city.name)}</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --ac:#0f766e; --acbg:#ecfdf5; --warn:#b45309; --warnbg:#fffbeb; --danger:#b91c1c; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: var(--ink); margin: 0; background:#fff; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 40px 28px 64px; }
  header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; border-bottom:2px solid var(--line); padding-bottom:16px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 16px; margin: 28px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .sub { color: var(--muted); font-size: 13px; }
  .score { text-align:right; }
  .score .big { font-size: 30px; font-weight: 800; color: var(--ac); }
  .note { background: var(--warnbg); border:1px solid #fde68a; color:var(--warn); border-radius:8px; padding:10px 12px; font-size:13px; margin:16px 0; }
  .disc { background:#f8fafc; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-size:12px; color:var(--muted); margin:10px 0 0; }
  table { width:100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color: var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .num { text-align:right; white-space:nowrap; }
  .mono { font-family: ui-monospace, Menlo, monospace; color:#475569; }
  .bar { background:#eef2f7; border-radius:6px; height:8px; width:120px; overflow:hidden; }
  .bar span { display:block; height:100%; background: linear-gradient(90deg,#10b981,#22d3ee); }
  .cols { display:flex; gap:24px; flex-wrap:wrap; }
  .cols > div { flex:1; min-width:260px; }
  ul { margin:6px 0; padding-left:18px; } li { margin:5px 0; }
  .refs { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
  .conf { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .conf-high { color: #047857; background: #ecfdf5; border-color: #a7f3d0; }
  .conf-medium { color: #b45309; background: #fffbeb; border-color: #fde68a; }
  .conf-low { color: #64748b; background: #f8fafc; border-color: #e2e8f0; }
  .cols3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 8px 0; }
  .cols3 .rl { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .cols3 .rl h3 { margin: 0 0 4px; font-size: 13px; color: var(--ac); }
  .cols3 .rl p { margin: 0; font-size: 12px; }
  .gap { color: var(--muted); font-size:12px; margin-top:2px; }
  .phase { font-size:11px; font-weight:700; padding:2px 7px; border-radius:20px; }
  .phase-Now { background:#ecfdf5; color:#047857; } .phase-Next { background:#fffbeb; color:#b45309; } .phase-Later { background:#eef2ff; color:#4338ca; }
  .chips span { display:inline-block; background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; border-radius:20px; padding:1px 9px; font-size:12px; margin:2px 4px 2px 0; }
  footer { margin-top:36px; border-top:1px solid var(--line); padding-top:12px; color:var(--muted); font-size:11px; }
  @media print { .wrap { padding:0; } body { font-size:12px; } h2 { page-break-after: avoid; } tr { page-break-inside: avoid; } }
</style></head>
<body><div class="wrap">
  <header>
    <div>
      <h1>Disaster Resilience Report, ${esc(sc.city.name)}</h1>
      <div class="sub">${esc(sc.city.country)}${sc.assessedDate ? " · assessed " + esc(sc.assessedDate) : ""}${
    sc.profile.population ? " · pop. " + sc.profile.population.toLocaleString() : ""
  }</div>
    </div>
    <div class="score"><div class="big">${sc.total}<span style="font-size:16px;color:#94a3b8;font-weight:500">/${sc.totalMax}</span></div><div class="sub">${pct}% resilience</div></div>
  </header>

  <div class="note"><strong>AI-generated analysis.</strong> This report was produced by <strong>${esc(
    meta.provider
  )} · ${esc(
    meta.model
  )}</strong>. Results depend on the AI model used, a different model can produce different findings, priorities and cost estimates. Treat this as decision support, not a substitute for review by qualified disaster-resilience professionals.</div>

  ${hazards}${severe}

  <h2>Ten Essentials</h2>
  <table><thead><tr><th>#</th><th>Essential</th><th class="num">Score</th><th></th><th class="num">%</th></tr></thead>
  <tbody>${essentialRows}</tbody></table>

  <h2>Summary</h2>
  <p>${esc(a.summary)}</p>
  ${a.riskProfile ? `<h2>Risk lens</h2>
  <div class="cols3">
    <div class="rl"><h3>Hazard</h3><p>${esc(a.riskProfile.hazard)}</p></div>
    <div class="rl"><h3>Exposure</h3><p>${esc(a.riskProfile.exposure)}</p></div>
    <div class="rl"><h3>Vulnerability</h3><p>${esc(a.riskProfile.vulnerability)}</p></div>
  </div>` : ""}
  <div class="disc">The scores and projected figures here are heuristic estimates drawn from the scorecard and available evidence. Read them comparatively, to see where a city is relatively stronger or weaker, rather than as precise measurements. Confidence labels next to each point show how well-evidenced it is: <strong>high</strong> means documented, <strong>low</strong> means an inference (often from missing data) that should be verified locally.</div>

  <div class="cols">
    <div><h2>Strengths</h2><ul>${list(a.strengths)}</ul></div>
    <div><h2>Weaknesses</h2><ul>${list(a.weaknesses)}</ul></div>
  </div>

  <h2>Projected score</h2>
  <p>Current <strong>${a.projection.current}</strong> → achievable <strong style="color:var(--ac)">${
    a.projection.potential
  }</strong> of ${sc.totalMax} if the actions below are delivered.</p>

  <h2>Sequenced action plan</h2>
  <table><thead><tr><th class="num">#</th><th>Action</th><th>Ess.</th><th>Phase</th><th class="num">Impact</th><th class="num">Difficulty</th><th>Cost</th><th class="num">Δ</th></tr></thead>
  <tbody>${actionRows}</tbody></table>

  <h2>Open data used</h2>
  ${dr?.located ? `<p class="sub">Located as: ${esc(dr.located)} · ${dr.dataPoints} data point(s)</p>` : ""}
  <table><thead><tr><th>Source</th><th class="num">Points</th></tr></thead><tbody>${sourceRows}</tbody></table>

  ${
    dr?.reference && (dr.reference.facts.length || dr.reference.answer || dr.reference.passages.length)
      ? `<h2>Web research (cross-checked)</h2>
         <p class="sub">Retrieved evidence from ${dr.reference.sources
           .slice(0, 6)
           .map((s) => `<a href="${esc(s.url)}">${esc(s.name)}</a>`)
           .join(", ")}. The AI was instructed to cross-check these and cite them, not to trust any single figure.</p>
         ${
           dr.reference.facts.length
             ? `<table><tbody>${dr.reference.facts
                 .map(
                   (f) =>
                     `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td><td class="sub">${esc(
                       f.source
                     )}</td></tr>`
                 )
                 .join("")}</tbody></table>`
             : ""
         }
         ${dr.reference.answer ? `<p>${esc(dr.reference.answer)}</p>` : ""}`
      : ""
  }

  <div class="disc">UNDRR ARISE Disaster Resilience Scorecard Analyzer · Generated ${esc(
    when
  )} · Runs entirely in the browser. The official scorecard methodology defines the Ten Essentials; scoring here is read directly from the uploaded workbook.</div>

  <footer>Generated ${esc(when)}, UNDRR ARISE Scorecard Analyzer.</footer>
</div></body></html>`;
}
