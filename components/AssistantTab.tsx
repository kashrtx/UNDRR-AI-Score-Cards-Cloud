"use client";

/**
 * Assistant tab — an AI agent that helps fill out the UNDRR ARISE Preliminary
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
  ClipboardCheck, Lightbulb, Plus, Trash2, Paperclip, X, Play, AlertTriangle,
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
import {
  createSession, listSessions, loadSession, saveSession, deleteSession, getActiveId, setActiveId,
  type AssistantSession, type SessionMeta, type ChatItem, type Attachment,
} from "@/lib/agent/sessions";
import { ConfirmModal } from "@/components/ConfirmModal";

const SCORE_LABELS: Record<string, string> = {
  "0": "0 · None", "1": "1 · Limited", "2": "2 · Substantial", "3": "3 · Comprehensive",
};

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|rtf|html?|xml|yaml|yml)$/i;
const MAX_ATTACH_CHARS = 12000;

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState("");
  const [continuable, setContinuable] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; onYes: () => void; danger?: boolean; yes: string }>(null);

  // Non-rendered working state
  const transcriptRef = useRef<TranscriptItem[]>([]);
  const activeMetaRef = useRef<{ id: string; createdAt: number }>({ id: "", createdAt: Date.now() });
  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef<Draft>(draft);
  draftRef.current = draft;
  const attachRef = useRef<Attachment[]>(attachments);
  attachRef.current = attachments;
  const streamBuf = useRef("");
  const streamScheduled = useRef(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);
  const ready = useRef(false);

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
    setActive(s.id);
    setActiveId(s.id);
    setCity(s.city || "");
    setCountry(s.country || "");
    setInfo(s.info || "");
    setChat(s.chat || []);
    setDraft(Object.keys(s.draft || {}).length ? s.draft : emptyDraft());
    setAttachments(s.attachments || []);
    setContinuable(false);
    setStream("");
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
  }, [city, country, info, chat, draft, attachments, saveActive]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat, thinking, stream]);

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
        if (e.on) { streamBuf.current = ""; setStream(""); }
        break;
      case "stream":
        streamBuf.current += e.text;
        if (!streamScheduled.current) {
          streamScheduled.current = true;
          setTimeout(() => { setStream(streamBuf.current.slice(-600)); streamScheduled.current = false; }, 90);
        }
        break;
      case "thought":
        setChat((c) => [...c, { kind: "thought", text: e.text }]);
        break;
      case "assistant":
        setChat((c) => [...c, { kind: "assistant", text: e.text }]);
        break;
      case "tool":
        setChat((c) => [...c, { kind: "tool", label: e.label, detail: e.detail }]);
        break;
      case "draft":
        setDraft({ ...draftRef.current });
        break;
      case "done":
        setContinuable(false);
        break;
      case "stopped":
        setContinuable(true);
        setChat((c) => [...c, { kind: "tool", label: "Stopped", detail: "press Continue to resume" }]);
        break;
      case "error":
        setChat((c) => [...c, { kind: "assistant", text: `⚠ Couldn't continue: ${e.text}.` }]);
        setContinuable(!!e.canContinue);
        break;
    }
  }, []);

  const runTurn = useCallback(
    async (userText: string | null, opts?: { silent?: boolean }) => {
      if (!providerReady) {
        setChat((c) => [...c, { kind: "assistant", text: "First choose an AI model and add a key in Settings, then come back here." }]);
        return;
      }
      let provider;
      try {
        provider = await createProvider(settings); // rebuilt each turn, so switching model then Continue works
      } catch (err) {
        setChat((c) => [...c, { kind: "assistant", text: `⚠ Couldn't start the model: ${err instanceof Error ? err.message : String(err)}.` }]);
        return;
      }
      const searchKey = hasSearchKey() ? await getSearchKey() : null;
      const ctx: AgentContext = {
        provider,
        transcript: transcriptRef.current,
        draft: draftRef.current,
        searchKey,
        city: city.trim(),
        country: country.trim(),
        attachments: attachRef.current,
      };
      if (userText) transcriptRef.current.push({ role: "user", content: userText } as TranscriptItem);
      setRunning(true);
      setContinuable(false);
      abortRef.current = new AbortController();
      try {
        await runAgentTurn(ctx, onEvent, abortRef.current.signal);
      } finally {
        setRunning(false);
        setThinking(false);
        setStream("");
        setDraft({ ...ctx.draft }); // triggers the debounced auto-save with fresh state
      }
    },
    [providerReady, settings, city, country, onEvent]
  );

  const handleStartAutonomous = useCallback(() => {
    if (!city.trim() || running) return;
    const cityLine = `${city.trim()}${country.trim() ? ", " + country.trim() : ""}`;
    const already = filledCount(draftRef.current);
    const scope =
      already > 0
        ? `Some indicators (${already} of ${TOTAL_INDICATORS}) are already filled from an uploaded file — keep those and complete the remaining ones for ${cityLine}. `
        : `Please fill out the whole scorecard for ${cityLine}. `;
    const msg =
      scope +
      (info.trim() ? `Here is what I know about the city: ${info.trim()}. ` : "") +
      `Research the city as needed, set every indicator with a short note, and only ask me if something truly cannot be researched.`;
    setChat((c) => [...c, { kind: "user", text: already > 0 ? `Complete the rest for ${cityLine}.` : `Fill it out for ${cityLine}.` }]);
    void runTurn(msg);
  }, [city, country, info, running, runTurn]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || running) return;
    setInput("");
    setChat((c) => [...c, { kind: "user", text }]);
    void runTurn(text);
  }, [input, running, runTurn]);

  const handleContinue = useCallback(() => {
    if (running) return;
    setChat((c) => [...c, { kind: "tool", label: "Continuing", detail: `with ${settings.provider}` }]);
    void runTurn("Continue completing the scorecard from where you left off.");
  }, [running, runTurn, settings.provider]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // ── Scorecard upload (start / continue a fill) ──────
  const applyScorecardFile = useCallback(async (file: File, intoNew: boolean) => {
    setChat((c) => [...c, { kind: "tool", label: "Reading file", detail: file.name }]);
    try {
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
        : `That file looks blank — no answers yet. Enter the city above and press "Fill it out for me", and I'll complete the whole thing.`;
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
        setChat((c) => [...c, { kind: "assistant", text: `I can read text documents (txt, md, csv, json, html). "${file.name}" is a ${file.name.split(".").pop()?.toUpperCase() || "binary"} file — please paste its key text into the chat and I'll use it.` }]);
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
    if (running) stop();
    saveActive();
    const s = loadSession(id);
    if (s) loadIntoState(s);
  }, [activeId, running, stop, saveActive, loadIntoState]);

  const newChat = useCallback(() => {
    if (running) stop();
    saveActive();
    const s = createSession();
    saveSession(s);
    setSessions(listSessions());
    loadIntoState(s);
  }, [running, stop, saveActive, loadIntoState]);

  const deleteCurrent = useCallback(() => {
    setConfirm({
      title: "Delete this chat?",
      body: "This permanently removes this scorecard chat and its draft. This cannot be undone.",
      yes: "Delete",
      danger: true,
      onYes: () => {
        setConfirm(null);
        if (running) stop();
        const id = activeMetaRef.current.id;
        deleteSession(id);
        const list = listSessions();
        setSessions(list);
        const nextExisting = list[0] && loadSession(list[0].id);
        if (nextExisting) loadIntoState(nextExisting);
        else {
          const s = createSession();
          saveSession(s);
          setSessions(listSessions());
          loadIntoState(s);
        }
      },
    });
  }, [running, stop, loadIntoState]);

  // ── Draft edits + handoff ───────────────────────────
  const cityInfo: CityInfo = useMemo(
    () => ({ name: city.trim() || "Unknown", country: country.trim() || "Unknown" }),
    [city, country]
  );
  const handleLoad = useCallback(() => onLoadIntoAnalyzer(draftToScorecard(draftRef.current, cityInfo)), [cityInfo, onLoadIntoAnalyzer]);
  const handleDownload = useCallback(() => exportScorecardXlsx(draftToScorecard(draftRef.current, cityInfo)), [cityInfo]);
  const setScore = (code: string, score: Score | null) =>
    setDraft((d) => { const n = { ...d, [code]: { ...d[code], score } }; draftRef.current = n; return n; });
  const setNote = (code: string, note: string) =>
    setDraft((d) => { const n = { ...d, [code]: { ...d[code], note } }; draftRef.current = n; return n; });

  const showContinue = !running && continuable && filled < TOTAL_INDICATORS;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 lg:h-[calc(100vh-13rem)]">
      {/* ── Left: chat ─────────────────────────────── */}
      <section className="glass-card p-4 sm:p-5 flex flex-col h-[72vh] lg:h-full min-h-0 overflow-hidden">
        {/* Session bar */}
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <Bot size={20} className="text-accent-400 shrink-0" />
          <h2 className="text-base font-semibold text-text-primary shrink-0">Assistant</h2>
          <select
            value={activeId}
            onChange={(e) => switchTo(e.target.value)}
            className="ml-auto max-w-[45%] text-xs rounded-lg px-2 py-1.5 bg-surface-overlay border border-border text-text-primary"
            title="Switch scorecard chat"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.title} · {s.filled}/{TOTAL_INDICATORS}</option>
            ))}
          </select>
          <button onClick={newChat} title="New chat" className="shrink-0 p-1.5 rounded-lg bg-surface-overlay border border-border text-text-secondary hover:text-text-primary">
            <Plus size={15} />
          </button>
          <button onClick={deleteCurrent} title="Delete this chat" className="shrink-0 p-1.5 rounded-lg bg-surface-overlay border border-border text-text-secondary hover:text-danger-400">
            <Trash2 size={15} />
          </button>
        </div>

        {/* Setup (always visible) */}
        <div className="shrink-0 space-y-2.5 rounded-xl border border-border p-3 bg-surface-overlay/30 mb-3">
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

        {/* Chat log */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-3 pr-1">
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
              {stream && (
                <div className="text-[11px] font-mono text-text-secondary/70 bg-surface-overlay/50 border border-border rounded-lg p-2 max-h-24 overflow-hidden whitespace-pre-wrap break-words">
                  {stream}
                </div>
              )}
            </div>
          )}
          {showContinue && (
            <button onClick={handleContinue} className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold btn-accent">
              <Play size={15} /> Continue
            </button>
          )}
          <div ref={chatEndRef} />
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
            rows={1} placeholder="Reply, or ask it to adjust something…"
            className="flex-1 px-3 py-2.5 rounded-xl bg-surface-overlay border border-border text-text-primary text-sm resize-none max-h-32" />
          {running ? (
            <button onClick={stop} className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary">
              <Loader2 size={15} className="animate-spin" /> Stop
            </button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()}
              className="flex items-center justify-center px-3.5 py-2.5 rounded-xl btn-accent disabled:opacity-50" aria-label="Send">
              <Send size={16} />
            </button>
          )}
        </div>
      </section>

      {/* ── Right: live draft ──────────────────────── */}
      <section className="glass-card p-4 sm:p-5 flex flex-col h-[72vh] lg:h-full min-h-0 overflow-hidden">
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
                            <option value="">—</option>
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
          <button onClick={handleDownload} className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary">
            <Download size={15} /> Download .xlsx
          </button>
        </div>
        {filled < TOTAL_INDICATORS && (
          <p className="text-xs text-text-secondary mt-2 shrink-0">Unfilled indicators count as 0 if you load now. Keep chatting to finish them.</p>
        )}
      </section>

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
