/**
 * Shared types used across the app (client + server).
 */

export interface CityProfile {
  name: string;
  country: string;
  lat?: number;
  lon?: number;
}

export interface DemographicProfile {
  population?: number;
  incomeUsd?: number;
  hazards?: string[];
  mostSevere?: string;
}

export interface Indicator {
  code: string;
  essential: number;
  text: string;
  score: 0 | 1 | 2 | 3;
  maxScore: 3;
  notes?: string;
}

export interface EssentialSummary {
  num: number;
  name: string;
  score: number;
  max: number;
}

export interface NormalizedScorecard {
  city: CityProfile;
  profile: DemographicProfile;
  assessedDate?: string;
  indicators: Indicator[];
  essentials: EssentialSummary[];
  total: number;
  totalMax: number;
}

export interface Provenance {
  source: string;
  dataset: string;
  retrievedAt: string;
  query: string;
  url?: string;
}

export interface NormalizedDatum {
  key: string;
  label: string;
  value: unknown;
  unit?: string;
  essentialHint?: number;
  provenance: Provenance;
}

export type CostTier = "$0–100k" | "$100k–500k" | "$500k–1M" | "$1M–10M" | ">$10M";
export type Phase = "Now" | "Next" | "Later";

export interface Action {
  n: number;
  title: string;
  essential: number;
  gap: string;
  impact: 1 | 2 | 3 | 4 | 5;
  difficulty: 1 | 2 | 3 | 4 | 5;
  costTier: CostTier;
  phase: Phase;
  scoreDelta: number;
  sourceRefs: string[];
}

export interface SourcedStatement {
  text: string;
  sourceRefs: string[];
}

export interface AnalysisResult {
  summary: string;
  strengths: SourcedStatement[];
  weaknesses: SourcedStatement[];
  actions: Action[];
  projection: {
    current: number;
    potential: number;
  };
}

// ── Analysis progress events (client-side orchestrator) ─────

export interface ProgressEvent {
  step: string;
  label: string;
  pct: number;
  indeterminate?: boolean;
}

export interface DataReport {
  serviceUp: boolean;
  located: string | null;
  dataPoints: number;
  sources: Array<{ id: string; name: string; points: number; error?: string }>;
  warnings: string[];
}

// ── Data pack returned by /api/data/fetch ────────────────────

export interface DataPack {
  city: string;
  country?: string;
  resolved: { displayName: string; lat: number; lon: number; countryCode: string | null } | null;
  sources: Array<{ id: string; name: string; points: number; error?: string }>;
  dataPoints: number;
  data: NormalizedDatum[];
  warnings: string[];
}
