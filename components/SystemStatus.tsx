"use client";

/**
 * System status — an at-a-glance panel of everything the tool needs and whether
 * it's healthy: the attached scorecard (with filename + a Remove button), the AI
 * provider (with a one-click Test), and the open-data service. Surfaces parse
 * warnings so you can see exactly what was read and flag anything off.
 */

import { useState } from "react";
import {
  FileSpreadsheet, X, CheckCircle2, AlertTriangle, Cloud, Cpu, Sparkles,
  Boxes, MonitorSmartphone, Plug, Loader2, ShieldCheck, KeyRound, XCircle,
} from "lucide-react";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import { createProvider } from "@/lib/llm";
import type { AppSettings, ProviderId } from "@/lib/settings/store";

const LABEL: Record<ProviderId, string> = {
  claude: "Claude", gemini: "Gemini", openrouter: "OpenRouter",
  ollama: "Local (Ollama)", lmstudio: "Local (LM Studio)",
};
function icon(p: ProviderId, cls: string) {
  switch (p) {
    case "claude": return <Cloud size={15} className={cls} />;
    case "gemini": return <Sparkles size={15} className={cls} />;
    case "openrouter": return <Boxes size={15} className={cls} />;
    case "ollama": return <Cpu size={15} className={cls} />;
    case "lmstudio": return <MonitorSmartphone size={15} className={cls} />;
  }
}

function parseChecks(sc: NormalizedScorecard): { warnings: string[]; essentialsWithData: number } {
  const warnings: string[] = [];
  const essentialsWithData = sc.essentials.filter((e) =>
    sc.indicators.some((i) => i.essential === e.num)
  ).length;
  if (sc.indicators.length < 40) {
    warnings.push(`Only ${sc.indicators.length} indicators detected (a full Preliminary scorecard has ~47). Double-check the file.`);
  }
  if (essentialsWithData < 10) {
    warnings.push(`${10 - essentialsWithData} of the Ten Essentials have no indicators — some sections may not have parsed.`);
  }
  return { warnings, essentialsWithData };
}

export function SystemStatus({
  scorecard,
  fileName,
  onRemove,
  settings,
  providerReady,
  modelName,
}: {
  scorecard: NormalizedScorecard | null;
  fileName: string | null;
  onRemove: () => void;
  settings: AppSettings;
  providerReady: boolean;
  modelName: string;
}) {
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const runTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const p = await createProvider(settings);
      setTestMsg(await p.test());
    } catch (err) {
      setTestMsg({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const checks = scorecard ? parseChecks(scorecard) : null;
  const pct = scorecard ? Math.round((scorecard.total / scorecard.totalMax) * 100) : 0;

  return (
    <div className="glass-card p-4 space-y-3">
      {/* Scorecard row */}
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 ${scorecard ? "text-accent-400" : "text-text-secondary"}`}>
          {scorecard ? <CheckCircle2 size={18} /> : <FileSpreadsheet size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          {scorecard ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-text-primary">Scorecard loaded</span>
                {fileName && (
                  <span className="inline-flex items-center gap-1 text-xs text-text-secondary bg-surface-overlay/60 border border-border rounded-full px-2 py-0.5 max-w-full">
                    <FileSpreadsheet size={11} className="shrink-0" />
                    <span className="truncate">{fileName}</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-text-secondary mt-1">
                {scorecard.city.name}, {scorecard.city.country} · read{" "}
                <span className="text-text-primary">{scorecard.indicators.length}</span> indicators across{" "}
                <span className="text-text-primary">{checks?.essentialsWithData}/10</span> Essentials · score{" "}
                <span className="text-accent-400 font-medium">{scorecard.total}/{scorecard.totalMax}</span> ({pct}%)
              </p>
              {checks && checks.warnings.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {checks.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-warn-400">
                      <AlertTriangle size={12} className="shrink-0 mt-0.5" /> {w}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-sm text-text-secondary">
              No scorecard attached yet — upload one below to begin.
            </p>
          )}
        </div>
        {scorecard && (
          <button
            onClick={onRemove}
            title="Remove this scorecard"
            className="flex items-center gap-1 text-xs text-danger-400 hover:text-danger-500 border border-danger-500/30 hover:bg-danger-500/10 rounded-lg px-2 py-1 transition-all shrink-0"
          >
            <X size={13} /> Remove
          </button>
        )}
      </div>

      <div className="h-px bg-border/60" />

      {/* AI provider row */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{icon(settings.provider, providerReady ? "text-accent-400" : "text-warn-400")}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary">{LABEL[settings.provider]}</span>
            <span className="font-mono text-xs text-text-secondary truncate">{modelName}</span>
            {providerReady ? (
              <span className="inline-flex items-center gap-1 text-xs text-accent-400">
                <CheckCircle2 size={12} /> Ready
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-warn-400">
                <KeyRound size={12} /> Needs a key — open Settings
              </span>
            )}
          </div>
          {testMsg && (
            <p className={`text-xs mt-1 flex items-start gap-1.5 ${testMsg.ok ? "text-accent-400" : "text-danger-400"}`}>
              {testMsg.ok ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> : <XCircle size={12} className="mt-0.5 shrink-0" />}
              {testMsg.message}
            </p>
          )}
        </div>
        <button
          onClick={runTest}
          disabled={testing}
          className="flex items-center gap-1.5 text-xs text-text-primary border border-border hover:border-accent-500/50 rounded-lg px-2.5 py-1 transition-all disabled:opacity-50 shrink-0"
        >
          {testing ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
          Test AI
        </button>
      </div>

      <div className="h-px bg-border/60" />

      {/* Open data row */}
      <div className="flex items-center gap-3">
        <ShieldCheck size={15} className="text-accent-400" />
        <p className="text-xs text-text-secondary flex-1">
          Open-data service ready — climate, infrastructure, seismic, national indicators &amp; disaster history are fetched automatically at analysis time.
        </p>
      </div>
    </div>
  );
}
