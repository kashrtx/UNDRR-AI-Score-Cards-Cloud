"use client";

/**
 * One AI helper's lane in the Assistant: its own chat, agent run, and copy of
 * the scorecard. The Assistant tab mounts one lane per helper picked in
 * Settings, so several helpers can fill separate copies in parallel.
 *
 * A lane stays mounted (and keeps running) whichever tab or sub-tab is shown.
 * It draws its chat into the Assistant view's slot and its scorecard into the
 * Scorecard view's slot through portals, and is simply hidden when it isn't
 * the selected sub-tab. The place (city or area), notes and attachments are
 * shared and owned by the Assistant tab; the lane reads them through getShared().
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Send, Upload, Loader2, Wrench, Download, RotateCcw,
  ClipboardCheck, Lightbulb, Paperclip, X, Play, AlertTriangle, ChevronDown, Coins,
} from "lucide-react";
import {
  getSearchKey, hasSearchKey, settingsFor, providerIsReady, modelForSettings, PROVIDER_LABEL,
  type AppSettings, type ProviderId,
} from "@/lib/settings/store";
import { newFillRecord, addUsage, saveFillRecord, type FillRecord } from "@/lib/agent/usageLog";
import { costOf, formatUsd, formatTokens } from "@/lib/llm/pricing";
import { usePriceCatalog } from "@/components/usePriceCatalog";
import { createProvider } from "@/lib/llm";
import { PRELIMINARY_INDICATORS, TOTAL_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";
import { ESSENTIAL_NAMES, type NormalizedScorecard } from "@/lib/scorecard/schema";
import {
  emptyDraft, filledCount, blankCount, resolvedCount, draftToScorecard, mergeScorecardIntoDraft,
  type Draft, type Score, type CityInfo,
} from "@/lib/agent/draft";
import { runAgentTurn, type AgentContext, type AgentEvent, type TranscriptItem } from "@/lib/agent/agent";
import { exportScorecardXlsx } from "@/lib/export/scorecardXlsx";
import { renderMarkdown, deEmDash } from "@/lib/ui/markdown";
import { UserMessageBubble } from "@/components/UserMessageBubble";
import { computeTemplateEdits, fillOfficialTemplate } from "@/lib/export/fillTemplate";
import type { ChatItem, Attachment, LaneData } from "@/lib/agent/sessions";
import { LiveStream } from "@/components/LiveStream";
import { AreaThumbnail } from "@/components/AreaThumbnail";
import { formatKm2, type AreaSelection } from "@/lib/geo/area";
import { shapefileName } from "@/lib/geo/shapefile";
import { scopeOf, AREA_SPECIFIC_CODES } from "@/lib/geo/indicatorScope";
import { citedSources, selectedDataSources, shortName } from "@/lib/data/catalog";
import { DataSourceChips, BasisTag, WebSourceChips } from "@/components/DataSourceChips";
import { emptyRegistry, type SourceRegistry } from "@/lib/agent/sources";

const SCORE_LABELS: Record<string, string> = {
  "0": "0 · None", "1": "1 · Limited", "2": "2 · Substantial", "3": "3 · Comprehensive",
};

/** The place and inputs every lane shares, owned by the Assistant tab. */
export interface LaneShared {
  city: string;
  country: string;
  region: string;
  /** The boundary the AI works from (drawn/loaded area, or the typed city's boundary), if any. */
  area: AreaSelection | null;
  /** "Draw an area" mode, with the area drawn there (for the scorecard's area card). */
  areaActive: boolean;
  drawnArea: AreaSelection | null;
  /** "Tempe, Arizona, United States", or "New scorecard". */
  place: string;
  attachments: Attachment[];
  /** An uploaded official scorecard, used as the base for the .xlsm download. */
  templateBuf: ArrayBuffer | null;
}

export interface LaneStatus {
  running: boolean;
  /** Indicators scored. */
  filled: number;
  /** Indicators left blank on purpose, with a reason (count as handled). */
  blank: number;
  continuable: boolean;
  /** Requests, tokens and cost of this helper's current fill. */
  fill: FillRecord | null;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  yes: string;
  danger?: boolean;
  onYes: () => void;
}

/** What the Assistant tab can ask of a lane. */
export interface LaneHandle {
  /** "Fill it out for me": complete the scorecard for `cityLine`. */
  startFill(cityLine: string, info: string, areaActive: boolean, area: AreaSelection | null): void;
  stop(): void;
  /** Add a line to this lane's chat (e.g. "Ready to use report.pdf"). */
  note(item: ChatItem): void;
  /** Merge an uploaded scorecard's answers and City Information into this lane's draft. */
  loadScorecard(sc: NormalizedScorecard, fromFile: Partial<CityInfo>, notes: ChatItem[]): void;
  /** Start this lane over: no chat, no answers. */
  clearAll(): void;
}

/** The area to name in the AI's instructions: the uploaded .zip itself, or the generated Shapefile. */
function areaFileFor(a: AreaSelection, place: string): string {
  return a.source === "file" && /\.zip$/i.test(a.fileName || "") ? a.fileName! : shapefileName(a, place);
}

// Pull the model's own reasoning (the words it wrote before/around the JSON it
// returns) out of a raw step so we can keep it for the reader. Models that only
// return JSON leave nothing here, and that's fine, the summary line covers them.
/**
 * Is the model that answered the one that was asked for? Loose on purpose:
 * providers add or drop a vendor prefix ("openai/"), a ":free" or ":online"
 * suffix, or a release date ("claude-sonnet-4-6-20260115").
 */
