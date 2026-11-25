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
  Download, FileJson, Eraser, Bot, HelpCircle, Lightbulb, Compass, ExternalLink, Sparkles, ClipboardCheck, Library, ArrowLeft,
} from "lucide-react";

import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { RadarChart } from "@/components/RadarChart";
import { ImpactDifficultyMatrix } from "@/components/ImpactDifficultyMatrix";
import { ActionPlan } from "@/components/ActionPlan";
import { ScoreProjection } from "@/components/ScoreProjection";
import { ProvenanceBadge } from "@/components/Provenance";
import { AnalysisSourceUse } from "@/components/DataSourceChips";
import { StatusBar } from "@/components/StatusBar";
import { GettingStarted } from "@/components/GettingStarted";
import { ModelSuggestion } from "@/components/ModelSuggestion";
import { AnalysisAdvisor } from "@/components/AnalysisAdvisor";
import { SectionTabs } from "@/components/SectionTabs";
import { renderInline } from "@/lib/ui/markdown";
import { AnalysisProgress } from "@/components/AnalysisProgress";
import { DataSourcesPanel } from "@/components/DataSourcesPanel";
import { SettingsTab } from "@/components/SettingsTab";
import { AssistantTab, type LaneSummary } from "@/components/AssistantTab";
import { AnalysisLibrary } from "@/components/AnalysisLibrary";
import {
  loadLibrary, storeLibrary, addToLibrary, otherShapes, newLibraryId,
  type SavedAnalysis, type SavedShape,
} from "@/lib/analysis/library";
import { LiveStream } from "@/components/LiveStream";
import { Onboarding } from "@/components/Onboarding";
import { SystemStatus } from "@/components/SystemStatus";
import { ConfirmModal } from "@/components/ConfirmModal";

import { runAnalysis } from "@/lib/analysis/analyze";
import { downloadReport, downloadJson, type ExportMeta, type ExportPayload } from "@/lib/export/report";
import {
  loadSettings, saveSettings as persistSettings, hasApiKey, isCloudProvider, hasSearchKey, modelForSettings,
  selectedProviders, settingsFor, providerIsReady, PROVIDER_LABEL,
  type AppSettings, type ProviderId,
} from "@/lib/settings/store";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { AnalysisResult } from "@/lib/analysis/schema";
import type { DataReport, ProgressEvent } from "@/lib/types";

type AppState = "empty" | "ready" | "analyzing" | "results" | "error";
type Tab = "dashboard" | "assistant" | "scorecard" | "settings";

const SCORECARD_KEY = "undrr.scorecard";
const SCORECARD_NAME_KEY = "undrr.scorecard.name";
const ANALYSIS_KEY = "undrr.analysis";
const REFINE_KEY = "undrr.refinefacts";
// Older single-analysis keys above are read once and moved here, per scorecard.
const ANALYSES_PREFIX = "undrr.analyses.";
const ONBOARDED_KEY = "undrr.onboarded.v1";
const TIPS_KEY = "undrr.tips.dismissed";

function modelOf(s: AppSettings): string {
  return modelForSettings(s);
}

