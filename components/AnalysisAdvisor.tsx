"use client";

/**
 * The Analysis Advisor: a small, dismissible chat attached to a finished
 * Dashboard analysis. The user can ask what might be missing, question a score,
 * or paste in real data they found (reports, statistics, local knowledge).
 *
 * Two things make it genuinely useful rather than just a chat:
 *  1. The conversation is remembered (saved per city), so closing the panel or
 *     refreshing doesn't lose the thread or the data already shared.
 *  2. Anything substantial the user shares is captured automatically as context
 *     for the next re-run, so "why did I paste this?" has an obvious answer.
 *     Everything captured is reviewable and removable.
 *
 * It's deliberately NOT agentic: exactly one model call per message, which keeps
 * it fast and easy on free-tier rate limits.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Send, Loader2, ClipboardCheck, Sparkles, Globe2, RefreshCw, Plus, Trash2, ChevronDown, Check } from "lucide-react";
import { createProvider } from "@/lib/llm";
import type { AppSettings } from "@/lib/settings/store";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { AnalysisResult } from "@/lib/analysis/schema";
import type { DataReport } from "@/lib/types";
import { renderMarkdown, tidyPaste } from "@/lib/ui/markdown";
import { UserMessageBubble } from "@/components/UserMessageBubble";

type Msg = { role: "user" | "assistant"; text: string };

const CHAT_KEY = "undrr.advisor.chat";

const SYSTEM = `You are a friendly, encouraging advisor sitting beside a city official who just ran a disaster-resilience analysis of their city. Think of yourself as a knowledgeable, supportive teammate whose whole goal is to help them end up with a scorecard they feel confident about. You are given the scorecard scores and the analysis that was produced.

The user may: point out something the analysis missed, question a score or claim, or paste in real data they found (reports, statistics, local knowledge). Your job:
- Point out likely gaps or inaccuracies in the analysis, and what would be worth verifying locally.
- When the user pastes data, FIRST briefly restate the key facts from it in a clean, organized way (a short tidy list or a sentence or two, not a wall of text), so they can see you understood it. THEN say plainly how it changes the picture and which scores or points it would affect.
- Anything substantial the user shares is saved automatically as context for the next re-run, so you can reassure them it will be used, and suggest pressing "Re-run" when they have shared enough to be worth rebuilding the analysis.
- Suggest concrete, specific refinements that would make the scorecard or analysis more accurate.
- Encourage them, warmly and briefly, to share any relevant local data they have, while keeping it on-topic for this city's resilience (gently steer away from unrelated material).

Rules:
- Be honest and grounded. Never invent facts, statistics, programme names, or budgets. If you are not sure, say so.
- If the user's data conflicts with the analysis, explain which is more reliable and why, rather than just agreeing.
- Keep answers short, warm, and genuinely helpful. Plain language, a little encouragement, no jargon dumps.
- Use short markdown lists when they make things clearer.
- Do not use em dashes.`;

/** Is this worth keeping as context for the re-run? Pasted data, figures, and
 * the user's own corrections and feedback are; a bare question like "can you see
 * my data?" is not, since that's conversation rather than information. */
function isSubstantive(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length >= 140) return true;                                  // a decent chunk
  if (t.split("\n").filter((l) => l.trim()).length >= 3) return true; // multi-line / pasted
  const numbers = (t.match(/\d+(?:[.,]\d+)?/g) || []).length;
  if (numbers >= 3 && t.length >= 60) return true;                    // figures
  // Short statements are usually real feedback ("the flood score looks too high"),
  // so keep those. Pure questions are just conversation, so skip them.
  const isQuestion = t.endsWith("?") || /^(can|could|do|does|did|is|are|was|were|who|what|when|where|why|how|should|would|will)\b/i.test(t);
  return !isQuestion && t.length >= 25;
}

