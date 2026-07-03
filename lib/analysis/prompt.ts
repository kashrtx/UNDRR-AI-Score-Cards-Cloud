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
import type { NormalizedDatum } from "@/lib/types";
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

## THE TEN ESSENTIALS
${Object.entries(ESSENTIAL_NAMES).map(([n, name]) => `${n}. ${name}`).join("\n")}

## OUTPUT FORMAT
Respond with ONLY a JSON object matching this exact schema — no markdown, no explanation outside the JSON:

{
  "summary": "Plain-language paragraph summarizing the city's resilience position",
  "strengths": [{ "text": "...", "sourceRefs": ["P4.2", "P4.3"] }],
  "weaknesses": [{ "text": "...", "sourceRefs": ["P9.1", "P9.5"] }],
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
  enrichmentData: NormalizedDatum[]
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
        `- Climate (precipitation/temperature extremes), flood (river discharge) and elevation figures are specific to the city's coordinates — use them to corroborate or challenge the self-reported hazard scores.\n` +
        `- A very low ground elevation signals coastal-flood / sea-level-rise exposure; high river discharge signals riverine-flood exposure.\n` +
        `- OpenStreetMap infrastructure counts reflect how completely the area is mapped in OSM and may UNDERCOUNT facilities in less-mapped cities — treat them as a floor, not a census, and don't infer a critical gap from a low OSM count alone.\n` +
        `- World Bank figures and disaster history are NATIONAL, not city-level — use them as context.`
    );
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