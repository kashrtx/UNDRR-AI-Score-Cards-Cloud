"use client";

/**
 * Main app, UNDRR ARISE Scorecard Analyzer.
 *
 * Everything runs client-side. Scorecard, settings, AND the finished analysis
 * persist in localStorage, so a refresh restores the full dashboard. Results can
 * be exported (printable HTML report or JSON) and cleared; attaching a new file
 * warns first and offers to download the current results.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play, Loader2, AlertTriangle, MapPin, Users, Calendar, Zap,
  CheckCircle2, XCircle, Info, Settings as SettingsIcon, LayoutDashboard, RotateCcw,
  Download, FileJson, Eraser, Bot,
} from "lucide-react";

import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
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
import { AssistantTab } from "@/components/AssistantTab";
import { LiveStream } from "@/components/LiveStream";
import { Onboarding } from "@/components/Onboarding";
import { SystemStatus } from "@/components/SystemStatus";
import { ConfirmModal } from "@/components/ConfirmModal";

import { runAnalysis } from "@/lib/analysis/analyze";
import { downloadReport, downloadJson, type ExportMeta, type ExportPayload } from "@/lib/export/report";
import {
  loadSettings, saveSettings as persistSettings, hasApiKey, isCloudProvider, hasSearchKey, modelForSettings,
  type AppSettings, type ProviderId,
} from "@/lib/settings/store";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { AnalysisResult } from "@/lib/analysis/schema";
import type { DataReport, ProgressEvent } from "@/lib/types";

type AppState = "empty" | "ready" | "analyzing" | "results" | "error";
type Tab = "dashboard" | "assistant" | "settings";

const SCORECARD_KEY = "undrr.scorecard";
const SCORECARD_NAME_KEY = "undrr.scorecard.name";
const ANALYSIS_KEY = "undrr.analysis";
const ONBOARDED_KEY = "undrr.onboarded.v1";
const TIPS_KEY = "undrr.tips.dismissed";

const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude", gemini: "Gemini", openrouter: "OpenRouter",
  openai: "OpenAI", xai: "xAI Grok", zai: "z.AI GLM", nvidia: "NVIDIA NIM", meta: "Meta Llama",
  ollama: "Ollama (local)", lmstudio: "LM Studio (local)",
};

function computeReady(s: AppSettings): boolean {
  return isCloudProvider(s.provider) ? hasApiKey(s.provider) : true;
}
function modelOf(s: AppSettings): string {
  return modelForSettings(s);
}

export default function Page() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providerReady, setProviderReady] = useState(false);
  const [tavilyActive, setTavilyActive] = useState(false);

  const [scorecard, setScorecard] = useState<NormalizedScorecard | null>(null);
  const [scFileName, setScFileName] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisMeta, setAnalysisMeta] = useState<ExportMeta | null>(null);
  const [state, setState] = useState<AppState>("empty");

  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [dataReport, setDataReport] = useState<DataReport | null>(null);
  const [narration, setNarration] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Pending upload awaiting confirmation (because it would clear results)
  const [pendingUpload, setPendingUpload] = useState<{ sc: NormalizedScorecard; name: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [tipsDismissed, setTipsDismissed] = useState(true); // assume seen until mount says otherwise

  const abortRef = useRef<AbortController | null>(null);

  // ── Load persisted state on mount ─────────────────────────
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    setProviderReady(computeReady(s));
    setTavilyActive(!!s.useTavily && hasSearchKey());
    try {
      const onboarded = !!localStorage.getItem(ONBOARDED_KEY);
      setShowTour(!onboarded);
      setTipsDismissed(onboarded && !!localStorage.getItem(TIPS_KEY));
    } catch {
      /* ignore */
    }
    try {
      const raw = localStorage.getItem(SCORECARD_KEY);
      if (raw) {
        const sc = JSON.parse(raw) as NormalizedScorecard;
        setScorecard(sc);
        setScFileName(localStorage.getItem(SCORECARD_NAME_KEY));
        // Restore a saved analysis if present.
        const rawA = localStorage.getItem(ANALYSIS_KEY);
        if (rawA) {
          const saved = JSON.parse(rawA) as {
            result: AnalysisResult; dataReport: DataReport | null; meta: ExportMeta;
          };
          if (saved?.result) {
            setAnalysis(saved.result);
            setDataReport(saved.dataReport ?? null);
            setAnalysisMeta(saved.meta ?? null);
            setState("results");
          } else {
            setState("ready");
          }
        } else {
          setState("ready");
        }
      }
    } catch {
      /* ignore corrupt cache */
    }
    return () => abortRef.current?.abort();
  }, []);

  // Recharts' ResponsiveContainer occasionally measures 0/stale size on first
  // paint (especially right after a tab switch or when results first appear),
  // leaving a blank box until the window is resized. Nudging a resize event
  // after paint forces every chart to re-measure correctly.
  useEffect(() => {
    if (tab !== "dashboard" || (state !== "results" && state !== "analyzing")) return;
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          window.dispatchEvent(new Event("resize"));
        } catch {
          /* no-op */
        }
      })
    );
    return () => cancelAnimationFrame(id);
  }, [tab, state, analysis]);

  const handleSettingsChange = useCallback((s: AppSettings) => {
    persistSettings(s);
    setSettings(s);
    setProviderReady(computeReady(s));
    setTavilyActive(!!s.useTavily && hasSearchKey());
  }, []);

  // Commit a scorecard (replaces any current one + clears results).
  const commitUpload = useCallback((sc: NormalizedScorecard, name: string) => {
    setScorecard(sc);
    setScFileName(name);
    setAnalysis(null);
    setAnalysisMeta(null);
    setDataReport(null);
    setNarration("");
    setError(null);
    setState("ready");
    try {
      localStorage.setItem(SCORECARD_KEY, JSON.stringify(sc));
      localStorage.setItem(SCORECARD_NAME_KEY, name);
      localStorage.removeItem(ANALYSIS_KEY);
    } catch {
      /* quota, non-fatal */
    }
  }, []);

  // Called by the upload widget. If results would be lost, ask first.
  const handleUpload = useCallback(
    (sc: NormalizedScorecard, name: string) => {
      if (analysis) {
        setPendingUpload({ sc, name });
      } else {
        commitUpload(sc, name);
      }
    },
    [analysis, commitUpload]
  );

  // Called by the Assistant tab: load its draft as the active scorecard.
  const handleLoadFromAssistant = useCallback(
    (sc: NormalizedScorecard) => {
      commitUpload(sc, `${sc.city.name} (assistant draft)`);
      setTab("dashboard");
    },
    [commitUpload]
  );

  const closeTour = useCallback(() => {
    setShowTour(false);
    setTipsDismissed(true);
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
      localStorage.setItem(TIPS_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);
  const replayTour = useCallback(() => setShowTour(true), []);
  const dismissTips = useCallback(() => {
    setTipsDismissed(true);
    try {
      localStorage.setItem(TIPS_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  const buildPayload = useCallback((): ExportPayload | null => {
    if (!scorecard || !analysis) return null;
    const meta: ExportMeta =
      analysisMeta ??
      { provider: settings ? PROVIDER_LABEL[settings.provider] : "AI", model: settings ? modelOf(settings) : "", generatedAt: new Date().toISOString() };
    return { scorecard, analysis, dataReport, meta };
  }, [scorecard, analysis, dataReport, analysisMeta, settings]);

  const handleExportReport = useCallback(() => {
    const p = buildPayload();
    if (p) downloadReport(p);
  }, [buildPayload]);
  const handleExportJson = useCallback(() => {
    const p = buildPayload();
    if (p) downloadJson(p);
  }, [buildPayload]);

  const handleClearResults = useCallback(() => {
    setAnalysis(null);
    setAnalysisMeta(null);
    setDataReport(null);
    setNarration("");
    setState(scorecard ? "ready" : "empty");
    try {
      localStorage.removeItem(ANALYSIS_KEY);
    } catch {
      /* ignore */
    }
  }, [scorecard]);

  const handleRemove = useCallback(() => {
    abortRef.current?.abort();
    setScorecard(null);
    setScFileName(null);
    setAnalysis(null);
    setAnalysisMeta(null);
    setProgress(null);
    setDataReport(null);
    setNarration("");
    setError(null);
    setState("empty");
    try {
      localStorage.removeItem(SCORECARD_KEY);
      localStorage.removeItem(SCORECARD_NAME_KEY);
      localStorage.removeItem(ANALYSIS_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // Removing while results exist should warn first (and offer a download).
  const requestRemove = useCallback(() => {
    if (analysis) setConfirmRemove(true);
    else handleRemove();
  }, [analysis, handleRemove]);

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
      const { result, dataReport: dr } = await runAnalysis(scorecard, settings, {
        onProgress: setProgress,
        onDataReport: setDataReport,
        onNarration: setNarration,
        signal: controller.signal,
      });
      const meta: ExportMeta = {
        provider: PROVIDER_LABEL[settings.provider],
        model: modelOf(settings),
        generatedAt: new Date().toISOString(),
      };
      setAnalysis(result);
      setDataReport(dr);
      setAnalysisMeta(meta);
      setState("results");
      try {
        localStorage.setItem(ANALYSIS_KEY, JSON.stringify({ result, dataReport: dr, meta }));
      } catch {
        /* quota, non-fatal */
      }
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
  const modelName = modelOf(settings);

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────── */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-surface/80 border-b border-border">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-2 sm:gap-4 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <Logo size={34} />
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-bold tracking-tight text-text-primary truncate">
                UNDRR ARISE Scorecard Analyzer
              </h1>
              <p className="hidden sm:block text-xs text-text-secondary">
                Disaster Resilience Assessment &amp; Action Planning
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 order-3 sm:order-none w-full sm:w-auto justify-between sm:justify-normal">
            <nav className="flex items-center gap-1 bg-surface-overlay/40 rounded-xl p-1">
              <button
                onClick={() => setTab("dashboard")}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  tab === "dashboard" ? "bg-primary-700 text-white" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                <LayoutDashboard size={15} /> <span className="hidden sm:inline">Dashboard</span>
              </button>
              <button
                onClick={() => setTab("assistant")}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  tab === "assistant" ? "bg-primary-700 text-white" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                <Bot size={15} /> <span className="hidden sm:inline">Assistant</span>
              </button>
              <button
                onClick={() => setTab("settings")}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  tab === "settings" ? "bg-primary-700 text-white" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                <SettingsIcon size={15} /> <span className="hidden sm:inline">Settings</span>
              </button>
            </nav>

            <ThemeToggle />

            {/* Fixed-width slot so switching tabs (button present on Dashboard,
                absent on Settings) doesn't shift the nav / theme toggle. */}
            <div className="flex justify-end items-center min-w-[112px] sm:min-w-[132px] shrink-0">
            {tab === "dashboard" && (state === "ready" || state === "results") && scorecard && (
              <button
                onClick={handleAnalyze}
                className="flex items-center gap-2 px-3.5 sm:px-5 py-2 rounded-xl text-sm font-semibold btn-accent transition-all shadow-lg shadow-accent-500/25 active:scale-95 shrink-0"
              >
                {state === "results" ? <RotateCcw size={16} /> : <Play size={16} />}
                {state === "results" ? "Re-run" : "Run Analysis"}
              </button>
            )}
            {tab === "dashboard" && state === "analyzing" && (
              <button
                onClick={cancelAnalyze}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm font-semibold bg-surface-overlay text-accent-400 border border-accent-500/30 shrink-0"
              >
                <Loader2 size={16} className="animate-spin" /> <span className="hidden sm:inline">Analysing… (cancel)</span><span className="sm:hidden">Cancel</span>
              </button>
            )}
            </div>
          </div>
        </div>

        <div className="border-t border-border/60 bg-surface/60">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-1.5">
            <StatusBar settings={settings} providerReady={providerReady} city={scorecard?.city.name ?? null} tavilyOn={tavilyActive} />
          </div>
        </div>
      </header>

      {/* ── Main ───────────────────────────────── */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-6">
        {/* Assistant stays mounted so a run keeps going even if you switch tabs
            (e.g. to change the model in Settings), just hidden when inactive. */}
        <div className={tab === "assistant" ? "" : "hidden"}>
          <AssistantTab
            settings={settings}
            providerReady={providerReady}
            onLoadIntoAnalyzer={handleLoadFromAssistant}
          />
        </div>

        <div key={tab} className="tab-enter">
        {tab === "settings" && (
          <SettingsTab settings={settings} onChange={handleSettingsChange} onReplayTutorial={replayTour} />
        )}

        {tab === "dashboard" && (
          <>
            <div className="mb-6">
              <SystemStatus
                scorecard={scorecard}
                fileName={scFileName}
                onRemove={requestRemove}
                settings={settings}
                providerReady={providerReady}
                modelName={modelName}
              />
            </div>
            {state === "error" && (
              <div className="flex items-center justify-center py-16 sm:py-24">
                <div className="glass-card p-6 sm:p-8 max-w-md text-center">
                  <AlertTriangle size={40} className="text-danger-400 mx-auto mb-4" />
                  <h2 className="text-lg font-semibold text-text-primary mb-2">Analysis failed</h2>
                  <p className="text-sm text-text-secondary mb-4">{error}</p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() => { setError(null); setState(scorecard ? "ready" : "empty"); }}
                      className="px-4 py-2 text-sm rounded-lg bg-primary-700 text-white hover:bg-primary-600 transition-colors"
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
                {!tipsDismissed && (
                  <GettingStarted onOpenSettings={() => setTab("settings")} onTakeTour={replayTour} onDismiss={dismissTips} />
                )}
                <div className="max-w-2xl mx-auto">
                  <ScorecardUpload onUploaded={handleUpload} />
                </div>
              </div>
            )}

            {(state === "ready" || state === "results" || state === "analyzing") && scorecard && (
              <div className="space-y-6">
                {state === "ready" && !analysis && !tipsDismissed && (
                  <GettingStarted onOpenSettings={() => setTab("settings")} onTakeTour={replayTour} onDismiss={dismissTips} />
                )}

                {/* City overview + upload */}
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                  <div className="glass-card p-5 lg:col-span-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-xl font-bold text-text-primary truncate">{scorecard.city.name}</h2>
                        <p className="text-sm text-text-secondary flex items-center gap-1 mt-0.5">
                          <MapPin size={13} /> {scorecard.city.country}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-3xl font-bold text-accent-400">
                          {scorecard.total}
                          <span className="text-lg text-text-secondary font-normal">/{scorecard.totalMax}</span>
                        </p>
                        <p className="text-xs text-text-secondary">{pct}% resilience</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
                      {scorecard.profile.population && (
                        <div className="flex items-center gap-2 text-sm">
                          <Users size={14} className="text-primary-300 shrink-0" />
                          <span className="text-text-secondary truncate">{scorecard.profile.population.toLocaleString()}</span>
                        </div>
                      )}
                      {scorecard.assessedDate && (
                        <div className="flex items-center gap-2 text-sm">
                          <Calendar size={14} className="text-primary-300 shrink-0" />
                          <span className="text-text-secondary truncate">{scorecard.assessedDate}</span>
                        </div>
                      )}
                      {scorecard.profile.incomeUsd && (
                        <div className="flex items-center gap-2 text-sm">
                          <Zap size={14} className="text-primary-300 shrink-0" />
                          <span className="text-text-secondary truncate">${scorecard.profile.incomeUsd.toLocaleString()}</span>
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

                {/* Weakest areas — computed straight from the scorecard, so it
                    shows something useful even for a high-scoring city. */}
                {(() => {
                  const weak = [...scorecard.indicators]
                    .filter((i) => typeof i.score === "number")
                    .sort((a, b) => (a.score as number) - (b.score as number));
                  const low = weak.filter((i) => (i.score as number) <= 1);
                  const show = (low.length ? low : weak.slice(0, 5));
                  if (!show.length) return null;
                  const heading = low.length
                    ? "Where this city looks weakest"
                    : "Its lowest-scoring areas";
                  return (
                    <div className="glass-card p-5">
                      <h2 className="text-base font-semibold text-text-primary flex items-center gap-2 mb-1">
                        <AlertTriangle size={16} className="text-warn-400" /> {heading}
                      </h2>
                      <p className="text-sm text-text-secondary mb-3">
                        These come straight from the scores in your file. Run the analysis for the reasons behind them and what to do next.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {show.map((ind) => {
                          const s = ind.score as number;
                          const t = s === 0
                            ? { box: "bg-danger-500/5 border-danger-500/15", code: "text-danger-400" }
                            : s === 1
                            ? { box: "bg-warn-500/5 border-warn-500/15", code: "text-warn-400" }
                            : { box: "bg-primary-500/5 border-primary-500/15", code: "text-primary-300" };
                          return (
                            <div key={ind.code} className={`flex items-start gap-2 p-3 rounded-lg border ${t.box}`}>
                              <span className={`font-mono text-xs shrink-0 mt-0.5 ${t.code}`}>{ind.code}</span>
                              <div className="min-w-0">
                                <p className="text-sm text-text-primary">{ind.text}</p>
                                <p className={`text-xs mt-0.5 ${t.code}`}>Scored {s} out of 3</p>
                                {ind.notes && <p className="text-xs text-text-secondary mt-0.5">{ind.notes}</p>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Live progress */}
                {state === "analyzing" && (
                  <>
                    <AnalysisProgress progress={progress} dataReport={dataReport} tavilyOn={tavilyActive} />
                    <DataSourcesPanel report={dataReport} live />
                    {narration && (
                      <div className="glass-card p-5">
                        <LiveStream text={narration} label="Live AI output" />
                      </div>
                    )}
                  </>
                )}

                {/* Results */}
                {state === "results" && analysis && (
                  <div className="space-y-6">
                    {/* Results toolbar: export + clear */}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={handleExportReport}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent transition-all active:scale-95"
                      >
                        <Download size={15} /> Export report
                      </button>
                      <button
                        onClick={handleExportJson}
                        className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium border border-border text-text-primary hover:border-accent-500/50 transition-all"
                      >
                        <FileJson size={15} /> Data (JSON)
                      </button>
                      <button
                        onClick={handleClearResults}
                        className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium border border-border text-text-secondary hover:text-danger-400 hover:border-danger-500/40 transition-all sm:ml-auto"
                      >
                        <Eraser size={15} /> Clear results
                      </button>
                    </div>

                    <DataSourcesPanel report={dataReport} />
                    <div className="glass-card p-5 sm:p-6">
                      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                        <h2 className="text-lg font-semibold text-text-primary">Analysis Summary</h2>
                        {analysisMeta && (
                          <span className="text-xs text-text-secondary bg-surface-overlay/50 border border-border rounded-full px-2.5 py-1">
                            by {analysisMeta.provider} · <span className="font-mono">{analysisMeta.model}</span>
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-text-secondary leading-relaxed">{analysis.summary}</p>
                      <p className="mt-3 text-xs text-text-secondary flex items-start gap-1.5 bg-surface-overlay/40 border border-border rounded-lg px-3 py-2">
                        <Info size={13} className="shrink-0 mt-0.5 text-primary-300" />
                        This analysis reflects the judgement of the AI model above. A different model
                        (or a re-run) may surface different strengths, gaps and recommendations, compare models for important decisions.
                      </p>

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
        </div>
      </main>

      {/* ── Footer ─────────────────────────────── */}
      <footer className="border-t border-border py-4 px-4 sm:px-6">
        <div className="max-w-[1600px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1 text-sm text-text-secondary">
          <span>UNDRR ARISE · Disaster Resilience Scorecard Analyzer</span>
          <span>Runs entirely in your browser · Deployed on Vercel</span>
        </div>
      </footer>

      {/* ── New-file warning modal ─────────────── */}
      <ConfirmModal
        open={!!pendingUpload}
        title="Replace the current scorecard?"
        onClose={() => setPendingUpload(null)}
        actions={[
          {
            label: "Download results, then replace",
            variant: "primary",
            onClick: () => {
              const p = buildPayload();
              if (p) downloadReport(p);
              if (pendingUpload) commitUpload(pendingUpload.sc, pendingUpload.name);
              setPendingUpload(null);
            },
          },
          {
            label: "Replace & discard",
            variant: "danger",
            onClick: () => {
              if (pendingUpload) commitUpload(pendingUpload.sc, pendingUpload.name);
              setPendingUpload(null);
            },
          },
          { label: "Cancel", variant: "ghost", onClick: () => setPendingUpload(null) },
        ]}
      >
        Loading <strong className="text-text-primary">{pendingUpload?.name}</strong> will clear the
        current analysis results for{" "}
        <strong className="text-text-primary">{scorecard?.city.name}</strong>. You can download the
        current results first, otherwise they&apos;ll be discarded.
      </ConfirmModal>

      {/* ── Remove-scorecard warning modal ─────── */}
      <ConfirmModal
        open={confirmRemove}
        title="Remove this scorecard?"
        onClose={() => setConfirmRemove(false)}
        actions={[
          {
            label: "Download results, then remove",
            variant: "primary",
            onClick: () => {
              const p = buildPayload();
              if (p) downloadReport(p);
              setConfirmRemove(false);
              handleRemove();
            },
          },
          {
            label: "Remove & discard",
            variant: "danger",
            onClick: () => {
              setConfirmRemove(false);
              handleRemove();
            },
          },
          { label: "Cancel", variant: "ghost", onClick: () => setConfirmRemove(false) },
        ]}
      >
        Removing <strong className="text-text-primary">{scorecard?.city.name}</strong> will erase its
        completed analysis results. This can&apos;t be undone, download them first if you want to
        keep a copy.
      </ConfirmModal>

      {/* ── First-visit / replayable tour ──────── */}
      <Onboarding open={showTour} onClose={closeTour} />

      {/* ── Slim footer (unobtrusive safety note) ─ */}
      <footer className="mt-auto border-t border-border px-4 sm:px-6 py-3">
        <p className="max-w-[1600px] mx-auto text-xs text-text-secondary text-center">
          The AI's answers can vary depending on the model you pick, so please have someone who knows disaster resilience look them over before acting on them. Everything runs right here in your browser.
        </p>
      </footer>
    </div>
  );
}
