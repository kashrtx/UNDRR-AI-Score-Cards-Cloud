"use client";

/**
 * Assistant tab — an AI agent that helps fill out the UNDRR ARISE Preliminary
 * scorecard. Tell it about your city (autonomous) or chat step by step. It can
 * research the city, search the web, and fill indicators, building a live draft
 * you can edit, then load straight into the analyzer or download as .xlsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, Send, Sparkles, Upload, Loader2, Wrench, Download, ArrowRight, RotateCcw, ClipboardCheck,
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

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string; detail?: string };

const SCORE_LABELS: Record<string, string> = {
  "0": "0 · None",
  "1": "1 · Limited",
  "2": "2 · Substantial",
  "3": "3 · Comprehensive",
};

export function AssistantTab({
  settings,
  providerReady,
  onLoadIntoAnalyzer,
}: {
  settings: AppSettings;
  providerReady: boolean;
  onLoadIntoAnalyzer: (sc: NormalizedScorecard) => void;
}) {
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [info, setInfo] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [started, setStarted] = useState(false);

  // Live agent state kept in a ref so the loop mutates one shared object.
  const ctxRef = useRef<AgentContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef<Draft>(draft);
  draftRef.current = draft;
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat, thinking]);

  const filled = filledCount(draft);
  const pct = Math.round((filled / TOTAL_INDICATORS) * 100);

  const ensureCtx = useCallback(async (): Promise<AgentContext> => {
    if (ctxRef.current) {
      ctxRef.current.draft = draftRef.current; // sync any manual edits in
      return ctxRef.current;
    }
    const provider = await createProvider(settings);
    const searchKey = hasSearchKey() ? await getSearchKey() : null;
    const ctx: AgentContext = { provider, transcript: [], draft: draftRef.current, searchKey };
    ctxRef.current = ctx;
    return ctx;
  }, [settings]);

  const onEvent = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case "thinking":
        setThinking(e.on);
        break;
      case "assistant":
        setChat((c) => [...c, { kind: "assistant", text: e.text }]);
        break;
      case "tool":
        setChat((c) => [...c, { kind: "tool", label: e.label, detail: e.detail }]);
        break;
      case "draft":
        if (ctxRef.current) setDraft({ ...ctxRef.current.draft });
        break;
      case "error":
        setChat((c) => [...c, { kind: "assistant", text: `Something went wrong: ${e.text}. You can try again, or switch model in Settings.` }]);
        break;
      case "done":
        break;
    }
  }, []);

  const runTurn = useCallback(
    async (userText: string) => {
      if (!providerReady) {
        setChat((c) => [...c, { kind: "assistant", text: "First choose an AI model and add a key in Settings, then come back here." }]);
        return;
      }
      setRunning(true);
      const ctx = await ensureCtx();
      ctx.draft = draftRef.current;
      ctx.transcript.push({ role: "user", content: userText } as TranscriptItem);
      abortRef.current = new AbortController();
      try {
        await runAgentTurn(ctx, onEvent, abortRef.current.signal);
      } finally {
        setRunning(false);
        setThinking(false);
        setDraft({ ...ctx.draft });
      }
    },
    [ensureCtx, onEvent, providerReady]
  );

  const handleStartAutonomous = useCallback(() => {
    if (!city.trim()) return;
    setStarted(true);
    const cityLine = `${city.trim()}${country.trim() ? ", " + country.trim() : ""}`;
    const msg =
      `Please fill out the whole scorecard for ${cityLine}. ` +
      (info.trim() ? `Here is what I know about the city: ${info.trim()}. ` : "") +
      `Research the city as needed, set every indicator with a short note, and only ask me if something truly cannot be researched.`;
    setChat((c) => [...c, { kind: "user", text: `Fill it out for ${cityLine}.` }]);
    void runTurn(msg);
  }, [city, country, info, runTurn]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || running) return;
    setStarted(true);
    setInput("");
    setChat((c) => [...c, { kind: "user", text }]);
    void runTurn(text);
  }, [input, running, runTurn]);

  const handleUpload = useCallback(async (file: File) => {
    try {
      const sc = await uploadScorecard(file);
      setDraft((d) => {
        const merged = mergeScorecardIntoDraft(d, sc);
        if (ctxRef.current) ctxRef.current.draft = merged;
        return merged;
      });
      if (sc.city?.name && sc.city.name !== "Unknown") setCity(sc.city.name);
      if (sc.city?.country && sc.city.country !== "Unknown") setCountry(sc.city.country);
      setChat((c) => [...c, { kind: "tool", label: `Loaded ${file.name}`, detail: "existing answers pre-filled" }]);
    } catch (e) {
      setChat((c) => [...c, { kind: "assistant", text: `Could not read that file: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
    setThinking(false);
  }, []);

  const cityInfo: CityInfo = useMemo(
    () => ({ name: city.trim() || "Unknown", country: country.trim() || "Unknown" }),
    [city, country]
  );

  const handleLoad = useCallback(() => {
    const sc = draftToScorecard(draftRef.current, cityInfo);
    onLoadIntoAnalyzer(sc);
  }, [cityInfo, onLoadIntoAnalyzer]);

  const handleDownload = useCallback(() => {
    exportScorecardXlsx(draftToScorecard(draftRef.current, cityInfo));
  }, [cityInfo]);

  const setScore = (code: string, score: Score | null) =>
    setDraft((d) => {
      const next = { ...d, [code]: { ...d[code], score } };
      if (ctxRef.current) ctxRef.current.draft = next;
      return next;
    });
  const setNote = (code: string, note: string) =>
    setDraft((d) => {
      const next = { ...d, [code]: { ...d[code], note } };
      if (ctxRef.current) ctxRef.current.draft = next;
      return next;
    });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* ── Left: chat ─────────────────────────────── */}
      <section className="glass-card p-5 flex flex-col min-h-[70vh]">
        <div className="flex items-center gap-2 mb-1">
          <Bot size={20} className="text-accent-400" />
          <h2 className="text-lg font-semibold text-text-primary">Scorecard assistant</h2>
        </div>
        <p className="text-sm text-text-secondary mb-4">
          Tell it about your city and it fills the scorecard for you, or chat step by step. It can research your city and the web as it goes.
        </p>

        {/* City setup (shown until first message) */}
        {!started && (
          <div className="space-y-3 mb-4 rounded-xl border border-border p-4 bg-surface-overlay/30">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-secondary">City</label>
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g. Toronto"
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-text-secondary">Country</label>
                <input
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="e.g. Canada"
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-text-secondary">Anything you already know (optional)</label>
              <textarea
                value={info}
                onChange={(e) => setInfo(e.target.value)}
                rows={2}
                placeholder="e.g. We have a flood plan and an emergency office, but no early-warning system yet."
                className="w-full mt-1 px-3 py-2 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm resize-none"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleStartAutonomous}
                disabled={!city.trim() || !providerReady}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles size={16} /> Fill it out for me
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary"
              >
                <Upload size={15} /> Continue from a file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsm,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUpload(f);
                  e.currentTarget.value = "";
                }}
              />
            </div>
            {!providerReady && (
              <p className="text-xs text-warn-400">Choose an AI model and add a key in Settings first.</p>
            )}
          </div>
        )}

        {/* Chat log */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {chat.map((m, i) =>
            m.kind === "tool" ? (
              <div key={i} className="flex items-center gap-2 text-xs text-text-secondary">
                <Wrench size={13} className="text-primary-300 shrink-0" />
                <span className="font-medium text-text-primary">{m.label}</span>
                {m.detail && <span className="text-text-secondary">· {m.detail}</span>}
              </div>
            ) : (
              <div key={i} className={`flex ${m.kind === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                    m.kind === "user"
                      ? "bg-primary-500/15 border border-primary-500/25 text-text-primary rounded-br-sm"
                      : "bg-surface-overlay border border-border text-text-primary rounded-bl-sm"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            )
          )}
          {thinking && (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin text-accent-400" /> Thinking…
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Composer */}
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            placeholder={started ? "Reply, or ask it to adjust something…" : "Or just start typing…"}
            className="flex-1 px-3 py-2.5 rounded-xl bg-surface-overlay border border-border text-text-primary text-sm resize-none max-h-32"
          />
          {running ? (
            <button onClick={stop} className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary">
              <Loader2 size={15} className="animate-spin" /> Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="flex items-center justify-center px-3.5 py-2.5 rounded-xl btn-accent disabled:opacity-50"
              aria-label="Send"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </section>

      {/* ── Right: live draft ──────────────────────── */}
      <section className="glass-card p-5 flex flex-col min-h-[70vh]">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <ClipboardCheck size={20} className="text-accent-400" />
            <h2 className="text-lg font-semibold text-text-primary">Draft scorecard</h2>
          </div>
          <span className="text-sm font-medium text-text-secondary">{filled}/{TOTAL_INDICATORS}</span>
        </div>
        <div className="h-2 rounded-full bg-surface-overlay overflow-hidden mb-4">
          <div className="h-full btn-accent transition-all" style={{ width: `${pct}%` }} />
        </div>

        <div className="flex-1 overflow-y-auto pr-1 space-y-4">
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
                          <select
                            value={entry?.score == null ? "" : String(entry.score)}
                            onChange={(ev) => setScore(ind.code, ev.target.value === "" ? null : (Number(ev.target.value) as Score))}
                            className={`shrink-0 text-xs rounded-lg px-2 py-1 border bg-surface-overlay text-text-primary ${
                              entry?.score == null ? "border-border" : "border-accent-500/40"
                            }`}
                          >
                            <option value="">—</option>
                            <option value="0">{SCORE_LABELS["0"]}</option>
                            <option value="1">{SCORE_LABELS["1"]}</option>
                            <option value="2">{SCORE_LABELS["2"]}</option>
                            <option value="3">{SCORE_LABELS["3"]}</option>
                          </select>
                        </div>
                        {(entry?.note || entry?.score != null) && (
                          <input
                            value={entry?.note || ""}
                            onChange={(ev) => setNote(ind.code, ev.target.value)}
                            placeholder="note / basis (optional)"
                            className="w-full mt-2 px-2 py-1 rounded-md bg-surface border border-border text-text-secondary text-xs"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
          <button onClick={handleLoad} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent">
            <ArrowRight size={16} /> Load into analyzer
          </button>
          <button onClick={handleDownload} className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary">
            <Download size={15} /> Download .xlsx
          </button>
          <button
            onClick={() => {
              setDraft(emptyDraft());
              if (ctxRef.current) ctxRef.current.draft = emptyDraft();
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-text-secondary hover:text-text-primary ml-auto"
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>
        {filled < TOTAL_INDICATORS && (
          <p className="text-xs text-text-secondary mt-2">
            Unfilled indicators count as 0 if you load now. You can keep chatting to finish them.
          </p>
        )}
      </section>
    </div>
  );
}
