"use client";

/**
 * Settings — choose which AI writes the analysis and configure it. Everything
 * here is stored in THIS browser only: plain settings in localStorage, and API
 * keys encrypted with a device key (WebCrypto AES-GCM). Nothing is ever sent to
 * our server or stored in the repo.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  Cloud, Cpu, Sparkles, Boxes, MonitorSmartphone, Save, Loader2,
  CheckCircle2, XCircle, KeyRound, Trash2, Plug,
} from "lucide-react";
import {
  type AppSettings, type ProviderId, type CloudProviderId,
  setApiKey, hasApiKey, clearApiKey, isCloudProvider,
} from "@/lib/settings/store";
import { createProvider } from "@/lib/llm";

const MODELS: Record<ProviderId, string[]> = {
  gemini: ["gemini-2.0-flash", "gemini-3.5-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro"],
  openrouter: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemini-2.0-flash-exp:free",
    "deepseek/deepseek-chat:free",
    "mistralai/mistral-7b-instruct:free",
  ],
  claude: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-5"],
  lmstudio: ["local-model", "qwen2.5-7b-instruct", "llama-3.2-3b-instruct"],
  ollama: ["llama3.1:8b", "llama3.2", "qwen2.5", "mistral"],
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

// Display order — cloud first (the friction-free path), then local.
const ORDER: ProviderId[] = ["gemini", "openrouter", "claude", "lmstudio", "ollama"];

const inputCls =
  "mt-1 w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm text-text-primary focus:border-accent-500/60 outline-none";

export function SettingsTab({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [keyInput, setKeyInput] = useState("");
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => setDraft(settings), [settings]);

  const refreshKeyPresence = () => {
    setKeyPresence({
      gemini: hasApiKey("gemini"),
      openrouter: hasApiKey("openrouter"),
      claude: hasApiKey("claude"),
    });
  };
  useEffect(() => { refreshKeyPresence(); }, []);
  useEffect(() => { setKeyInput(""); setTestMsg(null); }, [draft.provider]);

  const provider = draft.provider;
  const isCloud = isCloudProvider(provider);
  const isLocal = !isCloud;

  const modelField =
    provider === "claude" ? "claudeModel"
    : provider === "gemini" ? "geminiModel"
    : provider === "openrouter" ? "openrouterModel"
    : provider === "lmstudio" ? "lmstudioModel"
    : "ollamaModel";
  const currentModel = draft[modelField] as string;
  const setModel = (value: string) => setDraft({ ...draft, [modelField]: value } as AppSettings);

  const baseField = provider === "lmstudio" ? "lmstudioBaseUrl" : "ollamaBaseUrl";
  const currentBase = draft[baseField] as string;
  const setBase = (value: string) => setDraft({ ...draft, [baseField]: value } as AppSettings);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      if (isCloud && keyInput.trim()) {
        await setApiKey(provider as CloudProviderId, keyInput.trim());
        setKeyInput("");
      }
      onChange(draft);
      refreshKeyPresence();
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
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-1">AI provider</h2>
        <p className="text-sm text-text-secondary">
          Choose who writes the analysis. All AI calls run in your browser — your key is sent
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
              className={`text-left p-4 rounded-xl border transition-all ${
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
        {/* Model picker */}
        <label className="block">
          <span className="text-sm text-text-primary">Model</span>
          <input
            list="model-presets"
            value={currentModel}
            onChange={(e) => setModel(e.target.value)}
            className={`${inputCls} font-mono`}
            placeholder={MODELS[provider][0]}
          />
          <datalist id="model-presets">
            {MODELS[provider].map((m) => <option key={m} value={m} />)}
          </datalist>
          <span className="text-xs text-text-secondary">
            {provider === "lmstudio"
              ? "Should match a model loaded in LM Studio (it also uses the loaded model if unsure)."
              : "Pick a preset or type any model id the provider supports."}
          </span>
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
                  ? "A key is saved — type to replace it, or leave blank to keep"
                  : provider === "claude" ? "sk-ant-…"
                  : provider === "openrouter" ? "sk-or-…"
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
              .
            </span>
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

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-accent-500 to-accent-400 text-surface hover:from-accent-400 hover:to-accent-500 transition-all active:scale-95 disabled:opacity-50"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Save settings
        </button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-accent-400">
            <CheckCircle2 size={15} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