function sameModelId(answered: string, requested: string): boolean {
  const key = (s: string) => {
    const base = s.replace(/:(free|online)$/i, "");
    return base.slice(base.lastIndexOf("/") + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  };
  const a = key(answered), r = key(requested);
  return !!a && !!r && (a === r || a.startsWith(r) || r.startsWith(a));
}

function extractReasoning(raw: string): string {
  if (!raw) return "";
  let text = raw;
  const think = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (think) {
    text = think[1];
  } else {
    const brace = text.search(/\{\s*["']?(thought|action)/i);
    if (brace > 0) text = text.slice(0, brace);
  }
  text = text.replace(/```[a-z]*|```/gi, "").trim();
  return text.length > 30 ? text : "";
}

// A single "thinking" step in the chat log. The friendly summary is always
// shown; the model's fuller reasoning tucks away behind a toggle so nothing is
// lost and nothing is overwhelming.
function ReasoningItem({ summary, detail, seconds }: { summary: string; detail?: string; seconds?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-start gap-2 text-xs text-text-secondary">
      <Lightbulb size={13} className="text-warn-400 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <span className="italic">{summary}</span>
        {detail && (
          <>
            {" "}
            <button
              onClick={() => setOpen((v) => !v)}
              className="not-italic underline decoration-dotted underline-offset-2 hover:text-text-primary"
              aria-expanded={open}
            >
              {open ? "Hide thinking" : `Show thinking${seconds ? ` (${seconds}s)` : ""}`}
            </button>
            {open && (
              <pre className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-secondary bg-surface-overlay/50 border border-border rounded-lg p-2.5 max-h-64 overflow-y-auto">
                {detail}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export const AgentLane = forwardRef<LaneHandle, {
  provider: ProviderId;
  settings: AppSettings;
  /** This lane is the selected sub-tab. */
  visible: boolean;
  view: "assistant" | "scorecard";
  /** Where to draw the chat and the scorecard (slots in the Assistant tab). */
  assistantHost: HTMLElement | null;
  scorecardHost: HTMLElement | null;
  initial: LaneData;
  /** The saved scorecard this lane belongs to (for the usage log). */
  sessionId: string;
  shared: LaneShared;
  getShared: () => LaneShared;
  /** The Analysis tab is running this helper's analysis (or its advisor is writing). */
  externalBusy: boolean;
  uploadNote: { ok: boolean; text: string } | null;
  onDismissUploadNote: () => void;
  onData: (p: ProviderId, data: LaneData) => void;
  onStatus: (p: ProviderId, s: LaneStatus) => void;
  onLoadIntoAnalyzer: (p: ProviderId, sc: NormalizedScorecard) => void;
  onOpenView?: (v: "assistant" | "scorecard") => void;
  onAttachClick: () => void;
  onRemoveAttachment: (name: string) => void;
  onPickScorecard: (file: File) => void;
  requestConfirm: (c: ConfirmRequest) => void;
  /** Open the Cost comparison window. */
  onOpenCosts: () => void;
}>(function AgentLane(
  {
    provider, settings, visible, view, assistantHost, scorecardHost, initial, sessionId, shared, getShared, externalBusy,
    uploadNote, onDismissUploadNote, onData, onStatus, onLoadIntoAnalyzer, onOpenView,
    onAttachClick, onRemoveAttachment, onPickScorecard, requestConfirm, onOpenCosts,
  },
  ref
) {
  const label = PROVIDER_LABEL[provider];
  const [chat, setChat] = useState<ChatItem[]>(initial.chat || []);
  const [draft, setDraft] = useState<Draft>(() => (Object.keys(initial.draft || {}).length ? initial.draft : emptyDraft()));
  const [profile, setProfile] = useState<CityInfo>(initial.profile && initial.profile.name != null ? initial.profile : { name: "", country: "" });
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [thinking, setThinking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState("");
  const [continuable, setContinuable] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [building, setBuilding] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [showJump, setShowJump] = useState(false);
  // This helper's current fill: requests, tokens, cost, time (kept with the scorecard and in the usage log).
  const [fill, setFill] = useState<FillRecord | null>(initial.fill ?? null);
  // The web pages / datasets this helper has been shown, tagged S1, S2… (see agent/sources).
  const sourcesRef = useRef<SourceRegistry>(initial.sources ?? emptyRegistry());
  // Essentials already sent back for a search before guessing (kept across Continue).
  const lookAskedRef = useRef<Set<number>>(new Set());
  const fillRef = useRef<FillRecord | null>(fill);
  const lastEndRef = useRef<FillRecord["status"] | null>(null);
  const priceCat = usePriceCatalog();
  const updateFill = useCallback((r: FillRecord | null) => {
    fillRef.current = r;
    setFill(r);
    if (r) saveFillRecord(r);
  }, []);

  const transcriptRef = useRef<TranscriptItem[]>(initial.transcript || []);
  const draftRef = useRef<Draft>(draft);
  draftRef.current = draft;
  const profileRef = useRef<CityInfo>(profile);
  profileRef.current = profile;
  const abortRef = useRef<AbortController | null>(null);
  const ctxRef = useRef<AgentContext | null>(null);
  const queuedInputRef = useRef<string[]>([]);
  const undoSnapshotRef = useRef<Draft | null>(null);
  const lastModeRef = useRef<"autonomous" | "assist">("assist");
  const streamBuf = useRef("");
  const streamScheduled = useRef(false);
  const stepStartRef = useRef(0);
  const mountedRef = useRef(true);
  const stuckToBottomRef = useRef(true);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const filled = filledCount(draft);
  const blanks = blankCount(draft);
  const resolved = filled + blanks;
  const pct = Math.round((filled / TOTAL_INDICATORS) * 100);

  // The data sources chosen in Settings (Step 3), and which answers cite them.
  const chosenIds = settings.dataSources;
  const chosenRef = useRef(chosenIds);
  chosenRef.current = chosenIds;
  const announcedRef = useRef<string | null>(null);
  const sourceUse = useMemo(() => {
    const chosen = selectedDataSources(chosenIds);
    if (!chosen.length) return null;
    const perCode = new Map<string, ReturnType<typeof citedSources>>();
    const count = new Map<string, number>();
    let answered = 0;
    let citing = 0;
    for (const [code, e] of Object.entries(draft)) {
      if (e?.score == null) continue;
      answered++;
      const cited = citedSources(e.note, chosenIds);
      perCode.set(code, cited);
      if (cited.length) citing++;
      for (const d of cited) count.set(d.id, (count.get(d.id) ?? 0) + 1);
    }
    return { chosen, perCode, count, answered, citing };
  }, [draft, chosenIds]);

  // Where every answer comes from: chosen data sources (green), web pages /
  // open data / attachments (blue), or, with no source, its basis. Blanks too.
  const sourceTally = useMemo(() => {
    const t = { answered: 0, green: 0, blue: 0, general: 0, user: 0, guess: 0, none: 0, blank: 0 };
    for (const ind of PRELIMINARY_INDICATORS) {
      const e = draft[ind.code];
      if (e?.score == null) { if (e?.blank) t.blank++; continue; }
      t.answered++;
      const g = chosenIds?.length ? citedSources(e.note, chosenIds).length > 0 : false;
      const b = (e.sources?.length ?? 0) > 0;
      if (g) t.green++;
      if (b) t.blue++;
      if (!g && !b) {
        if (e.basis === "general") t.general++;
        else if (e.basis === "user") t.user++;
        else if (e.basis === "assumption") t.guess++;
        else t.none++;
      }
    }
    return t;
  }, [draft, chosenIds]);

  // Report progress and data up to the Assistant tab (it saves the session).
  useEffect(() => { onStatus(provider, { running, filled, blank: blanks, continuable, fill }); }, [provider, running, filled, blanks, continuable, fill, onStatus]);
  useEffect(() => {
    onData(provider, { chat, transcript: transcriptRef.current, draft, profile, fill, sources: sourcesRef.current });
  }, [provider, chat, draft, profile, fill, onData]);

  // Stop any run when the lane goes away (session switched, helper deselected).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!thinking) { setElapsed(0); return; }
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [thinking]);

  // Auto-grow the composer so a long paste is fully visible and easy to edit.
  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const h = el.scrollHeight;
    el.style.height = h > 0 ? `${Math.min(h, 200)}px` : "";
  }, []);
  useEffect(() => { resizeComposer(); }, [input, visible, view, resizeComposer]);

  // The Assistant is a normal, full-height page: the whole window scrolls.
  // While the reader follows along at the bottom, new output keeps the page at
  // the bottom. Following only ever moves the page DOWN (never up, e.g. away from
  // the footer or the Stop button), and any upward scroll by the reader stops it
  // at once; reaching the bottom again (or "Jump to latest") resumes it.
  const showing = visible && view === "assistant";
  const autoScrollAt = useRef(0); // when we last moved the page ourselves
  const followBottom = useCallback(() => {
    const target = document.documentElement.scrollHeight - window.innerHeight;
    if (target > window.scrollY + 1) {
      autoScrollAt.current = Date.now();
      window.scrollTo({ top: target, behavior: "auto" });
    }
  }, []);
  useEffect(() => {
    if (showing && stuckToBottomRef.current) followBottom();
  }, [chat, thinking, stream, showing, followBottom]);
  useEffect(() => {
    if (!showing) return;
    let lastY = window.scrollY;
    const stopFollowing = () => {
      stuckToBottomRef.current = false;
      setShowJump(true);
    };
    const onScroll = () => {
      const doc = document.documentElement;
      const y = window.scrollY;
      const atBottom = window.innerHeight + y >= doc.scrollHeight - 120;
      if (atBottom) {
        stuckToBottomRef.current = true;
        setShowJump(false);
      } else if (y < lastY - 2 && Date.now() - autoScrollAt.current > 250) {
        stopFollowing(); // the reader moved up (e.g. dragging the scrollbar)
      } else if (!stuckToBottomRef.current) {
        setShowJump(true);
      }
      lastY = y;
    };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) stopFollowing(); };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => { if ((e.touches[0]?.clientY ?? 0) > touchY + 4) stopFollowing(); };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) stopFollowing();
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [showing]);
  const jumpToLatest = useCallback(() => {
    stuckToBottomRef.current = true;
    setShowJump(false);
    followBottom();
  }, [followBottom]);

  // ── Agent event handling ────────────────────────────
  const onEvent = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case "thinking":
        setThinking(e.on);
        if (e.on) { streamBuf.current = ""; setStream(""); stepStartRef.current = Date.now(); }
        break;
      case "stream":
        streamBuf.current = (streamBuf.current + e.text).slice(-20000);
        if (!streamScheduled.current) {
          streamScheduled.current = true;
          setTimeout(() => { setStream(streamBuf.current); streamScheduled.current = false; }, 90);
        }
        break;
      case "thought": {
        // Freeze this step's thinking into the history so it can always be
        // scrolled back to and expanded.
        const seconds = Math.max(1, Math.round((Date.now() - stepStartRef.current) / 1000));
        const detail = extractReasoning(streamBuf.current).slice(0, 8000);
        setChat((c) => [...c, { kind: "reasoning", summary: e.text, detail: detail || undefined, seconds }]);
        streamBuf.current = "";
        setStream("");
        break;
      }
      case "assistant":
        setChat((c) => [...c, { kind: "assistant", text: e.text }]);
        break;
      case "tool": {
        const cited = citedSources(`${e.label} ${e.detail ?? ""}`, chosenRef.current).map((d) => d.id);
        setChat((c) => [...c, { kind: "tool", label: e.label, detail: e.detail, ...(cited.length ? { sources: cited } : {}) }]);
        break;
      }
      case "draft":
        // Read the live object the agent is mutating (ctx.draft), not the last
        // rendered copy, so the scorecard fills in as the run goes.
        setDraft({ ...(ctxRef.current?.draft || draftRef.current) });
        break;
      case "info":
        if (ctxRef.current?.info) setProfile({ ...ctxRef.current.info });
        break;
      case "usage":
        if (fillRef.current) updateFill(addUsage(fillRef.current, e.usage));
        break;
      case "model":
        setChat((c) => [...c, {
          kind: "tool",
          label: `Answered by ${e.model}`,
          detail: !sameModelId(e.model, e.requested)
            ? `not ${e.requested}, the model picked in Settings${provider === "createai" ? " (CreateAI used your project's model; change it on the project's Basic tab)" : ""}`
            : e.reported ? undefined : "as picked in Settings",
        }]);
        break;
      case "done":
        lastEndRef.current = "done";
        setContinuable(false);
        break;
      case "stopped":
        lastEndRef.current = "paused";
        setContinuable(true);
        setChat((c) => [...c, { kind: "tool", label: "Paused", detail: "press Continue whenever you're ready" }]);
        break;
      case "error":
        lastEndRef.current = "error";
        setChat((c) => [...c, { kind: "assistant", text: `I couldn't keep going: ${e.text}.` }]);
        setContinuable(!!e.canContinue);
        break;
    }
  }, [updateFill]);

  const runTurn = useCallback(
    async (userText: string | null, opts?: { mode?: "autonomous" | "assist"; area?: AreaSelection | null; newFill?: boolean }) => {
      if (runningRef.current) return; // never start a second run over a live one
      if (externalBusy) {
        setChat((c) => [...c, { kind: "assistant", text: `${label}'s analysis is still running on the Analysis tab. I'll wait for that to finish so the two don't clash, then ask me again.` }]);
        return;
      }
      if (!providerIsReady(provider)) {
        setChat((c) => [...c, { kind: "assistant", text: `Add a key for ${label} in Settings first, then come back here.` }]);
        return;
      }
      const mode = opts?.mode ?? lastModeRef.current;
      lastModeRef.current = mode;
      let llm;
      try {
        llm = await createProvider(settingsFor(settings, provider)); // rebuilt each turn, so switching model then Continue works
      } catch (err) {
        setChat((c) => [...c, { kind: "assistant", text: `⚠ Couldn't start ${label}: ${err instanceof Error ? err.message : String(err)}.` }]);
        return;
      }
      // Tavily only when it's switched on in Settings (Step 4), like the Analysis
      // tab; otherwise the research and searches stay keyless (Wikipedia + DuckDuckGo).
      const searchKey = settings.useTavily && hasSearchKey() ? await getSearchKey() : null;
      const sh = getShared();
      // A just-resolved city boundary is passed in, since state won't have re-rendered yet.
      const runArea = opts && "area" in opts ? opts.area ?? null : sh.area;
      // Snapshot the draft so the whole run can be undone in one click.
      undoSnapshotRef.current = JSON.parse(JSON.stringify(draftRef.current));
      queuedInputRef.current = [];
      const ctx: AgentContext = {
        provider: llm,
        transcript: transcriptRef.current,
        draft: draftRef.current,
        info: { ...profileRef.current, name: sh.city || profileRef.current.name || "", country: sh.country || profileRef.current.country || "" },
        searchKey,
        city: sh.city,
        country: sh.country,
        region: sh.region || undefined,
        attachments: sh.attachments,
        mode,
        drainInput: () => queuedInputRef.current.shift() ?? null,
        area: runArea,
        sources: sourcesRef.current,
        areaFile: runArea ? areaFileFor(runArea, sh.city) : null,
        dataSources: settings.dataSources,
        allowGuesses: settings.allowGuesses,
        lookAsked: lookAskedRef.current,
      };
      ctxRef.current = ctx;
      const chosen = selectedDataSources(settings.dataSources);
      const chosenKey = chosen.map((d) => d.id).join(",");
      if (chosen.length && (opts?.newFill || announcedRef.current !== chosenKey)) {
        setChat((c) => [...c, {
          kind: "tool",
          label: "Using your data sources first",
          detail: `${chosen.map(shortName).join(", ")} (Settings, Step 3); general sources only fill gaps`,
          sources: chosen.map((d) => d.id),
        }]);
      }
      announcedRef.current = chosen.length ? chosenKey : null;
      if (userText) transcriptRef.current.push({ role: "user", content: userText } as TranscriptItem);
      const emit = (e: AgentEvent) => { if (mountedRef.current) onEvent(e); };
      // Usage: a fill's record covers its runs until the next "Fill it out for me".
      const model = modelForSettings(settingsFor(settings, provider));
      const base = (opts?.newFill ? null : fillRef.current) ?? newFillRecord({ sessionId, place: sh.place, provider, model, filled: resolvedCount(draftRef.current) });
      updateFill({ ...base, model, status: "running" });
      lastEndRef.current = null;
      const runStartedAt = Date.now();
      setRunning(true);
      runningRef.current = true;
      setContinuable(false);
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;
      try {
        await runAgentTurn(ctx, emit, signal);
      } finally {
        runningRef.current = false;
        if (fillRef.current) {
          const r = fillRef.current;
          const status: FillRecord["status"] = signal.aborted ? "stopped" : lastEndRef.current ?? "paused";
          const endRecord = { ...r, status, filledEnd: resolvedCount(ctx.draft), activeMs: r.activeMs + (Date.now() - runStartedAt), updatedAt: new Date().toISOString() };
          if (mountedRef.current) updateFill(endRecord); else saveFillRecord(endRecord);
        }
        if (mountedRef.current) {
          setRunning(false);
          setThinking(false);
          setStream("");
          setDraft({ ...ctx.draft }); // fresh state → the session auto-saves
          setProfile({ ...ctx.info });
          // Offer a one-click undo if the run actually changed the scores.
          const before = undoSnapshotRef.current;
          setCanUndo(!!before && JSON.stringify(before) !== JSON.stringify(ctx.draft));
        }
      }
    },
    [externalBusy, provider, label, settings, getShared, onEvent, sessionId, updateFill]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  useImperativeHandle(ref, () => ({
    startFill(cityLine, info, areaActive, area) {
      if (runningRef.current) return;
      const already = filledCount(draftRef.current);
      const scope =
        already > 0
          ? `Some indicators (${already} of ${TOTAL_INDICATORS}) are already filled in. Keep those and finish the rest for ${cityLine}. `
          : `Please fill out the whole scorecard for ${cityLine}. `;
      const msg =
        scope +
        (info ? `Here is what I know about ${areaActive ? "the area" : "the city"}: ${info}. ` : "") +
        `Research ${areaActive ? "the area and its city" : "the city"} as needed, set every indicator with a short note, and only ask me if something truly cannot be researched.`;
      setChat((c) => [...c, { kind: "user", text: already > 0 ? `Complete the rest for ${cityLine}.` : `Fill it out for ${cityLine}.` }]);
      void runTurn(msg, { mode: "autonomous", area, newFill: true });
    },
    stop,
    note(item) {
      setChat((c) => [...c, item]);
    },
    loadScorecard(sc, fromFile, notes) {
      const { draft: merged } = mergeScorecardIntoDraft(draftRef.current, sc);
      draftRef.current = merged;
      setDraft(merged);
      setProfile((p) => {
        const next = { ...p, ...fromFile };
        profileRef.current = next;
        return next;
      });
      setChat((c) => [...c, ...notes]);
    },
    clearAll() {
      const blank = emptyDraft();
      draftRef.current = blank;
      setDraft(blank);
      profileRef.current = { name: "", country: "" };
      setProfile({ name: "", country: "" });
      setChat([]);
      transcriptRef.current = [];
      sourcesRef.current = emptyRegistry();
      lookAskedRef.current = new Set();
      undoSnapshotRef.current = null;
      queuedInputRef.current = [];
      setCanUndo(false);
      setContinuable(false);
      fillRef.current = null;
      setFill(null); // the usage log keeps its record
    },
  }), [runTurn, stop]);

  const undoLastRun = useCallback(() => {
    const snap = undoSnapshotRef.current;
    if (!snap) return;
    setDraft({ ...snap });
    draftRef.current = { ...snap };
    setCanUndo(false);
    setChat((c) => [...c, { kind: "tool", label: "Undid the last run", detail: "scores restored to before it started" }]);
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || externalBusy) return;
    setInput("");
    setChat((c) => [...c, { kind: "user", text }]);
    if (running) {
      // Steer mid-run: queue it for the next step.
      queuedInputRef.current.push(text);
      setChat((c) => [...c, { kind: "tool", label: "I'll pick that up on the next step", detail: undefined }]);
      return;
    }
    void runTurn(text, { mode: "assist" });
  }, [input, running, externalBusy, runTurn]);

  const handleContinue = useCallback(() => {
    if (running || externalBusy) return;
    setChat((c) => [...c, { kind: "tool", label: "Continuing", detail: `with ${label}` }]);
    void runTurn("Continue from where you left off."); // keeps the last mode
  }, [running, externalBusy, runTurn, label]);

  // ── Scorecard edits + handoff ───────────────────────
  const cityInfo: CityInfo = useMemo(
    () => ({ ...profile, name: shared.city || profile.name || "Unknown", country: shared.country || profile.country || "Unknown" }),
    [shared.city, shared.country, profile]
  );
  const handleLoad = useCallback(() => onLoadIntoAnalyzer(provider, draftToScorecard(draftRef.current, cityInfo)), [provider, cityInfo, onLoadIntoAnalyzer]);
  const handleDownload = useCallback(() => exportScorecardXlsx(draftToScorecard(draftRef.current, cityInfo)), [cityInfo]);

  const requestClearScorecard = useCallback(() => {
    requestConfirm({
      title: `Clear ${label}'s scorecard?`,
      body: `All of ${label}'s scorecard information will be reset: every answer and note, and the City Information. The other helpers' scorecards, the city or area and the chat stay. This can't be undone.`,
      yes: "Proceed",
      danger: true,
      onYes: () => {
        const blank = emptyDraft();
        draftRef.current = blank;
        setDraft(blank);
        const p: CityInfo = { name: shared.city, country: shared.country };
        profileRef.current = p;
        setProfile(p);
        undoSnapshotRef.current = null;
        setCanUndo(false);
        setContinuable(false);
        transcriptRef.current.push({
          role: "tool",
          content: "The user cleared the scorecard: every indicator and the City Information page are blank again. Earlier scores no longer apply, but the research and searches already done (see WORK SO FAR) are still valid evidence: reuse them to score again rather than repeating them, and only look up what they don't cover.",
        });
        setChat((c) => [...c, { kind: "tool", label: "Scorecard cleared", detail: "all answers and City Information reset" }]);
      },
    });
  }, [requestConfirm, label, shared.city, shared.country]);

  // Fill and download the REAL official .xlsm (formatting + macros preserved).
  const fetchBundled = async (): Promise<ArrayBuffer> => {
    const res = await fetch("/undrr-preliminary-template.xlsm");
    if (!res.ok) throw new Error("Couldn't load the official template file.");
    return res.arrayBuffer();
  };
  const editCount = (m: Map<string, unknown[]>) => [...m.values()].reduce((n, a) => n + a.length, 0);
  const handleDownloadOfficial = useCallback(async () => {
    setBuilding(true);
    const sh = getShared();
    try {
      const p = profileRef.current;
      const info = {
        city: sh.city || p.name || undefined,
        country: sh.country || p.country || undefined,
        typeOfCity: p.typeOfCity || "Municipality",
        date: new Date().toISOString().slice(0, 10),
        authorityTitle: p.authorityTitle,
        population: p.population,
        areaKm2: p.areaKm2,
        density: p.density,
        youthPct: p.youthPct,
        seniorPct: p.seniorPct,
        femaleHeadedPct: p.femaleHeadedPct,
        literacyPct: p.literacyPct,
        povertyPct: p.povertyPct,
        incomeUsd: p.incomeUsd,
        nonCitizenPct: p.nonCitizenPct,
        mostLikelyHazard: p.mostLikelyHazard || (p.hazards && p.hazards[0]),
        mostSevereHazard: p.mostSevere,
      };
      let buf = sh.templateBuf || (await fetchBundled());
      let edits = computeTemplateEdits(buf, draftRef.current, info);
      if (editCount(edits) < 40) {
        // Uploaded base wasn't a standard official template, so use the bundled one.
        buf = await fetchBundled();
        edits = computeTemplateEdits(buf, draftRef.current, info);
      }
      const blob = await fillOfficialTemplate(buf, edits);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `UNDRR-ARISE-${(sh.city || "scorecard").replace(/\s+/g, "-")}-${label.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.xlsm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const n = filledCount(draftRef.current);
      const what =
        n === 0 ? "Downloaded blank official sheet (.xlsm)"
        : n === TOTAL_INDICATORS ? "Downloaded completed scorecard (.xlsm)"
        : "Downloaded scorecard so far (.xlsm)";
      setChat((c) => [...c, { kind: "tool", label: what, detail: "real UNDRR template, formatting and macros kept" }]);
    } catch (e) {
      setChat((c) => [...c, { kind: "assistant", text: `Couldn't build the official file: ${e instanceof Error ? e.message : String(e)}. You can use the simple .xlsx instead, or Run analysis.` }]);
    } finally {
      setBuilding(false);
    }
  }, [getShared, label]);
  // Choosing a score by hand ends a "left blank" (and the user is now its basis).
  const setScore = (code: string, score: Score | null) =>
    setDraft((d) => {
      const { blank: _blank, ...rest } = d[code] ?? { score: null, note: "" };
      const n = { ...d, [code]: score != null && _blank ? { ...rest, score, basis: "user" as const } : { ...d[code], score } };
      draftRef.current = n;
      return n;
    });
  const setNote = (code: string, note: string) =>
    setDraft((d) => { const n = { ...d, [code]: { ...d[code], note } }; draftRef.current = n; return n; });

  const showContinue = !running && continuable && resolved < TOTAL_INDICATORS;
  const { areaActive, drawnArea: area, place, attachments } = shared;

  // ── Assistant view: this helper's chat ──────────────
  const chatView = (
    <div className={visible ? "flex flex-col flex-1" : "hidden"}>
      {externalBusy && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-warn-500/30 bg-warn-500/10 px-3.5 py-2.5 text-sm text-warn-400">
          <Loader2 size={15} className="animate-spin shrink-0" />
          <span>{label}&apos;s analysis is running on the Analysis tab. {label} will be ready as soon as it finishes, so the two don&apos;t clash.</span>
        </div>
      )}
      <div className="flex-1 min-h-[12rem]">
        <div className="space-y-3 pr-1">
          {chat.length === 0 && (
            <p className="text-sm text-text-secondary">
              {areaActive
                ? <>Draw or load an area above and press &ldquo;Fill it out for me,&rdquo; or just type below to work through it with {label}. You can attach reference documents with the paperclip.</>
                : <>Fill in your city above and press &ldquo;Fill it out for me,&rdquo; or just type below to work through it with {label}. You can attach reference documents with the paperclip.</>}
            </p>
          )}
          {chat.map((m, i) =>
            m.kind === "tool" ? (
              <div key={i} className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-text-secondary min-w-0">
                  <Wrench size={13} className="text-primary-300 shrink-0" />
                  <span className="font-medium text-text-primary shrink-0 truncate max-w-[55%]">{m.label}</span>
                  {m.detail && <span className="truncate min-w-0 text-text-secondary">· {m.detail}</span>}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div className="ml-5 mt-1"><DataSourceChips sources={selectedDataSources(m.sources)} size="xs" /></div>
                )}
              </div>
            ) : m.kind === "thought" ? (
              <div key={i} className="flex items-start gap-2 text-xs text-text-secondary italic">
                <Lightbulb size={13} className="text-warn-400 shrink-0 mt-0.5" />
                <span>{deEmDash(m.text)}</span>
              </div>
            ) : m.kind === "reasoning" ? (
              <ReasoningItem key={i} summary={m.summary} detail={m.detail} seconds={m.seconds} />
            ) : (
              <div key={i} className={`flex ${m.kind === "user" ? "justify-end" : "justify-start"}`}>
                {m.kind === "assistant" ? (
                  <div
                    className="msg-md max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-surface-overlay border border-border text-text-primary space-y-2"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
                  />
                ) : (
                  <UserMessageBubble text={m.text} />
                )}
              </div>
            )
          )}
          {thinking && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Loader2 size={14} className="animate-spin text-accent-400" /> {label} is thinking{elapsed > 0 ? `… (${elapsed}s)` : "…"}
              </div>
              {stream && <LiveStream text={stream} label="Show what it's writing" defaultOpen={false} />}
            </div>
          )}
          {(showContinue || (!running && canUndo)) && (
            <div className="flex flex-col gap-2">
              {showContinue && (
                <button onClick={handleContinue} disabled={externalBusy} className="self-start flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold btn-accent disabled:opacity-50 disabled:cursor-not-allowed">
                  <Play size={15} /> Continue
                </button>
              )}
              {!running && canUndo && !showContinue && (
                <div className="rounded-xl border border-border bg-surface-overlay/30 p-3">
                  <p className="text-xs text-text-secondary mb-2">
                    Not quite right? Tell {label} what to change and it&apos;ll refine it. It can revisit any answer, not just the last one.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      "A few of these scores look too high, can you reconsider them?",
                      "Explain why you scored the weakest Essential the way you did.",
                      "I have local details to add, let me tell you about a few indicators.",
                    ].map((q) => (
                      <button key={q} onClick={() => { setInput(q); }}
                        className="text-[11px] px-2.5 py-1 rounded-full bg-surface-overlay border border-border text-text-secondary hover:text-text-primary">
                        {q}
                      </button>
                    ))}
                    <button onClick={undoLastRun}
                      title="Revert the scores to exactly how they were before this run"
                      className="text-[11px] px-2.5 py-1 rounded-full text-text-secondary hover:text-danger-400 inline-flex items-center gap-1">
                      <RotateCcw size={11} /> Revert this run
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Attachments + composer stay pinned to the bottom of the window. */}
      <div className="sticky bottom-0 z-10 -mx-4 sm:-mx-5 px-4 sm:px-5 pb-4 sm:pb-5 -mb-4 sm:-mb-5 pt-1 rounded-b-2xl bg-surface-raised/95 backdrop-blur-xl">
        {showJump && chat.length > 0 && (
          <button
            onClick={jumpToLatest}
            className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-surface border border-border shadow-lg text-text-primary hover:border-accent-500/50 transition-colors"
          >
            <ChevronDown size={14} /> Jump to latest
          </button>
        )}
        {attachments.length > 0 && (
          <div className="shrink-0 flex flex-wrap gap-1.5 mt-2">
            {attachments.map((a) => (
              <span key={a.name} title={`${a.name} (shared with every helper)`} className="flex items-center gap-1 max-w-full text-[11px] bg-surface-overlay border border-border rounded-full pl-2 pr-1 py-0.5 text-text-secondary">
                <Paperclip size={11} className="shrink-0" />
                <span className="truncate max-w-[220px]">{a.name}</span>
                <button onClick={() => onRemoveAttachment(a.name)} title="Remove" className="shrink-0 hover:text-danger-400"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="shrink-0 mt-3 flex items-end gap-2">
          <button onClick={onAttachClick} title="Attach reference documents (shared with every helper)" disabled={externalBusy}
            className="p-2.5 rounded-xl bg-surface-overlay border border-border text-text-secondary hover:text-text-primary shrink-0 disabled:opacity-40 disabled:cursor-not-allowed">
            <Paperclip size={16} />
          </button>
          <textarea ref={composerRef} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            disabled={externalBusy}
            rows={2} placeholder={externalBusy ? "Waiting for the other task to finish…" : running ? `Add a note to steer ${label}, picked up on the next step…` : `Message ${label}: reply, paste details, or ask it to adjust something… (Shift+Enter for a new line)`}
            className="flex-1 px-3 py-2.5 rounded-xl bg-surface-overlay border border-border text-text-primary text-sm resize-none leading-relaxed min-h-[3rem] disabled:opacity-60 disabled:cursor-not-allowed" />
          {running ? (
            <>
              <button onClick={handleSend} disabled={!input.trim() || externalBusy}
                title="Add this while it works, it's picked up on the next step"
                className="flex items-center justify-center px-3.5 py-2.5 rounded-xl btn-accent disabled:opacity-40" aria-label="Queue message">
                <Send size={16} />
              </button>
              <button onClick={stop} title={`Stop ${label}`}
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary shrink-0">
                <Loader2 size={15} className="animate-spin" /> Stop
              </button>
            </>
          ) : (
            <button onClick={handleSend} disabled={!input.trim() || externalBusy}
              className="flex items-center justify-center px-3.5 py-2.5 rounded-xl btn-accent disabled:opacity-50" aria-label="Send">
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  // ── Scorecard view: this helper's copy ──────────────
  const scorecardView = (
    <div className={visible ? "flex flex-col flex-1 min-h-0" : "hidden"}>
      <section className="glass-card p-4 sm:p-5 flex flex-col h-[80vh] lg:h-auto lg:flex-1 min-h-0 overflow-hidden">
        <div className="flex items-center justify-between gap-2 mb-1 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardCheck size={20} className="text-accent-400 shrink-0" />
            <h2 className="text-lg font-semibold text-text-primary truncate">{label}: {areaActive && area ? `Area · ${shared.city ? place : area.label || place}` : place}</h2>
            {running && (
              <button onClick={() => onOpenView?.("assistant")} title={`${label} is filling this in; open the Assistant to watch`}
                className="shrink-0 inline-flex items-center gap-1 text-xs text-accent-400 hover:underline">
                <Loader2 size={12} className="animate-spin" /> {label} is filling this in
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => fileRef.current?.click()} disabled={running || externalBusy}
              title="Upload a completed (or partly completed) UNDRR scorecard; its answers fill in every helper's copy"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40 disabled:opacity-50">
              <Upload size={13} /> Upload scorecard
            </button>
            <input ref={fileRef} type="file" accept=".xlsm,.xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickScorecard(f); e.currentTarget.value = ""; }} />
            <span className="text-sm font-medium text-text-secondary">{filled}/{TOTAL_INDICATORS}</span>
          </div>
        </div>
        <div className="h-2 rounded-full bg-surface-overlay overflow-hidden mb-3 shrink-0">
          <div className="h-full btn-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        {fill && fill.requests > 0 && (() => {
          const c = costOf(fill, provider, fill.model, priceCat);
          return (
            <p className="mb-3 shrink-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-secondary">
              <Coins size={13} className="text-accent-400 shrink-0" />
              <span>
                This fill: {fill.requests} request{fill.requests === 1 ? "" : "s"} · {formatTokens(fill.inputTokens)} in / {formatTokens(fill.outputTokens)} out tokens ·{" "}
                <span className="text-text-primary font-medium" title={c.note}>
                  {c.basis === "list" ? "≈ " : ""}{formatUsd(c.usd)}
                </span>{" "}
                {c.basis === "billed" ? "billed" : c.basis === "list" ? "at list price" : c.basis === "local" ? "(runs on this computer)" : "(price unknown)"}
                {" "}· {Math.max(1, Math.round(fill.activeMs / 60000))} min
              </span>
              <button onClick={onOpenCosts} className="underline text-accent-400 hover:text-accent-300">Compare AI costs</button>
            </p>
          );
        })()}
        {uploadNote && (
          <p className={`mb-3 shrink-0 flex items-start gap-1.5 text-xs ${uploadNote.ok ? "text-text-secondary" : "text-danger-400"}`}>
            {uploadNote.ok ? <ClipboardCheck size={13} className="shrink-0 mt-0.5 text-accent-400" /> : <AlertTriangle size={13} className="shrink-0 mt-0.5" />}
            <span className="flex-1">{uploadNote.text}</span>
            <button onClick={onDismissUploadNote} aria-label="Dismiss" className="shrink-0 hover:text-text-primary"><X size={12} /></button>
          </p>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-4">
          {filled === 0 && !running && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDropHover(true); }}
              onDragLeave={() => setDropHover(false)}
              onDrop={(e) => { e.preventDefault(); setDropHover(false); const f = e.dataTransfer.files?.[0]; if (f) onPickScorecard(f); }}
              className={`rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition-colors ${dropHover ? "border-accent-400 bg-accent-500/10" : "border-border hover:border-primary-500/50 hover:bg-surface-overlay/30"}`}
            >
              <Upload size={20} className="mx-auto mb-1.5 text-primary-300" />
              <p className="text-sm font-medium text-text-primary">Have a completed scorecard?</p>
              <p className="text-xs text-text-secondary">
                Drop the .xlsm here or click to upload. Its answers fill in every helper&apos;s copy, ready to review or analyze.
                Or let{" "}
                <button onClick={(e) => { e.stopPropagation(); onOpenView?.("assistant"); }} className="underline text-accent-400">{label}</button>{" "}
                fill it out for you.
              </p>
            </div>
          )}
          {areaActive && area && (
            <div className="rounded-xl border border-accent-500/30 bg-accent-500/5 p-3 flex items-start gap-3">
              <AreaThumbnail area={area} />
              <div className="min-w-0 text-xs leading-relaxed">
                <h3 className="text-sm font-semibold text-text-primary">
                  {area.source === "city" ? (area.approximate ? "Approximate city boundary" : "City boundary") : "Selected area"} · {formatKm2(area.areaKm2)}
                </h3>
                <p className="text-text-secondary truncate">
                  {area.label || place}{area.fileName ? ` · from ${area.fileName}` : ""}
                </p>
                {area.source === "city" ? (
                  <p className="text-text-secondary mt-1">
                    Picked on the map. Open data is measured inside this {area.approximate ? "approximate circle (no official boundary is mapped)" : "official boundary"}; every indicator describes the whole city.
                  </p>
                ) : (
                  <p className="text-text-secondary mt-1">
                    <span className="inline-block px-1.5 rounded bg-accent-500/15 text-accent-400 font-medium">Area</span>{" "}
                    {AREA_SPECIFIC_CODES.size} indicators are scored for this area.{" "}
                    <span className="inline-block px-1.5 rounded bg-surface-overlay border border-border font-medium">City-wide</span>{" "}
                    {TOTAL_INDICATORS - AREA_SPECIFIC_CODES.size} describe the whole city (plans, budgets, institutions).
                  </p>
                )}
              </div>
            </div>
          )}
          {(() => {
            const p = profile;
            const bits: string[] = [];
            if (p.population != null) bits.push(`Population ${p.population.toLocaleString()}`);
            if (p.areaKm2 != null) bits.push(`${p.areaKm2.toLocaleString()} km²`);
            if (p.density != null) bits.push(`${p.density.toLocaleString()}/km²`);
            if (p.incomeUsd != null) bits.push(`Income $${p.incomeUsd.toLocaleString()}`);
            if (p.povertyPct != null) bits.push(`Poverty ${p.povertyPct}%`);
            if (p.literacyPct != null) bits.push(`Literacy ${p.literacyPct}%`);
            if (p.mostLikelyHazard) bits.push(`Main hazard: ${p.mostLikelyHazard}`);
            if (p.mostSevere) bits.push(`Worst: ${p.mostSevere}`);
            if (!bits.length && !(p.hazards && p.hazards.length)) return null;
            return (
              <div className="rounded-xl border border-border bg-surface-overlay/40 p-3">
                <h3 className="text-sm font-semibold text-text-primary mb-1.5">City information</h3>
                {p.hazards && p.hazards.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {p.hazards.map((h) => (
                      <span key={h} className="px-2 py-0.5 text-[11px] rounded-full bg-danger-500/10 text-danger-400 border border-danger-500/20">{h}</span>
                    ))}
                  </div>
                )}
                {bits.length > 0 && <p className="text-xs text-text-secondary leading-relaxed">{bits.join(" · ")}</p>}
              </div>
            );
          })()}
          {(sourceUse || sourceTally.answered > 0 || sourceTally.blank > 0) && (
            <div className="rounded-xl border border-accent-500/25 bg-accent-500/5 p-3 text-xs">
              <h3 className="text-sm font-semibold text-text-primary mb-1">{sourceUse ? "Your data sources" : "Where the answers come from"}</h3>
              <p className="text-text-secondary mb-2">
                {sourceTally.answered === 0 && !sourceTally.blank
                  ? "None of the answers are in yet. Each answer will link the sources it rests on: green for a source you chose in Settings (Step 3), blue for web pages and open data the AI found itself."
                  : `Of the ${sourceTally.answered} answered indicator${sourceTally.answered === 1 ? "" : "s"}:`}
              </p>
              {(sourceTally.answered > 0 || sourceTally.blank > 0) && (() => {
                const t = sourceTally;
                const pill = (n: number, label: string, cls: string, title: string) => (
                  <span key={label} title={title} className={`px-1.5 py-0.5 rounded-md border ${n ? cls : "bg-surface-overlay text-text-secondary border-border opacity-60"}`}>
                    <span className="font-semibold tabular-nums">{n}</span> {label}
                  </span>
                );
                return (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {sourceUse && pill(t.green, "cite your data sources", "bg-accent-500/10 text-accent-400 border-accent-500/25", "Answers that name one of the data sources you checked in Settings (green links).")}
                    {pill(t.blue, "cite web pages, open data or attachments", "bg-primary-500/10 text-primary-300 border-primary-500/25", "Answers linked to web pages, open data or documents you attached (blue links). An answer can cite both green and blue sources.")}
                    {pill(t.general, "AI general knowledge", "bg-surface-overlay text-text-primary border-border", "No source cited: the AI's background knowledge.")}
                    {t.user > 0 && pill(t.user, "from your notes or chat", "bg-surface-overlay text-text-primary border-border", "No source cited: what you wrote in the setup notes or chat.")}
                    {(t.guess > 0 || settings.allowGuesses) && pill(t.guess, t.guess === 1 ? "educated guess" : "educated guesses", "bg-warn-500/10 text-warn-400 border-warn-500/25", "No source cited: the AI guessed (educated guesses are allowed in Settings).")}
                    {pill(t.none, "no source cited", "bg-surface-overlay text-text-primary border-border", "Answers with neither a source nor a basis (from before sources were tracked, uploaded from a file, or edited by hand).")}
                    {t.blank > 0 && pill(t.blank, "left blank", "bg-warn-500/10 text-warn-400 border-warn-500/25", "Not answered: nothing traceable supported a score (each shows its reason).")}
                  </div>
                );
              })()}
              {sourceUse && (
                <div className="flex flex-wrap gap-1.5">
                  {sourceUse.chosen.map((d) => {
                    const n = sourceUse.count.get(d.id) ?? 0;
                    return (
                      <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer" title={`${d.name} (${d.provider})`}
                        className={`px-1.5 py-0.5 rounded-md border ${n ? "bg-accent-500/10 text-accent-400 border-accent-500/25" : "bg-surface-overlay text-text-secondary border-border"}`}>
                        {shortName(d)} · {n ? `cited in ${n}` : "not cited yet"}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {Array.from({ length: 10 }, (_, k) => k + 1).map((e) => {
            const inds = PRELIMINARY_INDICATORS.filter((i) => i.essential === e);
            const done = inds.filter((i) => draft[i.code]?.score != null).length;
            return (
              <div key={e}>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-sm font-semibold text-text-primary">E{e} · {ESSENTIAL_NAMES[e]}</h3>
                  <span className="text-xs text-text-secondary">{done}/{inds.length}</span>
                </div>
                <div className="space-y-1.5">
                  {inds.map((ind) => {
                    const entry = draft[ind.code];
                    return (
                      <div key={ind.code} className="rounded-lg border border-border bg-surface-overlay/30 p-2.5">
                        <div className="flex items-start gap-2">
                          <span className="text-xs font-mono text-primary-300 mt-0.5 shrink-0 w-11">{ind.code}</span>
                          <p className="text-xs text-text-secondary flex-1 leading-snug">
                            {areaActive && area && area.source !== "city" && (
                              scopeOf(ind.code) === "area"
                                ? <span title="Scored from the selected area's own evidence" className="mr-1 inline-block px-1.5 rounded text-[10px] bg-accent-500/15 text-accent-400 font-medium">Area</span>
                                : <span title="Applies to the whole city (governance, plans, budgets)" className="mr-1 inline-block px-1.5 rounded text-[10px] bg-surface-overlay border border-border font-medium">City-wide</span>
                            )}
                            {ind.text}
                          </p>
                          <select value={entry?.score == null ? "" : String(entry.score)}
                            onChange={(ev) => setScore(ind.code, ev.target.value === "" ? null : (Number(ev.target.value) as Score))}
                            className={`shrink-0 text-xs rounded-lg px-2 py-1 border bg-surface-overlay text-text-primary ${entry?.score == null ? "border-border" : "border-accent-500/40"}`}>
                            <option value="">not set</option>
                            <option value="0">{SCORE_LABELS["0"]}</option>
                            <option value="1">{SCORE_LABELS["1"]}</option>
                            <option value="2">{SCORE_LABELS["2"]}</option>
                            <option value="3">{SCORE_LABELS["3"]}</option>
                          </select>
                        </div>
                        {(entry?.note || entry?.score != null) && (
                          <input value={entry?.note || ""} onChange={(ev) => setNote(ind.code, ev.target.value)}
                            placeholder="note / basis (optional)"
                            className="w-full mt-2 px-2 py-1 rounded-md bg-surface border border-border text-text-secondary text-xs" />
                        )}
                        {entry?.score == null && entry?.blank && (
                          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-text-secondary">
                            <span title="Nothing traceable supported a score, and educated guesses are off in Settings. Set it yourself, or give the AI details in the chat."
                              className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border bg-warn-500/10 border-warn-500/25 text-warn-400">
                              left blank
                            </span>
                            <span className="leading-snug">{entry.blank}</span>
                          </p>
                        )}
                        {entry?.score != null && (() => {
                          const chosen = sourceUse?.perCode.get(ind.code) ?? [];
                          const web = entry.sources ?? [];
                          return (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              {chosen.length > 0 && <DataSourceChips sources={chosen} size="xs" />}
                              {web.length > 0 && <WebSourceChips sources={web} size="xs" />}
                              {!chosen.length && !web.length && <BasisTag basis={entry.basis} />}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="shrink-0 mt-3 flex flex-wrap gap-2 border-t border-border pt-3 items-center">
          <button onClick={handleLoad} disabled={filled === 0 || running || externalBusy}
            title={`Open ${label}'s scorecard on the Analysis tab and have ${label} analyze it`}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent disabled:opacity-50 disabled:cursor-not-allowed">
            <Play size={16} /> Run analysis
          </button>
          <button onClick={handleDownloadOfficial} disabled={building}
            title="The finished scorecard written into the real UNDRR .xlsm: City Information filled, the matching radio button selected in every question, and totals recalculated."
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary disabled:opacity-60">
            {building ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}{" "}
            {filled === 0
              ? "Download official scorecard (.xlsm)"
              : filled === TOTAL_INDICATORS
              ? "Download completed scorecard (.xlsm)"
              : "Download scorecard so far (.xlsm)"}
          </button>
          <button onClick={requestClearScorecard} disabled={filled === 0 || running}
            title={running ? `Stop ${label} first` : filled === 0 ? "Nothing to clear yet: no answers have been filled in" : `Reset every answer, note and the City Information in ${label}'s copy`}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium border border-danger-500/40 bg-danger-500/10 text-danger-400 hover:bg-danger-500/15 disabled:opacity-50 disabled:cursor-not-allowed">
            <X size={15} /> Clear Scorecard
          </button>
          <button onClick={handleDownload}
            title="A plain spreadsheet where every answer is a simple 0-3 number and totals are formulas, no form controls at all. Handy if you'd rather not use the official template."
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary ml-auto">
            <Download size={13} /> Plain spreadsheet (.xlsx)
          </button>
        </div>
        {filled < TOTAL_INDICATORS && (
          <p className="text-xs text-text-secondary mt-2 shrink-0">
            {resolved < TOTAL_INDICATORS
              ? "Unfilled indicators count as 0 if you analyze now. Keep chatting to finish them."
              : `${blanks} indicator${blanks === 1 ? " was" : "s were"} left blank because nothing traceable supports a score; they count as 0 if you analyze now. Add details in the chat, or set them yourself.`}
          </p>
        )}
      </section>
    </div>
  );

  return (
    <>
      {assistantHost && createPortal(chatView, assistantHost)}
      {scorecardHost && createPortal(scorecardView, scorecardHost)}
    </>
  );
});