function ConfidenceBadge({ level }: { level?: "high" | "medium" | "low" }) {
  if (!level) return null;
  const s =
    level === "high"
      ? { c: "text-accent-400 border-accent-500/30 bg-accent-500/10", t: "Well documented" }
      : level === "medium"
      ? { c: "text-warn-400 border-warn-500/30 bg-warn-500/10", t: "Reasonable inference" }
      : { c: "text-text-secondary border-border bg-surface-overlay/60", t: "Low certainty" };
  return (
    <span
      title={s.t}
      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${s.c}`}
    >
      {level} confidence
    </span>
  );
}

/** One AI helper's analysis on the Analysis tab. */
interface LaneAnalysis {
  scorecard: NormalizedScorecard | null;
  fileName: string | null;
  analysis: AnalysisResult | null;
  meta: ExportMeta | null;
  dataReport: DataReport | null;
  state: AppState;
  progress: ProgressEvent | null;
  narration: string;
  error: string | null;
  /** Local facts the user shared with the advisor, folded into re-runs. */
  refineFacts: string[];
  /** The place it was made for (an analysis of another place is stale) and whose scorecard it read. */
  placeKey: string | null;
  source: ProviderId | null;
  /** The city (whatever its outline), how it was shown, and its outline: kept with the saved analysis. */
  cityKey: string | null;
  place: string | null;
  shape: SavedShape | null;
}
const blankLane = (): LaneAnalysis => ({
  scorecard: null, fileName: null, analysis: null, meta: null, dataReport: null,
  state: "empty", progress: null, narration: "", error: null, refineFacts: [], placeKey: null, source: null,
  cityKey: null, place: null, shape: null,
});

/** What's kept per helper in the browser (the finished parts, not a run in progress). */
interface SavedLane {
  scorecard: NormalizedScorecard;
  fileName: string | null;
  result: AnalysisResult | null;
  dataReport: DataReport | null;
  meta: ExportMeta | null;
  refineFacts?: string[];
  placeKey?: string | null;
  source?: ProviderId | null;
  cityKey?: string | null;
  place?: string | null;
  shape?: SavedShape | null;
}

/** The analyses belong to the scorecard (Assistant session) they were made for. */
const analysesKey = (sessionId: string) => `${ANALYSES_PREFIX}${sessionId}`;

function loadAnalyses(sessionId: string, primary: ProviderId): Record<string, LaneAnalysis> {
  const out: Record<string, LaneAnalysis> = {};
  try {
    let saved = JSON.parse(localStorage.getItem(analysesKey(sessionId)) || "null") as Record<string, SavedLane> | null;
    // Once: carry the single analysis saved before helpers had their own tabs
    // over to the primary helper of the scorecard that's open.
    const oldSc = localStorage.getItem(SCORECARD_KEY);
    if (!saved && oldSc) {
      const oldA = JSON.parse(localStorage.getItem(ANALYSIS_KEY) || "null") as { result: AnalysisResult; dataReport: DataReport | null; meta: ExportMeta } | null;
      saved = {
        [primary]: {
          scorecard: JSON.parse(oldSc), fileName: localStorage.getItem(SCORECARD_NAME_KEY),
          result: oldA?.result ?? null, dataReport: oldA?.dataReport ?? null, meta: oldA?.meta ?? null,
          refineFacts: JSON.parse(localStorage.getItem(REFINE_KEY) || "[]"),
        },
      };
      localStorage.setItem(analysesKey(sessionId), JSON.stringify(saved));
      [SCORECARD_KEY, SCORECARD_NAME_KEY, ANALYSIS_KEY, REFINE_KEY].forEach((k) => localStorage.removeItem(k));
    }
    for (const [p, l] of Object.entries(saved || {})) {
      if (!l?.scorecard) continue;
      out[p] = {
        ...blankLane(),
        scorecard: l.scorecard, fileName: l.fileName, analysis: l.result, dataReport: l.dataReport, meta: l.meta,
        refineFacts: Array.isArray(l.refineFacts) ? l.refineFacts : [],
        placeKey: l.placeKey ?? null,
        source: l.source ?? (p as ProviderId),
        cityKey: l.cityKey ?? null,
        place: l.place ?? null,
        shape: l.shape ?? null,
        state: l.result ? "results" : "ready",
      };
    }
  } catch {
    /* ignore corrupt cache */
  }
  return out;
}

function saveAnalyses(sessionId: string, all: Record<string, LaneAnalysis>) {
  const out: Record<string, SavedLane> = {};
  for (const [p, l] of Object.entries(all)) {
    if (!l.scorecard) continue;
    out[p] = { scorecard: l.scorecard, fileName: l.fileName, result: l.analysis, dataReport: l.dataReport, meta: l.meta, refineFacts: l.refineFacts, placeKey: l.placeKey, source: l.source, cityKey: l.cityKey, place: l.place, shape: l.shape };
  }
  try {
    if (Object.keys(out).length) localStorage.setItem(analysesKey(sessionId), JSON.stringify(out));
    else localStorage.removeItem(analysesKey(sessionId));
  } catch {
    /* quota, non-fatal */
  }
}

/** Where an analysis is aimed, from the Assistant's current place. */
const targetOf = (s: LaneSummary | null): Pick<LaneAnalysis, "placeKey" | "cityKey" | "place" | "shape"> => ({
  placeKey: s?.placeKey ?? null,
  cityKey: s?.cityKey ?? null,
  place: s?.place ?? null,
  shape: s?.shape ?? null,
});

const listLabels = (ps: ProviderId[]) => {
  const names = ps.map((p) => PROVIDER_LABEL[p]);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

export default function Page() {
  const [tab, setTab] = useState<Tab>("assistant"); // start where scorecards are built or uploaded
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tavilyActive, setTavilyActive] = useState(false);

  // Each helper's analysis of its own scorecard, for the scorecard (session) that's open.
  const [sessionId, setSessionId] = useState("");
  const sessionIdRef = useRef("");
  const [analyses, setAnalyses] = useState<Record<string, LaneAnalysis>>({});
  const analysesRef = useRef(analyses);
  analysesRef.current = analyses;
  const [activeLane, setActiveLane] = useState<ProviderId>("gemini");
  // The Assistant's current place and finished scorecards (what the Analysis tab offers).
  const [summary, setSummary] = useState<LaneSummary | null>(null);
  const summaryRef = useRef<LaneSummary | null>(null);
  summaryRef.current = summary;
  const scorecardSource = useRef<((p: ProviderId) => NormalizedScorecard | null) | null>(null);

  // ── Saved analyses library ──────────────────────────
  const [library, setLibrary] = useState<SavedAnalysis[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  // A saved analysis being looked at (read-only) instead of the live one.
  const [viewing, setViewing] = useState<SavedAnalysis | null>(null);
  // Analyses of a city that was saved before with another outline, waiting for "replace or keep both".
  const [pendingSaves, setPendingSaves] = useState<Array<{ entry: SavedAnalysis; others: SavedAnalysis[] }>>([]);
  // The answer for a city + outline applies to every helper's analysis of it.
  const saveDecisions = useRef<Map<string, "replace" | "keep">>(new Map());
  useEffect(() => { setLibrary(loadLibrary()); }, []);

  const writeLibrary = useCallback((entry: SavedAnalysis, replaceOtherShapes: boolean) => {
    const next = addToLibrary(loadLibrary(), entry, replaceOtherShapes);
    if (storeLibrary(next)) {
      setLibrary(next);
      setLibraryError(null);
    } else {
      setLibraryError("This analysis couldn't be saved to the library because the browser's storage is full. Download the report to keep it, or delete some saved analyses.");
    }
  }, []);

  /** File a finished analysis, asking first if it would sit beside the same city with another outline. */
  const saveToLibrary = useCallback((entry: SavedAnalysis) => {
    const decision = saveDecisions.current.get(`${entry.cityKey}::${entry.placeKey}`);
    const others = otherShapes(loadLibrary(), entry);
    if (others.length && !decision) setPendingSaves((q) => [...q, { entry, others }]);
    else writeLibrary(entry, decision === "replace");
  }, [writeLibrary]);

  const resolvePendingSave = useCallback((choice: "replace" | "keep") => {
    setPendingSaves((q) => {
      if (!q.length) return q;
      const key = `${q[0].entry.cityKey}::${q[0].entry.placeKey}`;
      saveDecisions.current.set(key, choice);
      // Everything queued for the same city and outline follows the same answer.
      const now = q.filter((x) => `${x.entry.cityKey}::${x.entry.placeKey}` === key);
      for (const x of now) writeLibrary(x.entry, choice === "replace");
      return q.filter((x) => !now.includes(x));
    });
  }, [writeLibrary]);

  const deleteFromLibrary = useCallback((e: SavedAnalysis) => {
    const next = loadLibrary().filter((x) => x.id !== e.id);
    storeLibrary(next);
    setLibrary(next);
    setViewing((v) => (v?.id === e.id ? null : v));
  }, []);

  // Pending load awaiting confirmation (because it would replace that helper's results)
  const [pendingUpload, setPendingUpload] = useState<{ p: ProviderId; sc: NormalizedScorecard; name: string; source: ProviderId } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [assistantRunning, setAssistantRunning] = useState<ProviderId[]>([]);
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const [tipsDismissed, setTipsDismissed] = useState(true); // assume seen until mount says otherwise

  const abortRefs = useRef<Partial<Record<ProviderId, AbortController>>>({});

  const selected = settings ? selectedProviders(settings) : [];
  const lane: ProviderId = selected.includes(activeLane) ? activeLane : selected[0] ?? "gemini";
  const live = analyses[lane] ?? blankLane();
  // Looking at a saved analysis shows it in place of the live one (read-only).
  const cur: LaneAnalysis = viewing
    ? { ...blankLane(), scorecard: viewing.scorecard, analysis: viewing.result, dataReport: viewing.dataReport, meta: viewing.meta, state: "results", source: viewing.source }
    : live;
  // The selected helper's analysis, under the names the results view uses.
  const { scorecard, fileName: scFileName, analysis, meta: analysisMeta, dataReport, state, progress, narration, error, refineFacts } = cur;
  const refineContext = refineFacts.join("\n\n---\n\n");
  const laneSettings = settings ? settingsFor(settings, lane) : null;
  const providerReady = providerIsReady(lane);
  const analyzingLanes = selected.filter((p) => analyses[p]?.state === "analyzing");

  const patchLane = useCallback((p: ProviderId, patch: Partial<LaneAnalysis>) => {
    setAnalyses((all) => ({ ...all, [p]: { ...(all[p] ?? blankLane()), ...patch } }));
  }, []);

  // ── Load persisted state on mount ─────────────────────────
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    setActiveLane(s.provider);
    setTavilyActive(!!s.useTavily && hasSearchKey());
    try {
      const onboarded = !!localStorage.getItem(ONBOARDED_KEY);
      setShowTour(!onboarded);
      setTipsDismissed(onboarded && !!localStorage.getItem(TIPS_KEY));
    } catch {
      /* ignore */
    }
    return () => { for (const c of Object.values(abortRefs.current)) c?.abort(); };
  }, []);

  // The Assistant picked a scorecard: show that scorecard's analyses (and stop
  // any still running for the previous one).
  const handleSessionChange = useCallback((id: string) => {
    if (id === sessionIdRef.current || !settings) return;
    for (const c of Object.values(abortRefs.current)) c?.abort();
    abortRefs.current = {};
    sessionIdRef.current = id;
    setSessionId(id);
    setAnalyses(loadAnalyses(id, selectedProviders(settings)[0]));
    setPendingUpload(null);
    setRefineOpen(false);
    setViewing(null);
  }, [settings]);

  // Keep the finished parts of every helper's analysis for this scorecard.
  useEffect(() => {
    if (sessionId && sessionId === sessionIdRef.current) saveAnalyses(sessionId, analyses);
  }, [analyses, sessionId]);

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
  }, [tab, state, analysis, lane]);

  const handleSettingsChange = useCallback((s: AppSettings) => {
    persistSettings(s);
    setSettings(s);
    setTavilyActive(!!s.useTavily && hasSearchKey());
  }, []);

  // One-tap provider switch used by the suggestion bars: use just that helper.
  // If there's no key for it yet, send them to Settings to add one.
  const useProvider = useCallback((p: AppSettings["provider"]) => {
    setSettings((s) => {
      if (!s) return s;
      const next = { ...s, provider: p, providers: [p] };
      persistSettings(next);
      return next;
    });
    setActiveLane(p);
    if (isCloudProvider(p) && !hasApiKey(p)) setTab("settings");
  }, []);

  // Wipe the saved advisor conversations, so nothing stale carries over.
  const clearAdvisorState = useCallback(() => {
    try { localStorage.removeItem("undrr.advisor.threads"); } catch { /* ignore */ }
  }, []);

  // Give a helper a new scorecard to analyze (replaces its results).
  const commitUpload = useCallback((p: ProviderId, sc: NormalizedScorecard, name: string, source: ProviderId) => {
    abortRefs.current[p]?.abort(); // stop that helper's analysis in progress before swapping
    patchLane(p, { ...blankLane(), scorecard: sc, fileName: name, state: "ready", source, ...targetOf(summaryRef.current) });
    clearAdvisorState();
  }, [patchLane, clearAdvisorState]);

  // Called by a helper's Scorecard tab: load its draft on its Analysis sub-tab,
  // then run the analysis as soon as it's committed (see the effect after handleAnalyze).
  const autoRunRef = useRef<ProviderId | null>(null);
  const handleLoadFromAssistant = useCallback(
    (p: ProviderId, sc: NormalizedScorecard) => {
      const name = `${sc.city.name} (${PROVIDER_LABEL[p]} draft)`;
      const l = analysesRef.current[p];
      autoRunRef.current = p;
      setActiveLane(p);
      if (l?.analysis || l?.state === "analyzing") setPendingUpload({ p, sc, name, source: p });
      else commitUpload(p, sc, name, p);
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
      { provider: PROVIDER_LABEL[lane], model: laneSettings ? modelOf(laneSettings) : "", generatedAt: new Date().toISOString() };
    return { scorecard, analysis, dataReport, meta };
  }, [scorecard, analysis, dataReport, analysisMeta, lane, laneSettings]);

  const handleExportReport = useCallback(() => {
    const p = buildPayload();
    if (p) downloadReport(p);
  }, [buildPayload]);
  const handleExportJson = useCallback(() => {
    const p = buildPayload();
    if (p) downloadJson(p);
  }, [buildPayload]);

  const handleClearResults = useCallback(() => {
    patchLane(lane, { analysis: null, meta: null, dataReport: null, narration: "", refineFacts: [], state: scorecard ? "ready" : "empty" });
    clearAdvisorState();
  }, [lane, scorecard, patchLane, clearAdvisorState]);

  // "Clear all Information" on the Assistant: this scorecard's analyses go too.
  const handleClearAll = useCallback(() => {
    for (const c of Object.values(abortRefs.current)) c?.abort();
    abortRefs.current = {};
    setAnalyses({});
    setPendingUpload(null);
    setRefineOpen(false);
    clearAdvisorState();
  }, [clearAdvisorState]);
  const handleSessionDeleted = useCallback((id: string) => {
    try { localStorage.removeItem(analysesKey(id)); } catch { /* ignore */ }
  }, []);

  // The dropdown on the Analysis tab: analyze another helper's finished scorecard.
  const selectSource = useCallback((src: ProviderId) => {
    const sc = scorecardSource.current?.(src);
    if (!sc) return;
    const name = `${sc.city.name} (${PROVIDER_LABEL[src]} scorecard)`;
    if (analysesRef.current[lane]?.analysis || analysesRef.current[lane]?.state === "analyzing") setPendingUpload({ p: lane, sc, name, source: src });
    else commitUpload(lane, sc, name, src);
  }, [lane, commitUpload]);

  // Opening the Analysis tab shows the Assistant's current place: analyses made
  // for another place are cleared, and each helper whose scorecard is finished
  // has it loaded, ready to analyze.
  useEffect(() => {
    if (tab !== "dashboard" || !summary || !settings) return;
    const fresh: Partial<Record<ProviderId, LaneAnalysis>> = {};
    for (const p of selectedProviders(settings)) {
      const l = analysesRef.current[p];
      const stale = !!l && l.placeKey !== summary.placeKey;
      if (stale) abortRefs.current[p]?.abort();
      if ((!l?.scorecard || stale) && summary.complete.includes(p)) {
        const sc = scorecardSource.current?.(p);
        if (sc) {
          fresh[p] = { ...blankLane(), scorecard: sc, fileName: `${sc.city.name} (${PROVIDER_LABEL[p]} scorecard)`, state: "ready", source: p, ...targetOf(summary) };
          continue;
        }
      }
      if (stale) fresh[p] = blankLane();
    }
    if (Object.keys(fresh).length) setAnalyses((all) => ({ ...all, ...fresh }));
  }, [tab, summary, settings]);

  const handleAnalyze = useCallback(async (p: ProviderId) => {
    const l = analysesRef.current[p];
    if (!l?.scorecard || !settings) return;
    if (l.state === "analyzing") return; // don't stack a second run on a live one
    if (assistantRunning.includes(p)) return; // this helper is mid-fill; don't run both at once
    if (advisorBusy) return; // the advisor is generating; don't hit the API twice at once
    if (!providerIsReady(p)) {
      setTab("settings");
      return;
    }
    const extraContext = l.refineFacts.join("\n\n---\n\n").trim() || undefined;
    // On a refine re-run (we have facts AND an existing analysis), let the model
    // read what it wrote before so it improves rather than starts blind.
    const priorSummary = extraContext && l.analysis ? l.analysis.summary : undefined;
    patchLane(p, { state: "analyzing", error: null, progress: null, dataReport: null, narration: "" });

    const controller = new AbortController();
    abortRefs.current[p] = controller;
    const sid = sessionIdRef.current;
    // Updates from a run that belongs to a scorecard no longer open are dropped.
    const live = (patch: Partial<LaneAnalysis>) => { if (sid === sessionIdRef.current) patchLane(p, patch); };
    const ps = settingsFor(settings, p);

    try {
      const { result, dataReport: dr } = await runAnalysis(l.scorecard, ps, {
        onProgress: (e) => live({ progress: e }),
        onDataReport: (d) => live({ dataReport: d }),
        onNarration: (n) => live({ narration: n }),
        signal: controller.signal,
        extraContext,
        priorSummary,
      });
      if (ps.dataSources?.length) result.dataSources = [...ps.dataSources];
      const meta: ExportMeta = { provider: PROVIDER_LABEL[p], model: modelOf(ps), generatedAt: new Date().toISOString() };
      live({ analysis: result, dataReport: dr, meta, state: "results" });
      // Keep it in the saved analyses library (even if the Assistant has moved on since).
      saveToLibrary({
        id: newLibraryId(),
        savedAt: meta.generatedAt,
        cityKey: l.cityKey || (l.scorecard.city.name || "unknown").toLowerCase(),
        placeKey: l.placeKey || l.cityKey || l.scorecard.city.name.toLowerCase(),
        place: l.place || l.scorecard.city.name,
        shape: l.shape || { kind: "Scorecard", detail: "" },
        provider: p,
        source: l.source || p,
        scorecard: l.scorecard,
        result,
        dataReport: dr,
        meta,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        live({ state: analysesRef.current[p]?.scorecard ? "ready" : "empty" });
        return;
      }
      live({ error: err instanceof Error ? err.message : String(err), state: "error" });
    }
  }, [settings, assistantRunning, advisorBusy, patchLane, saveToLibrary]);

  // One-click "Run analysis" from a helper's Scorecard tab: fire once its new
  // scorecard has been committed (immediately, or after the replace confirmation).
  useEffect(() => {
    const p = autoRunRef.current;
    if (!p || tab !== "dashboard" || analyses[p]?.state !== "ready" || !analyses[p]?.scorecard) return;
    autoRunRef.current = null;
    void handleAnalyze(p);
  }, [analyses, tab, handleAnalyze]);

  // Add a piece of local data the advisor gathered (deduped). The analysis,
  // the advisor banner, and the next re-run all read from this one list.
  const addRefineFact = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setAnalyses((all) => {
      const l = all[lane] ?? blankLane();
      return l.refineFacts.includes(t) ? all : { ...all, [lane]: { ...l, refineFacts: [...l.refineFacts, t] } };
    });
  }, [lane]);

  const removeRefineFact = useCallback((text: string) => {
    setAnalyses((all) => {
      const l = all[lane] ?? blankLane();
      return { ...all, [lane]: { ...l, refineFacts: l.refineFacts.filter((f) => f !== text) } };
    });
  }, [lane]);

  // Re-run the analysis folding in everything the user has added so far.
  const rerunWithFacts = useCallback(() => {
    setRefineOpen(false);
    void handleAnalyze(lane);
  }, [handleAnalyze, lane]);

  const clearRefineFacts = useCallback(() => patchLane(lane, { refineFacts: [] }), [lane, patchLane]);

  const cancelAnalyze = useCallback(() => {
    abortRefs.current[lane]?.abort();
    patchLane(lane, { state: scorecard ? "ready" : "empty" });
  }, [lane, scorecard, patchLane]);

  // While any helper is filling or analysing, the helper choice in Settings is locked.
  const settingsLock = assistantRunning.length
    ? `${listLabels(assistantRunning)} ${assistantRunning.length === 1 ? "is" : "are"} currently filling out the scorecard on the Assistant tab. You can change the AI helpers once ${assistantRunning.length === 1 ? "it finishes" : "they finish"} or ${assistantRunning.length === 1 ? "is" : "are"} stopped.`
    : analyzingLanes.length
    ? `The analysis is being performed on the Analysis tab by ${listLabels(analyzingLanes)}. You can change the AI helpers once it finishes or is cancelled.`
    : advisorBusy
    ? "The analysis advisor is writing a reply on the Analysis tab. You can change the AI helpers once it finishes."
    : null;
  // Helpers that can't start a fill right now (their analysis or the advisor is running).
  const busyProviders = advisorBusy ? [...analyzingLanes, lane] : analyzingLanes;

  if (!settings) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-accent-400" />
      </div>
    );
  }

  const pct = scorecard ? Math.round((scorecard.total / scorecard.totalMax) * 100) : 0;
  const modelName = modelOf(laneSettings ?? settings);

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────── */}
      <header className="sticky top-0 z-40 [backdrop-filter:blur(26px)_saturate(180%)] [-webkit-backdrop-filter:blur(26px)_saturate(180%)] bg-surface/55 border-b border-border/70">
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
            <SectionTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "assistant" as const, label: "Assistant", shortLabel: "Build", icon: <Bot size={15} /> },
                { id: "scorecard" as const, label: "Scorecard", shortLabel: "Card", icon: <ClipboardCheck size={15} /> },
                { id: "dashboard" as const, label: "Analysis", shortLabel: "Results", icon: <LayoutDashboard size={15} /> },
                { id: "settings" as const, label: "Settings", shortLabel: "Setup", icon: <SettingsIcon size={15} /> },
              ]}
            />

            <a
              href="/data-sources"
              target="_blank"
              rel="noreferrer"
              title="Open a directory of free, credible data sources you can fact-check and paste in"
              className="glass-bar press flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full text-sm font-medium text-accent-400 hover:text-accent-300 transition-all"
            >
              <Compass size={15} /> <span className="hidden sm:inline">Find data</span>
              <ExternalLink size={12} className="hidden sm:inline opacity-70" />
            </a>

            <ThemeToggle />

            {/* Fixed-width slot so switching tabs (button present on Analysis,
                absent on Settings) doesn't shift the nav / theme toggle. */}
            <div className="flex justify-end items-center min-w-[112px] sm:min-w-[132px] shrink-0">
            {tab === "dashboard" && !viewing && (state === "ready" || state === "results") && scorecard && (
              <button
                onClick={() => handleAnalyze(lane)}
                disabled={assistantRunning.includes(lane) || advisorBusy}
                title={assistantRunning.includes(lane) ? `${PROVIDER_LABEL[lane]} is still filling its scorecard. Let it finish, then run the analysis.` : advisorBusy ? "The advisor is still writing. One moment, then you can re-run." : refineFacts.length ? `Re-run, folding in the ${refineFacts.length} piece(s) of data you added` : undefined}
                className="relative flex items-center gap-2 px-3.5 sm:px-5 py-2 rounded-xl text-sm font-semibold btn-accent transition-all shadow-lg shadow-accent-500/25 active:scale-95 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {state === "results" ? <RotateCcw size={16} /> : <Play size={16} />}
                {state === "results" ? (refineFacts.length ? "Re-run with your data" : "Re-run") : "Run Analysis"}
                {refineFacts.length > 0 && (
                  <span className="absolute -top-2 -right-2 min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full bg-white text-accent-600 text-[10px] font-bold border border-accent-500">{refineFacts.length}</span>
                )}
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
            <StatusBar settings={settings} city={scorecard?.city.name ?? null} tavilyOn={tavilyActive} />
          </div>
        </div>
      </header>

      {/* ── Main ───────────────────────────────── */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-6">
        {/* Assistant + Scorecard stay mounted so a run keeps going even if you
            switch tabs (e.g. to change the model in Settings), just hidden when
            inactive. They are one component sharing the live draft. */}
        <div className={tab === "assistant" || tab === "scorecard" ? "" : "hidden"}>
          <AssistantTab
            view={tab === "scorecard" ? "scorecard" : "assistant"}
            onOpenView={setTab}
            settings={settings}
            activeLane={lane}
            onActiveLaneChange={setActiveLane}
            onLoadIntoAnalyzer={handleLoadFromAssistant}
            onUseProvider={useProvider}
            onRunningChange={setAssistantRunning}
            busyProviders={busyProviders}
            onSessionChange={handleSessionChange}
            onLaneSummary={setSummary}
            scorecardSource={scorecardSource}
            onClearAll={handleClearAll}
            onSessionDeleted={handleSessionDeleted}
          />
        </div>

        <div key={tab} className="tab-enter">
        {tab === "settings" && (
          <SettingsTab settings={settings} onChange={handleSettingsChange} onReplayTutorial={replayTour} lockReason={settingsLock} />
        )}

        {tab === "dashboard" && (
          <>
            {/* One sub-tab per AI helper: each analyses its own copy of the scorecard. */}
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
            <div role="tablist" aria-label="AI helpers" className="flex flex-wrap gap-1.5">
              {selected.map((p) => {
                const l = analyses[p];
                const on = p === lane && !viewing;
                return (
                  <button key={p} role="tab" aria-selected={on} onClick={() => { setViewing(null); setActiveLane(p); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors ${on ? "border-accent-500/60 bg-accent-500/15 text-text-primary font-medium" : "border-border bg-surface-overlay text-text-secondary hover:text-text-primary"}`}>
                    {l?.state === "analyzing" ? <Loader2 size={13} className="animate-spin text-accent-400" />
                      : l?.state === "results" ? <CheckCircle2 size={13} className="text-accent-400" />
                      : l?.state === "error" ? <AlertTriangle size={13} className="text-danger-400" />
                      : <Bot size={13} className="text-text-secondary" />}
                    {PROVIDER_LABEL[p]}
                    {l?.scorecard && <span className="text-xs text-text-secondary truncate max-w-[10rem]">· {l.scorecard.city.name}</span>}
                  </button>
                );
              })}
            </div>
              <button onClick={() => setLibraryOpen(true)}
                title="Every finished analysis, saved in this browser: open, download or delete them"
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-border bg-surface-overlay text-text-primary hover:border-primary-500/40">
                <Library size={14} className="text-accent-400" /> Saved analyses
                <span className="text-xs tabular-nums text-text-secondary">{library.length}</span>
              </button>
            </div>
            {libraryError && (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn-500/30 bg-warn-500/10 px-3.5 py-2.5 text-sm text-warn-400">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <span className="flex-1">{libraryError}</span>
                <button onClick={() => setLibraryError(null)} aria-label="Dismiss" className="shrink-0 hover:text-text-primary">✕</button>
              </div>
            )}
            {viewing && (
              <div className="mb-4 glass-card p-3 sm:p-4 flex flex-wrap items-center gap-3 border-l-4 border-l-accent-500">
                <Library size={18} className="text-accent-400 shrink-0" />
                <div className="flex-1 min-w-0 text-sm">
                  <p className="text-text-primary font-medium">
                    Saved analysis · {PROVIDER_LABEL[viewing.provider]} · {viewing.place}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {viewing.shape.kind}{viewing.shape.detail ? ` · ${viewing.shape.detail}` : ""} · saved {new Date(viewing.savedAt).toLocaleString()}
                    {viewing.source !== viewing.provider ? ` · on ${PROVIDER_LABEL[viewing.source]}'s scorecard` : ""} · read-only
                  </p>
                </div>
                <button onClick={() => setViewing(null)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40">
                  <ArrowLeft size={14} /> Back to current analysis
                </button>
              </div>
            )}
            {!viewing && (
            <div className="mb-6">
              <SystemStatus
                scorecard={scorecard}
                fileName={scFileName}
                sources={(() => {
                  const ids = [...(summary?.complete ?? [])];
                  if (cur.source && scorecard && !ids.includes(cur.source)) ids.push(cur.source);
                  return ids.map((id) => ({ id, label: `${PROVIDER_LABEL[id]}: ${summary?.place ?? scorecard?.city.name ?? ""}` }));
                })()}
                selectedSource={scorecard ? cur.source : null}
                onSelectSource={(id) => selectSource(id as ProviderId)}
                sourceDisabled={state === "analyzing"}
                settings={laneSettings ?? settings}
                providerReady={providerReady}
                modelName={modelName}
              />
            </div>
            )}
            {state === "error" && (
              <div className="flex items-center justify-center py-16 sm:py-24">
                <div className="glass-card p-6 sm:p-8 max-w-md text-center">
                  <AlertTriangle size={40} className="text-danger-400 mx-auto mb-4" />
                  <h2 className="text-lg font-semibold text-text-primary mb-2">Analysis failed</h2>
                  <p className="text-sm text-text-secondary mb-4">{error}</p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() => patchLane(lane, { error: null, state: scorecard ? "ready" : "empty" })}
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
                  <GettingStarted onOpenSettings={() => setTab("settings")} onTakeTour={replayTour} onDismiss={dismissTips} ready={providerReady} />
                )}
                <div className="max-w-2xl mx-auto glass-card p-8 text-center">
                  <Bot size={32} className="text-accent-400 mx-auto mb-3" />
                  <h2 className="text-lg font-semibold text-text-primary mb-1">No {PROVIDER_LABEL[lane]} analysis for this scorecard yet</h2>
                  <p className="text-sm text-text-secondary mb-4">
                    {summary?.complete.length
                      ? <>Choose a finished scorecard for {summary.place} in the box above, then press Run Analysis.</>
                      : <>Once a helper finishes its scorecard for {summary?.place ?? "this city"} on the Assistant tab, pick it in the box above (or press Run analysis on its Scorecard tab) and {PROVIDER_LABEL[lane]}&apos;s results appear here.</>}
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    <button onClick={() => setTab("scorecard")} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent">
                      <ClipboardCheck size={16} /> Upload a scorecard
                    </button>
                    <button onClick={() => setTab("assistant")} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40">
                      <Bot size={16} /> Build one with the Assistant
                    </button>
                  </div>
                </div>
              </div>
            )}

            {(state === "ready" || state === "results" || state === "analyzing") && scorecard && (
              <div className="space-y-6">
                {state === "ready" && !analysis && !tipsDismissed && (
                  <GettingStarted onOpenSettings={() => setTab("settings")} onTakeTour={replayTour} onDismiss={dismissTips} ready={providerReady} />
                )}

                <ModelSuggestion
                  show={!selected.includes("gemini") && state !== "analyzing" && !viewing}
                  title="Tip: Gemini is the fastest pick for analysis"
                  body="For the Analysis tab, Google Gemini runs straight from your browser (no timeouts) and is quick and capable. Great for reading a scorecard."
                  cta="Use Gemini"
                  onUse={() => useProvider("gemini")}
                  storageKey="undrr-suggest-gemini-dashboard"
                />

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

                  {!viewing && (
                  <div className="lg:col-span-2 glass-card p-5 flex flex-col justify-center gap-3">
                    <p className="text-sm text-text-secondary">
                      To analyze a different helper&apos;s finished scorecard, pick it in the box above. To change
                      answers, edit them on the Scorecard tab, then press Run analysis there.
                    </p>
                    <button onClick={() => setTab("scorecard")} className="self-start inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40">
                      <ClipboardCheck size={15} /> Open the Scorecard
                    </button>
                  </div>
                  )}
                </div>

                {/* Radar */}
                <RadarChart essentials={scorecard.essentials} />

                {/* Weakest areas, computed straight from the scorecard, so it
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
                    <AnalysisProgress progress={progress} dataReport={dataReport} tavilyOn={tavilyActive} hasContext={!!refineContext} />
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
                    {/* Results toolbar: a friendly "save & share" bar */}
                    <div className="glass-card p-3 sm:p-4 flex flex-wrap items-center gap-2.5">
                      <div className="flex items-center gap-2 mr-1 shrink-0">
                        <span className="grid place-items-center w-8 h-8 rounded-lg bg-accent-500/15 text-accent-300">
                          <Download size={16} />
                        </span>
                        <span className="text-sm font-semibold text-text-primary hidden sm:inline">Save &amp; share</span>
                      </div>
                      <button
                        onClick={handleExportReport}
                        title="Download a clean, printable report of this analysis (HTML). Great for sharing."
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold btn-accent lift active:scale-95"
                      >
                        <Download size={16} /> Download report
                      </button>
                      <button
                        onClick={handleExportJson}
                        title="Download the raw analysis as a JSON data file."
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-accent-500/12 text-accent-300 border border-accent-500/30 hover:border-accent-500/60 hover:text-accent-200 lift active:scale-95 transition-all"
                      >
                        <FileJson size={16} /> Download data
                      </button>
                      {!viewing && (<>
                      <div className="w-px h-7 bg-border mx-0.5 hidden sm:block" />
                      <button
                        onClick={() => setRefineOpen(true)}
                        title="Ask the analysis advisor to sanity-check this or fold in data you found"
                        className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-medium text-text-secondary hover:text-accent-300 border border-transparent hover:border-accent-500/30 transition-all"
                      >
                        <Lightbulb size={15} /> Am I missing something?
                      </button>
                      <button
                        onClick={() => setConfirmClear(true)}
                        title="Clear this analysis"
                        className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-text-secondary hover:text-danger-400 hover:bg-danger-500/10 transition-all sm:ml-auto"
                      >
                        <Eraser size={15} /> <span className="hidden sm:inline">Clear</span>
                      </button>
                      </>)}
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
                      <p className="text-sm text-text-secondary leading-relaxed [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderInline(analysis.summary) }} />
                      <p className="mt-3 text-xs text-text-secondary flex items-start gap-1.5 bg-surface-overlay/40 border border-border rounded-lg px-3 py-2">
                        <Info size={13} className="shrink-0 mt-0.5 text-primary-300" />
                        This analysis reflects the judgement of the AI model above. A different model
                        (or a re-run) may surface different strengths, gaps and recommendations, compare models for important decisions.
                        The scores are heuristic estimates, best read comparatively rather than as exact measurements, and the label on each point shows how well-evidenced it is (low usually means an inference worth checking locally).
                      </p>

                      {analysis.riskProfile && (
                        <div className="mt-5">
                          <h3 className="text-sm font-semibold text-text-primary mb-2">Risk lens</h3>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            {([
                              ["Hazard", analysis.riskProfile.hazard, "what threatens the city"],
                              ["Exposure", analysis.riskProfile.exposure, "what's in harm's way"],
                              ["Vulnerability", analysis.riskProfile.vulnerability, "likely impact given readiness"],
                            ] as const).map(([label, body, sub]) => (
                              <div key={label} className="rounded-xl border border-border bg-surface-overlay/30 p-3">
                                <div className="text-xs font-semibold text-primary-300">{label}</div>
                                <div className="text-[11px] text-text-secondary mb-1.5">{sub}</div>
                                <p className="text-xs text-text-secondary leading-relaxed [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderInline(body) }} />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <AnalysisSourceUse result={analysis} />

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
                        <div>
                          <h3 className="text-sm font-semibold text-accent-400 flex items-center gap-1.5 mb-2">
                            <CheckCircle2 size={14} /> Strengths
                          </h3>
                          <ul className="space-y-2">
                            {analysis.strengths.map((s, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm text-text-secondary p-2.5 rounded-lg bg-accent-500/5 border border-accent-500/15">
                                <span className="flex-1 [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderInline(s.text) }} />
                                <div className="flex flex-col items-end gap-1 shrink-0">
                                  <ConfidenceBadge level={s.confidence} />
                                  <ProvenanceBadge sourceRefs={s.sourceRefs} />
                                </div>
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
                                <span className="flex-1 [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderInline(w.text) }} />
                                <div className="flex flex-col items-end gap-1 shrink-0">
                                  <ConfidenceBadge level={w.confidence} />
                                  <ProvenanceBadge sourceRefs={w.sourceRefs} />
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                      <ImpactDifficultyMatrix actions={analysis.actions} estimated={analysis.actionsEstimated} />
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

      {/* ── Replace-scorecard warning modal (upload or assistant load) ─ */}
      <ConfirmModal
        open={!!pendingUpload}
        title="Replace what's loaded?"
        onClose={() => { autoRunRef.current = null; setPendingUpload(null); }}
        actions={[
          ...(analysis ? [{
            label: "Download report, then replace",
            variant: "primary" as const,
            onClick: () => {
              const p = buildPayload();
              if (p) downloadReport(p);
              if (pendingUpload) commitUpload(pendingUpload.p, pendingUpload.sc, pendingUpload.name, pendingUpload.source);
              setPendingUpload(null);
            },
          }] : []),
          {
            label: analysis ? "Replace & discard" : "Replace",
            variant: analysis ? "danger" as const : "primary" as const,
            onClick: () => {
              if (pendingUpload) commitUpload(pendingUpload.p, pendingUpload.sc, pendingUpload.name, pendingUpload.source);
              setPendingUpload(null);
            },
          },
          { label: "Cancel", variant: "ghost", onClick: () => { autoRunRef.current = null; setPendingUpload(null); } },
        ]}
      >
        Loading <strong className="text-text-primary">{pendingUpload?.name}</strong> will replace {pendingUpload ? PROVIDER_LABEL[pendingUpload.p] : ""}&apos;s
        {state === "analyzing" ? " analysis that's currently running" : analysis ? " current analysis results" : " scorecard currently loaded"} for{" "}
        <strong className="text-text-primary">{scorecard?.city.name}</strong>. Any data you added and your saved advisor
        conversations for that city are cleared too. The other helpers&apos; analyses stay.
        {analysis ? " You can download the current report first, otherwise it's discarded." : " This can't be undone."}
      </ConfirmModal>

      {/* ── Clear-results warning modal ─────────── */}
      <ConfirmModal
        open={confirmClear}
        title="Clear this analysis?"
        onClose={() => setConfirmClear(false)}
        actions={[
          {
            label: "Download report, then clear",
            variant: "primary",
            onClick: () => {
              const p = buildPayload();
              if (p) downloadReport(p);
              setConfirmClear(false);
              handleClearResults();
            },
          },
          {
            label: "Clear",
            variant: "danger",
            onClick: () => { setConfirmClear(false); handleClearResults(); },
          },
          { label: "Cancel", variant: "ghost", onClick: () => setConfirmClear(false) },
        ]}
      >
        This clears the analysis for <strong className="text-text-primary">{scorecard?.city.name}</strong>
        {refineFacts.length > 0 ? ", the " + refineFacts.length + " piece(s) of data you added" : ""}, and your saved
        advisor conversations for this city. The scorecard itself stays. This can&apos;t be undone, so download the
        report first if you want to keep it.
      </ConfirmModal>

      {/* ── Saved analyses library ─────────────── */}
      <AnalysisLibrary
        open={libraryOpen}
        entries={library}
        viewingId={viewing?.id ?? null}
        onOpen={(e) => { setViewing(e); setLibraryOpen(false); setRefineOpen(false); setTab("dashboard"); window.scrollTo({ top: 0 }); }}
        onDownloadReport={(e) => downloadReport({ scorecard: e.scorecard, analysis: e.result, dataReport: e.dataReport, meta: e.meta })}
        onDownloadData={(e) => downloadJson({ scorecard: e.scorecard, analysis: e.result, dataReport: e.dataReport, meta: e.meta })}
        onDelete={deleteFromLibrary}
        onClose={() => setLibraryOpen(false)}
      />

      {/* ── Same city, another outline: replace the earlier analysis or keep both ─ */}
      <ConfirmModal
        open={pendingSaves.length > 0}
        title="Replace the earlier analysis?"
        onClose={() => resolvePendingSave("keep")}
        actions={[
          { label: "Replace previous", variant: "danger", onClick: () => resolvePendingSave("replace") },
          { label: "Keep both", variant: "primary", onClick: () => resolvePendingSave("keep") },
        ]}
      >
        {pendingSaves[0] && (() => {
          const { entry, others } = pendingSaves[0];
          return (
            <>
              <p>
                You already have a saved {PROVIDER_LABEL[entry.provider]} analysis for <strong className="text-text-primary">{entry.scorecard.city.name}</strong>{" "}
                made with a different outline:
              </p>
              <ul className="my-2 space-y-1">
                {others.map((o) => (
                  <li key={o.id} className="text-xs rounded-lg border border-border bg-surface-overlay/40 px-2.5 py-1.5">
                    <span className="text-text-primary">{o.shape.kind}</span>{o.shape.detail ? ` · ${o.shape.detail}` : ""} · {new Date(o.savedAt).toLocaleString()}
                  </li>
                ))}
              </ul>
              <p>
                This new one used: <span className="text-text-primary">{entry.shape.kind}</span>{entry.shape.detail ? ` · ${entry.shape.detail}` : ""}.
                Replace the earlier analysis with this one, or keep both in Saved analyses?
                {pendingSaves.length > 1 ? " Your answer also applies to the other helpers' analyses of this outline." : ""}
              </p>
            </>
          );
        })()}
      </ConfirmModal>

      {/* ── First-visit / replayable tour ──────── */}
      <Onboarding open={showTour} onClose={closeTour} />

      {/* ── Analysis advisor (opens from the results toolbar or the floating button) ─ */}
      {scorecard && analysis && laneSettings && !viewing && (
        <AnalysisAdvisor
          key={`${sessionId}:${lane}`}
          open={refineOpen}
          onClose={() => setRefineOpen(false)}
          scorecard={scorecard}
          analysis={analysis}
          dataReport={dataReport}
          settings={laneSettings}
          contextFacts={refineFacts}
          onAddContext={addRefineFact}
          onRemoveContext={removeRefineFact}
          onRerun={rerunWithFacts}
          onClearContext={clearRefineFacts}
          onBusyChange={setAdvisorBusy}
          externalBusy={state === "analyzing" || assistantRunning.includes(lane)}
        />
      )}

      {/* ── Floating actions (bottom-right): the advisor sits prominently above Help ─ */}
      <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3">
        {tab === "dashboard" && state === "results" && analysis && scorecard && !refineOpen && !viewing && (
          <button
            onClick={() => setRefineOpen(true)}
            title="Ask the analysis advisor to help sharpen this analysis"
            aria-label="Open the analysis advisor"
            className="glass-tint press on-accent flex items-center gap-2 rounded-full pl-4 pr-5 py-3.5 animate-breathe hover:scale-105 transition-transform"
          >
            <Sparkles size={20} />
            <span className="text-sm font-semibold">Ask the advisor</span>
          </button>
        )}
        {!showTour && (
          <button
            onClick={replayTour}
            title="New here? Take the quick tour"
            aria-label="Take the quick tour"
            className="glass-bar press flex items-center gap-2 rounded-full text-text-primary pl-3 pr-4 py-2.5 hover:scale-105 transition-transform"
          >
            <HelpCircle size={18} className="text-accent-400" />
            <span className="text-sm font-medium hidden sm:inline">Need help?</span>
          </button>
        )}
      </div>

      {/* ── Slim footer (unobtrusive safety note) ─ */}
      <footer className="mt-auto border-t border-border px-4 sm:px-6 py-3">
        <p className="max-w-[1600px] mx-auto text-xs text-text-secondary text-center">
          The AI's answers can vary depending on the model you pick, so please have someone who knows disaster resilience look them over before acting on them. Everything runs right here in your browser.
        </p>
      </footer>
    </div>
  );
}