function buildContext(sc: NormalizedScorecard, a: AnalysisResult, dr: DataReport | null, facts: string[]): string {
  const ess = [...sc.essentials]
    .sort((x, y) => x.num - y.num)
    .map((e) => `E${e.num} ${e.name}: ${e.score}/${e.max}`)
    .join("\n");
  const strengths = a.strengths.slice(0, 8).map((s) => `- ${s.text}`).join("\n");
  const weaknesses = a.weaknesses.slice(0, 8).map((s) => `- ${s.text}`).join("\n");
  const risk = a.riskProfile
    ? `\nRisk lens:\n- Hazard: ${a.riskProfile.hazard}\n- Exposure: ${a.riskProfile.exposure}\n- Vulnerability: ${a.riskProfile.vulnerability}`
    : "";
  const data = dr?.data?.length
    ? `\nOpen data points used (${dr.data.length}): ` +
      dr.data.slice(0, 20).map((d) => `${d.label}=${String(d.value)}${d.unit ? d.unit : ""}`).join("; ")
    : "";
  const added = facts.length
    ? `\n\nWHAT THE USER HAS SHARED SO FAR (${facts.length} item(s); already saved and queued for the next re-run, treat these as things you CAN see):\n` +
      facts.map((f, i) => `[${i + 1}] ${f.slice(0, 1200)}`).join("\n\n")
    : "\n\n(The user has not shared any local data yet.)";
  return `CITY: ${sc.city.name}, ${sc.city.country}
OVERALL SCORE: ${sc.total} out of ${sc.totalMax}

ESSENTIAL SCORES:
${ess}

ANALYSIS SUMMARY:
${a.summary}${risk}

STRENGTHS THE ANALYSIS FOUND:
${strengths || "(none listed)"}

WEAKNESSES THE ANALYSIS FOUND:
${weaknesses || "(none listed)"}${data}${added}`;
}

const STARTERS = [
  "What might be missing from this analysis?",
  "Which weak areas should I double-check locally?",
  "I have some extra data to add, here it is:",
];

