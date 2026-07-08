/**
 * Prompt Builder — constructs grounded system + user prompts
 * for the UNDRR Disaster Resilience Scorecard analysis.
 *
 * Rules encoded here (from the spec):
 * - Cite indicator codes for every claim
 * - Use banded costs only (never precise figures)
 * - Sequence actions (Now/Next/Later) by impact, cost, dependencies
 * - Score-movement projection
 * - Mark data gaps explicitly — never invent data
 * - Reference ARISE Action Guides where applicable
 * - Plain language for non-technical city officials
 */

import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { NormalizedDatum, ReferenceFacts } from "@/lib/types";
import { ESSENTIAL_NAMES } from "@/lib/scorecard/schema";

// ── System prompt (persona + rules) ─────────────────────────

export function buildSystemPrompt(): string {
  return `You are a disaster resilience advisor for the UNDRR ARISE network. Your audience is non-technical city officials (mayor's office staff, city planners). You speak in clear, plain language — no jargon without explanation.

## YOUR TASK
Analyze a city's Disaster Resilience Scorecard and produce a structured action plan.

## STRICT RULES — VIOLATIONS ARE UNACCEPTABLE

1. **GROUNDING**: Every claim MUST reference the specific indicator code (e.g., "P9.1") or dataset key that supports it. Use "sourceRefs" arrays. Do NOT make ungrounded assertions.

2. **COST BANDS ONLY**: Use ONLY these cost tiers: "$0–100k", "$100k–500k", "$500k–1M", "$1M–10M", ">$10M". NEVER give precise cost figures.

3. **SEQUENCING**: Assign every action to a phase:
   - "Now" = quick wins or critical gaps, low cost / high impact, no prerequisites
   - "Next" = medium-term, may depend on "Now" actions completing
   - "Later" = major programs, high cost, long timelines, depend on earlier actions

4. **IMPACT vs DIFFICULTY**: Rate each action:
   - impact: 1 (minimal) to 5 (transformative for city resilience)
   - difficulty: 1 (simple, low resource) to 5 (complex, multi-year, expensive)

5. **SCORE PROJECTION**: Estimate how much each action could improve the city's total score (scoreDelta). Be conservative. The "projection" field shows current total and achievable potential.

6. **DATA GAPS**: If data is missing for an Essential, say so explicitly. Do NOT invent data. Mark what additional information would be needed.

7. **PLAIN LANGUAGE**: Write for a mayor's office staffer, not a technical audience. Explain DRR terms when first used.

8. **ARISE ALIGNMENT**: Where relevant, reference the ARISE Action Guides:
   - Chapter 1: Overview of survey results
   - Chapter 2: How to create a prioritized action plan
   - Chapter 3: How to engage with the community
   - Chapter 4: How to finance projects

9. **SANITY-CHECK THE DATA**: The enrichment figures come from automated open sources and can contain artifacts or coarse approximations. Before repeating a number as fact, ask whether it is plausible. If a value is clearly an artifact or implausible, describe it qualitatively or caveat it rather than stating it as precise fact. Concrete example: a grid-derived ground elevation of 0 m for an inhabited island almost always means the coarse grid cell fell on water/coastline — say "low-lying / near sea level" rather than "0 metres elevation". You MAY point out a likely data artifact when you are confident from general knowledge, but ONLY when confident, and you must NEVER invent a precise replacement figure — if unsure, state the uncertainty and lean on the scorecard. Correct obvious errors; do not manufacture new ones.

10. **USE THE RESEARCH CONTEXT**: When a "RESEARCH CONTEXT" section (retrieved from the web/encyclopedia) is provided, treat it as cited evidence to cross-check the coarse open-data estimates and your own prior memory. Prefer well-corroborated retrieved facts, cite the source, and note conflicts. Do NOT treat any single database field as authoritative — corroborate it against the retrieved excerpts. If you have a web-search tool available, you may also use it to verify uncertain or city-specific facts. Either way, your FINAL output must be ONLY the JSON object below.

11. **CONFIDENCE ON EVERY STRENGTH AND WEAKNESS**: Give each strength and weakness a "confidence" of "high", "medium", or "low":
   - "high" = directly documented (a well-known historical event, a clear scorecard score, a corroborated retrieved fact).
   - "medium" = a reasonable inference from partial or indirect evidence.
   - "low" = an educated guess, or an inference from the ABSENCE of data.
   Calibrate honestly. "The 2010 earthquake caused severe destruction" is high. "No businesses have continuity plans" is low. Do not present everything with equal certainty.

12. **NEVER STATE AN INFERENCE AS A FACT**:
   - Do NOT invent precise statistics. Never write things like "early warning reaches 70% of residents" or "insurance penetration is under 1%" unless that exact figure appears in the provided evidence. Describe the situation qualitatively instead ("early-warning coverage is uneven / limited").
   - ABSENCE OF DATA IS NOT PROOF OF ABSENCE. Zero mapped shelters in OpenStreetMap means "no publicly mapped shelters were found", NOT "there are no shelters". Say "no confirmed or mapped X could be located" rather than "there is no X".
   - Avoid absolute claims like "all infrastructure will fail" — soften to "infrastructure has limited redundancy and is vulnerable to widespread disruption" unless an actual engineering assessment is cited.
   - When in doubt, hedge and lower the confidence rather than overstate.

13. **RISK LENS (hazard / exposure / vulnerability)**: Provide a "riskProfile" with three short plain-language paragraphs that a non-expert can follow, grounded in the scorecard and any city data:
   - "hazard": which natural/human events realistically threaten this city (use the city's known hazards; don't invent new ones).
   - "exposure": what and who is in harm's way if such an event occurs (people, homes, critical infrastructure, economic activity) — describe qualitatively, no invented figures.
   - "vulnerability": given the city's CURRENT preparedness as reflected in the scorecard scores, what level of damage or disruption is plausible, and why (tie it to weak Essentials). Keep the same honesty and hedging rules as above.

## THE TEN ESSENTIALS
${Object.entries(ESSENTIAL_NAMES).map(([n, name]) => `${n}. ${name}`).join("\n")}

## OUTPUT FORMAT
Respond with ONLY a JSON object matching this exact schema — no markdown, no explanation outside the JSON:

{
  "summary": "Plain-language paragraph summarizing the city's resilience position. End by noting the scores are heuristic estimates from available evidence, useful for comparison rather than precise measurements.",
  "riskProfile": { "hazard": "…", "exposure": "…", "vulnerability": "…" },
  "strengths": [{ "text": "...", "sourceRefs": ["P4.2", "P4.3"], "confidence": "high" }],
  "weaknesses": [{ "text": "...", "sourceRefs": ["P9.1", "P9.5"], "confidence": "low" }],
  "actions": [{
    "n": 1,
    "title": "Short action title",
    "essential": 9,
    "gap": "What weakness this addresses",
    "impact": 5,
    "difficulty": 2,
    "costTier": "$0–100k",
    "phase": "Now",
    "scoreDelta": 3,
    "sourceRefs": ["P9.1", "heavy_rain_days"]
  }],
  "projection": { "current": 46, "potential": 72 }
}`;
}

