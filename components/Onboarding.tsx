"use client";

/**
 * A friendly, skippable tour shown on a person's first visit (and replayable
 * from Settings). Click through the arrows to learn the workflow, or skip.
 * Accessible: focus is moved in, Escape skips, ← / → navigate.
 */

import { useEffect, useRef, useState } from "react";
import {
  Compass, Bot, ClipboardCheck, BarChart3, Settings as SettingsIcon, ShieldCheck,
  ArrowLeft, ArrowRight, X,
} from "lucide-react";

interface Step {
  icon: React.ReactNode;
  title: string;
  body: string;
  bullets?: string[];
}

const STEPS: Step[] = [
  {
    icon: <Compass size={26} />,
    title: "Welcome",
    body: "This tool takes a city's UNDRR disaster resilience scorecard and turns it into a clear analysis with a practical action plan. If you don't have a scorecard yet, it can help you build one. Here's a quick look around, it only takes about half a minute.",
  },
  {
    icon: <Bot size={26} />,
    title: "The Assistant builds a scorecard for you",
    body: "New to the scorecard, or only part way through? Head to the Assistant tab.",
    bullets: [
      "Type in your city and it will do the research and fill in all 47 questions for you.",
      "Prefer to go question by question? Just chat with it and it will help.",
      "When you're happy, download the real official file or send it straight to the analysis.",
    ],
  },
  {
    icon: <BarChart3 size={26} />,
    title: "The Dashboard analyzes it",
    body: "On the Dashboard, add a completed scorecard (your own, or one from the Assistant) and press Run Analysis.",
    bullets: [
      "It quietly gathers free public data about your city while it works.",
      "You get a plain language summary, a clear picture of strong and weak areas, an action plan, and where your score could go.",
    ],
  },
  {
    icon: <SettingsIcon size={26} />,
    title: "Settings is where you pick the AI",
    body: "Choose which AI writes the analysis and paste in a key. Gemini and OpenRouter both have free options, and NVIDIA NIM works nicely for the Assistant. You can turn on web search here too, and come back to watch this tour again any time.",
  },
  {
    icon: <ShieldCheck size={26} />,
    title: "A helping hand, not the last word",
    body: "The AI's answers can vary depending on which model you choose, so please have someone who knows disaster resilience look them over before you act on them. Everything happens right here in your browser, so your information stays with you.",
  },
];

export function Onboarding({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      setI(0);
      // Move focus into the dialog for keyboard + screen-reader users.
      setTimeout(() => nextRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((v) => Math.min(STEPS.length - 1, v + 1));
      else if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
    >
      <div
        ref={panelRef}
        className="w-full sm:max-w-lg bg-surface border border-border shadow-2xl rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-end px-3 pt-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded-lg"
          >
            Skip <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-2 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-accent-500/15 text-accent-400 flex items-center justify-center mb-4">
            {step.icon}
          </div>
          <h2 id="tour-title" className="text-lg font-semibold text-text-primary mb-2">{step.title}</h2>
          <p className="text-sm text-text-secondary leading-relaxed">{step.body}</p>
          {step.bullets && (
            <ul className="mt-3 space-y-1.5 text-left max-w-sm mx-auto">
              {step.bullets.map((b, k) => (
                <li key={k} className="flex items-start gap-2 text-sm text-text-secondary">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-400 shrink-0" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Dots */}
        <div className="flex items-center justify-center gap-1.5 py-4">
          {STEPS.map((_, k) => (
            <button
              key={k}
              onClick={() => setI(k)}
              aria-label={`Go to step ${k + 1}`}
              className={`h-1.5 rounded-full transition-all ${k === i ? "w-5 bg-accent-400" : "w-1.5 bg-border hover:bg-text-secondary"}`}
            />
          ))}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={() => setI((v) => Math.max(0, v - 1))}
            disabled={i === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowLeft size={16} /> Back
          </button>
          {last ? (
            <button
              ref={nextRef}
              onClick={onClose}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold btn-accent"
            >
              Get started
            </button>
          ) : (
            <button
              ref={nextRef}
              onClick={() => setI((v) => Math.min(STEPS.length - 1, v + 1))}
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm font-semibold btn-accent"
            >
              Next <ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
