/**
 * Scorecard Schema — the normalized internal representation
 * of a UNDRR Disaster Resilience Scorecard (Preliminary / short-form).
 *
 * 47 indicators, each scored 0–3, grouped under the Ten Essentials.
 * Total max = 141. (Per-Essential maximums are derived from the actual
 * indicator counts read out of the file, not hard-coded, so they stay correct.)
 */

import { z } from "zod";

// ── Constants ────────────────────────────────────────────────

export const ESSENTIAL_NAMES: Record<number, string> = {
  1: "Organize for Resilience",
  2: "Identify & Understand Risk Scenarios",
  3: "Strengthen Financial Capacity",
  4: "Pursue Resilient Urban Development",
  5: "Safeguard Natural Buffers",
  6: "Strengthen Institutional Capacity",
  7: "Strengthen Societal Capacity",
  8: "Increase Infrastructure Resilience",
  9: "Ensure Effective Disaster Response",
  10: "Expedite Recovery & Build Back Better",
};

// ── Zod schemas ──────────────────────────────────────────────

export const IndicatorSchema = z.object({
  code: z.string(),                   // e.g. "P1.1"
  essential: z.number().int().min(1).max(10),
  text: z.string(),                   // indicator question text
  score: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  maxScore: z.literal(3),
  notes: z.string().optional(),       // qualitative notes from the E-sheets
  answered: z.boolean().optional(),   // whether this indicator was actually answered (vs a blank template)
});

export const CityProfileSchema = z.object({
  name: z.string(),
  country: z.string(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

export const DemographicProfileSchema = z.object({
  population: z.number().optional(),
  incomeUsd: z.number().optional(),
  hazards: z.array(z.string()).optional(),
  mostSevere: z.string().optional(),
});

export const EssentialSummarySchema = z.object({
  num: z.number().int().min(1).max(10),
  name: z.string(),
  score: z.number(),
  max: z.number(),
});

export const NormalizedScorecardSchema = z.object({
  city: CityProfileSchema,
  profile: DemographicProfileSchema,
  assessedDate: z.string().optional(),
  indicators: z.array(IndicatorSchema),
  essentials: z.array(EssentialSummarySchema),
  total: z.number(),
  totalMax: z.number(),
});

// ── TypeScript types (derived from Zod) ──────────────────────

export type Indicator = z.infer<typeof IndicatorSchema>;
export type CityProfile = z.infer<typeof CityProfileSchema>;
export type DemographicProfile = z.infer<typeof DemographicProfileSchema>;
export type EssentialSummary = z.infer<typeof EssentialSummarySchema>;
export type NormalizedScorecard = z.infer<typeof NormalizedScorecardSchema>;