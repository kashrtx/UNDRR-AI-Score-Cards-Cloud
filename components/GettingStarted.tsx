/**
 * Getting Started, a warm, plain-language "what do I do?" panel aimed at people
 * who aren't technical. It greets the user, and when no AI is set up yet it
 * leads with that one step (the only real hurdle) before the rest.
 */

import { Upload, Play, Sparkles, Compass, X, KeyRound, ArrowRight, CheckCircle2 } from "lucide-react";

export function GettingStarted({
  onOpenSettings,
  onTakeTour,
  onDismiss,
  ready = false,
}: {
  onOpenSettings: () => void;
  onTakeTour?: () => void;
  onDismiss?: () => void;
  ready?: boolean;
}) {
  const steps = [
    {
      icon: <Upload size={18} className="text-accent-400" />,
      title: "1. Add your scorecard",
      body: "Drag a completed UNDRR scorecard onto the box below, or click to pick the file. It's read right here on your device, nothing is uploaded to us.",
    },
    {
      icon: <Play size={18} className="text-accent-400" />,
      title: "2. Press Run Analysis",
      body: "It gathers free public data about your city, then has the AI look for what's working, what's weak, and what to do. You'll watch each step happen.",
    },
    {
      icon: <Sparkles size={18} className="text-accent-400" />,
      title: "3. Read what comes back",
      body: "A plain-language summary, the city's strong and weak spots, a priority chart, and an action plan with rough costs. No jargon needed.",
    },
  ];

  return (
    <div className="glass-card p-5 animate-fadeInUp">
      <div className="flex items-start justify-between mb-3 gap-2">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Welcome! Let&apos;s get you started.</h2>
          <p className="text-sm text-text-secondary mt-0.5">
            This tool reads a city&apos;s disaster-resilience scorecard and explains it in plain language. Here&apos;s all there is to it.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onTakeTour && (
            <button
              onClick={onTakeTour}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-primary-300 hover:text-text-primary hover:border-primary-500/40 transition-colors"
            >
              <Compass size={13} /> Watch the quick tour
            </button>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              aria-label="Hide these tips"
              title="Hide these tips (you can reopen the tour any time from the Help button)"
              className="p-1 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      {/* The one real hurdle: setting up an AI. Lead with it when not ready. */}
      {!ready ? (
        <div className="rounded-xl border-2 border-accent-500/40 bg-accent-500/10 p-4 mb-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="grid place-items-center w-7 h-7 rounded-full bg-accent-500 text-white text-sm font-bold">1</span>
            <h3 className="text-base font-semibold text-text-primary">First, choose your AI helper</h3>
          </div>
          <p className="text-sm text-text-secondary mb-3">
            The app needs an AI to read the scorecard. It&apos;s free to start, Google Gemini is the easiest and fastest,
            and it takes about two minutes. The Settings page walks you through each click and gives you the link to get a key.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold btn-accent lift active:scale-95"
            >
              <KeyRound size={15} /> Set up my AI helper <ArrowRight size={15} />
            </button>
            {onTakeTour && (
              <button
                onClick={onTakeTour}
                className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40 transition-colors"
              >
                <Compass size={15} /> Show me how
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-accent-500/25 bg-accent-500/5 p-3 mb-3 flex items-center gap-2">
          <CheckCircle2 size={16} className="text-accent-400 shrink-0" />
          <p className="text-sm text-text-secondary">
            Your AI is set up and ready. Just add a scorecard below and press Run Analysis.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {steps.map((s) => (
          <div key={s.title} className="p-3 rounded-lg bg-surface-overlay/40 border border-border lift">
            <div className="flex items-center gap-2 mb-1.5">
              {s.icon}
              <h3 className="text-sm font-semibold text-text-primary">{s.title}</h3>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{s.body}</p>
          </div>
        ))}
      </div>

      <p className="text-sm text-text-secondary mt-3">
        Stuck at any point? The green <span className="font-semibold text-text-primary">Need help?</span> button in the
        bottom corner replays the guided tour whenever you want it.
      </p>
    </div>
  );
}
