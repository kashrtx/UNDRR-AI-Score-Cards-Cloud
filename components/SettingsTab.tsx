"use client";

/**
 * Settings, choose which AI writes the analysis and configure it. Everything
 * here is stored in THIS browser only: plain settings in localStorage, and API
 * keys encrypted with a device key (WebCrypto AES-GCM). Nothing is ever sent to
 * our server or stored in the repo.
 */

import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  Cloud, Cpu, Sparkles, Boxes, MonitorSmartphone, Save, Loader2,
  CheckCircle2, XCircle, KeyRound, Trash2, Plug, Globe, Search, Compass, BookCheck, GraduationCap, RefreshCw, Database, ChevronDown,
  Lightbulb,
} from "lucide-react";
import {
  type AppSettings, type ProviderId, type CloudProviderId, selectedProviders, PROVIDER_LABEL,
  setApiKey, hasApiKey, clearApiKey, isCloudProvider,
  setSearchKey, hasSearchKey, clearSearchKey,
} from "@/lib/settings/store";
import { createProvider } from "@/lib/llm";
import { listCreateAIModels, type CreateAIModel } from "@/lib/llm/openaiCompatible";
import { getApiKey } from "@/lib/settings/store";
import { DATA_SOURCES, DATA_SOURCE_CATEGORIES, HAZARD_ORDER, type DataSourceInfo } from "@/lib/data/catalog";

const MODELS: Record<ProviderId, string[]> = {
  gemini: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-2.5-pro"],
  openrouter: [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemini-2.0-flash-exp:free",
    "deepseek/deepseek-chat:free",
    "mistralai/mistral-7b-instruct:free",
  ],
  claude: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-5"],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.1"],
  xai: ["grok-4.3", "grok-4.1-fast-reasoning", "grok-4.1-fast-non-reasoning", "grok-code-fast-1"],
  zai: ["glm-4.7", "glm-5.2", "glm-5.1", "glm-4.7-flash", "glm-4.5-flash"],
  nvidia: ["z-ai/glm-5.2", "moonshotai/kimi-k2-instruct", "deepseek-ai/deepseek-r1", "qwen/qwen3-coder-480b-a35b-instruct", "meta/llama-3.3-70b-instruct", "meta/llama-3.1-405b-instruct"],
  meta: ["Llama-4-Maverick-17B-128E-Instruct-FP8", "Llama-4-Scout-17B-16E-Instruct-FP8"],
  azure: [],
  perplexity: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"],
  // A starting list; "Load my models" replaces it with what the key can actually use.
  createai: [
    "openai/gpt4_1-mini", "openai/gpt5_mini", "openai/gpt5_4_mini", "aws/claude5_5_haiku",
    "gcp-deepmind/geminiflash3", "gcp-deepmind/geminiflash3_7", "asu-air/gemma4_31b_it", "asu-air/llama4_scout-17b",
  ],
  lmstudio: ["local-model", "qwen2.5-7b-instruct", "llama-3.2-3b-instruct"],
  ollama: ["qwen2.5:3b", "llama3.2:3b", "qwen2.5:7b", "llama3.1:8b", "mistral"],
};

// The single model we recommend per provider (shown as "recommended").
const RECOMMENDED_MODEL: Partial<Record<ProviderId, string>> = {
  gemini: "gemini-3.6-flash",
  nvidia: "z-ai/glm-5.2",
  openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
  perplexity: "sonar",
  createai: "openai/gpt4_1-mini",
};

// How each provider actually reaches its API. "direct" = straight from the
// browser (fast, no server time limit). "proxy" = through our /api/llm route,
// which on Vercel's free plan is cut off at 120s, so slow/"reasoning" models can
// time out. "local" = runs on the visitor's own machine.
const TRANSPORT: Record<ProviderId, "direct" | "proxy" | "local"> = {
  gemini: "direct", openrouter: "direct", claude: "direct",
  openai: "proxy", xai: "proxy", zai: "proxy", nvidia: "proxy", meta: "proxy", azure: "proxy", perplexity: "proxy", createai: "proxy",
  lmstudio: "local", ollama: "local",
};

// Short "what's this good for" tags shown on the provider tiles.
const BEST_FOR: Partial<Record<ProviderId, string>> = {
  gemini: "Best for the Analysis tab",
  openrouter: "Best for the Assistant",
};

