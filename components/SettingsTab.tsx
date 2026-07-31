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
  CheckCircle2, XCircle, KeyRound, Trash2, Plug, Globe, Search, Compass, ArrowDown, BookCheck,
} from "lucide-react";
import {
  type AppSettings, type ProviderId, type CloudProviderId,
  setApiKey, hasApiKey, clearApiKey, isCloudProvider,
  setSearchKey, hasSearchKey, clearSearchKey,
} from "@/lib/settings/store";
import { createProvider } from "@/lib/llm";

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
  lmstudio: ["local-model", "qwen2.5-7b-instruct", "llama-3.2-3b-instruct"],
  ollama: ["llama3.1:8b", "llama3.2", "qwen2.5", "mistral"],
};

// The single model we recommend per provider (shown as "recommended").
const RECOMMENDED_MODEL: Partial<Record<ProviderId, string>> = {
  gemini: "gemini-3.6-flash",
  nvidia: "z-ai/glm-5.2",
  openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
  perplexity: "sonar",
};

// How each provider actually reaches its API. "direct" = straight from the
// browser (fast, no server time limit). "proxy" = through our /api/llm route,
// which on Vercel's free plan is cut off at 120s, so slow/"reasoning" models can
// time out. "local" = runs on the visitor's own machine.
const TRANSPORT: Record<ProviderId, "direct" | "proxy" | "local"> = {
  gemini: "direct", openrouter: "direct", claude: "direct",
  openai: "proxy", xai: "proxy", zai: "proxy", nvidia: "proxy", meta: "proxy", azure: "proxy", perplexity: "proxy",
  lmstudio: "local", ollama: "local",
};

// Short "what's this good for" tags shown on the provider tiles.
const BEST_FOR: Partial<Record<ProviderId, string>> = {
  gemini: "Best for the Dashboard analysis",
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
const ORDER: ProviderId[] = ["gemini", "openrouter", "nvidia", "perplexity", "zai", "claude", "openai", "xai", "meta", "azure", "lmstudio", "ollama"];

const inputCls =
  "mt-1 w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm text-text-primary focus:border-accent-500/60 outline-none";

export function SettingsTab({
  settings,
  onChange,
  onReplayTutorial,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onReplayTutorial?: () => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [keyInput, setKeyInput] = useState("");
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [searchKeyInput, setSearchKeyInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  // Show a friendly "more below" pointer whenever the end of the settings page
  // is off-screen, so novice users always know there's more to scroll to.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => setMoreBelow(!entries[0].isIntersecting),
      { rootMargin: "0px 0px -40px 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
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
    });
  };
  useEffect(() => { refreshKeyPresence(); setSearchKeyPresent(hasSearchKey()); }, []);
  useEffect(() => { setKeyInput(""); setTestMsg(null); }, [draft.provider]);

  const provider = draft.provider;
  const isCloud = isCloudProvider(provider);
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
    : provider === "lmstudio" ? "lmstudioModel"
    : "ollamaModel";
  const currentModel = draft[modelField] as string;
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

  return (
    <div className="max-w-2xl mx-auto space-y-6">
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
          <li><span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-500/20 text-accent-400 text-xs font-bold mr-1.5">3</span> Scroll down for optional web search and other settings, then press <strong>Save</strong>.</li>
        </ol>
        <p className="text-xs text-text-secondary mt-2.5">Keep scrolling, there is more further down the page than fits on one screen.</p>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-1">
          <span className="text-accent-400">Step 1.</span> Choose your AI helper
        </h2>
        <p className="text-sm text-text-secondary">
          This is who writes the analysis. All AI calls run in your browser, your key is sent
          only to the provider you pick, never to this site.
        </p>
      </div>

      {/* Provider selection */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ORDER.map((id) => {
          const meta = PROVIDER_META[id];
          const active = provider === id;
          const cloud = isCloudProvider(id);
          const keyed = cloud ? keyPresence[id] : true;
          return (
            <button
              key={id}
              onClick={() => setDraft({ ...draft, provider: id })}
              className={`text-left p-4 rounded-xl border transition-all lift ${
                active
                  ? "border-accent-500/60 bg-accent-500/10"
                  : "border-border bg-surface-overlay/30 hover:border-primary-500/40"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {meta.icon}
                <span className="font-semibold text-text-primary">{meta.title}</span>
                {active && <CheckCircle2 size={15} className="text-accent-400 ml-auto" />}
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
      <div className="glass-card p-5 space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">
          <span className="text-accent-400">Step 2.</span> Set up {PROVIDER_META[provider].title}
        </h2>
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
            {MODELS[provider].map((m) => <option key={m} value={m} />)}
          </datalist>
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
              It&apos;s fine for the Dashboard analysis. For filling out a whole scorecard,
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
                  : "AIza…"
              }
            />
            <span className="text-xs text-text-secondary">
              Encrypted in this browser (AES-GCM). Get a free key at{" "}
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
                <p>1. Pull a model: <code className="text-primary-300">ollama pull {draft.ollamaModel || "llama3.1:8b"}</code></p>
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

      {/* Web search (optional Tavily, keyless by default) */}
      <div className="glass-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <span className="text-accent-400">Step 3.</span> <Search size={17} className="text-accent-400" /> Web search <span className="text-xs font-normal text-text-secondary">(optional)</span>
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
      <div className="glass-card p-5 flex items-center gap-3 flex-wrap">
        <span className="grid place-items-center w-10 h-10 rounded-xl bg-accent-500/15 text-accent-300 shrink-0">
          <BookCheck size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-text-primary">Looking for real data to back up a scorecard?</h2>
          <p className="text-sm text-text-secondary">Browse a directory of free, credible sources (UN, World Bank, NASA and more), then paste what you find into the copilot or Assistant.</p>
        </div>
        <a href="/data-sources" target="_blank" rel="noreferrer" className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold btn-accent lift">
          <Globe size={15} /> Find data
        </a>
      </div>

      {/* Sentinel: when this is off-screen we show the "more below" pointer. */}
      <div ref={bottomRef} aria-hidden="true" className="h-1" />

      {moreBelow && (
        <button
          type="button"
          onClick={() => window.scrollBy({ top: Math.round(window.innerHeight * 0.7), behavior: "smooth" })}
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold bg-accent-500 text-white shadow-lg shadow-accent-500/30 animate-bounce"
          aria-label="Scroll down to see more settings"
        >
          <ArrowDown size={16} /> More settings below
        </button>
      )}
    </div>
  );
}
