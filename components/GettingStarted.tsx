/**
 * Getting Started, a short, friendly "what do I do?" panel, shown until the
 * user has run their first analysis.
 */

import { Upload, Play, Sparkles, Settings as SettingsIcon, Compass, X } from "lucide-react";

export function GettingStarted({
  onOpenSettings,
  onTakeTour,
  onDismiss,
}: {
  onOpenSettings: () => void;
  onTakeTour?: () => void;
  onDismiss?: () => void;
}) {
  const steps = [
    {
      icon: <Upload size={18} className="text-accent-400" />,
      title: "1. Add your scorecard",
      body: "Drag a completed UNDRR scorecard onto the box, or click to pick the file (.xlsm, .xlsx, or .xls). It's read right here on your device, nothing is uploaded to us.",
    },
    {
      icon: <Play size={18} className="text-accent-400" />,
      title: "2. Press Run Analysis",
      body: "It gathers free public data about your city, then has the AI look for what's working, what's weak, and what to do about it. You'll see each step as it happens.",
    },
    {
      icon: <Sparkles size={18} className="text-accent-400" />,
      title: "3. Read what comes back",
      body: "You get a summary in plain language, the city's strong and weak spots, a priority chart, an action plan with rough costs, and where your score could go.",
    },
  ];

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-base font-semibold text-text-primary">New here? Here&apos;s what to do</h2>
        <div className="flex items-center gap-2">
          {onTakeTour && (
            <button
              onClick={onTakeTour}
              className="flex items-center gap-1.5 text-xs text-primary-300 hover:text-text-primary transition-colors"
            >
              <Compass size={13} /> Take the tour
            </button>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              aria-label="Dismiss tips"
              className="p-1 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {steps.map((s) => (
          <div key={s.title} className="p-3 rounded-lg bg-surface-overlay/40 border border-border">
            <div className="flex items-center gap-2 mb-1.5">
              {s.icon}
              <h3 className="text-sm font-semibold text-text-primary">{s.title}</h3>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{s.body}</p>
          </div>
        ))}
      </div>
      <p className="text-sm text-text-secondary mt-3">
        The bar at the top tells you whether your AI is ready to go. If it isn&apos;t, pop into{" "}
        <button onClick={onOpenSettings} className="text-primary-300 hover:text-text-primary underline underline-offset-2">Settings</button>{" "}
        to pick one and add a key. Gemini and OpenRouter both have free options, or you can point it at your own local model.
      </p>
    </div>
  );
}