const PROVIDER_META: Record<ProviderId, { title: string; subtitle: string; icon: ReactNode }> = {
  gemini: {
    title: "Gemini (Google AI Studio)",
    subtitle: "Free tier, fast, high quality. The easiest starting point.",
    icon: <Sparkles size={18} className="text-accent-400" />,
  },
  openrouter: {
    title: "OpenRouter (free models)",
    subtitle: "Free open models (ids ending in :free). One key, many models.",
    icon: <Boxes size={18} className="text-accent-400" />,
  },
  claude: {
    title: "Claude API (Anthropic)",
    subtitle: "Top-quality analysis. Needs a paid Anthropic key.",
    icon: <Cloud size={18} className="text-accent-400" />,
  },
  openai: {
    title: "OpenAI (GPT)",
    subtitle: "GPT-5.5 and the GPT-5 family. Needs a paid OpenAI key.",
    icon: <Sparkles size={18} className="text-accent-400" />,
  },
  xai: {
    title: "xAI (Grok)",
    subtitle: "Grok 4.3 and the fast Grok models. Needs an xAI key.",
    icon: <Boxes size={18} className="text-accent-400" />,
  },
  zai: {
    title: "z.AI (GLM)",
    subtitle: "GLM 5.2, 5.1 and 4.7. Two flash models are free to use.",
    icon: <Boxes size={18} className="text-accent-400" />,
  },
  nvidia: {
    title: "NVIDIA NIM (free)",
    subtitle: "100+ open models, free, including the very smart GLM 5.2. Great models, but they run through the proxy, so slow ones can time out on free hosting.",
    icon: <Cpu size={18} className="text-accent-400" />,
  },
  meta: {
    title: "Meta (Llama)",
    subtitle: "Llama 4 via Meta's API (experimental). Llama is also free on NVIDIA NIM.",
    icon: <Cloud size={18} className="text-accent-400" />,
  },
  azure: {
    title: "Microsoft (Azure OpenAI)",
    subtitle: "Microsoft's own API, the engine behind Copilot. Needs an Azure endpoint, deployment name, and key.",
    icon: <Cloud size={18} className="text-accent-400" />,
  },
  perplexity: {
    title: "Perplexity (Sonar)",
    subtitle: "Search-grounded models with built-in web results and citations. Good for the Assistant's research. Needs a Perplexity key.",
    icon: <Search size={18} className="text-accent-400" />,
  },
  createai: {
    title: "ASU CreateAI",
    subtitle: "Arizona State University's AI platform: Claude, Gemini, GPT, Gemma and Llama with one project API key from platform.aiml.asu.edu. Usage counts against your project's monthly budget.",
    icon: <GraduationCap size={18} className="text-accent-400" />,
  },
  lmstudio: {
    title: "Local (LM Studio)",
    subtitle: "Free & private. OpenAI-compatible; usually works with no extra setup.",
    icon: <MonitorSmartphone size={18} className="text-accent-400" />,
  },
  ollama: {
    title: "Local (Ollama)",
    subtitle: "Free & private. Runs on your machine (needs OLLAMA_ORIGINS).",
    icon: <Cpu size={18} className="text-accent-400" />,
  },
};

// Display order, cloud first (the friction-free path), then local.
const ORDER: ProviderId[] = ["gemini", "openrouter", "createai", "nvidia", "perplexity", "zai", "claude", "openai", "xai", "meta", "azure", "lmstudio", "ollama"];

