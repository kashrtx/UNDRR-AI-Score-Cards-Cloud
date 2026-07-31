"use client";

/**
 * "Am I missing something?" — a small, dismissible chat scoped to the finished
 * Dashboard analysis. The user can ask what might be missing, question a score,
 * or paste in real data they found (reports, statistics, local knowledge), and
 * the AI uses the full analysis as context to point out gaps and suggest
 * concrete refinements for a more accurate scorecard.
 *
 * It never mutates the displayed analysis; it advises, so the on-screen result
 * stays stable and reliable. It reuses whatever provider is configured.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Send, Loader2, ClipboardCheck, Sparkles, Globe2, RefreshCw } from "lucide-react";
import { createProvider } from "@/lib/llm";
import type { AppSettings } from "@/lib/settings/store";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { AnalysisResult } from "@/lib/analysis/schema";
import type { DataReport } from "@/lib/types";
import { renderMarkdown } from "@/lib/ui/markdown";
import { UserMessageBubble } from "@/components/UserMessageBubble";

type Msg = { role: "user" | "assistant"; text: string };

const SYSTEM = `You are a friendly, encouraging copilot sitting beside a city official who just ran a disaster-resilience analysis of their city. Think of yourself as a knowledgeable, supportive teammate whose whole goal is to help them end up with a scorecard they feel confident about. You are given the scorecard scores and the analysis that was produced.

The user may: point out something the analysis missed, question a score or claim, or paste in real data they found (reports, statistics, local knowledge). Your job:
- Point out likely gaps or inaccuracies in the analysis, and what would be worth verifying locally.
- When the user pastes data, FIRST briefly restate the key facts from it in a clean, organized way (a short tidy list or a sentence or two, not a wall of text), so they can see you understood it. THEN say plainly how it changes the picture and which scores or points it would affect. If it is the kind of fact that should update the scorecard, remind them they can tap "Use in re-run" under their pasted message and then "Re-run" so you can rebuild the analysis with it.
- Encourage them, warmly and briefly, to paste any relevant local data they have, while keeping it on-topic for this city's resilience (gently steer away from unrelated material).
- Suggest concrete, specific refinements that would make the scorecard or analysis more accurate.
- Warmly encourage them to bring in their own local data whenever they have it, since that is what makes the result trustworthy.

Rules:
- Be honest and grounded. Never invent facts, statistics, programme names, or budgets. If you are not sure, say so.
- If the user's data conflicts with the analysis, explain which is more reliable and why, rather than just agreeing.
- Keep answers short, warm, and genuinely helpful. Plain language, a little encouragement, no jargon dumps.
- Use short markdown lists when they make things clearer.
- Do not use em dashes.`;

function buildContext(sc: NormalizedScorecard, a: AnalysisResult, dr: DataReport | null): string {
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
  return `CITY: ${sc.city.name}, ${sc.city.country}
OVERALL SCORE: ${sc.total} out of ${sc.totalMax}

ESSENTIAL SCORES:
${ess}

ANALYSIS SUMMARY:
${a.summary}${risk}

STRENGTHS THE ANALYSIS FOUND:
${strengths || "(none listed)"}

WEAKNESSES THE ANALYSIS FOUND:
${weaknesses || "(none listed)"}${data}`;
}

const STARTERS = [
  "What might be missing from this analysis?",
  "Which weak areas should I double-check locally?",
  "I have some extra data to add, here it is:",
];

export function RefineAnalysisChat({
  open,
  onClose,
  scorecard,
  analysis,
  dataReport,
  settings,
  currentContext,
  onRerunWithContext,
}: {
  open: boolean;
  onClose: () => void;
  scorecard: NormalizedScorecard;
  analysis: AnalysisResult;
  dataReport: DataReport | null;
  settings: AppSettings;
  currentContext?: string;
  onRerunWithContext?: (ctx: string) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState("");
  const [gathered, setGathered] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const addFact = (text: string) => {
    setGathered((g) => (g.includes(text) ? g : [...g, text]));
  };

  const rerun = () => {
    if (!onRerunWithContext || gathered.length === 0) return;
    const combined = [currentContext, ...gathered].filter((s) => s && s.trim()).join("\n\n---\n\n");
    setGathered([]); // applied now; they live in the analysis context from here
    onRerunWithContext(combined);
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stream]);

  // Abort any in-flight request if the panel is closed.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const history: Msg[] = [...messages, { role: "user", text }];
    setMessages(history);
    setBusy(true);
    setStream("");
    try {
      const provider = await createProvider(settings);
      const convo = history.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`).join("\n\n");
      const user = `${buildContext(scorecard, analysis, dataReport)}

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
      setStream("");
    }
  }, [input, busy, messages, settings, scorecard, analysis, dataReport]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 animate-fadeInUp" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full sm:max-w-md h-full bg-surface-raised border-l border-border shadow-2xl flex flex-col animate-fadeInUp">
        {/* Header */}
        <div className="flex items-center gap-2 p-4 border-b border-border shrink-0">
          <span className="grid place-items-center w-8 h-8 rounded-lg bg-accent-500/20 text-accent-300 animate-breathe">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">Your scorecard copilot</h2>
            <p className="text-[11px] text-text-secondary truncate">Here to help you get {scorecard.city.name} right</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-auto p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay">
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
                    Hi! I&apos;m your copilot for this analysis. I can spot gaps, sanity-check a score, and fold in real data
                    you bring. Paste in as much relevant data as you like, reports, statistics, local knowledge, even a messy
                    copy-paste is fine, I&apos;ll tidy it up. When it helps, tap <strong>Use in re-run</strong> under your paste and
                    then <strong>Re-run</strong>, and I&apos;ll rebuild the scorecard with those facts. What should we look at first?
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
                <div className="msg-md max-w-[90%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-surface-overlay border border-border text-text-primary space-y-2"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
              ) : (
                <UserMessageBubble text={m.text} onAdd={onRerunWithContext ? () => addFact(m.text) : undefined} added={gathered.includes(m.text)} />
              )}
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="msg-md max-w-[90%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-surface-overlay border border-border text-text-primary">
                {stream ? (
                  <span dangerouslySetInnerHTML={{ __html: renderMarkdown(stream) }} />
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
          {onRerunWithContext && gathered.length > 0 && (
            <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-accent-500/40 bg-accent-500/10 px-3 py-2 animate-fadeInUp">
              <span className="text-xs text-text-primary flex-1">
                <strong>{gathered.length}</strong> piece{gathered.length === 1 ? "" : "s"} of your data ready. Re-run to fold {gathered.length === 1 ? "it" : "them"} into a better scorecard.
              </span>
              <button
                onClick={rerun}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold btn-accent active:scale-95"
              >
                <RefreshCw size={13} /> Re-run now
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={2}
              placeholder="Ask me anything, or paste data you found (I'll tidy it up)…"
              className="flex-1 resize-none rounded-xl bg-surface-overlay border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus:outline-none focus:border-primary-500/50"
            />
            <button
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="shrink-0 grid place-items-center w-10 h-10 rounded-xl btn-accent disabled:opacity-40 active:scale-95 transition-all"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
          <p className="text-[10px] text-text-secondary mt-1.5 flex items-center gap-1">
            <ClipboardCheck size={11} /> Paste real data, then tap &quot;Use in re-run&quot; under it and Re-run to fold it into a better scorecard.
          </p>
        </div>
      </div>
    </div>
  );
}
