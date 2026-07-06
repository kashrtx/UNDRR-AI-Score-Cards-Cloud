"use client";

/**
 * Assistant tab, an AI agent that helps fill out the UNDRR ARISE Preliminary
 * scorecard. Highlights:
 *   • Streams the model's output live so you can see it working.
 *   • Stop any time and Continue later (even after switching model, or once a
 *     rate limit clears). Failures explain themselves instead of dying quietly.
 *   • Saved chat history: switch between scorecards, start new, delete.
 *   • Attach reference documents (text files) to teach the model about the city.
 *   • Fills a live, editable draft you can load into the analyzer or download.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, Send, Sparkles, Upload, Loader2, Wrench, Download, ArrowRight, RotateCcw,
  ClipboardCheck, Lightbulb, Plus, Trash2, Paperclip, X, Play, AlertTriangle, History, ChevronDown,
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
import { computeTemplateEdits, fillOfficialTemplate } from "@/lib/export/fillTemplate";
import {
  createSession, listSessions, loadSession, saveSession, deleteSession, getActiveId, setActiveId,
  type AssistantSession, type SessionMeta, type ChatItem, type Attachment,
} from "@/lib/agent/sessions";
import { ConfirmModal } from "@/components/ConfirmModal";
import { LiveStream } from "@/components/LiveStream";
import { SessionMenu } from "@/components/SessionMenu";

const SCORE_LABELS: Record<string, string> = {
  "0": "0 · None", "1": "1 · Limited", "2": "2 · Substantial", "3": "3 · Comprehensive",
};

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|rtf|html?|xml|yaml|yml)$/i;
const MAX_ATTACH_CHARS = 12000;

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
  settings,
  providerReady,
  onLoadIntoAnalyzer,
}: {
  settings: AppSettings;
  providerReady: boolean;
  onLoadIntoAnalyzer: (sc: NormalizedScorecard) => void;
}) {
  // Mirrored active-session state
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActive] = useState<string>("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [info, setInfo] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [profile, setProfile] = useState<CityInfo>({ name: "", country: "" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
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
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
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

  // ── Session load/save ───────────────────────────────
  const buildActiveSession = useCallback((): AssistantSession => ({
    id: activeMetaRef.current.id,
    title: "",
    city, country, info,
    chat,
    transcript: transcriptRef.current,
    draft: draftRef.current,
    profile: profileRef.current,
    attachments: attachRef.current,
    createdAt: activeMetaRef.current.createdAt,
    updatedAt: Date.now(),
  }), [city, country, info, chat]);

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
    setInfo(s.info || "");
    setChat(s.chat || []);
    setDraft(Object.keys(s.draft || {}).length ? s.draft : emptyDraft());
    setProfile(s.profile && s.profile.name != null ? s.profile : { name: s.city || "", country: s.country || "" });
    setAttachments(s.attachments || []);
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
  }, [city, country, info, chat, draft, profile, attachments, saveActive]);

  // On unmount (e.g. full page navigation), stop any run and persist.
  const saveActiveRef = useRef(saveActive);
  saveActiveRef.current = saveActive;
  useEffect(
    () => () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      try { saveActiveRef.current(); } catch { /* ignore */ }
    },
    []
  );

  // Only pull the view to the newest message if the reader is already near the
  // bottom. If they've scrolled up to read, leave them be (and show a "jump to
  // latest" button instead).
  useEffect(() => {
    if (stuckToBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [chat, thinking, stream]);

  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stuckToBottomRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

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
        // rendered copy — otherwise the panel freezes at the first batch and
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
        attachments: attachRef.current,
        mode,
        drainInput: () => queuedInputRef.current.shift() ?? null,
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
      setContinuable(false);
      abortRef.current = new AbortController();
      try {
        await runAgentTurn(ctx, emit, abortRef.current.signal);
      } finally {
        const sameSession = mountedRef.current && activeMetaRef.current.id === runSession;
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
    [providerReady, settings, city, country, onEvent]
  );

  const undoLastRun = useCallback(() => {
    const snap = undoSnapshotRef.current;
    if (!snap) return;
    setDraft({ ...snap });
    draftRef.current = { ...snap };
    setCanUndo(false);
    setChat((c) => [...c, { kind: "tool", label: "Undid the last run", detail: "scores restored to before it started" }]);
  }, []);

  const handleStartAutonomous = useCallback(() => {
    if (!city.trim() || running) return;
    const cityLine = `${city.trim()}${country.trim() ? ", " + country.trim() : ""}`;
    const already = filledCount(draftRef.current);
    const scope =
      already > 0
        ? `Some indicators (${already} of ${TOTAL_INDICATORS}) are already filled in from the file you uploaded. I'll keep those and finish the rest for ${cityLine}. `
        : `Please fill out the whole scorecard for ${cityLine}. `;
    const msg =
      scope +
      (info.trim() ? `Here is what I know about the city: ${info.trim()}. ` : "") +
      `Research the city as needed, set every indicator with a short note, and only ask me if something truly cannot be researched.`;
    setChat((c) => [...c, { kind: "user", text: already > 0 ? `Complete the rest for ${cityLine}.` : `Fill it out for ${cityLine}.` }]);
    void runTurn(msg, { mode: "autonomous" });
  }, [city, country, info, running, runTurn]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setChat((c) => [...c, { kind: "user", text }]);
    if (running) {
      // Steer mid-run: queue it for the next step (like Cursor/Copilot).
      queuedInputRef.current.push(text);
      setChat((c) => [...c, { kind: "tool", label: "I'll pick that up on the next step", detail: undefined }]);
      return;
    }
    void runTurn(text, { mode: "assist" });
  }, [input, running, runTurn]);

  const handleContinue = useCallback(() => {
    if (running) return;
    setChat((c) => [...c, { kind: "tool", label: "Continuing", detail: `with ${settings.provider}` }]);
    void runTurn("Continue from where you left off."); // keeps the last mode
  }, [running, runTurn, settings.provider]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // ── Scorecard upload (start / continue a fill) ──────
  const applyScorecardFile = useCallback(async (file: File, intoNew: boolean) => {
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
      if (knownCountry) setCountry(knownCountry);
      setChat((c) => [...c, { kind: "tool", label: `Parsed ${file.name}`, detail: `${loaded} of ${TOTAL_INDICATORS} answers found` }]);
      const guidance = knownCity
        ? `Loaded your file for ${knownCity}${knownCountry ? ", " + knownCountry : ""} with ${loaded} of ${TOTAL_INDICATORS} indicators already answered. Press "Fill it out for me" and I'll complete the rest.`
        : loaded > 0
        ? `Loaded ${loaded} of ${TOTAL_INDICATORS} answers, but I couldn't find the city in the file. Which city is this scorecard for? (You can also type it in the City box above.)`
        : `That file doesn't have any answers in it yet. Type your city above and press "Fill it out for me" and I'll take it from there.`;
      setChat((c) => [...c, { kind: "assistant", text: guidance }]);
    } catch (e) {
      setChat((c) => [...c, { kind: "assistant", text: `Could not read that file: ${e instanceof Error ? e.message : String(e)}. Make sure it's an official UNDRR Preliminary scorecard (.xlsm/.xlsx).` }]);
    }
  }, [saveActive, loadIntoState]);

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
      if (!TEXT_EXT.test(file.name) && !file.type.startsWith("text/")) {
        setChat((c) => [...c, { kind: "assistant", text: `I can read text documents (txt, md, csv, json, html). "${file.name}" is a ${file.name.split(".").pop()?.toUpperCase() || "binary"} file, so I can't read it directly. If you paste the important text into the chat, I'll use it.` }]);
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
      setChat((c) => [...c, { kind: "tool", label: `Attached ${added.length} document${added.length === 1 ? "" : "s"}`, detail: added.map((a) => a.name).join(", ") }]);
    }
  }, []);

  const removeAttachment = useCallback((name: string) => {
    setAttachments((a) => {
      const next = a.filter((x) => x.name !== name);
      attachRef.current = next;
      return next;
    });
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

  // ── Draft edits + handoff ───────────────────────────
  const cityInfo: CityInfo = useMemo(
    () => ({ ...profile, name: city.trim() || profile.name || "Unknown", country: country.trim() || profile.country || "Unknown" }),
    [city, country, profile]
  );
  const headerTitle = city.trim() ? (country.trim() ? `${city.trim()}, ${country.trim()}` : city.trim()) : "New scorecard";
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
    <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-5 lg:h-[calc(100vh-11rem)]">
      {/* ── Left: chat ─────────────────────────────── */}
      <section className="glass-card p-4 sm:p-5 flex flex-col h-[80vh] lg:h-full min-h-0 overflow-hidden">
        {/* Session bar */}
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <Bot size={20} className="text-accent-400 shrink-0" />
          <h2 className="text-base font-semibold text-text-primary shrink-0">Assistant</h2>
          <button
            onClick={() => setMenuOpen(true)}
            title="Chat history"
            className="ml-auto flex items-center gap-1.5 max-w-[60%] text-sm rounded-lg px-2.5 py-1.5 bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40"
          >
            <History size={14} className="shrink-0 text-text-secondary" />
            <span className="truncate">{headerTitle}</span>
            <ChevronDown size={14} className="shrink-0 text-text-secondary" />
          </button>
          <button onClick={newChat} title="New chat" className="shrink-0 p-1.5 rounded-lg bg-surface-overlay border border-border text-text-secondary hover:text-text-primary">
            <Plus size={15} />
          </button>
        </div>

        {/* Setup (collapsible, so the chat has room to breathe) */}
        <div className="shrink-0 rounded-xl border border-border bg-surface-overlay/30 mb-3">
          <button
            onClick={() => setSetupOpen((v) => !v)}
            aria-expanded={setupOpen}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
          >
            <span className="text-sm font-medium text-text-primary truncate">
              {setupOpen ? "City & setup" : city.trim() ? headerTitle : "City & setup"}
            </span>
            <span className="flex items-center gap-1 text-xs text-text-secondary shrink-0">
              {setupOpen ? "Hide" : "Show"}
              <ChevronDown size={15} className={`transition-transform ${setupOpen ? "" : "-rotate-90"}`} />
            </span>
          </button>
          {setupOpen && (
          <div className="space-y-2.5 px-3 pb-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-text-secondary">City</label>
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Toronto"
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
            </div>
            <div>
              <label className="text-[11px] text-text-secondary">Country</label>
              <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. Canada"
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
            </div>
          </div>
          <textarea value={info} onChange={(e) => setInfo(e.target.value)} rows={2}
            placeholder="Anything you already know (optional): e.g. we have a flood plan but no early-warning system."
            className="w-full px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm resize-none" />
          <div className="flex flex-wrap gap-2">
            <button onClick={handleStartAutonomous} disabled={!city.trim() || !providerReady || running}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold btn-accent disabled:opacity-50 disabled:cursor-not-allowed">
              <Sparkles size={16} /> Fill it out for me
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={running}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary disabled:opacity-50">
              <Upload size={15} /> Continue from a file
            </button>
            <input ref={fileRef} type="file" accept=".xlsm,.xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onScorecardPicked(f); e.currentTarget.value = ""; }} />
          </div>
          {!providerReady && <p className="text-xs text-warn-400">Choose an AI model and add a key in Settings first.</p>}
          </div>
          )}
        </div>

        {/* Chat log */}
        <div className="relative flex-1 min-h-0 flex flex-col">
        <div ref={chatScrollRef} onScroll={onChatScroll} className="flex-1 overflow-y-auto min-h-0 space-y-3 pr-1">
          {chat.length === 0 && (
            <p className="text-sm text-text-secondary">
              Fill in your city above and press &ldquo;Fill it out for me,&rdquo; or just type below to work through it together. You can attach reference documents with the paperclip.
            </p>
          )}
          {chat.map((m, i) =>
            m.kind === "tool" ? (
              <div key={i} className="flex items-center gap-2 text-xs text-text-secondary">
                <Wrench size={13} className="text-primary-300 shrink-0" />
                <span className="font-medium text-text-primary">{m.label}</span>
                {m.detail && <span className="truncate">· {m.detail}</span>}
              </div>
            ) : m.kind === "thought" ? (
              <div key={i} className="flex items-start gap-2 text-xs text-text-secondary italic">
                <Lightbulb size={13} className="text-warn-400 shrink-0 mt-0.5" />
                <span>{m.text}</span>
              </div>
            ) : m.kind === "reasoning" ? (
              <ReasoningItem key={i} summary={m.summary} detail={m.detail} seconds={m.seconds} />
            ) : (
              <div key={i} className={`flex ${m.kind === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  m.kind === "user"
                    ? "bg-primary-500/15 border border-primary-500/25 text-text-primary rounded-br-sm"
                    : "bg-surface-overlay border border-border text-text-primary rounded-bl-sm"
                }`}>{m.text}</div>
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
            <div className="flex flex-wrap items-center gap-2">
              {showContinue && (
                <button onClick={handleContinue} className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold btn-accent">
                  <Play size={15} /> Continue
                </button>
              )}
              {!running && canUndo && (
                <button onClick={undoLastRun}
                  title="Restore the scores to how they were before the last run"
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary">
                  <RotateCcw size={15} /> Undo last run
                </button>
              )}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
          {showJump && (
            <button
              onClick={jumpToLatest}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-surface border border-border shadow-lg text-text-primary hover:border-accent-500/50 transition-colors"
            >
              <ChevronDown size={14} /> Jump to latest
            </button>
          )}
        </div>

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="shrink-0 flex flex-wrap gap-1.5 mt-2">
            {attachments.map((a) => (
              <span key={a.name} className="flex items-center gap-1 text-[11px] bg-surface-overlay border border-border rounded-full pl-2 pr-1 py-0.5 text-text-secondary">
                <Paperclip size={11} /> {a.name}
                <button onClick={() => removeAttachment(a.name)} className="hover:text-danger-400"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}

        {/* Composer */}
        <div className="shrink-0 mt-3 flex items-end gap-2">
          <button onClick={() => docRef.current?.click()} title="Attach reference documents"
            className="p-2.5 rounded-xl bg-surface-overlay border border-border text-text-secondary hover:text-text-primary shrink-0">
            <Paperclip size={16} />
          </button>
          <input ref={docRef} type="file" multiple className="hidden"
            onChange={(e) => { if (e.target.files?.length) void onDocsPicked(e.target.files); e.currentTarget.value = ""; }} />
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            rows={1} placeholder={running ? "Add a note to steer it, picked up on the next step…" : "Reply, or ask it to adjust something…"}
            className="flex-1 px-3 py-2.5 rounded-xl bg-surface-overlay border border-border text-text-primary text-sm resize-none max-h-32" />
          {running ? (
            <>
              <button onClick={handleSend} disabled={!input.trim()}
                title="Add this while it works — it's picked up on the next step"
                className="flex items-center justify-center px-3.5 py-2.5 rounded-xl btn-accent disabled:opacity-40" aria-label="Queue message">
                <Send size={16} />
              </button>
              <button onClick={stop} title="Stop the run"
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary shrink-0">
                <Loader2 size={15} className="animate-spin" /> Stop
              </button>
            </>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()}
              className="flex items-center justify-center px-3.5 py-2.5 rounded-xl btn-accent disabled:opacity-50" aria-label="Send">
              <Send size={16} />
            </button>
          )}
        </div>
      </section>

      {/* ── Right: live draft ──────────────────────── */}
      <section className="glass-card p-4 sm:p-5 flex flex-col h-[80vh] lg:h-full min-h-0 overflow-hidden">
        <div className="flex items-center justify-between mb-1 shrink-0">
          <div className="flex items-center gap-2">
            <ClipboardCheck size={20} className="text-accent-400" />
            <h2 className="text-lg font-semibold text-text-primary">Draft scorecard</h2>
          </div>
          <span className="text-sm font-medium text-text-secondary">{filled}/{TOTAL_INDICATORS}</span>
        </div>
        <div className="h-2 rounded-full bg-surface-overlay overflow-hidden mb-4 shrink-0">
          <div className="h-full btn-accent transition-all" style={{ width: `${pct}%` }} />
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-4">
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
                          <p className="text-xs text-text-secondary flex-1 leading-snug">{ind.text}</p>
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
          <button onClick={handleLoad} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent">
            <ArrowRight size={16} /> Load into analyzer
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
          <button onClick={handleDownload}
            title="A plain spreadsheet where every answer is a simple 0-3 number and totals are formulas — no form controls at all. Handy if you'd rather not use the official template."
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary ml-auto">
            <Download size={13} /> Plain spreadsheet (.xlsx)
          </button>
        </div>
        {filled < TOTAL_INDICATORS && (
          <p className="text-xs text-text-secondary mt-2 shrink-0">Unfilled indicators count as 0 if you load now. Keep chatting to finish them.</p>
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