export function AnalysisAdvisor({
  open,
  onClose,
  scorecard,
  analysis,
  dataReport,
  settings,
  contextFacts = [],
  onAddContext,
  onRemoveContext,
  onClearContext,
  onRerun,
  onBusyChange,
  externalBusy = false,
}: {
  open: boolean;
  onClose: () => void;
  scorecard: NormalizedScorecard;
  analysis: AnalysisResult;
  dataReport: DataReport | null;
  settings: AppSettings;
  contextFacts?: string[];
  onAddContext?: (text: string) => void;
  onRemoveContext?: (text: string) => void;
  onClearContext?: () => void;
  onRerun?: () => void;
  onBusyChange?: (busy: boolean) => void;
  externalBusy?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState("");
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // ── Remember the conversation (per city) ──────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.city === scorecard.city.name && Array.isArray(saved.messages)) {
          setMessages(saved.messages);
        }
      }
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, [scorecard.city.name]);

  useEffect(() => {
    if (!loaded) return;
    try {
      if (messages.length) {
        localStorage.setItem(CHAT_KEY, JSON.stringify({ city: scorecard.city.name, messages: messages.slice(-40) }));
      } else {
        localStorage.removeItem(CHAT_KEY);
      }
    } catch {
      /* quota, non-fatal */
    }
  }, [messages, loaded, scorecard.city.name]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stream, open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || externalBusy) return;
    setInput("");
    setPendingPaste(null);
    // Capture anything substantial automatically, so sharing data just works.
    if (onAddContext && isSubstantive(text)) onAddContext(text);
    const history: Msg[] = [...messages, { role: "user", text }];
    setMessages(history);
    setBusy(true);
    onBusyChange?.(true);
    setStream("");
    try {
      const provider = await createProvider(settings);
      // Keep the prompt bounded: send the most recent turns rather than the
      // entire history, so a long chat stays fast and within context limits.
      const convo = history.slice(-14).map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`).join("\n\n");
      const user = `${buildContext(scorecard, analysis, dataReport, contextFacts)}

CONVERSATION SO FAR:
${convo}

Reply to the latest User message only.`;
      let full = "";
      abortRef.current = new AbortController();
      const answer = await provider.complete(SYSTEM, user, { onToken: (t) => { full += t; setStream(full); } }, abortRef.current.signal);
      setMessages((m) => [...m, { role: "assistant", text: answer || full }]);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setMessages((m) => [...m, { role: "assistant", text: `Sorry, that didn't go through: ${err instanceof Error ? err.message : String(err)}. If your model runs through the proxy it may have timed out, try Gemini for this.` }]);
      }
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      setStream("");
    }
  }, [input, busy, externalBusy, messages, settings, scorecard, analysis, dataReport, contextFacts, onAddContext, onBusyChange]);

  // If the panel closes mid-generation, abort and clear the busy signal so the
  // rest of the app unlocks.
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setBusy(false);
      onBusyChange?.(false);
    }
  }, [open, onBusyChange]);

  const clearChat = () => {
    setMessages([]);
    try { localStorage.removeItem(CHAT_KEY); } catch { /* ignore */ }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 animate-fadeInUp" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full sm:max-w-lg h-full bg-surface-raised border-l border-border shadow-2xl flex flex-col animate-fadeInUp">
        {/* Header */}
        <div className="flex items-center gap-2 p-4 border-b border-border shrink-0">
          <span className="grid place-items-center w-8 h-8 rounded-lg bg-accent-500/20 text-accent-300 animate-breathe">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">Analysis advisor</h2>
            <p className="text-[11px] text-text-secondary truncate">Reviewing {scorecard.city.name} with you</p>
          </div>
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              title="Start a fresh conversation (your saved data stays)"
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay shrink-0"
            >
              <Trash2 size={12} /> New chat
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay shrink-0">
            <X size={18} />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
          {messages.length === 0 && !busy && (
            <div className="text-sm text-text-secondary space-y-3">
              <div className="flex items-start gap-2.5">
                <span className="grid place-items-center w-8 h-8 rounded-full bg-accent-500/20 text-accent-300 shrink-0">
                  <Sparkles size={15} />
                </span>
                <div className="msg-md px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-surface-overlay border border-border text-text-primary">
                  <p className="text-sm">
                    Hi! I&apos;m here to help you sharpen this analysis. Ask me what might be missing, or share real
                    data you have (a report, some statistics, local knowledge). Anything substantial you share is saved
                    automatically, and pressing <strong>Re-run</strong> rebuilds the scorecard using it. Our conversation is
                    remembered too, so you can come back to it later.
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 pl-10">
                {STARTERS.map((q) => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="text-left text-xs px-3 py-2 rounded-lg bg-surface-overlay border border-border text-text-secondary hover:text-text-primary hover:border-primary-500/40 transition-colors lift"
                  >
                    {q}
                  </button>
                ))}
                <a
                  href="/data-sources"
                  target="_blank"
                  rel="noreferrer"
                  className="text-left text-xs px-3 py-2 rounded-lg bg-accent-500/10 border border-accent-500/25 text-accent-300 hover:text-accent-200 transition-colors inline-flex items-center gap-1.5"
                >
                  <Globe2 size={12} /> Need data? Browse free, credible sources
                </a>
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" ? (
                <div className="msg-md max-w-[90%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-surface-overlay border border-border text-text-primary space-y-2 break-words [overflow-wrap:anywhere]"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
              ) : (
                <UserMessageBubble
                  text={m.text}
                  onAdd={onAddContext ? () => onAddContext(m.text) : undefined}
                  added={contextFacts.includes(m.text.trim())}
                />
              )}
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="max-w-[90%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-surface-overlay border border-border text-text-primary break-words [overflow-wrap:anywhere]">
                {stream ? (
                  // Plain text while streaming (fast); markdown renders once complete.
                  <span className="whitespace-pre-wrap">{stream}</span>
                ) : (
                  <span className="inline-flex items-center gap-2 text-text-secondary"><Loader2 size={14} className="animate-spin" /> Thinking…</span>
                )}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Composer */}
        <div className="p-3 border-t border-border shrink-0">
          {externalBusy && (
            <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-xs text-warn-400">
              <Loader2 size={13} className="animate-spin shrink-0" />
              <span>Something else is running (an analysis or the Assistant). I&apos;ll be ready the moment it finishes.</span>
            </div>
          )}

          {/* One-tap capture for a paste that wouldn't be auto-saved */}
          {pendingPaste && onAddContext && !isSubstantive(pendingPaste) && (
            <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-accent-500/40 bg-accent-500/10 px-3 py-2 animate-fadeInUp">
              <ClipboardCheck size={14} className="text-accent-300 shrink-0" />
              <span className="text-xs text-text-primary flex-1">Save this as data for the scorecard?</span>
              <button
                onClick={() => { onAddContext(pendingPaste); setPendingPaste(null); }}
                className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold btn-accent active:scale-95"
              >
                <Plus size={12} /> Save it
              </button>
              <button onClick={() => setPendingPaste(null)} aria-label="Dismiss" className="shrink-0 p-1 rounded text-text-secondary hover:text-text-primary">
                <X size={13} />
              </button>
            </div>
          )}

          {/* What's saved for the re-run, reviewable and removable */}
          {contextFacts.length > 0 && (
            <div className="mb-2.5 rounded-xl border border-accent-500/40 bg-accent-500/10 overflow-hidden animate-fadeInUp">
              <div className="flex items-center gap-2 px-3 py-2">
                <Check size={13} className="text-accent-300 shrink-0" />
                <span className="text-xs text-text-primary flex-1">
                  <strong>{contextFacts.length}</strong> thing{contextFacts.length === 1 ? "" : "s"} you shared {contextFacts.length === 1 ? "is" : "are"} saved for the re-run.
                </span>
                <button
                  onClick={() => setShowContext((v) => !v)}
                  className="shrink-0 text-[11px] text-accent-300 hover:text-accent-200 inline-flex items-center gap-0.5"
                >
                  {showContext ? "Hide" : "Review"} <ChevronDown size={11} className={showContext ? "rotate-180 transition-transform" : "transition-transform"} />
                </button>
                {onRerun && (
                  <button
                    onClick={onRerun}
                    disabled={busy || externalBusy}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold btn-accent active:scale-95 disabled:opacity-40"
                  >
                    <RefreshCw size={13} /> Re-run
                  </button>
                )}
              </div>
              {showContext && (
                <div className="border-t border-accent-500/25 max-h-40 overflow-y-auto divide-y divide-accent-500/15">
                  {contextFacts.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 px-3 py-1.5">
                      <span className="text-[11px] text-text-secondary flex-1 [overflow-wrap:anywhere]">{f.slice(0, 160)}{f.length > 160 ? "…" : ""}</span>
                      {onRemoveContext && (
                        <button
                          onClick={() => onRemoveContext(f)}
                          title="Remove this from the re-run"
                          className="shrink-0 p-0.5 rounded text-text-secondary hover:text-danger-400"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                  {onClearContext && (
                    <button onClick={onClearContext} className="w-full text-[11px] py-1.5 text-text-secondary hover:text-danger-400">
                      Remove everything
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const t = e.clipboardData.getData("text");
                if (onAddContext && t && t.trim().length > 40) setPendingPaste(tidyPaste(t));
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={2}
              placeholder={externalBusy ? "Waiting for the other task to finish…" : "Ask me anything, or paste data you found (I'll save and tidy it)…"}
              className="flex-1 resize-none rounded-xl bg-surface-overlay border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus:outline-none focus:border-primary-500/50 disabled:opacity-60"
              disabled={externalBusy}
            />
            <button
              onClick={() => void send()}
              disabled={busy || externalBusy || !input.trim()}
              aria-label="Send"
              className="shrink-0 grid place-items-center w-10 h-10 rounded-xl btn-accent disabled:opacity-40 active:scale-95 transition-all"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
          <p className="text-[10px] text-text-secondary mt-1.5 flex items-center gap-1">
            <ClipboardCheck size={11} /> Data you share is saved automatically and used the next time you re-run.
          </p>
        </div>
      </div>
    </div>
  );
}
