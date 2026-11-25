"use client";

/**
 * Status bar, a live, plain-language read-out of what's ready: which AI
 * helpers are picked, whether each has what it needs (an API key, or a local
 * server), and whether a scorecard is loaded. Everything is client-side, so
 * there's no backend to be "down".
 */

import { CheckCircle2, AlertCircle, Cpu, Cloud, Sparkles, Boxes, MonitorSmartphone, FileSpreadsheet, ShieldCheck, Globe, GraduationCap } from "lucide-react";
import type { AppSettings, ProviderId } from "@/lib/settings/store";
import { modelForSettings, selectedProviders, settingsFor, providerIsReady } from "@/lib/settings/store";

const LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  xai: "xAI Grok",
  zai: "z.AI GLM",
  nvidia: "NVIDIA NIM",
  meta: "Meta Llama",
  azure: "Microsoft Azure",
  perplexity: "Perplexity",
  createai: "ASU CreateAI",
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
    case "createai":
      return <GraduationCap size={14} className={cls} />;
    case "ollama":
      return <Cpu size={14} className={cls} />;
    case "lmstudio":
      return <MonitorSmartphone size={14} className={cls} />;
  }
}

export function StatusBar({
  settings,
  city,
  tavilyOn = false,
}: {
  settings: AppSettings;
  city: string | null;
  tavilyOn?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {selectedProviders(settings).map((p) => {
        const ready = providerIsReady(p);
        const isLocal = p === "ollama" || p === "lmstudio";
        const readyDetail = ready
          ? isLocal ? "Local model selected" : "API key saved"
          : isLocal ? "Local model selected, make sure the local server is running" : "No API key yet, add one in Settings";
        return (
          <div key={p} className="flex items-center gap-1.5 text-text-secondary" title={readyDetail}>
            {providerIcon(p, ready)}
            <span>
              {LABEL[p]} · <span className="font-mono">{modelForSettings(settingsFor(settings, p))}</span>
            </span>
            {ready ? (
              <CheckCircle2 size={14} className="text-accent-400" aria-label="Ready" />
            ) : (
              <span className="flex items-center gap-1 text-warn-400"><AlertCircle size={14} /> Needs a key</span>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-1.5 text-text-secondary" title="Public data is fetched for you, nothing to set up">
        <ShieldCheck size={14} className="text-accent-400" />
        <span>Open data ready</span>
      </div>

      <div
        className="flex items-center gap-1.5"
        title={
          tavilyOn
            ? "Tavily is powering the live web search"
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