// ── User prompt (data payload) ───────────────────────────────

export function buildUserPrompt(
  scorecard: NormalizedScorecard,
  enrichmentData: NormalizedDatum[],
  reference?: ReferenceFacts | null
): string {
  const parts: string[] = [];

  // ── City profile ──
  parts.push(`## CITY: ${scorecard.city.name}, ${scorecard.city.country}`);
  if (typeof scorecard.city.lat === "number" && typeof scorecard.city.lon === "number") {
    parts.push(`Coordinates: ${scorecard.city.lat}, ${scorecard.city.lon}`);
  }
  parts.push(`Assessed: ${scorecard.assessedDate || "unknown date"}`);

  if (scorecard.profile.population) {
    parts.push(`Population: ${scorecard.profile.population.toLocaleString()}`);
  }
  if (scorecard.profile.incomeUsd) {
    parts.push(`Avg household income: $${scorecard.profile.incomeUsd.toLocaleString()}`);
  }
  if (scorecard.profile.hazards?.length) {
    parts.push(`Known hazards: ${scorecard.profile.hazards.join(", ")}`);
  }
  if (scorecard.profile.mostSevere) {
    parts.push(`Most severe hazard: ${scorecard.profile.mostSevere}`);
  }

  // ── Scorecard summary ──
  parts.push(`\n## SCORECARD SUMMARY`);
  parts.push(`Total score: ${scorecard.total} / ${scorecard.totalMax} (${((scorecard.total / scorecard.totalMax) * 100).toFixed(0)}%)`);
  parts.push(`\nPer-Essential breakdown:`);

  for (const ess of scorecard.essentials) {
    const pct = ((ess.score / ess.max) * 100).toFixed(0);
    parts.push(`  Essential ${ess.num} (${ess.name}): ${ess.score}/${ess.max} (${pct}%)`);
  }

  // ── All 46 indicators ──
  parts.push(`\n## ALL INDICATORS (46 total, each scored 0–3)`);
  for (const ind of scorecard.indicators) {
    const line = `  ${ind.code}: Score ${ind.score}/3 — ${ind.text}`;
    parts.push(ind.notes ? `${line} [Notes: ${ind.notes}]` : line);
  }

  // ── Enrichment data from adapters ──
  if (enrichmentData.length > 0) {
    parts.push(`\n## ENRICHMENT DATA (from external sources)`);
    for (const datum of enrichmentData) {
      if (datum.value === null || datum.value === undefined) {
        parts.push(`  ${datum.key}: DATA UNAVAILABLE (source: ${datum.provenance.source})`);
        continue;
      }

      let valueStr: string;
      if (typeof datum.value === "object") {
        valueStr = JSON.stringify(datum.value);
      } else {
        valueStr = String(datum.value);
      }

      const unitStr = datum.unit ? ` ${datum.unit}` : "";
      const essStr = datum.essentialHint ? ` [Essential ${datum.essentialHint}]` : "";
      parts.push(
        `  ${datum.key}: ${valueStr}${unitStr}${essStr} ` +
        `(source: ${datum.provenance.source}, ${datum.provenance.dataset}, retrieved ${datum.provenance.retrievedAt})`
      );
    }
  } else {
    parts.push(`\n## ENRICHMENT DATA: None available. Base your analysis on the scorecard data alone and note which data gaps should be filled.`);
  }

  if (enrichmentData.length > 0) {
    parts.push(
      `\n### How to read the enrichment data\n` +
        `- Climate figures (precipitation and temperature extremes) are specific to the city's coordinates — use them to corroborate or challenge the self-reported hazard scores.\n` +
        `- The ground-elevation figure is a COARSE global-grid estimate. On small islands and coastlines it frequently reads 0 m even though the real ground is a few metres higher — read a near-zero value as "low-lying / near sea level", and NEVER state a literal, precise "0 m elevation" as fact. A low elevation still signals coastal-flood and sea-level-rise exposure.\n` +
        `- OpenStreetMap infrastructure counts reflect how completely the area is mapped in OSM and may UNDERCOUNT facilities in less-mapped cities — treat them as a floor, not a census, and don't infer a critical gap from a low OSM count alone.\n` +
        `- World Bank figures are NATIONAL, not city-level — use them as context, not as the city's own numbers.`
    );
  }

  // ── Research context (retrieved evidence — RAG) ──
  if (reference && (reference.answer || reference.summary || reference.passages.length || reference.facts.length)) {
    parts.push(`\n## RESEARCH CONTEXT (retrieved from the web & encyclopedia — evidence to cross-check, NOT gospel)`);
    parts.push(
      `Ground your analysis in this retrieved evidence and cite the source by name (for example "Wikipedia", or the site or title). The evidence spans the city's geography and climate, its hazards and past disasters, recent resilience initiatives and successes, and current challenges. Use recent initiatives and projects to inform strengths, and ongoing or historical problems to inform weaknesses and the action plan. Cross-check figures across the sources below. For physical facts such as elevation, rely on what these sources actually say and give a qualified value or range; treat any single database field as one source that may be wrong; never state a precise number as fact unless the retrieved evidence supports it. If sources conflict, say so briefly.`
    );
    if (reference.answer) parts.push(`\nSynthesized answer: ${reference.answer}`);
    if (reference.summary) parts.push(`\nOverview (${reference.title}): ${reference.summary}`);
    if (reference.facts.length) {
      parts.push(`\nReference data (single-source — verify against the excerpts):`);
      for (const f of reference.facts) parts.push(`  - ${f.label}: ${f.value} [${f.source}]`);
    }
    if (reference.passages.length) {
      parts.push(`\nRetrieved excerpts:`);
      for (const p of reference.passages) {
        parts.push(`  - [${p.source}] ${p.text} (${p.url})`);
      }
    }
  }

  // ── Instructions ──
  parts.push(`\n## INSTRUCTIONS`);
  parts.push(`Analyze this city's scorecard and produce a comprehensive resilience action plan.`);
  parts.push(`Focus on:`);
  parts.push(`1. The weakest Essentials (especially those below 30%)`);
  parts.push(`2. Any indicators scored 0 — these are critical gaps`);
  parts.push(`3. The relationship between the city's top hazard (${scorecard.profile.mostSevere || "unknown"}) and its weakest scores`);
  parts.push(`4. Quick wins (low cost, high impact) vs major programs`);
  parts.push(`5. Dependencies between actions (what must happen first)`);
  parts.push(`\nProvide at least 10 concrete actions, sequenced across Now/Next/Later phases.`);
  parts.push(`Remember: respond with ONLY the JSON object, no other text.`);

  return parts.join("\n");
}