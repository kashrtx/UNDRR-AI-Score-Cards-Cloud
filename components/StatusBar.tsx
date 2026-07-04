"use client";

/**
 * Status bar, a live, plain-language read-out of what's ready: which AI
 * provider is active, whether it has what it needs (an API key, or Ollama for
 * local), and whether a scorecard is loaded. Everything is client-side, so
 * there's no backend to be "down".
 */

import { CheckCircle2, AlertCircle, Cpu, Cloud, Sparkles, Boxes, MonitorSmartphone, FileSpreadsheet, ShieldCheck, Globe } from "lucide-react";
import type { AppSettings, ProviderId } from "@/lib/settings/store";
import { modelForSettings } from "@/lib/settings/store";

const LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  xai: "xAI Grok",
  zai: "z.AI GLM",
  nvidia: "NVIDIA NIM",
  meta: "Meta Llama",
  ollama: "Local (Ollama)",
  lmstudio: "Local (LM Studio)",
};

function providerIcon(p: ProviderId, ready: boolean) {
  const cls = ready ? "text-accent-400" : "text-warn-400";
  switch (p) {
    case "claude":
      return <Cloud size={14} className={cls} />;
    case "gemini":
      return <Sparkles size={14} className={cls} />;
    case "openrouter":
    case "xai":
    case "zai":
      return <Boxes size={14} className={cls} />;
    case "openai":
      return <Sparkles size={14} className={cls} />;
    case "nvidia":
      return <Cpu size={14} className={cls} />;
    case "meta":
      return <Cloud size={14} className={cls} />;
    case "ollama":
      return <Cpu size={14} className={cls} />;
    case "lmstudio":
      return <MonitorSmartphone size={14} className={cls} />;
  }
}

export function StatusBar({
  settings,
  providerReady,
  city,
  tavilyOn = false,
}: {
  settings: AppSettings;
  providerReady: boolean;
  city: string | null;
  tavilyOn?: boolean;
}) {
  const model = modelForSettings(settings);

  const isLocal = settings.provider === "ollama" || settings.provider === "lmstudio";
  const readyDetail = providerReady
    ? isLocal
      ? "Local model selected"
      : "API key saved"
    : isLocal
    ? "Local model selected, make sure the local server is running"
    : "No API key yet, add one in Settings";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <div className="flex items-center gap-1.5 text-text-secondary" title={readyDetail}>
        {providerIcon(settings.provider, providerReady)}
        <span>
          {LABEL[settings.provider]} · <span className="font-mono">{model}</span>
        </span>
      </div>

      <div className="flex items-center gap-1.5" title={readyDetail}>
        {providerReady ? (
          <CheckCircle2 size={14} className="text-accent-400" />
        ) : (
          <AlertCircle size={14} className="text-warn-400" />
        )}
        <span className={providerReady ? "text-text-secondary" : "text-warn-400"}>
          {providerReady ? "Ready" : "Needs a key"}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-text-secondary" title="Open data runs server-side (no setup needed)">
        <ShieldCheck size={14} className="text-accent-400" />
        <span>Open data ready</span>
      </div>

      <div
        className="flex items-center gap-1.5"
        title={
          tavilyOn
            ? "Tavily is running the live web search for grounding"
            : "Free web search (Wikipedia + DuckDuckGo). Add a Tavily key in Settings for richer results."
        }
      >
        <Globe size={14} className={tavilyOn ? "text-accent-400" : "text-primary-300"} />
        <span className={tavilyOn ? "text-accent-400 font-medium" : "text-text-secondary"}>
          {tavilyOn ? "Tavily web search on" : "Web search: free"}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-text-secondary">
        <FileSpreadsheet size={14} className="text-primary-300" />
        <span>{city ? city : "No scorecard loaded"}</span>
      </div>
    </div>
  );
}
