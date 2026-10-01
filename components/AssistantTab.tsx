"use client";

/**
 * Assistant + Scorecard tabs, an AI agent that helps fill out the UNDRR ARISE
 * Preliminary scorecard, and the live scorecard it fills. One component renders
 * both (chosen by `view`) so they share a single draft: a run in the Assistant
 * keeps filling the Scorecard tab even while you look at it. Highlights:
 *   • Streams the model's output live so you can see it working.
 *   • Stop any time and Continue later (even after switching model, or once a
 *     rate limit clears). Failures explain themselves instead of dying quietly.
 *   • Saved chat history: switch between scorecards, start new, delete.
 *   • Attach reference documents (text files) to teach the model about the city.
 *   • Fills a live, editable draft you can load into the analyzer or download.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, Send, Sparkles, Upload, Loader2, Wrench, Download, RotateCcw,
  ClipboardCheck, Lightbulb, Plus, Trash2, Paperclip, X, Play, AlertTriangle, History, ChevronDown,
  Building2, Map as MapIcon,
} from "lucide-react";
import type { AppSettings } from "@/lib/settings/store";
import { getSearchKey, hasSearchKey } from "@/lib/settings/store";
import { createProvider } from "@/lib/llm";
import { uploadScorecard } from "@/lib/client/api";
import { PRELIMINARY_INDICATORS, TOTAL_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";
import { ESSENTIAL_NAMES, type NormalizedScorecard } from "@/lib/scorecard/schema";
import {
  emptyDraft, filledCount, draftToScorecard, mergeScorecardIntoDraft,
  type Draft, type Score, type CityInfo,
} from "@/lib/agent/draft";
import { runAgentTurn, type AgentContext, type TranscriptItem, type AgentEvent } from "@/lib/agent/agent";
import { exportScorecardXlsx } from "@/lib/export/scorecardXlsx";
import { renderMarkdown, deEmDash } from "@/lib/ui/markdown";
import { ModelSuggestion } from "@/components/ModelSuggestion";
import { UserMessageBubble } from "@/components/UserMessageBubble";
import { computeTemplateEdits, fillOfficialTemplate } from "@/lib/export/fillTemplate";
import {
  createSession, listSessions, loadSession, saveSession, deleteSession, getActiveId, setActiveId,
  type AssistantSession, type SessionMeta, type ChatItem, type Attachment,
} from "@/lib/agent/sessions";
import { ConfirmModal } from "@/components/ConfirmModal";
import { LiveStream } from "@/components/LiveStream";
import { SessionMenu } from "@/components/SessionMenu";
import { AreaPicker } from "@/components/AreaPicker";
import { AreaThumbnail } from "@/components/AreaThumbnail";
import { validateArea, describeArea, formatKm2, type AreaSelection } from "@/lib/geo/area";
import { scopeOf, AREA_SPECIFIC_CODES } from "@/lib/geo/indicatorScope";
import { COUNTRIES, countryByCode, countryCodeFor, regionsOf, findRegion } from "@/lib/geo/countries";

const SCORE_LABELS: Record<string, string> = {
  "0": "0 · None", "1": "1 · Limited", "2": "2 · Substantial", "3": "3 · Comprehensive",
};

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|rtf|html?|xml|yaml|yml)$/i;
const MAX_ATTACH_CHARS = 12000;

// Lazy-load pdf.js from a CDN only when a PDF is actually attached, so we don't
// add a build dependency. Returns extracted text, or throws so the caller can
// fall back to asking the user to paste the text.
let pdfjsPromise: Promise<unknown> | null = null;
function loadPdfJs(): Promise<{ getDocument: (opts: unknown) => { promise: Promise<unknown> } } & Record<string, unknown>> {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const w = window as unknown as Record<string, unknown>;
      if (w.pdfjsLib) return resolve(w.pdfjsLib);
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
      s.type = "module";
      // The .mjs build attaches to window as pdfjsLib once evaluated.
      const fallback = document.createElement("script");
      fallback.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      fallback.onload = () => {
        const lib = (window as unknown as Record<string, unknown>).pdfjsLib as Record<string, unknown> | undefined;
        if (lib) {
          (lib as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions &&
            ((lib as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
              "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js");
          resolve(lib);
        } else reject(new Error("pdf.js failed to load"));
      };
      fallback.onerror = () => reject(new Error("pdf.js failed to load"));
      document.head.appendChild(fallback);
    });
  }
  return pdfjsPromise as Promise<{ getDocument: (opts: unknown) => { promise: Promise<unknown> } } & Record<string, unknown>>;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = (await (pdfjs.getDocument({ data: buf }) as { promise: Promise<unknown> }).promise) as {
    numPages: number;
    getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>;
  };
  const parts: string[] = [];
  const maxPages = Math.min(doc.numPages, 40);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str || "").join(" "));
    if (parts.join(" ").length > MAX_ATTACH_CHARS) break;
  }
  return parts.join("\n").trim();
}

// Pull the model's own reasoning (the words it wrote before/around the JSON it
// returns) out of a raw step so we can keep it for the reader. Models that only
// return JSON leave nothing here, and that's fine, the summary line covers them.
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

export function AssistantTab({
  view,
  onOpenView,
  settings,
  providerReady,
  onLoadIntoAnalyzer,
  onUseProvider,
  onRunningChange,
  externalBusy = false,
}: {
  /** Which half to show: the chat ("assistant") or the live draft ("scorecard"). */
  view: "assistant" | "scorecard";
  onOpenView?: (v: "assistant" | "scorecard") => void;
  settings: AppSettings;
  providerReady: boolean;
  onLoadIntoAnalyzer: (sc: NormalizedScorecard) => void;
  onUseProvider?: (p: AppSettings["provider"]) => void;
  onRunningChange?: (running: boolean) => void;
  externalBusy?: boolean;
}) {
  // Mirrored active-session state
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActive] = useState<string>("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState(""); // country name, as shown and sent to research
  const [countryCode, setCountryCode] = useState(""); // ISO alpha-2 behind the Country dropdown
  const [region, setRegion] = useState(""); // state/province name, when the country has them
  const [info, setInfo] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [profile, setProfile] = useState<CityInfo>({ name: "", country: "" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [setupMode, setSetupMode] = useState<"city" | "area">("city");
  const [dropHover, setDropHover] = useState(false);
  // Upload feedback shown on the Scorecard tab (the chat log lives on the other tab).
  const [uploadNote, setUploadNote] = useState<{ ok: boolean; text: string } | null>(null);
  // "That place doesn't exist" popup, and the check that runs before a fill.
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [checkingPlace, setCheckingPlace] = useState(false);
  // Bumped by "Clear all Information" so the map picker starts over too.
  const [pickerKey, setPickerKey] = useState(0);
  const [area, setArea] = useState<AreaSelection | null>(null);

  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [thinking, setThinking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState("");
  const [continuable, setContinuable] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; onYes: () => void; danger?: boolean; yes: string }>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Non-rendered working state
  const transcriptRef = useRef<TranscriptItem[]>([]);
  const activeMetaRef = useRef<{ id: string; createdAt: number }>({ id: "", createdAt: Date.now() });
  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef<Draft>(draft);
  draftRef.current = draft;
  const profileRef = useRef<CityInfo>(profile);
  profileRef.current = profile;
  const [setupOpen, setSetupOpen] = useState(true);
  const attachRef = useRef<Attachment[]>(attachments);
  attachRef.current = attachments;
  const streamBuf = useRef("");
  const streamScheduled = useRef(false);
  const stepStartRef = useRef(0);
  const templateBufRef = useRef<ArrayBuffer | null>(null);
  const lastModeRef = useRef<"autonomous" | "assist">("assist");
  const [building, setBuilding] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the composer so a long paste is fully visible and easy to edit.
  // Guard against being measured while the tab is hidden (scrollHeight is 0
  // then), which previously collapsed the box until you clicked it.
  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const h = el.scrollHeight;
    el.style.height = h > 0 ? `${Math.min(h, 200)}px` : ""; // "" → fall back to CSS min-height
  }, []);
  useEffect(() => { resizeComposer(); }, [input, resizeComposer]);
  // Re-measure when the composer becomes visible again (e.g. switching to this
  // tab), so it's never stuck collapsed.
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(() => resizeComposer());
    obs.observe(el);
    return () => obs.disconnect();
  }, [resizeComposer]);
  const stuckToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);
  const ready = useRef(false);
  const mountedRef = useRef(true);
  const runSessionRef = useRef<string>("");
  const ctxRef = useRef<AgentContext | null>(null);
  const queuedInputRef = useRef<string[]>([]);
  const undoSnapshotRef = useRef<Draft | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  const filled = filledCount(draft);
  const pct = Math.round((filled / TOTAL_INDICATORS) * 100);
  const areaActive = setupMode === "area";
  const areaProblem = area ? validateArea(area) : "Draw an area on the map or load one from a file.";
  const canStart = areaActive ? !areaProblem : !!city.trim();
  // A new area fills in the City/Country boxes; the user can still edit them.
  const onPlaceResolved = useCallback((p: {
    city: string; country: string; countryCode?: string | null; regionName?: string | null; regionCode?: string | null;
  }) => {
    if (p.city) setCity(p.city);
    const code = countryCodeFor(p.countryCode || "") || countryCodeFor(p.country);
    if (code) {
      setCountryCode(code);
      setCountry(countryByCode(code)?.name || p.country);
      setRegion(findRegion(code, p.regionCode || "")?.name || findRegion(code, p.regionName || "")?.name || "");
    } else if (p.country) {
      setCountryCode("");
      setCountry(p.country);
      setRegion("");
    }
  }, []);

  // Country dropdown: keep the name, the code and the (now stale) state in step.
  const selectCountry = useCallback((code: string) => {
    setCountryCode(code);
    setCountry(countryByCode(code)?.name || "");
    setRegion("");
  }, []);
  const regionOptions = regionsOf(countryCode);
  const regionCode = findRegion(countryCode, region)?.code;

  // ── Session load/save ───────────────────────────────
  const buildActiveSession = useCallback((): AssistantSession => ({
    id: activeMetaRef.current.id,
    title: "",
    city, country, countryCode, region, info,
    chat,
    transcript: transcriptRef.current,
    draft: draftRef.current,
    profile: profileRef.current,
    attachments: attachRef.current,
    setupMode,
    area,
    createdAt: activeMetaRef.current.createdAt,
    updatedAt: Date.now(),
  }), [city, country, countryCode, region, info, chat, setupMode, area]);

  const saveActive = useCallback(() => {
    if (!activeMetaRef.current.id) return;
    saveSession(buildActiveSession());
    setSessions(listSessions());
  }, [buildActiveSession]);

  const loadIntoState = useCallback((s: AssistantSession) => {
    activeMetaRef.current = { id: s.id, createdAt: s.createdAt };
    transcriptRef.current = s.transcript || [];
    templateBufRef.current = null; // fresh sessions fill the bundled official template
    setActive(s.id);
    setActiveId(s.id);
    setCity(s.city || "");
    setCountry(s.country || "");
    // Sessions saved before the dropdown only have the country's name.
    setCountryCode(s.countryCode || countryCodeFor(s.country) || "");
    setRegion(s.region || "");
    setInfo(s.info || "");
    setChat(s.chat || []);
    setDraft(Object.keys(s.draft || {}).length ? s.draft : emptyDraft());
    setProfile(s.profile && s.profile.name != null ? s.profile : { name: s.city || "", country: s.country || "" });
    setAttachments(s.attachments || []);
    setSetupMode(s.setupMode === "area" ? "area" : "city");
    setUploadNote(null);
    setArea(s.area || null);
    setContinuable(false);
    setStream("");
    stuckToBottomRef.current = true;
    setShowJump(false);
    queuedInputRef.current = [];
    undoSnapshotRef.current = null;
    setCanUndo(false);
  }, []);

  // First mount: restore or create a session
  useEffect(() => {
    const list = listSessions();
    setSessions(list);
    const wantId = getActiveId();
    const existing = (wantId && loadSession(wantId)) || (list[0] && loadSession(list[0].id));
    if (existing) loadIntoState(existing);
    else {
      const s = createSession();
      saveSession(s);
      setSessions(listSessions());
      loadIntoState(s);
    }
    ready.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save (debounced) whenever mirrored state changes
  useEffect(() => {
    if (!ready.current || !activeMetaRef.current.id) return;
    const t = setTimeout(saveActive, 500);
    return () => clearTimeout(t);
  }, [city, country, countryCode, region, info, chat, draft, profile, attachments, setupMode, area, saveActive]);

  // Which session the rendered state currently reflects. loadIntoState sets the
  // id ref at once but the state only on the next render, so saving in between
  // would write a blank session over the stored one.
  const renderedIdRef = useRef("");
  useEffect(() => { renderedIdRef.current = activeId; }, [activeId]);

  // On unmount (e.g. full page navigation), stop any run and persist.
  // React Strict Mode (npm run dev) mounts, unmounts and re-mounts every
  // component once, so this must leave things usable when it mounts again.
  const saveActiveRef = useRef(saveActive);
  saveActiveRef.current = saveActive;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (renderedIdRef.current && renderedIdRef.current === activeMetaRef.current.id) {
        try { saveActiveRef.current(); } catch { /* ignore */ }
      }
    };
  }, []);

  // The Assistant is a normal, full-height page: the whole window scrolls.
  // Only pull the page to the newest message if the reader is already near the
  // bottom. If they've scrolled up to read, leave them be (and show a "jump to
  // latest" button instead).
  useEffect(() => {
    if (view === "assistant" && stuckToBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [chat, thinking, stream, view]);

  useEffect(() => {
    if (view !== "assistant") return;
    const onScroll = () => {
      const doc = document.documentElement;
      const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 120;
      stuckToBottomRef.current = atBottom;
      setShowJump(!atBottom);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [view]);

  const jumpToLatest = useCallback(() => {
    stuckToBottomRef.current = true;
    setShowJump(false);
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    if (!thinking) { setElapsed(0); return; }
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [thinking]);

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
        // scrolled back to and expanded, instead of vanishing when the next
        // step starts.
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
      case "tool":
        setChat((c) => [...c, { kind: "tool", label: e.label, detail: e.detail }]);
        break;
      case "draft":
        // Read the live object the agent is mutating (ctx.draft), NOT the last
        // rendered copy, otherwise the panel freezes at the first batch and
        // only catches up when the run ends.
        setDraft({ ...(ctxRef.current?.draft || draftRef.current) });
        break;
      case "info":
        if (ctxRef.current?.info) setProfile({ ...ctxRef.current.info });
        break;
      case "done":
        setContinuable(false);
        break;
      case "stopped":
        setContinuable(true);
        setChat((c) => [...c, { kind: "tool", label: "Paused", detail: "press Continue whenever you're ready" }]);
        break;
      case "error":
        setChat((c) => [...c, { kind: "assistant", text: `I couldn't keep going: ${e.text}.` }]);
        setContinuable(!!e.canContinue);
        break;
    }
  }, []);

  const runTurn = useCallback(
    async (userText: string | null, opts?: { mode?: "autonomous" | "assist" }) => {
      if (runningRef.current) return; // never start a second run over a live one
      if (externalBusy) {
        setChat((c) => [...c, { kind: "assistant", text: "The Dashboard analysis is still running. I'll wait for that to finish so the two don't clash, then ask me again." }]);
        return;
      }
      if (!providerReady) {
        setChat((c) => [...c, { kind: "assistant", text: "First choose an AI model and add a key in Settings, then come back here." }]);
        return;
      }
      const mode = opts?.mode ?? lastModeRef.current;
      lastModeRef.current = mode;
      let provider;
      try {
        provider = await createProvider(settings); // rebuilt each turn, so switching model then Continue works
      } catch (err) {
        setChat((c) => [...c, { kind: "assistant", text: `⚠ Couldn't start the model: ${err instanceof Error ? err.message : String(err)}.` }]);
        return;
      }
      const searchKey = hasSearchKey() ? await getSearchKey() : null;
      // Snapshot the draft so the whole run can be undone in one click.
      undoSnapshotRef.current = JSON.parse(JSON.stringify(draftRef.current));
      queuedInputRef.current = [];
      const ctx: AgentContext = {
        provider,
        transcript: transcriptRef.current,
        draft: draftRef.current,
        info: { ...profileRef.current, name: city.trim() || profileRef.current.name || "", country: country.trim() || profileRef.current.country || "" },
        searchKey,
        city: city.trim(),
        country: country.trim(),
        region: region.trim() || undefined,
        attachments: attachRef.current,
        mode,
        drainInput: () => queuedInputRef.current.shift() ?? null,
        area: areaActive ? area : null,
      };
      ctxRef.current = ctx;
      if (userText) transcriptRef.current.push({ role: "user", content: userText } as TranscriptItem);
      // Guard: if the user switches session (or unmounts) mid-run, an aborted
      // run must not write its old draft/events into the new session.
      const runSession = activeMetaRef.current.id;
      runSessionRef.current = runSession;
      const emit = (e: AgentEvent) => {
        if (!mountedRef.current || activeMetaRef.current.id !== runSession) return;
        onEvent(e);
      };
      setRunning(true);
      runningRef.current = true;
      onRunningChange?.(true);
      setContinuable(false);
      setSetupOpen(false); // give the chat room once it's working; user can reopen
      abortRef.current = new AbortController();
      try {
        await runAgentTurn(ctx, emit, abortRef.current.signal);
      } finally {
        const sameSession = mountedRef.current && activeMetaRef.current.id === runSession;
        runningRef.current = false;
        onRunningChange?.(false);
        if (mountedRef.current) {
          setRunning(false);
          setThinking(false);
          setStream("");
        }
        if (sameSession) {
          setDraft({ ...ctx.draft }); // fresh state → debounced auto-save
          setProfile({ ...ctx.info });
          // Offer a one-click undo if the run actually changed the scores.
          const before = undoSnapshotRef.current;
          const changed = before && JSON.stringify(before) !== JSON.stringify(ctx.draft);
          setCanUndo(!!changed);
        }
      }
    },
    [providerReady, settings, city, country, region, onEvent, areaActive, area]
  );

  const undoLastRun = useCallback(() => {
    const snap = undoSnapshotRef.current;
    if (!snap) return;
    setDraft({ ...snap });
    draftRef.current = { ...snap };
    setCanUndo(false);
    setChat((c) => [...c, { kind: "tool", label: "Undid the last run", detail: "scores restored to before it started" }]);
  }, []);

  const handleStartAutonomous = useCallback(async () => {
    if (!canStart || running || externalBusy || checkingPlace) return;
    const place = [city.trim(), region.trim(), country.trim()].filter(Boolean).join(", ");
    // Make sure the typed city (in that state and country) is a real place before
    // spending any AI calls on it. If the lookup itself fails, don't block the user.
    if (city.trim()) {
      setCheckingPlace(true);
      let found: boolean | null = null;
      try {
        const res = await fetch("/api/area", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "checkCity", city: city.trim(), country: country.trim(),
            countryCode: countryCode || undefined, regionCode: regionCode || undefined,
          }),
        });
        if (res.ok) found = ((await res.json()) as { found: boolean }).found;
      } catch {
        found = null;
      } finally {
        setCheckingPlace(false);
      }
      if (found === false) {
        setPlaceError(
          region.trim()
            ? `The city, state or province, country combination "${place}" does not exist. Check the spelling and try again.`
            : country.trim()
            ? `The city, country combination "${place}" does not exist. Check the spelling and try again.`
            : `The city "${city.trim()}" does not exist. Check the spelling and try again.`
        );
        setCity("");
        setCountry("");
        setCountryCode("");
        setRegion("");
        return;
      }
    }
    const cityLine = areaActive && area
      ? `the selected area (${describeArea(area)}${place ? `, in ${place}` : ""})`
      : place;
    const already = filledCount(draftRef.current);
    const scope =
      already > 0
        ? `Some indicators (${already} of ${TOTAL_INDICATORS}) are already filled in from the file you uploaded. I'll keep those and finish the rest for ${cityLine}. `
        : `Please fill out the whole scorecard for ${cityLine}. `;
    const msg =
      scope +
      (info.trim() ? `Here is what I know about ${areaActive ? "the area" : "the city"}: ${info.trim()}. ` : "") +
      `Research ${areaActive ? "the area and its city" : "the city"} as needed, set every indicator with a short note, and only ask me if something truly cannot be researched.`;
    setChat((c) => [...c, { kind: "user", text: already > 0 ? `Complete the rest for ${cityLine}.` : `Fill it out for ${cityLine}.` }]);
    void runTurn(msg, { mode: "autonomous" });
  }, [canStart, checkingPlace, city, country, countryCode, region, regionCode, info, running, externalBusy, runTurn, areaActive, area]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || externalBusy) return;
    setInput("");
    setChat((c) => [...c, { kind: "user", text }]);
    if (running) {
      // Steer mid-run: queue it for the next step (like Cursor/Copilot).
      queuedInputRef.current.push(text);
      setChat((c) => [...c, { kind: "tool", label: "I'll pick that up on the next step", detail: undefined }]);
      return;
    }
    void runTurn(text, { mode: "assist" });
  }, [input, running, externalBusy, runTurn]);

  const handleContinue = useCallback(() => {
    if (running || externalBusy) return;
    setChat((c) => [...c, { kind: "tool", label: "Continuing", detail: `with ${settings.provider}` }]);
    void runTurn("Continue from where you left off."); // keeps the last mode
  }, [running, externalBusy, runTurn, settings.provider]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // ── Scorecard upload (start / continue a fill) ──────
  const applyScorecardFile = useCallback(async (file: File, intoNew: boolean) => {
    setUploadNote({ ok: true, text: `Reading ${file.name}…` });
    setChat((c) => [...c, { kind: "tool", label: "Reading file", detail: file.name }]);
    try {
      templateBufRef.current = await file.arrayBuffer(); // use their file as the fill base when possible
      const sc = await uploadScorecard(file);
      const knownCity = sc.city?.name && sc.city.name !== "Unknown" ? sc.city.name : "";
      const knownCountry = sc.city?.country && sc.city.country !== "Unknown" ? sc.city.country : "";

      if (intoNew) {
        saveActive();
        const s = createSession({ city: knownCity, country: knownCountry });
        s.draft = emptyDraft();
        saveSession(s);
        setSessions(listSessions());
        loadIntoState(s);
      }
      const base = intoNew ? emptyDraft() : draftRef.current;
      const { draft: merged, loaded } = mergeScorecardIntoDraft(base, sc);
      draftRef.current = merged;
      setDraft(merged);
      if (knownCity) setCity(knownCity);
      if (knownCountry) {
        const code = countryCodeFor(knownCountry);
        setCountry(code ? countryByCode(code)?.name || knownCountry : knownCountry);
        if (code !== countryCode) setRegion("");
        setCountryCode(code || "");
      }
      // Carry the file's City Information over too (only the fields it has).
      const pf = sc.profile || {};
      const fromFile: Partial<CityInfo> = {};
      if (pf.population != null) fromFile.population = pf.population;
      if (pf.incomeUsd != null) fromFile.incomeUsd = pf.incomeUsd;
      if (pf.hazards?.length) fromFile.hazards = pf.hazards;
      if (pf.mostSevere) fromFile.mostSevere = pf.mostSevere;
      if (sc.assessedDate) fromFile.assessedDate = sc.assessedDate;
      setProfile((p) => {
        const next = { ...(intoNew ? { name: "", country: "" } : p), ...fromFile, name: knownCity || p.name, country: knownCountry || p.country };
        profileRef.current = next;
        return next;
      });
      setChat((c) => [...c, { kind: "tool", label: `Parsed ${file.name}`, detail: `${loaded} of ${TOTAL_INDICATORS} answers found` }]);
      setUploadNote({
        ok: true,
        text: `Loaded ${loaded} of ${TOTAL_INDICATORS} answers from ${file.name}` +
          (loaded < TOTAL_INDICATORS ? `. The Assistant can fill in the rest.` : "."),
      });
      const guidance = knownCity && loaded >= TOTAL_INDICATORS
        ? `Loaded your completed scorecard for ${knownCity}${knownCountry ? ", " + knownCountry : ""}: all ${TOTAL_INDICATORS} answers are on the Scorecard tab. Press "Run analysis" there to analyze it, or ask me to review any answer first.`
        : knownCity
        ? `Loaded your file for ${knownCity}${knownCountry ? ", " + knownCountry : ""} with ${loaded} of ${TOTAL_INDICATORS} indicators already answered. Press "Fill it out for me" and I'll complete the rest.`
        : loaded > 0
        ? `Loaded ${loaded} of ${TOTAL_INDICATORS} answers, but I couldn't find the city in the file. Which city is this scorecard for? (You can also type it in the City box above.)`
        : `That file doesn't have any answers in it yet. Type your city above and press "Fill it out for me" and I'll take it from there.`;
      setChat((c) => [...c, { kind: "assistant", text: guidance }]);
    } catch (e) {
      const msg = `Could not read that file: ${e instanceof Error ? e.message : String(e)}. Make sure it's an official UNDRR Preliminary scorecard (.xlsm/.xlsx).`;
      setUploadNote({ ok: false, text: msg });
      setChat((c) => [...c, { kind: "assistant", text: msg }]);
    }
  }, [saveActive, loadIntoState, countryCode]);

  const onScorecardPicked = useCallback((file: File) => {
    const hasContent = chat.length > 0 || filledCount(draftRef.current) > 0 || running;
    if (hasContent) {
      setConfirm({
        title: "Start a new chat?",
        body: "You attached a new scorecard while another was in progress. This starts a fresh chat for it. Your current chat stays saved and you can switch back any time.",
        yes: "Start new chat",
        onYes: () => { setConfirm(null); if (running) stop(); void applyScorecardFile(file, true); },
      });
    } else {
      void applyScorecardFile(file, false);
    }
  }, [chat.length, running, stop, applyScorecardFile]);

  // ── Reference-document attachments (RAG) ────────────
  const onDocsPicked = useCallback(async (files: FileList) => {
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      // Skip duplicates (same name already attached).
      if (attachRef.current.some((a) => a.name === file.name)) {
        setChat((c) => [...c, { kind: "tool", label: "Already attached", detail: file.name }]);
        continue;
      }
      const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      if (isPdf) {
        setChat((c) => [...c, { kind: "tool", label: "Reading PDF", detail: file.name }]);
        try {
          const text = await extractPdfText(file);
          if (text && text.length > 20) {
            added.push({ name: file.name, text: text.slice(0, MAX_ATTACH_CHARS) });
          } else {
            setChat((c) => [...c, { kind: "assistant", text: `I opened "${file.name}" but couldn't pull much text out of it, it may be a scanned image rather than a text PDF. If you paste the key details into the chat, I'll use them.` }]);
          }
        } catch {
          setChat((c) => [...c, { kind: "assistant", text: `I couldn't read "${file.name}" as a PDF here. If you copy the important text into the chat, I'll work from that.` }]);
        }
        continue;
      }
      if (!TEXT_EXT.test(file.name) && !file.type.startsWith("text/")) {
        setChat((c) => [...c, { kind: "assistant", text: `I can read PDFs and text documents (txt, md, csv, json, html). "${file.name}" is a ${file.name.split(".").pop()?.toUpperCase() || "binary"} file, so I can't read it directly. If you paste the important text into the chat, I'll use it.` }]);
        continue;
      }
      try {
        const text = await file.text();
        added.push({ name: file.name, text: text.slice(0, MAX_ATTACH_CHARS) });
      } catch {
        setChat((c) => [...c, { kind: "assistant", text: `Couldn't read "${file.name}".` }]);
      }
    }
    if (added.length) {
      setAttachments((a) => {
        const next = [...a, ...added];
        attachRef.current = next;
        return next;
      });
      for (const a of added) {
        const words = a.text.split(/\s+/).filter(Boolean).length;
        setChat((c) => [...c, { kind: "tool", label: "Ready to use", detail: `${a.name} (read about ${words.toLocaleString()} words)` }]);
      }
    }
  }, []);

  const removeAttachment = useCallback((name: string) => {
    setAttachments((a) => {
      const next = a.filter((x) => x.name !== name);
      attachRef.current = next;
      return next;
    });
    setChat((c) => [...c, { kind: "tool", label: "Removed attachment", detail: name }]);
  }, []);

  // ── Session management ──────────────────────────────
  const switchTo = useCallback((id: string) => {
    if (id === activeId) return;
    if (running) { stop(); setRunning(false); setThinking(false); setStream(""); }
    saveActive();
    const s = loadSession(id);
    if (s) loadIntoState(s);
  }, [activeId, running, stop, saveActive, loadIntoState]);

  const newChat = useCallback(() => {
    if (running) { stop(); setRunning(false); setThinking(false); setStream(""); }
    saveActive();
    const s = createSession();
    saveSession(s);
    setSessions(listSessions());
    loadIntoState(s);
    setSetupOpen(true); // a fresh scorecard starts with choosing the place
  }, [running, stop, saveActive, loadIntoState]);

  const requestDeleteSession = useCallback((id: string) => {
    const meta = listSessions().find((s) => s.id === id);
    setConfirm({
      title: "Delete this chat?",
      body: `This permanently removes "${meta?.title || "this scorecard"}" and its draft. This cannot be undone.`,
      yes: "Delete",
      danger: true,
      onYes: () => {
        setConfirm(null);
        const wasActive = id === activeMetaRef.current.id;
        if (wasActive && running) stop();
        deleteSession(id);
        const list = listSessions();
        setSessions(list);
        if (wasActive) {
          const next = list[0] && loadSession(list[0].id);
          if (next) loadIntoState(next);
          else {
            const s = createSession();
            saveSession(s);
            setSessions(listSessions());
            loadIntoState(s);
          }
        }
      },
    });
  }, [running, stop, loadIntoState]);

  // ── Clearing ────────────────────────────────────────
  // Only offered while no run is going: a stopping run writes its last draft
  // back when it ends, which would undo the clear.

  /** Scorecard tab: blank the 47 answers and the City Information; keep the place and the chat. */
  const clearScorecardNow = useCallback(() => {
    const blank = emptyDraft();
    draftRef.current = blank;
    setDraft(blank);
    const p: CityInfo = { name: city.trim(), country: country.trim() };
    profileRef.current = p;
    setProfile(p);
    templateBufRef.current = null; // downloads go back to the bundled official template
    undoSnapshotRef.current = null;
    setCanUndo(false);
    setContinuable(false);
    setUploadNote(null);
    transcriptRef.current.push({
      role: "tool",
      content: "The user cleared the scorecard: every indicator and the City Information page are blank again. Earlier scores no longer apply.",
    });
    setChat((c) => [...c, { kind: "tool", label: "Scorecard cleared", detail: "all answers and City Information reset" }]);
  }, [city, country]);

  /** Assistant tab: start this scorecard over — place, area, notes, answers, chat and attachments. */
  const clearEverythingNow = useCallback(() => {
    const blank = emptyDraft();
    draftRef.current = blank;
    setDraft(blank);
    profileRef.current = { name: "", country: "" };
    setProfile({ name: "", country: "" });
    setCity("");
    setCountry("");
    setCountryCode("");
    setRegion("");
    setInfo("");
    setArea(null);
    setPickerKey((k) => k + 1);
    setChat([]);
    transcriptRef.current = [];
    attachRef.current = [];
    setAttachments([]);
    templateBufRef.current = null;
    undoSnapshotRef.current = null;
    queuedInputRef.current = [];
    setCanUndo(false);
    setContinuable(false);
    setUploadNote(null);
    setSetupOpen(true);
  }, []);

  const requestClearScorecard = useCallback(() => {
    setConfirm({
      title: "Clear the scorecard?",
      body: "All scorecard information will be reset: every answer and note, and the City Information. The city or area and the chat stay. This can't be undone.",
      yes: "Proceed",
      danger: true,
      onYes: () => { setConfirm(null); clearScorecardNow(); },
    });
  }, [clearScorecardNow]);

  const requestClearEverything = useCallback(() => {
    setConfirm({
      title: "Clear all information?",
      body: "All unsaved data for this scorecard will be lost: the city or area, country, state or province, your notes, every scorecard answer, the chat, and any attached documents. This can't be undone.",
      yes: "Proceed",
      danger: true,
      onYes: () => { setConfirm(null); clearEverythingNow(); },
    });
  }, [clearEverythingNow]);

  // ── Draft edits + handoff ───────────────────────────
  const cityInfo: CityInfo = useMemo(
    () => ({ ...profile, name: city.trim() || profile.name || "Unknown", country: country.trim() || profile.country || "Unknown" }),
    [city, country, profile]
  );
  const headerTitle = city.trim() ? [city.trim(), region.trim(), country.trim()].filter(Boolean).join(", ") : "New scorecard";
  const handleLoad = useCallback(() => onLoadIntoAnalyzer(draftToScorecard(draftRef.current, cityInfo)), [cityInfo, onLoadIntoAnalyzer]);
  const handleDownload = useCallback(() => exportScorecardXlsx(draftToScorecard(draftRef.current, cityInfo)), [cityInfo]);

  // Fill and download the REAL official .xlsm (formatting + macros preserved).
  const fetchBundled = async (): Promise<ArrayBuffer> => {
    const res = await fetch("/undrr-preliminary-template.xlsm");
    if (!res.ok) throw new Error("Couldn't load the official template file.");
    return res.arrayBuffer();
  };
  const editCount = (m: Map<string, unknown[]>) => [...m.values()].reduce((n, a) => n + a.length, 0);
  const handleDownloadOfficial = useCallback(async () => {
    setBuilding(true);
    try {
      const p = profileRef.current;
      const info = {
        city: city.trim() || p.name || undefined,
        country: country.trim() || p.country || undefined,
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
      let buf = templateBufRef.current || (await fetchBundled());
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
      a.download = `UNDRR-ARISE-${(city.trim() || "scorecard").replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.xlsm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const n = filledCount(draftRef.current);
      const label =
        n === 0 ? "Downloaded blank official sheet (.xlsm)"
        : n === TOTAL_INDICATORS ? "Downloaded completed scorecard (.xlsm)"
        : "Downloaded scorecard so far (.xlsm)";
      setChat((c) => [...c, { kind: "tool", label, detail: "real UNDRR template, formatting and macros kept" }]);
    } catch (e) {
      setChat((c) => [...c, { kind: "assistant", text: `Couldn't build the official file: ${e instanceof Error ? e.message : String(e)}. You can use the simple .xlsx instead, or Load into analyzer.` }]);
    } finally {
      setBuilding(false);
    }
  }, [city, country]);
  const setScore = (code: string, score: Score | null) =>
    setDraft((d) => { const n = { ...d, [code]: { ...d[code], score } }; draftRef.current = n; return n; });
  const setNote = (code: string, note: string) =>
    setDraft((d) => { const n = { ...d, [code]: { ...d[code], note } }; draftRef.current = n; return n; });

  const showContinue = !running && continuable && filled < TOTAL_INDICATORS;

  return (
    <div className={view === "scorecard" ? "lg:h-[calc(100vh-11rem)]" : ""}>
      {/* ── Assistant tab: chat (a full page; the window scrolls) ───── */}
      <section className={`glass-card p-4 sm:p-5 flex-col min-h-[calc(100vh-11rem)] ${view === "assistant" ? "flex" : "hidden"}`}>
        {/* Session bar */}
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <Bot size={20} className="text-accent-400 shrink-0" />
          <h2 className="text-base font-semibold text-text-primary shrink-0">Assistant</h2>
          <button
            onClick={() => setMenuOpen(true)}
            title="Chat history"
            className="ml-auto flex items-center gap-1.5 max-w-[55%] text-sm rounded-lg px-2.5 py-1.5 bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40"
          >
            <History size={14} className="shrink-0 text-text-secondary" />
            <span className="truncate">{headerTitle}</span>
            <ChevronDown size={14} className="shrink-0 text-text-secondary" />
          </button>
          <button onClick={() => onOpenView?.("scorecard")}
            title="Open the scorecard the Assistant is filling"
            aria-label={`Scorecard, ${filled} of ${TOTAL_INDICATORS} answered`}
            className="relative overflow-hidden shrink-0 flex items-center gap-1.5 text-sm rounded-lg px-2.5 py-1.5 bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40">
            <span aria-hidden className="absolute inset-y-0 left-0 btn-accent opacity-60 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            <ClipboardCheck size={14} className="relative text-accent-400" />
            <span className="relative hidden sm:inline">Scorecard</span> <span className="relative">{filled}/{TOTAL_INDICATORS}</span>
          </button>
          <button onClick={newChat} title="New chat" className="shrink-0 p-1.5 rounded-lg bg-surface-overlay border border-border text-text-secondary hover:text-text-primary">
            <Plus size={15} />
          </button>
        </div>

        {externalBusy && (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-warn-500/30 bg-warn-500/10 px-3.5 py-2.5 text-sm text-warn-400">
            <Loader2 size={15} className="animate-spin shrink-0" />
            <span>The Dashboard analysis is running. I&apos;ll be ready as soon as it finishes, so the two don&apos;t clash.</span>
          </div>
        )}

        {onUseProvider && (
          <ModelSuggestion
            show={settings.provider === "gemini" && !running}
            title="Tip: OpenRouter is smoother for the Assistant"
            body="Gemini's free tier is tightly rate-limited, so filling a whole scorecard can stall partway. OpenRouter's free Nemotron Ultra handles the many quick steps without those limits."
            cta="Use OpenRouter"
            onUse={() => onUseProvider("openrouter")}
            storageKey="undrr-suggest-openrouter-assistant"
          />
        )}

        {/* Setup (collapsible, so the chat has room to breathe) */}
        <div className="shrink-0 rounded-xl border border-border bg-surface-overlay/30 mb-3">
          <button
            onClick={() => setSetupOpen((v) => !v)}
            aria-expanded={setupOpen}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
          >
            <span className="text-sm font-medium text-text-primary truncate">
              {setupOpen
                ? areaActive ? "Area & setup" : "City & setup"
                : areaActive && area
                ? `Area · ${area.label || headerTitle} · ${formatKm2(area.areaKm2)}`
                : city.trim() ? headerTitle : "City & setup"}
            </span>
            <span className="flex items-center gap-1 text-xs text-text-secondary shrink-0">
              {setupOpen ? "Hide" : "Show"}
              <ChevronDown size={15} className={`transition-transform ${setupOpen ? "" : "-rotate-90"}`} />
            </span>
          </button>
          {setupOpen && (
          <div className="space-y-2.5 px-3 pb-3">
          <div className="flex rounded-lg border border-border overflow-hidden text-xs w-full sm:w-fit" role="tablist" aria-label="How to choose the place">
            {([
              ["city", "By city name", <Building2 key="c" size={13} />],
              ["area", "Draw an area", <MapIcon key="a" size={13} />],
            ] as const).map(([m, label, icon]) => (
              <button key={m} role="tab" aria-selected={setupMode === m} disabled={running}
                onClick={() => setSetupMode(m)}
                className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 disabled:opacity-60 ${setupMode === m ? "bg-accent-500/15 text-text-primary font-medium" : "bg-surface-overlay text-text-secondary hover:text-text-primary"}`}>
                {icon}{label}
              </button>
            ))}
          </div>
          {areaActive && (
            <AreaPicker
              key={pickerKey}
              area={area}
              onAreaChange={setArea}
              onPlaceResolved={onPlaceResolved}
              onPlaceNotFound={(q) => setPlaceError(`No place called "${q}" could be found. Check the spelling and try again.`)}
              disabled={running}
              initialQuery={[city.trim(), region.trim(), country.trim()].filter(Boolean).join(", ")}
            />
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-text-secondary">{areaActive ? "City the area is in" : "City"}</label>
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Toronto"
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
            </div>
            <div>
              <label htmlFor="assistant-country" className="text-[11px] text-text-secondary">Country</label>
              <select id="assistant-country" value={countryCode || (country ? "__other" : "")}
                onChange={(e) => { if (e.target.value !== "__other") selectCountry(e.target.value); }}
                className={`w-full mt-0.5 px-2 py-1.5 rounded-lg bg-surface-overlay border border-border text-sm ${countryCode || country ? "text-text-primary" : "text-text-secondary"}`}>
                <option value="">Select a country</option>
                {!countryCode && country && <option value="__other">{country}</option>}
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            {regionOptions.length > 0 && (
              <div className="sm:col-start-1">
                <label htmlFor="assistant-region" className="text-[11px] text-text-secondary">State or Province</label>
                <select id="assistant-region" value={regionCode || ""}
                  onChange={(e) => setRegion(regionOptions.find((r) => r.code === e.target.value)?.name || "")}
                  className={`w-full mt-0.5 px-2 py-1.5 rounded-lg bg-surface-overlay border border-border text-sm ${regionCode ? "text-text-primary" : "text-text-secondary"}`}>
                  <option value="">Select a state or province (optional)</option>
                  {regionOptions.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <textarea value={info} onChange={(e) => setInfo(e.target.value)} rows={2}
            placeholder={areaActive
              ? "Anything you already know about this area (optional): e.g. the riverside blocks flood most springs."
              : "Anything you already know (optional): e.g. we have a flood plan but no early-warning system."}
            className="w-full px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm resize-none" />
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void handleStartAutonomous()} disabled={!canStart || !providerReady || running || externalBusy || checkingPlace}
              title={areaActive && areaProblem ? areaProblem : undefined}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold btn-accent disabled:opacity-50 disabled:cursor-not-allowed">
              {checkingPlace ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {checkingPlace ? "Checking the place…" : "Fill it out for me"}
            </button>
            <button onClick={requestClearEverything} disabled={running || checkingPlace}
              title={running ? "Stop the Assistant first" : "Reset the place, notes, scorecard and chat for this scorecard"}
              className="ml-auto flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold border border-danger-500/40 bg-danger-500/10 text-danger-400 hover:bg-danger-500/15 disabled:opacity-50 disabled:cursor-not-allowed">
              <X size={16} /> Clear all Information
            </button>
          </div>
          {!providerReady && <p className="text-xs text-warn-400">Choose an AI model and add a key in Settings first.</p>}
          </div>
          )}
        </div>

        {/* Chat log */}
        <div className="flex-1 min-h-[12rem]">
        <div className="space-y-3 pr-1">
          {chat.length === 0 && (
            <p className="text-sm text-text-secondary">
              {areaActive
                ? <>Draw or load an area above and press &ldquo;Fill it out for me,&rdquo; or just type below to work through it together. You can attach reference documents with the paperclip.</>
                : <>Fill in your city above and press &ldquo;Fill it out for me,&rdquo; or just type below to work through it together. You can attach reference documents with the paperclip.</>}
            </p>
          )}
          {chat.map((m, i) =>
            m.kind === "tool" ? (
              <div key={i} className="flex items-center gap-2 text-xs text-text-secondary min-w-0">
                <Wrench size={13} className="text-primary-300 shrink-0" />
                <span className="font-medium text-text-primary shrink-0 truncate max-w-[55%]">{m.label}</span>
                {m.detail && <span className="truncate min-w-0 text-text-secondary">· {m.detail}</span>}
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
                <Loader2 size={14} className="animate-spin text-accent-400" /> Thinking{elapsed > 0 ? `… (${elapsed}s)` : "…"}
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
                    Not quite right? Tell me what to change and I&apos;ll refine it, I can revisit any answer, not just the last one.
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

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="shrink-0 flex flex-wrap gap-1.5 mt-2">
            {attachments.map((a) => (
              <span key={a.name} title={a.name} className="flex items-center gap-1 max-w-full text-[11px] bg-surface-overlay border border-border rounded-full pl-2 pr-1 py-0.5 text-text-secondary">
                <Paperclip size={11} className="shrink-0" />
                <span className="truncate max-w-[220px]">{a.name}</span>
                <button onClick={() => removeAttachment(a.name)} title="Remove" className="shrink-0 hover:text-danger-400"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}

        {/* Composer */}
        <div className="shrink-0 mt-3 flex items-end gap-2">
          <button onClick={() => docRef.current?.click()} title="Attach reference documents" disabled={externalBusy}
            className="p-2.5 rounded-xl bg-surface-overlay border border-border text-text-secondary hover:text-text-primary shrink-0 disabled:opacity-40 disabled:cursor-not-allowed">
            <Paperclip size={16} />
          </button>
          <input ref={docRef} type="file" multiple accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.log,.rtf,.html,.htm,.xml,.yaml,.yml,text/*,application/pdf" className="hidden"
            onChange={(e) => { if (e.target.files?.length) void onDocsPicked(e.target.files); e.currentTarget.value = ""; }} />
          <textarea ref={composerRef} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            disabled={externalBusy}
            rows={2} placeholder={externalBusy ? "Waiting for the other task to finish…" : running ? "Add a note to steer it, picked up on the next step…" : "Reply, paste details, or ask it to adjust something… (Shift+Enter for a new line)"}
            className="flex-1 px-3 py-2.5 rounded-xl bg-surface-overlay border border-border text-text-primary text-sm resize-none leading-relaxed min-h-[3rem] disabled:opacity-60 disabled:cursor-not-allowed" />
          {running ? (
            <>
              <button onClick={handleSend} disabled={!input.trim() || externalBusy}
                title="Add this while it works, it's picked up on the next step"
                className="flex items-center justify-center px-3.5 py-2.5 rounded-xl btn-accent disabled:opacity-40" aria-label="Queue message">
                <Send size={16} />
              </button>
              <button onClick={stop} title="Stop the run"
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
      </section>

      {/* ── Scorecard tab: live draft ──────────────── */}
      <section className={`glass-card p-4 sm:p-5 flex-col h-[80vh] lg:h-full min-h-0 overflow-hidden max-w-5xl mx-auto ${view === "scorecard" ? "flex" : "hidden"}`}>
        <div className="flex items-center justify-between gap-2 mb-1 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardCheck size={20} className="text-accent-400 shrink-0" />
            <h2 className="text-lg font-semibold text-text-primary shrink-0">Scorecard</h2>
            <span className="text-sm text-text-secondary truncate">· {areaActive && area ? `Area · ${area.label || headerTitle}` : headerTitle}</span>
            {running && (
              <button onClick={() => onOpenView?.("assistant")} title="The Assistant is filling this in; open it to watch"
                className="shrink-0 inline-flex items-center gap-1 text-xs text-accent-400 hover:underline">
                <Loader2 size={12} className="animate-spin" /> Assistant is filling this in
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => fileRef.current?.click()} disabled={running || externalBusy}
              title="Upload a completed (or partly completed) UNDRR scorecard; its answers fill in below"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40 disabled:opacity-50">
              <Upload size={13} /> Upload scorecard
            </button>
            <input ref={fileRef} type="file" accept=".xlsm,.xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onScorecardPicked(f); e.currentTarget.value = ""; }} />
            <span className="text-sm font-medium text-text-secondary">{filled}/{TOTAL_INDICATORS}</span>
          </div>
        </div>
        <div className="h-2 rounded-full bg-surface-overlay overflow-hidden mb-3 shrink-0">
          <div className="h-full btn-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        {uploadNote && (
          <p className={`mb-3 shrink-0 flex items-start gap-1.5 text-xs ${uploadNote.ok ? "text-text-secondary" : "text-danger-400"}`}>
            {uploadNote.ok ? <ClipboardCheck size={13} className="shrink-0 mt-0.5 text-accent-400" /> : <AlertTriangle size={13} className="shrink-0 mt-0.5" />}
            <span className="flex-1">{uploadNote.text}</span>
            <button onClick={() => setUploadNote(null)} aria-label="Dismiss" className="shrink-0 hover:text-text-primary"><X size={12} /></button>
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
              onDrop={(e) => { e.preventDefault(); setDropHover(false); const f = e.dataTransfer.files?.[0]; if (f) onScorecardPicked(f); }}
              className={`rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition-colors ${dropHover ? "border-accent-400 bg-accent-500/10" : "border-border hover:border-primary-500/50 hover:bg-surface-overlay/30"}`}
            >
              <Upload size={20} className="mx-auto mb-1.5 text-primary-300" />
              <p className="text-sm font-medium text-text-primary">Have a completed scorecard?</p>
              <p className="text-xs text-text-secondary">
                Drop the .xlsm here or click to upload. Its answers fill in below, ready to review or analyze.
                Or let the{" "}
                <button onClick={(e) => { e.stopPropagation(); onOpenView?.("assistant"); }} className="underline text-accent-400">Assistant</button>{" "}
                fill it out for you.
              </p>
            </div>
          )}
          {areaActive && area && (
            <div className="rounded-xl border border-accent-500/30 bg-accent-500/5 p-3 flex items-start gap-3">
              <AreaThumbnail area={area} />
              <div className="min-w-0 text-xs leading-relaxed">
                <h3 className="text-sm font-semibold text-text-primary">Selected area · {formatKm2(area.areaKm2)}</h3>
                <p className="text-text-secondary truncate">
                  {area.label || headerTitle}{area.fileName ? ` · from ${area.fileName}` : ""}
                </p>
                <p className="text-text-secondary mt-1">
                  <span className="inline-block px-1.5 rounded bg-accent-500/15 text-accent-400 font-medium">Area</span>{" "}
                  {AREA_SPECIFIC_CODES.size} indicators are scored for this area.{" "}
                  <span className="inline-block px-1.5 rounded bg-surface-overlay border border-border font-medium">City-wide</span>{" "}
                  {TOTAL_INDICATORS - AREA_SPECIFIC_CODES.size} describe the whole city (plans, budgets, institutions).
                </p>
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
                            {areaActive && area && (
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
            title="Open this scorecard on the Dashboard and run the analysis"
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
          <button onClick={requestClearScorecard} disabled={running}
            title={running ? "Stop the Assistant first" : "Reset every answer, note and the City Information"}
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
          <p className="text-xs text-text-secondary mt-2 shrink-0">Unfilled indicators count as 0 if you analyze now. Keep chatting to finish them.</p>
        )}
      </section>

      <SessionMenu
        open={menuOpen}
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => { setMenuOpen(false); switchTo(id); }}
        onNew={() => { setMenuOpen(false); newChat(); }}
        onDelete={(id) => requestDeleteSession(id)}
        onClose={() => setMenuOpen(false)}
      />

      <ConfirmModal
        open={!!placeError}
        title="Place not found"
        onClose={() => setPlaceError(null)}
        actions={[{ label: "OK", variant: "primary", onClick: () => setPlaceError(null) }]}
      >
        <p className="text-sm text-text-secondary">{placeError}</p>
      </ConfirmModal>

      <ConfirmModal
        open={!!confirm}
        title={confirm?.title || ""}
        onClose={() => setConfirm(null)}
        actions={confirm ? [
          { label: "Cancel", variant: "ghost", onClick: () => setConfirm(null) },
          { label: confirm.yes, variant: confirm.danger ? "danger" : "primary", onClick: confirm.onYes },
        ] : []}
      >
        <p className="text-sm text-text-secondary flex items-start gap-2">
          {confirm?.danger && <AlertTriangle size={16} className="text-danger-400 shrink-0 mt-0.5" />}
          {confirm?.body}
        </p>
      </ConfirmModal>
    </div>
  );
}