/** Step 3: optional data sources, grouped as in the source catalogue, all off by default. */
function DataSourcePicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const on = new Set(selected);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => onChange(on.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const setGroup = (ids: string[], value: boolean) =>
    onChange(value ? Array.from(new Set([...selected, ...ids])) : selected.filter((x) => !ids.includes(x)));

  const row = (d: DataSourceInfo) => (
    <label key={d.id} className="flex items-start gap-2.5 py-1.5 cursor-pointer">
      <input type="checkbox" checked={on.has(d.id)} onChange={() => toggle(d.id)}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent-500,#10b981)]" />
      <span className="min-w-0 text-sm">
        <span className="text-text-primary font-medium">{d.name}</span>
        <span className="text-text-secondary"> · {d.provider}</span>
        <span className="block text-xs text-text-secondary">
          {d.provides} {d.coverage}{" "}
          <span className="text-warn-400">{d.caveat}</span>{" "}
          <a href={d.url} target="_blank" rel="noreferrer" className="underline text-primary-300" onClick={(e) => e.stopPropagation()}>link</a>
        </span>
      </span>
    </label>
  );

  return (
    <div id="settings-sources" className="glass-card p-5 space-y-4 scroll-mt-24">
      <div>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <span className="text-accent-400">Step 3.</span> <Database size={17} className="text-accent-400" /> Choose data sources <span className="text-xs font-normal text-text-secondary">(optional)</span>
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          Tick the free global datasets you want the AI helpers to look for and cite when they fill out a scorecard
          (&quot;Fill it out for me&quot;) and when they write an analysis (&quot;Run analysis&quot;). The app always gathers its own
          open data (climate, elevation, OpenStreetMap, earthquakes, World Bank); these are extra. The AI looks them up
          and names them where they support an answer. The app doesn&apos;t download the files themselves.
        </p>
        <p className="text-xs text-text-secondary mt-1.5">
          {selected.length ? `${selected.length} of ${DATA_SOURCES.length} selected.` : "None selected."}{" "}
          {selected.length > 0 && <button type="button" onClick={() => onChange([])} className="underline text-primary-300">Clear all</button>}
        </p>
      </div>
      {DATA_SOURCE_CATEGORIES.map((cat) => {
        const items = DATA_SOURCES.filter((d) => d.category === cat.id);
        if (!items.length) return null;
        const ids = items.map((d) => d.id);
        const count = ids.filter((id) => on.has(id)).length;
        const isOpen = open[cat.id] ?? count > 0;
        const groups = cat.id === "hazard"
          ? HAZARD_ORDER.map((h) => [h, items.filter((d) => d.hazard === h)] as const).filter(([, list]) => list.length)
          : [["", items] as const];
        return (
          <div key={cat.id} className="rounded-xl border border-border">
            <div className="flex items-center gap-2 px-3 py-2">
              <button type="button" onClick={() => setOpen((o) => ({ ...o, [cat.id]: !isOpen }))} aria-expanded={isOpen}
                className="flex-1 min-w-0 flex items-center gap-2 text-left">
                <ChevronDown size={15} className={`shrink-0 text-text-secondary transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                <span className="min-w-0">
                  <span className="text-sm font-medium text-text-primary">{cat.title}</span>
                  <span className="text-xs text-text-secondary"> · {count}/{items.length} selected</span>
                  <span className="block text-xs text-text-secondary truncate">{cat.blurb}</span>
                </span>
              </button>
              <button type="button" onClick={() => setGroup(ids, count < items.length)}
                className="shrink-0 text-xs px-2 py-1 rounded-lg border border-border text-text-secondary hover:text-text-primary">
                {count < items.length ? "Select all" : "Clear"}
              </button>
            </div>
            {isOpen && (
              <div className="px-3 pb-2 border-t border-border">
                {groups.map(([h, list]) => (
                  <div key={h || cat.id} className="pt-2">
                    {h && <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{h}</p>}
                    {list.map(row)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-xs text-text-secondary">
        Several of these are free for non-commercial use only (GEM, EM-DAT). Check each dataset&apos;s licence before reusing its data elsewhere.
      </p>
    </div>
  );
}

const inputCls =
  "mt-1 w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm text-text-primary focus:border-accent-500/60 outline-none";

export function SettingsTab({
  settings,
  onChange,
  onReplayTutorial,
  lockReason = null,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onReplayTutorial?: () => void;
  /** Set while helpers are filling or analysing: the helper choice can't change then. */
  lockReason?: string | null;
}) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [keyInput, setKeyInput] = useState("");
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [searchKeyInput, setSearchKeyInput] = useState("");
  const [searchKeyPresent, setSearchKeyPresent] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const refreshKeyPresence = () => {
    setKeyPresence({
      gemini: hasApiKey("gemini"),
      openrouter: hasApiKey("openrouter"),
      claude: hasApiKey("claude"),
      openai: hasApiKey("openai"),
      xai: hasApiKey("xai"),
      zai: hasApiKey("zai"),
      nvidia: hasApiKey("nvidia"),
      meta: hasApiKey("meta"),
      azure: hasApiKey("azure"),
      perplexity: hasApiKey("perplexity"),
      createai: hasApiKey("createai"),
    });
  };
  useEffect(() => { refreshKeyPresence(); setSearchKeyPresent(hasSearchKey()); }, []);
  useEffect(() => { setKeyInput(""); setTestMsg(null); }, [draft.provider]);

  const provider = draft.provider; // the helper being set up in Step 2
  const picked = selectedProviders(draft);
  const isCloud = isCloudProvider(provider);

  // Step 1 is a multi-select: each picked helper fills its own copy of the scorecard.
  const [pickNote, setPickNote] = useState<string | null>(null);
  const togglePick = (id: ProviderId) => {
    if (lockReason) return;
    setPickNote(null);
    if (picked.includes(id)) {
      if (picked.length === 1) {
        setPickNote("Keep at least one AI helper selected.");
        return;
      }
      const rest = picked.filter((p) => p !== id);
      setDraft({ ...draft, providers: rest, provider: provider === id ? rest[0] : provider });
    } else {
      // Newly picked: open its setup below so the key can be added straight away.
      setDraft({ ...draft, providers: ORDER.filter((p) => p === id || picked.includes(p)), provider: id });
    }
  };
  const isLocal = !isCloud;

  const modelField =
    provider === "claude" ? "claudeModel"
    : provider === "gemini" ? "geminiModel"
    : provider === "openrouter" ? "openrouterModel"
    : provider === "openai" ? "openaiModel"
    : provider === "xai" ? "xaiModel"
    : provider === "zai" ? "zaiModel"
    : provider === "nvidia" ? "nvidiaModel"
    : provider === "meta" ? "metaModel"
    : provider === "azure" ? "azureDeployment"
    : provider === "perplexity" ? "perplexityModel"
    : provider === "createai" ? "createaiModel"
    : provider === "lmstudio" ? "lmstudioModel"
    : "ollamaModel";
  const currentModel = draft[modelField] as string;

  // ASU CreateAI: the models this key can use, with prices (loaded on request).
  const [caiModels, setCaiModels] = useState<CreateAIModel[] | null>(null);
  const [caiLoading, setCaiLoading] = useState(false);
  const [caiError, setCaiError] = useState<string | null>(null);
  const loadCreateAIModels = async () => {
    setCaiLoading(true);
    setCaiError(null);
    try {
      const key = keyInput.trim() || (await getApiKey("createai")) || "";
      if (!key) throw new Error("Add your CreateAI key below first.");
      setCaiModels(await listCreateAIModels(key));
    } catch (e) {
      setCaiError(e instanceof Error ? e.message : String(e));
    } finally {
      setCaiLoading(false);
    }
  };
  const presets = provider === "createai" && caiModels?.length ? caiModels.map((m) => m.id) : MODELS[provider];
  const setModel = (value: string) => setDraft({ ...draft, [modelField]: value } as AppSettings);

  const baseField = provider === "lmstudio" ? "lmstudioBaseUrl" : "ollamaBaseUrl";
  const currentBase = draft[baseField] as string;
  const setBase = (value: string) => setDraft({ ...draft, [baseField]: value } as AppSettings);

  // True when the person has picked or typed something they haven't saved yet.
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(settings) ||
    !!keyInput.trim() ||
    !!searchKeyInput.trim();

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      if (isCloud && keyInput.trim()) {
        await setApiKey(provider as CloudProviderId, keyInput.trim());
        setKeyInput("");
      }
      if (searchKeyInput.trim()) {
        await setSearchKey(searchKeyInput.trim());
        setSearchKeyInput("");
      }
      onChange(draft);
      refreshKeyPresence();
      setSearchKeyPresent(hasSearchKey());
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      if (isCloud && keyInput.trim()) {
        await setApiKey(provider as CloudProviderId, keyInput.trim());
        setKeyInput("");
        refreshKeyPresence();
      }
      const p = await createProvider(draft);
      setTestMsg(await p.test());
    } catch (err) {
      setTestMsg({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const clearKey = (p: CloudProviderId) => {
    clearApiKey(p);
    refreshKeyPresence();
    setTestMsg(null);
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-app.vercel.app";

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* A plain map of the page. Novices can see at a glance that there are
          three steps plus extras, and jump straight to any of them. */}
      <nav className="glass-card p-3 flex flex-wrap items-center gap-2" aria-label="Settings sections">
        <span className="text-xs text-text-secondary px-1">On this page:</span>
        {[
          { id: "settings-provider", label: "1. Choose an AI" },
          { id: "settings-setup", label: "2. Add your key" },
          { id: "settings-sources", label: "3. Data sources" },
          { id: "settings-search", label: "4. Web search" },
          { id: "settings-data", label: "Find data" },
        ].map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => jump(x.id)}
            className="press text-xs font-medium px-2.5 py-1.5 rounded-full border border-border text-text-secondary hover:text-text-primary hover:border-accent-500/50 transition-colors"
          >
            {x.label}
          </button>
        ))}
      </nav>
      {onReplayTutorial && (
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-500/15 text-accent-400 flex items-center justify-center shrink-0">
            <Compass size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">How it works</h3>
            <p className="text-xs text-text-secondary">Replay the quick guided tour of the app.</p>
          </div>
          <button
            onClick={onReplayTutorial}
            className="shrink-0 px-3 py-2 rounded-xl text-sm font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40"
          >
            Take the tour
          </button>
        </div>
      )}

      <div className="glass-card p-4 border-l-4 border-l-accent-500">
        <h3 className="text-sm font-semibold text-text-primary mb-2">New here? It only takes three steps</h3>
        <ol className="text-sm text-text-secondary space-y-1.5">
          <li><span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-500/20 text-accent-400 text-xs font-bold mr-1.5">1</span> Pick an AI helper from the boxes below (the free ones are listed first).</li>
          <li><span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-500/20 text-accent-400 text-xs font-bold mr-1.5">2</span> Paste its key where it asks, then press <strong>Test</strong> to make sure it works.</li>
          <li><span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-500/20 text-accent-400 text-xs font-bold mr-1.5">3</span> Optionally turn on web search, then press <strong>Save</strong>. The row above jumps to any section.</li>
        </ol>
      </div>

      <div id="settings-provider" className="scroll-mt-24">
        <h2 className="text-lg font-semibold text-text-primary mb-1">
          <span className="text-accent-400">Step 1.</span> Choose your AI helpers
        </h2>
        <p className="text-sm text-text-secondary">
          Pick one or more. Each helper fills out its own copy of the scorecard, in parallel, and
          writes its own analysis, so you can compare them side by side. All AI calls run in your
          browser, and each key is sent only to its own provider, never to this site.
        </p>
        {lockReason && (
          <p role="status" className="mt-2 flex items-start gap-2 text-sm rounded-lg border border-warn-500/30 bg-warn-500/10 text-warn-400 px-3 py-2">
            <Loader2 size={15} className="animate-spin shrink-0 mt-0.5" />
            <span>{lockReason}</span>
          </p>
        )}
        {pickNote && !lockReason && <p className="mt-2 text-sm text-warn-400">{pickNote}</p>}
      </div>

      {/* Provider selection */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ORDER.map((id) => {
          const meta = PROVIDER_META[id];
          const active = picked.includes(id);
          const cloud = isCloudProvider(id);
          const keyed = cloud ? keyPresence[id] : true;
          return (
            <button
              key={id}
              role="checkbox"
              aria-checked={active}
              onClick={() => togglePick(id)}
              disabled={!!lockReason}
              title={lockReason || (active ? "Selected. Click to remove this helper." : "Click to add this helper.")}
              className={`text-left p-4 rounded-xl border transition-all ${lockReason ? "opacity-50 cursor-not-allowed" : "lift"} ${
                active
                  ? "border-accent-500/60 bg-accent-500/10"
                  : "border-border bg-surface-overlay/30 hover:border-primary-500/40"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {meta.icon}
                <span className="font-semibold text-text-primary">{meta.title}</span>
                <span aria-hidden className={`ml-auto shrink-0 w-4 h-4 rounded border grid place-items-center ${active ? "bg-accent-500 border-accent-500 text-white" : "border-border"}`}>
                  {active && <CheckCircle2 size={12} />}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 mb-1.5">
                {BEST_FOR[id] && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-accent-500/20 text-accent-300">{BEST_FOR[id]}</span>
                )}
                {TRANSPORT[id] === "direct" && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary-500/15 text-primary-300" title="Talks straight to the provider from your browser, no server time limit.">⚡ Fast &amp; reliable</span>
                )}
                {TRANSPORT[id] === "proxy" && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-warn-500/15 text-warn-400" title="Routed through the app's proxy. On free hosting this is cut off at 120 seconds, so slow models can time out.">⏳ May time out on free hosting</span>
                )}
                {TRANSPORT[id] === "local" && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary-500/15 text-primary-300" title="Runs on your own computer, effectively unlimited.">🖥️ Runs on your PC</span>
                )}
              </div>
              <p className="text-xs text-text-secondary">{meta.subtitle}</p>
              {cloud && (
                <p className={`text-[11px] mt-1.5 flex items-center gap-1 ${keyed ? "text-accent-400" : "text-text-secondary"}`}>
                  <KeyRound size={11} /> {keyed ? "Key saved" : "No key yet"}
                </p>
              )}
            </button>
          );
        })}
      </div>

      {/* Provider-specific configuration */}
      <div id="settings-setup" className="glass-card p-5 space-y-4 scroll-mt-24">
        <h2 className="text-lg font-semibold text-text-primary">
          <span className="text-accent-400">Step 2.</span> Set up {PROVIDER_META[provider].title}
        </h2>
        {picked.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Helper to set up">
            <span className="text-xs text-text-secondary mr-1">Set up:</span>
            {picked.map((p) => (
              <button key={p} type="button" role="tab" aria-selected={p === provider} onClick={() => setDraft({ ...draft, provider: p })}
                className={`text-xs px-2.5 py-1 rounded-full border ${p === provider ? "border-accent-500/60 bg-accent-500/15 text-text-primary font-medium" : "border-border text-text-secondary hover:text-text-primary"}`}>
                {PROVIDER_LABEL[p]}
                {isCloudProvider(p) && !keyPresence[p] && <span className="text-warn-400"> · no key</span>}
              </button>
            ))}
          </div>
        )}
        {TRANSPORT[provider] === "proxy" && (
          <div className="text-xs bg-warn-500/10 border border-warn-500/30 text-warn-400 rounded-lg p-2.5">
            Heads up: this provider is reached through the app&apos;s proxy, which on the free hosting plan is cut off after 120 seconds. Fast models are fine, but slow or heavy &quot;reasoning&quot; models (and long Assistant runs) can time out. If you hit timeouts, Gemini and OpenRouter run straight from your browser with no such limit.
          </div>
        )}
        {TRANSPORT[provider] === "direct" && (
          <div className="text-xs bg-accent-500/10 border border-accent-500/25 text-accent-300 rounded-lg p-2.5">
            Nice choice, this provider talks straight to its API from your browser, so there&apos;s no server time limit and it stays fast and reliable.
          </div>
        )}
        {/* Model picker */}
        <label className="block">
          <span className="text-sm text-text-primary">{provider === "azure" ? "Deployment name" : "Model"}</span>
          <input
            list="model-presets"
            value={currentModel}
            onChange={(e) => setModel(e.target.value)}
            className={`${inputCls} font-mono`}
            placeholder={provider === "azure" ? "e.g. gpt-4o (the name you gave your deployment)" : MODELS[provider][0]}
          />
          <datalist id="model-presets">
            {presets.map((m) => <option key={m} value={m} />)}
          </datalist>
          {provider === "createai" && (
            <span className="mt-1.5 block">
              <button type="button" onClick={() => void loadCreateAIModels()} disabled={caiLoading}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-border text-text-primary hover:border-accent-500/50 disabled:opacity-50">
                {caiLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {caiModels ? "Reload my models" : "Load my models"}
              </button>
              {caiError && <span className="ml-2 text-xs text-danger-400">{caiError}</span>}
              {caiModels && (
                <span className="mt-2 block max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                  {caiModels.map((m) => (
                    <button key={m.id} type="button" onClick={() => setModel(m.id)}
                      className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs ${m.id === currentModel ? "bg-accent-500/15 text-text-primary" : "text-text-secondary hover:bg-surface-overlay/60"}`}>
                      <span className="min-w-0 truncate"><span className="text-text-primary">{m.name}</span> <code className="font-mono">{m.id}</code></span>
                      <span className="shrink-0 tabular-nums">
                        {Number.isFinite(m.inPerM) ? `$${m.inPerM.toFixed(2)} in · $${m.outPerM.toFixed(2)} out per 1M tokens` : "price not listed"}
                      </span>
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
          <span className="text-xs text-text-secondary">
            {provider === "lmstudio"
              ? "Should match a model loaded in LM Studio (it also uses the loaded model if unsure)."
              : provider === "azure"
              ? "The deployment name from your Azure resource (not the base model name), unless they match."
              : "Pick a preset or type any model id the provider supports."}
          </span>
          {provider === "azure" && (
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className="text-sm text-text-primary">Azure endpoint</span>
                <input
                  value={draft.azureEndpoint}
                  onChange={(e) => setDraft({ ...draft, azureEndpoint: e.target.value })}
                  className={`${inputCls} font-mono`}
                  placeholder="https://your-resource.openai.azure.com"
                />
                <span className="text-xs text-text-secondary">From the Azure portal, your resource&apos;s &quot;Keys and Endpoint&quot; page.</span>
              </label>
              <label className="block">
                <span className="text-sm text-text-primary">API version</span>
                <input
                  value={draft.azureApiVersion}
                  onChange={(e) => setDraft({ ...draft, azureApiVersion: e.target.value })}
                  className={`${inputCls} font-mono`}
                  placeholder="2024-10-21"
                />
                <span className="text-xs text-text-secondary">Leave the default unless Azure tells you otherwise.</span>
              </label>
            </div>
          )}
          {RECOMMENDED_MODEL[provider] && (
            <span className="text-xs text-text-secondary mt-1 flex flex-wrap items-center gap-1.5">
              Recommended: <code className="font-mono text-primary-300">{RECOMMENDED_MODEL[provider]}</code>
              {currentModel !== RECOMMENDED_MODEL[provider] && (
                <button type="button" onClick={() => setModel(RECOMMENDED_MODEL[provider]!)}
                  className="underline text-primary-300 hover:text-primary-200">use this</button>
              )}
            </span>
          )}
          {provider === "gemini" && (
            <span className="text-xs mt-1.5 block bg-warn-500/10 border border-warn-500/30 text-warn-400 rounded-lg p-2.5">
              Heads up: Gemini&apos;s free tier is tightly rate-limited, so the Assistant&apos;s
              &quot;Fill it out for me&quot; (which makes many calls in a row) often stops partway.
              It&apos;s fine for the Analysis tab. For filling out a whole scorecard,
              OpenRouter or NVIDIA NIM (both free) tend to work more reliably.
            </span>
          )}
        </label>

        {/* Cloud: API key */}
        {isCloud && (
          <label className="block">
            <span className="text-sm text-text-primary flex items-center gap-1.5">
              <KeyRound size={13} /> API key
            </span>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder={
                keyPresence[provider]
                  ? "A key is saved, type to replace it, or leave blank to keep"
                  : provider === "claude" ? "sk-ant-…"
                  : provider === "openrouter" ? "sk-or-…"
                  : provider === "openai" ? "sk-…"
                  : provider === "xai" ? "xai-…"
                  : provider === "nvidia" ? "nvapi-…"
                  : provider === "zai" ? "your z.AI key"
                  : provider === "meta" ? "LLM|… (Meta API key)"
                  : provider === "azure" ? "your Azure OpenAI key (Key 1 or Key 2)"
                  : provider === "createai" ? "your CreateAI project API key"
                  : "AIza…"
              }
            />
            <span className="text-xs text-text-secondary">
              Encrypted in this browser (AES-GCM). {provider === "createai" ? "Request a project key at" : "Get a free key at"}{" "}
              {provider === "gemini" && (
                <a className="text-primary-300 underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>
              )}
              {provider === "openrouter" && (
                <a className="text-primary-300 underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>
              )}
              {provider === "claude" && (
                <a className="text-primary-300 underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>
              )}
              {provider === "openai" && (
                <a className="text-primary-300 underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com</a>
              )}
              {provider === "xai" && (
                <a className="text-primary-300 underline" href="https://console.x.ai" target="_blank" rel="noreferrer">console.x.ai</a>
              )}
              {provider === "zai" && (
                <a className="text-primary-300 underline" href="https://z.ai/manage-apikey/apikey-list" target="_blank" rel="noreferrer">z.ai</a>
              )}
              {provider === "nvidia" && (
                <a className="text-primary-300 underline" href="https://build.nvidia.com" target="_blank" rel="noreferrer">build.nvidia.com</a>
              )}
              {provider === "meta" && (
                <a className="text-primary-300 underline" href="https://llama.developer.meta.com" target="_blank" rel="noreferrer">llama.developer.meta.com</a>
              )}
              {provider === "azure" && (
                <a className="text-primary-300 underline" href="https://portal.azure.com" target="_blank" rel="noreferrer">portal.azure.com</a>
              )}
              {provider === "perplexity" && (
                <a className="text-primary-300 underline" href="https://www.perplexity.ai/account/api/keys" target="_blank" rel="noreferrer">perplexity.ai/account/api/keys</a>
              )}
              {provider === "createai" && (
                <a className="text-primary-300 underline" href="https://platform.aiml.asu.edu" target="_blank" rel="noreferrer">platform.aiml.asu.edu</a>
              )}
              .
            </span>
            {provider === "nvidia" && (
              <span className="text-xs text-text-secondary block mt-1.5 bg-surface-overlay/40 border border-border rounded-lg p-2.5">
                Getting an NVIDIA key takes a few steps, here&apos;s the short version:
                1) go to build.nvidia.com and sign in (or make a free NVIDIA account);
                2) open any model, for example GLM 5.2;
                3) click &quot;Get API Key&quot; / &quot;Build with this NIM&quot; on the right;
                4) copy the key (it starts with <code className="font-mono">nvapi-</code>) and paste it below.
                The free tier includes generous credits. Just remember GLM 5.2 is very smart but,
                because NVIDIA runs through the proxy, it can time out on the free hosting plan for long tasks.
              </span>
            )}
            {provider === "perplexity" && (
              <span className="text-xs text-text-secondary block mt-1.5 bg-surface-overlay/40 border border-border rounded-lg p-2.5">
                Perplexity&apos;s Sonar models search the web as they answer and return citations, which makes them a strong fit for the Assistant&apos;s research. Sign in at perplexity.ai, open Settings, go to the API tab, add a little credit, and generate a key (starts with <code className="font-mono">pplx-</code>). &quot;sonar&quot; is a good default; &quot;sonar-pro&quot; is deeper.
              </span>
            )}
            {provider === "createai" && (
              <span className="text-xs text-text-secondary block mt-1.5 bg-surface-overlay/40 border border-border rounded-lg p-2.5 space-y-1">
                <span className="block">
                  Use the key from your CreateAI project (platform.aiml.asu.edu → your project → Behaviors → Project API Keys).
                  It only works here, under ASU CreateAI, not under Claude, Gemini or OpenAI, even for their models.
                </span>
                <span className="block">
                  A project &quot;Service&quot; key may answer with the model set on your project&apos;s Basic tab whatever model you pick here;
                  Test connection tells you which model actually answered. Every call counts against your project&apos;s monthly budget
                  (shown by Test connection), and filling a whole scorecard makes many calls, so a cheap, fast model is a good choice.
                </span>
                <span className="block text-warn-400">
                  ASU advises keeping Service keys out of apps that run in a browser. Here it&apos;s stored encrypted on this computer and sent only through this app&apos;s own server, which is fine for local development; don&apos;t enter it on a shared or public deployment.
                </span>
              </span>
            )}
            {provider === "azure" && (
              <span className="text-xs text-text-secondary block mt-1.5 bg-surface-overlay/40 border border-border rounded-lg p-2.5">
                This is Microsoft Azure OpenAI, the same technology behind Microsoft Copilot and the way Microsoft hands out an actual API key. In the Azure portal, open your Azure OpenAI resource, copy the Endpoint and one of the Keys from &quot;Keys and Endpoint,&quot; and enter the name of the model deployment you created above. Note: consumer Copilot and Microsoft 365 Copilot do not provide a plain API key, so they cannot be used here.
              </span>
            )}
            {(provider === "openai" || provider === "xai" || provider === "zai" || provider === "nvidia" || provider === "meta") && (
              <span className="text-xs text-text-secondary block mt-1.5 bg-surface-overlay/40 border border-border rounded-lg p-2.5">
                These providers block direct browser calls, so requests go through
                your own app&apos;s server (your key is used once and never stored there).
                Very slow reasoning models may hit Vercel&apos;s 120s limit on the free
                plan, if so, pick a faster model or use Vercel Pro.
                {provider === "nvidia" && " NVIDIA NIM is free (1,000 credits) and includes Llama, DeepSeek, Kimi and GLM."}
                {provider === "meta" && " Meta's direct API is experimental here; Llama also runs free on NVIDIA NIM."}
              </span>
            )}
            {keyPresence[provider] && (
              <button
                onClick={() => clearKey(provider as CloudProviderId)}
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-danger-400 hover:text-danger-500"
              >
                <Trash2 size={12} /> Remove saved key
              </button>
            )}
          </label>
        )}

        {/* Local: base URL + setup help */}
        {isLocal && (
          <>
            <div className="text-xs text-warn-400 bg-warn-500/10 border border-warn-500/20 rounded-lg p-3">
              <strong>On a phone or tablet?</strong> Local models won&apos;t work, the browser can
              only reach a model server running on the same computer. On mobile, pick a cloud
              provider (Gemini, OpenRouter or Claude) instead.
            </div>
            <label className="block">
              <span className="text-sm text-text-primary">Local server address</span>
              <input
                value={currentBase}
                onChange={(e) => setBase(e.target.value)}
                className={inputCls}
                placeholder={provider === "lmstudio" ? "http://127.0.0.1:1234/v1" : "http://127.0.0.1:11434"}
              />
            </label>
            {provider === "lmstudio" ? (
              <div className="text-xs text-text-secondary bg-surface-overlay/40 border border-border rounded-lg p-3 space-y-1">
                <p className="text-text-primary font-medium">LM Studio setup</p>
                <p>1. In LM Studio, load a model (the little chat icon).</p>
                <p>2. Open the <span className="text-primary-300">Developer</span> tab → <span className="text-primary-300">Start Server</span> (default port 1234). CORS is on by default.</p>
                <p>3. Keep the address as <code className="text-primary-300">http://127.0.0.1:1234/v1</code>, then hit Test.</p>
              </div>
            ) : (
              <div className="text-xs text-text-secondary bg-surface-overlay/40 border border-border rounded-lg p-3 space-y-1">
                <p className="text-text-primary font-medium">Ollama setup (one-time)</p>
                <p>1. Pull a model: <code className="text-primary-300">ollama pull {draft.ollamaModel || "qwen2.5:3b"}</code></p>
                <p>2. Allow this site to reach it:</p>
                <p><code className="text-primary-300">OLLAMA_ORIGINS=&quot;{origin}&quot; ollama serve</code></p>
                <p className="text-warn-400">Note: on newer Chrome, a hosted (https) site reaching localhost may need the Local Network Access permission prompt to be allowed. LM Studio is often smoother.</p>
              </div>
            )}
          </>
        )}

        {/* Web research toggle */}
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setDraft({ ...draft, webSearch: !draft.webSearch })}
            className="w-full flex items-start gap-3 text-left"
          >
            <span
              className={`mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                draft.webSearch ? "bg-accent-500" : "bg-surface-overlay border border-border"
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                  draft.webSearch ? "left-[18px]" : "left-0.5"
                }`}
              />
            </span>
            <span>
              <span className="text-sm text-text-primary flex items-center gap-1.5">
                <Globe size={14} className="text-accent-400" /> Let the AI model search the web itself
              </span>
              <span className="text-xs text-text-secondary block mt-0.5">
                {isCloud
                  ? "Separate from the research step below: the model itself runs live web searches via its provider (Gemini, Claude, OpenRouter) to verify facts and cite sources, then still receives the research context. If a search-enabled run fails, it automatically retries without it."
                  : "Local models can't browse the web, this applies to cloud providers. Either way, every analysis gets the server-side research context (Wikipedia + web search) below."}
              </span>
              {provider === "openrouter" && (
                <span className="text-xs text-warn-400 block mt-1">
                  {/:free$/.test(draft.openrouterModel)
                    ? "OpenRouter charges for its web search even on free models, so it's skipped for this :free model to keep it free. The app's own free research still runs."
                    : "OpenRouter charges about $0.007 per request for its web search, on top of the model's own price."}
                </span>
              )}
            </span>
          </button>
        </div>

        {/* Educated guesses (applies to every helper) */}
        <div className="pt-1">
          <button
            type="button"
            role="switch"
            aria-checked={draft.allowGuesses}
            onClick={() => setDraft({ ...draft, allowGuesses: !draft.allowGuesses })}
            className="w-full flex items-start gap-3 text-left"
          >
            <span
              className={`mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                draft.allowGuesses ? "bg-warn-500" : "bg-surface-overlay border border-border"
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                  draft.allowGuesses ? "left-[18px]" : "left-0.5"
                }`}
              />
            </span>
            <span>
              <span className="text-sm text-text-primary flex items-center gap-1.5">
                <Lightbulb size={14} className="text-warn-400" /> Let the AI make educated guesses
              </span>
              <span className="text-xs text-text-secondary block mt-0.5">
                {draft.allowGuesses
                  ? "On: when nothing supports an answer (no source, none of your data sources, and nothing the AI knows), the AI may make an educated guess. Those answers are labelled \"AI's educated guess\" on the Scorecard so you can check them."
                  : "Off: every answer must rest on a source, one of your data sources, or the AI's general knowledge. When none of these supports an answer, it is left blank with the reason, instead of guessed."}
                {" "}Applies to every AI helper.
              </span>
            </span>
          </button>
        </div>

        {/* Test connection */}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={runTest}
            disabled={testing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-border text-text-primary hover:border-accent-500/50 transition-all disabled:opacity-50"
          >
            {testing ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />}
            Test connection
          </button>
          {testMsg && (
            <span className={`flex items-center gap-1.5 text-sm ${testMsg.ok ? "text-accent-400" : "text-danger-400"}`}>
              {testMsg.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {testMsg.message}
            </span>
          )}
        </div>
      </div>

      {/* Optional data sources for the AI to prefer */}
      <DataSourcePicker
        selected={draft.dataSources || []}
        onChange={(ids) => setDraft({ ...draft, dataSources: ids })}
      />

      {/* Web search (optional Tavily, keyless by default) */}
      <div id="settings-search" className="glass-card p-5 space-y-4 scroll-mt-24">
        <div>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <span className="text-accent-400">Step 4.</span> <Search size={17} className="text-accent-400" /> Web search <span className="text-xs font-normal text-text-secondary">(optional)</span>
          </h2>
          <p className="text-sm text-text-secondary mt-1">
            The tool always checks your city against Wikipedia for free, so the AI works from real
            facts. You can also switch on Tavily for richer live web results.
          </p>
        </div>

        {(() => {
          const tavilyReady = searchKeyPresent || searchKeyInput.trim().length > 0;
          const on = draft.useTavily && tavilyReady;
          return (
            <button
              type="button"
              disabled={!tavilyReady}
              onClick={() => setDraft({ ...draft, useTavily: !draft.useTavily })}
              className={`w-full flex items-center gap-3 text-left ${tavilyReady ? "" : "opacity-60 cursor-not-allowed"}`}
            >
              <span
                className={`shrink-0 w-11 h-6 rounded-full relative ${
                  on ? "bg-accent-500" : "bg-surface-overlay border border-border"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                    on ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </span>
              <span>
                <span className="text-base font-semibold text-text-primary block">
                  Use Tavily for web search
                </span>
                <span className="text-sm text-text-secondary block">
                  {tavilyReady
                    ? on
                      ? "On. Tavily runs the live web search."
                      : "Off. Live web search uses the free DuckDuckGo option."
                    : "Add a Tavily key below to switch this on."}
                </span>
              </span>
            </button>
          );
        })()}

        <label className="block">
          <span className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
            <KeyRound size={14} /> Tavily key
            <span className="text-text-secondary font-normal">(optional, free)</span>
          </span>
          <input
            type="password"
            value={searchKeyInput}
            onChange={(e) => setSearchKeyInput(e.target.value)}
            className={`${inputCls} font-mono`}
            placeholder={searchKeyPresent ? "Key saved. Type to replace it, or leave blank." : "tvly-..."}
          />
          <span className="text-xs text-text-secondary mt-1 block">
            Get a free key at{" "}
            <a className="text-primary-300 underline" href="https://app.tavily.com/home" target="_blank" rel="noreferrer">app.tavily.com</a>
            {" "}(sign up, then copy the key from your dashboard, it starts with <code className="font-mono">tvly-</code>).
          </span>
          {searchKeyPresent && (
            <button
              onClick={() => { clearSearchKey(); setSearchKeyPresent(false); setDraft({ ...draft, useTavily: false }); }}
              className="mt-2 inline-flex items-center gap-1.5 text-sm text-danger-400 hover:text-danger-500"
            >
              <Trash2 size={13} /> Remove saved key
            </button>
          )}
        </label>

        <details className="text-sm text-text-secondary">
          <summary className="cursor-pointer font-semibold text-text-primary select-none">
            How web search works
          </summary>
          <div className="mt-2 space-y-2 leading-relaxed">
            <p>
              Wikipedia and Wikidata always run for free, and give the AI the city overview plus
              population and area. On top of that, one live web search runs each time.
            </p>
            <p>
              If Tavily is switched on, it does that search. Otherwise the tool uses free DuckDuckGo.
              Only one of them runs, so turning Tavily on simply replaces DuckDuckGo.
            </p>
            <p>
              Prefer to set it up once for everyone? Add{" "}
              <code className="text-primary-300">TAVILY_API_KEY</code>, or point{" "}
              <code className="text-primary-300">SEARXNG_URL</code> at your own{" "}
              <a className="text-primary-300 underline" href="https://searxng.org" target="_blank" rel="noreferrer">SearXNG</a>{" "}
              server, in your Vercel settings. Your key is encrypted in this browser and only sent to
              your own app to run the search.
            </p>
          </div>
        </details>
      </div>

      {/* Save, sticks to the bottom of the screen so it's always in view and
          nudges you when you've changed something but haven't saved it. */}
      <div className="sticky bottom-3 z-20 pt-1">
        <div
          className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur transition-colors ${
            dirty
              ? "bg-accent-500/10 border-accent-500/40"
              : "bg-surface/90 border-border"
          }`}
        >
          <span className="text-sm flex items-center gap-2 min-w-0">
            {saved ? (
              <span className="flex items-center gap-1.5 text-accent-400 font-medium">
                <CheckCircle2 size={16} /> Saved
              </span>
            ) : dirty ? (
              <span className="text-text-primary font-medium truncate">
                You have changes that aren&apos;t saved yet
              </span>
            ) : (
              <span className="text-text-secondary truncate">Everything here is saved</span>
            )}
          </span>
          <button
            onClick={save}
            disabled={saving || (!dirty && !saved)}
            className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold btn-accent transition-all active:scale-95 disabled:opacity-40"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      {/* Pointer to the full data-source directory (its own page) */}
      <div id="settings-data" className="glass-card p-5 flex items-center gap-3 flex-wrap scroll-mt-24">
        <span className="grid place-items-center w-10 h-10 rounded-xl bg-accent-500/15 text-accent-300 shrink-0">
          <BookCheck size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-text-primary">Looking for real data to back up a scorecard?</h2>
          <p className="text-sm text-text-secondary">Browse a directory of free, credible sources (UN, World Bank, NASA and more), then paste what you find into the advisor or the Assistant.</p>
        </div>
        <a href="/data-sources" target="_blank" rel="noreferrer" className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent lift">
          <Globe size={15} /> Find data
        </a>
      </div>

      {/* Sentinel kept for spacing at the very bottom. */}
      <div aria-hidden="true" className="h-1" />

    </div>
  );
}
