/**
 * Getting Started — a short, friendly "what do I do?" panel, shown until the
 * user has run their first analysis.
 */

import { Upload, Play, Sparkles, Settings as SettingsIcon } from "lucide-react";

export function GettingStarted({ onOpenSettings }: { onOpenSettings: () => void }) {
  const steps = [
    {
      icon: <Upload size={18} className="text-accent-400" />,
      title: "1 · Load a scorecard",
      body: "Drag a completed UNDRR scorecard (.xlsm/.xlsx) onto the upload box, or click it to choose a file. Everything is processed in your browser session.",
    },
    {
      icon: <Play size={18} className="text-accent-400" />,
      title: "2 · Click “Run Analysis”",
      body: "The app gathers free open data about the city, then asks the AI to find strengths, gaps and a prioritised action plan. You'll see each step as it happens.",
    },
    {
      icon: <Sparkles size={18} className="text-accent-400" />,
      title: "3 · Read the results",
      body: "You'll get a plain-language summary, a strengths/weaknesses list, a priority matrix, a costed action plan and a projected score.",
    },
  ];

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-text-primary">New here? Here's what to do</h2>
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-1.5 text-xs text-primary-300 hover:text-text-primary transition-colors"
        >
          <SettingsIcon size={13} /> Choose the AI model
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {steps.map((s) => (
          <div key={s.title} className="p-3 rounded-lg bg-surface-overlay/40 border border-border">
            <div className="flex items-center gap-2 mb-1.5">
              {s.icon}
              <h3 className="text-sm font-semibold text-text-primary">{s.title}</h3>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">{s.body}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-text-secondary mt-3">
        The status bar at the top shows whether your AI provider is ready. If it isn&apos;t, open{" "}
        <span className="text-primary-300">Settings</span> to pick a provider (Gemini and OpenRouter
        have free tiers) and paste a key — or select your local Ollama model.
      </p>
    </div>
  );
}