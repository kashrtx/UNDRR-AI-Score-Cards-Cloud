/**
 * Analysis Result Schema — the structured output from the LLM.
 *
 * Every claim is grounded (sourceRefs point to indicator codes or dataset keys).
 * Costs are banded, never precise. Actions are sequenced into phases.
 */

import { z } from "zod";

// ── Cost tiers (banded, never false-precision) ──────────────

export const CostTierSchema = z.enum([
  "$0–100k",
  "$100k–500k",
  "$500k–1M",
  "$1M–10M",
  ">$10M",
]);
export type CostTier = z.infer<typeof CostTierSchema>;

// ── Action phases ────────────────────────────────────────────

export const PhaseSchema = z.enum(["Now", "Next", "Later"]);
export type Phase = z.infer<typeof PhaseSchema>;

// ── A single recommended action ──────────────────────────────

export const ActionSchema = z.object({
  n: z.number().int(),                          // sequence number
  title: z.string(),                            // short action title
  essential: z.number().int().min(1).max(10),   // which Essential this addresses
  gap: z.string(),                              // the weakness/gap this fixes
  impact: z.number().int().min(1).max(5),       // 1=low, 5=transformative
  difficulty: z.number().int().min(1).max(5),   // 1=easy, 5=very hard
  costTier: CostTierSchema,
  phase: PhaseSchema,                           // Now / Next / Later
  scoreDelta: z.number(),                       // projected score improvement
  sourceRefs: z.array(z.string()),              // indicator codes or dataset keys
});

export type Action = z.infer<typeof ActionSchema>;

// ── Confidence in a statement (well-documented vs inferred) ──

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// ── Sourced statement (strength or weakness) ─────────────────

export const SourcedStatementSchema = z.object({
  text: z.string(),
  sourceRefs: z.array(z.string()),
  confidence: ConfidenceSchema.optional(),      // how well-evidenced the claim is
});

export type SourcedStatement = z.infer<typeof SourcedStatementSchema>;

// ── Risk lens: hazard / exposure / vulnerability ─────────────
// A plain-language framing of the city's risk, derived from the scorecard and
// research. Each field is one short paragraph. Optional so older analyses and
// smaller models still validate.

export const RiskProfileSchema = z.object({
  hazard: z.string(),         // what events threaten the city
  exposure: z.string(),       // what/who is in harm's way
  vulnerability: z.string(),  // likely impact given current preparedness
});
export type RiskProfile = z.infer<typeof RiskProfileSchema>;

// ── Full analysis result ─────────────────────────────────────

export const AnalysisResultSchema = z.object({
  summary: z.string(),                          // plain-language situation summary
  riskProfile: RiskProfileSchema.optional(),
  strengths: z.array(SourcedStatementSchema),
  weaknesses: z.array(SourcedStatementSchema),
  actions: z.array(ActionSchema),
  projection: z.object({
    current: z.number(),
    potential: z.number(),
  }),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;