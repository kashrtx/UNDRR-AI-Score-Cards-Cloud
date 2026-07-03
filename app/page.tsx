"use client";

/**
 * Main app — UNDRR ARISE Scorecard Analyzer.
 *
 * Everything runs client-side: upload parses on a stateless API route, open
 * data is fetched from a stateless API route, and the AI analysis streams
 * directly from the provider you chose (key stays in your browser). Scorecard
 * and settings persist in localStorage so a refresh doesn't lose your place.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Shield, Play, Loader2, AlertTriangle, MapPin, Users, Calendar, Zap,
  CheckCircle2, XCircle, Info, Settings as SettingsIcon, LayoutDashboard, RotateCcw,
} from "lucide-react";

import { RadarChart } from "@/components/RadarChart";
import { ImpactDifficultyMatrix } from "@/components/ImpactDifficultyMatrix";
import { ActionPlan } from "@/components/ActionPlan";
import { ScoreProjection } from "@/components/ScoreProjection";
import { ScorecardUpload } from "@/components/ScorecardUpload";
import { ProvenanceBadge } from "@/components/Provenance";
import { StatusBar } from "@/components/StatusBar";
import { GettingStarted } from "@/components/GettingStarted";
import { AnalysisProgress } from "@/components/AnalysisProgress";
import { DataSourcesPanel } from "@/components/DataSourcesPanel";
import { SettingsTab } from "@/components/SettingsTab";

import { runAnalysis } from "@/lib/analysis/analyze";
import {
  loadSettings, saveSettings as persistSettings, hasApiKey,
  type AppSettings,
} from "@/lib/settings/store";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { AnalysisResult } from "@/lib/analysis/schema";
import type { DataReport, ProgressEvent } from "@/lib/types";

type AppState = "empty" | "ready" | "analyzing" | "results" | "error";
type Tab = "dashboard" | "settings";

const SCORECARD_KEY = "undrr.scorecard";

function computeReady(s: AppSettings): boolean {
  if (s.provider === "ollama") return true;
  return hasApiKey(s.provider);
}

export default function Page() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerReady, setProviderReady] = useState(false);

  const [scorecard, setScorecard] = useState<NormalizedScorecard | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [state, setState] = useState<AppState>("empty");

  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [dataReport, setDataReport] = useState<DataReport | null>(null);
  const [narration, setNarration] = useState("");
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // ── Load persisted settings + scorecard on mount ──────────
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    setProviderReady(computeReady(s));
    try {
      const raw = localStorage.getItem(SCORECARD_KEY);
      if (raw) {
        const sc = JSON.parse(raw) as NormalizedScorecard;
        setScorecard(sc);
        setState("ready");
      }
    } catch {
      /* ignore corrupt cache */
    }
    return () => abortRef.current?.abort();
  }, []);

  const handleSettingsChange = useCallback((s: AppSettings) => {
    persistSettings(s);
    setSettings(s);
    setProviderReady(computeReady(s));
  }, []);

  const handleUpload = useCallback((sc: NormalizedScorecard) => {
    setScorecard(sc);
    setAnalysis(null);
    setError(null);
    setState("ready");
    try {
      localStorage.setItem(SCORECARD_KEY, JSON.stringify(sc));
    } catch {
      /* quota — non-fatal */
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (!scorecard || !settings) return;
    if (!computeReady(settings)) {
      setTab("settings");
      return;
    }
    setState("analyzing");
    setError(null);
    setProgress(null);
    setDataReport(null);
    setNarration("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { result, dataReport } = await runAnalysis(scorecard, settings, {
        onProgress: setProgress,
        onDataReport: setDataReport,
        onNarration: setNarration,
        signal: controller.signal,
      });
      setAnalysis(result);
      setDataReport(dataReport);
      setState("results");
    } catch (err) {
      if (controller.signal.aborted) {
        setState(scorecard ? "ready" : "empty");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [scorecard, settings]);

  const cancelAnalyze = useCallback(() => {
    abortRef.current?.abort();
    setState(scorecard ? "ready" : "empty");
  }, [scorecard]);

  if (!settings) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-accent-400" />
      </div>
    );
  }

  const pct = scorecard ? Math.round((scorecard.total / scorecard.totalMax) * 100) : 0;

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────── */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-surface/80 border-b border-border">
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-accent-500/20 to-primary-500/20 border border-accent-500/20">
              <Shield size={22} className="text-accent-400" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-text-primary">
                UNDRR ARISE Scorecard Analyzer
              </h1>
              <p className="text-xs text-text-secondary">
                Disaster Resilience Assessment &amp; Action Planning
              </p>
            </div>
          </div>

          <nav className="hidden sm:flex items-center gap-1 bg-surface-overlay/40 rounded-xl p-1">
            <button
              onClick={() => setTab("dashboard")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                tab === "dashboard" ? "bg-primary-700 text-text-primary" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              <LayoutDashboard size={15} /> Dashboard
            </button>
            <button
              onClick={() => setTab("settings")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                tab === "settings" ? "bg-primary-700 text-text-primary" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              <SettingsIcon size={15} /> Settings
            </button>
          </nav>

          <div className="flex items-center gap-2">
            {tab === "dashboard" && (state === "ready" || state === "results") && scorecard && (
              <button
                onClick={handleAnalyze}
                className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-accent-500 to-accent-400 text-surface hover:from-accent-400 hover:to-accent-500 transition-all shadow-lg shadow-accent-500/25 active:scale-95"
              >
                {state === "results" ? <RotateCcw size={16} /> : <Play size={16} />}
                {state === "results" ? "Re-run" : "Run Analysis"}
              </button>
            )}
            {tab === "dashboard" && state === "analyzing" && (
              <button
                onClick={cancelAnalyze}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-surface-overlay text-accent-400 border border-accent-500/30"
              >
                <Loader2 size={16} className="animate-spin" /> Analysing… (cancel)
              </button>
            )}
          </div>
        </div>

        <div className="border-t border-border/60 bg-surface/60">
          <div className="max-w-[1600px] mx-auto px-6 py-1.5">
            <StatusBar settings={settings} providerReady={providerReady} city={scorecard?.city.name ?? null} />
          </div>
        </div>
      </header>

      {/* ── Disclaimer ─────────────────────────── */}
      <div className="bg-warn-500/10 border-b border-warn-500/20 px-6 py-2">
        <div className="max-w-[1600px] mx-auto flex items-center gap-2 text-xs text-warn-400">
          <Info size={14} className="shrink-0" />
          <span>
            <strong>Decision-support tool.</strong> Outputs are illustrative and AI-generated. All
            recommendations require review by qualified disaster-resilience professionals before implementation.
          </span>
        </div>
      </div>

      {/* ── Main ───────────────────────────────── */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-6 py-6">
        {tab === "settings" && (
          <SettingsTab settings={settings} onChange={handleSettingsChange} />
        )}

        {tab === "dashboard" && (
          <>
            {state === "error" && (
              <div className="flex items-center justify-center py-24">
                <div className="glass-card p-8 max-w-md text-center">
                  <AlertTriangle size={40} className="text-danger-400 mx-auto mb-4" />
                  <h2 className="text-lg font-semibold text-text-primary mb-2">Analysis failed</h2>
                  <p className="text-sm text-text-secondary mb-4">{error}</p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() => { setError(null); setState(scorecard ? "ready" : "empty"); }}
                      className="px-4 py-2 text-sm rounded-lg bg-primary-700 text-text-primary hover:bg-primary-600 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => setTab("settings")}
                      className="px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:text-text-primary transition-colors"
                    >
                      Check Settings
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Empty: no scorecard yet */}
            {state === "empty" && (
              <div className="space-y-6">
                <GettingStarted onOpenSettings={() => setTab("settings")} />
                <div className="max-w-2xl mx-auto">
                  <ScorecardUpload onUploaded={handleUpload} />
                </div>
              </div>
            )}

            {(state === "ready" || state === "results" || state === "analyzing") && scorecard && (
              <div className="space-y-6">
                {state === "ready" && !analysis && (
                  <GettingStarted onOpenSettings={() => setTab("settings")} />
                )}

                {/* City overview + upload */}
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                  <div className="glass-card p-5 lg:col-span-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <h2 className="text-xl font-bold text-text-primary">{scorecard.city.name}</h2>
                        <p className="text-sm text-text-secondary flex items-center gap-1 mt-0.5">
                          <MapPin size={13} /> {scorecard.city.country}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-3xl font-bold text-accent-400">
                          {scorecard.total}
                          <span className="text-lg text-text-secondary font-normal">/{scorecard.totalMax}</span>
                        </p>
                        <p className="text-xs text-text-secondary">{pct}% resilience</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                      {scorecard.profile.population && (
                        <div className="flex items-center gap-2 text-sm">
                          <Users size={14} className="text-primary-300" />
                          <span className="text-text-secondary">{scorecard.profile.population.toLocaleString()}</span>
                        </div>
                      )}
                      {scorecard.assessedDate && (
                        <div className="flex items-center gap-2 text-sm">
                          <Calendar size={14} className="text-primary-300" />
                          <span className="text-text-secondary">{scorecard.assessedDate}</span>
                        </div>
                      )}
                      {scorecard.profile.incomeUsd && (
                        <div className="flex items-center gap-2 text-sm">
                          <Zap size={14} className="text-primary-300" />
                          <span className="text-text-secondary">${scorecard.profile.incomeUsd.toLocaleString()} avg income</span>
                        </div>
                      )}
                    </div>

                    {scorecard.profile.hazards && scorecard.profile.hazards.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {scorecard.profile.hazards.map((h) => (
                          <span key={h} className="px-2 py-0.5 text-xs rounded-full bg-danger-500/15 text-danger-400 border border-danger-500/20">{h}</span>
                        ))}
                      </div>
                    )}

                    {scorecard.profile.mostSevere && (
                      <p className="mt-2 text-xs text-warn-400 bg-warn-500/10 rounded-lg px-3 py-1.5 border border-warn-500/15">
                        ⚠️ Most severe: {scorecard.profile.mostSevere}
                      </p>
                    )}
                  </div>

                  <div className="lg:col-span-2">
                    <ScorecardUpload onUploaded={handleUpload} />
                  </div>
                </div>

                {/* Radar */}
                <RadarChart essentials={scorecard.essentials} />

                {/* Critical gaps */}
                {scorecard.indicators.some((i) => i.score === 0) && (
                  <div className="glass-card p-5">
                    <h2 className="text-base font-semibold text-danger-400 flex items-center gap-2 mb-3">
                      <XCircle size={16} /> Critical Gaps (Score 0/3)
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {scorecard.indicators.filter((i) => i.score === 0).map((ind) => (
                        <div key={ind.code} className="flex items-start gap-2 p-3 rounded-lg bg-danger-500/5 border border-danger-500/15">
                          <span className="font-mono text-xs text-danger-400 shrink-0 mt-0.5">{ind.code}</span>
                          <div>
                            <p className="text-sm text-text-primary">{ind.text}</p>
                            {ind.notes && <p className="text-xs text-text-secondary mt-0.5">{ind.notes}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Live progress */}
                {state === "analyzing" && (
                  <>
                    <AnalysisProgress progress={progress} />
                    <DataSourcesPanel report={dataReport} live />
                    {narration && (
                      <div className="glass-card p-5">
                        <h3 className="text-sm font-semibold text-text-primary mb-2">Live AI output</h3>
                        <pre className="text-xs text-text-secondary whitespace-pre-wrap max-h-64 overflow-auto font-mono leading-relaxed">
                          {narration.slice(-4000)}
                        </pre>
                      </div>
                    )}
                  </>
                )}

                {/* Results */}
                {state === "results" && analysis && (
                  <div className="space-y-6">
                    <DataSourcesPanel report={dataReport} />
                    <div className="glass-card p-6">
                      <h2 className="text-lg font-semibold text-text-primary mb-3">Analysis Summary</h2>
                      <p className="text-sm text-text-secondary leading-relaxed">{analysis.summary}</p>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
                        <div>
                          <h3 className="text-sm font-semibold text-accent-400 flex items-center gap-1.5 mb-2">
                            <CheckCircle2 size={14} /> Strengths
                          </h3>
                          <ul className="space-y-2">
                            {analysis.strengths.map((s, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm text-text-secondary p-2.5 rounded-lg bg-accent-500/5 border border-accent-500/15">
                                <span className="flex-1">{s.text}</span>
                                <ProvenanceBadge sourceRefs={s.sourceRefs} />
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-danger-400 flex items-center gap-1.5 mb-2">
                            <XCircle size={14} /> Weaknesses
                          </h3>
                          <ul className="space-y-2">
                            {analysis.weaknesses.map((w, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm text-text-secondary p-2.5 rounded-lg bg-danger-500/5 border border-danger-500/15">
                                <span className="flex-1">{w.text}</span>
                                <ProvenanceBadge sourceRefs={w.sourceRefs} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                      <ImpactDifficultyMatrix actions={analysis.actions} />
                      <ScoreProjection
                        currentScore={analysis.projection.current}
                        maxScore={scorecard.totalMax}
                        potentialScore={analysis.projection.potential}
                        actions={analysis.actions}
                      />
                    </div>

                    <ActionPlan actions={analysis.actions} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Footer ─────────────────────────────── */}
      <footer className="border-t border-border py-4 px-6">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between text-xs text-text-secondary">
          <span>UNDRR ARISE · Disaster Resilience Scorecard Analyzer</span>
          <span>Runs entirely in your browser · Deployed on Vercel</span>
        </div>
      </footer>
    </div>
  );
}
