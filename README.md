# UNDRR ARISE Scorecard Analyzer

Analyze a city's **UNDRR Disaster Resilience Scorecard** and generate a grounded,
prioritized action plan — entirely from a web browser. No terminals, no local
servers, no subscriptions.

It is a single **Next.js** app deployed on **Vercel**. Upload a completed
scorecard (`.xlsm`/`.xlsx`), the app pulls free open data about the city
(climate, infrastructure, seismic history, national indicators, recent
disasters), and an AI provider of your choice writes a plain-language summary,
strengths/weaknesses, an impact-vs-difficulty matrix, a costed action plan, and
a projected score.

> **Decision-support tool.** Outputs are illustrative and AI-generated. All
> recommendations require review by qualified disaster-resilience professionals
> before implementation.

---

## For the non-technical user (e.g. trying it out)

1. Open the app's URL in a browser.
2. Click **Settings** and pick an AI provider. The easiest free options:
   - **Gemini (Google AI Studio)** — get a free key at
     <https://aistudio.google.com/apikey>, paste it in, click **Test connection**.
   - **OpenRouter (free models)** — get a free key at
     <https://openrouter.ai/keys>; the default model id ends in `:free`.
   - **Claude (Anthropic)** — highest quality; needs a paid key from
     <https://console.anthropic.com>.
   - **Local (Ollama)** — free & private, runs on your own machine (see below).
3. Go back to **Dashboard**, drag your completed scorecard onto the upload box.
4. Click **Run Analysis** and watch the steps run. Read the results.

Your API key is **encrypted and stored only in your browser** (WebCrypto
AES-GCM, with a non-extractable device key in IndexedDB). It is never sent to
this site's server and never stored in the code. Keys must be re-entered on a
new browser or device — that is the intended trade-off for "never stored on a
server."

---

## Deploy your own (one click, free)

1. Push this repository to GitHub.
2. In [Vercel](https://vercel.com), **New Project → Import** the repo. Framework
   is auto-detected as **Next.js**. No environment variables are required.
3. Click **Deploy**. When it finishes you'll get a URL like
   `https://your-app.vercel.app`. Share it.

There are **no server secrets** — nothing to configure in env vars. All AI calls
happen in the visitor's browser using the key they paste into Settings.

Local development:

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

Requires Node 18.18+.

---

## AI providers (all run in the browser)

| Provider   | Cost                | Key needed | Notes                                             |
|------------|---------------------|------------|---------------------------------------------------|
| Gemini     | Free tier           | Yes        | Google AI Studio, CORS-enabled, fast.             |
| OpenRouter | Free models (`:free`)| Yes       | OpenAI-compatible, many free open models.         |
| NVIDIA NIM | Free (1,000 credits)| Yes        | 100+ open models: Llama, DeepSeek, Kimi, GLM.     |
| z.AI       | Free flash + paid   | Yes        | GLM 5.2 / 5.1 / 4.7; two flash models are free.   |
| Claude     | Paid                | Yes        | Anthropic; uses official direct-browser-access.   |
| OpenAI     | Paid                | Yes        | GPT-5.5 and the GPT-5 family.                     |
| xAI        | Paid                | Yes        | Grok 4.3 and fast Grok models.                    |
| Meta       | Paid (experimental) | Yes        | Llama 4 via Meta's API. Llama is also free on NIM.|
| LM Studio  | Free & private      | No         | Local, OpenAI-compatible, CORS on by default — usually the smoothest local option. |
| Ollama     | Free & private      | No         | Local; needs `OLLAMA_ORIGINS` set to your site.   |

Gemini, OpenRouter, Claude, and the local options run fully in the browser, so
keys never touch any server and long streams don't hit a serverless timeout.
OpenAI, xAI, z.AI, NVIDIA NIM, and Meta block direct browser calls, so those go
through a thin same-origin proxy route (`/api/llm`) on your own app: the key is
used once per request and never stored or logged. Reasoning ("thinking") models
are handled uniformly, their chain-of-thought streams to the live view while
only the final answer is parsed, so there's no empty-answer bug.

> Proxy note: on the Vercel free plan a request can run up to 60s, so a very
> slow reasoning model routed through the proxy could be cut off. Pick a faster
> model, or use Vercel Pro (up to 300s), for heavy reasoning workloads.

### Using local models

Two local options — both keep the model on your own machine, free and private:

**LM Studio (recommended, easiest).** In LM Studio: load a model, open the **Developer** tab, and **Start Server** (default port 1234). CORS is on by default, so it typically works from the hosted site with no extra flags. In **Settings**, choose **Local (LM Studio)**, leave the address as `http://127.0.0.1:1234/v1`, and click **Test connection**.

**Ollama.** For the website (a different origin) to be allowed to call Ollama, start it with your app's address allowed:

```bash
ollama pull llama3.1:8b
OLLAMA_ORIGINS="https://your-app.vercel.app" ollama serve
```

Then in **Settings**, choose **Local (Ollama)**, set the model + address (`http://127.0.0.1:11434`), and click **Test connection**.

> Note: on newer Chrome (142+), a hosted **https** site reaching `localhost` triggers a Local Network Access permission prompt — allow it when asked. If it's blocked, run the app locally (`npm run dev`, open `http://localhost:3000`) for a friction-free local-model experience.

---

## MCP endpoint (for Claude Desktop / other MCP clients)

The app exposes its open-data engine over the **Model Context Protocol**
(Streamable HTTP) at:

```
https://your-app.vercel.app/api/mcp
```

Tools:

- `list_sources` — list every open-data source the engine can query.
- `fetch_location_data` — geocode a city and return a full, provenance-tagged
  evidence bundle (climate, infrastructure, seismic history, national
  indicators, recent disasters).

Example Claude Desktop config entry:

```json
{
  "mcpServers": {
    "undrr-arise": {
      "type": "streamable-http",
      "url": "https://your-app.vercel.app/api/mcp"
    }
  }
}
```

---

## How it works

```
app/
  page.tsx                      Main app (Dashboard + Settings tabs)
  layout.tsx, globals.css
  api/
    health/route.ts             Health + list of data sources
    scorecard/parse/route.ts    .xlsm upload → parsed scorecard JSON (stateless)
    data/fetch/route.ts         Run all data adapters for a city → evidence bundle
    mcp/[transport]/route.ts    MCP server (JSON-RPC over Streamable HTTP)
components/                     UI (upload, radar, action plan, matrix, settings, …)
lib/
  scorecard/                    parseXlsm.ts, schema.ts
  data/adapters/                geocode, openMeteo, overpassOsm, usgs, worldBank,
                                reliefWeb, configSources (+ data-sources.json), registry
  analysis/                     prompt.ts, schema.ts, analyze.ts (client orchestrator)
  llm/                          claude, gemini, openrouter, ollama (one streaming interface)
  settings/                     crypto.ts (encrypted keys), store.ts
  client/                       api.ts (calls the two stateless routes)
```

- **Stateless server.** The server holds nothing between requests. The parse
  route returns JSON; the client keeps all state (React + localStorage).
- **Data fetch runs server-side** so open APIs that dislike browser CORS
  (Nominatim, Overpass) work and we can send polite, rate-limit-friendly
  requests. Each source fails independently — one bad source never stops the
  rest.
- **Add a data source without code:** edit `lib/data/adapters/data-sources.json`.
  A "simple" source is one URL plus which fields to pick out of the JSON.

### Adding a REST data source (no code)

Append an object to `lib/data/adapters/data-sources.json`:

```json
{
  "id": "my_source",
  "name": "My Source",
  "enabled": true,
  "needs": ["country_code"],
  "url": "https://api.example.com/{country_code}",
  "dataset": "Example API",
  "records_path": "0",
  "mode": "fields",
  "fields": [
    { "key": "some_value", "label": "Some value", "path": "field.path", "essentialHint": 4 }
  ]
}
```

Placeholders usable in `url`/`label`: `{name} {country} {country_code} {lat}
{lon} {bbox_south} {bbox_north} {bbox_west} {bbox_east} {today} {start_5y}`.

---

## Data sources (all free, no key)

Geocoding (OpenStreetMap Nominatim / Open-Meteo), historical climate &
coastal ground elevation (Open-Meteo — elevation returned with the climate
response), infrastructure counts (OpenStreetMap Overpass), earthquake history
(USGS FDSN), national indicators (World Bank Open Data), and any config-driven
REST sources you add.

## Web-search research (RAG) — keyless, no setup

Before the AI writes anything, a research step retrieves real, citable evidence
about the city and feeds it to the model as cross-checked context (never a
single "verified" number — that's what produced a bogus island elevation
before). It works for every provider, including local models that can't browse,
and needs **no API key**:

- **Wikipedia** (keyless core): a multi-article search plus full-article
  geography/hazard/climate extraction, bot-friendly and reliable from Vercel.
- **Wikidata**: population and area only. Elevation is intentionally not surfaced
  from Wikidata, since it's unreliable for islands and coastal cities.
- **DuckDuckGo** (keyless, best-effort): a little general-web coverage. It can be
  rate-limited or blocked from datacenter IPs, so it degrades quietly.

Whichever web search runs, it covers several angles for a rounded picture: the
city's geography and climate, its hazards and past disasters, recent resilience
initiatives and successes, and current challenges.

### Appearance

Light and dark themes are both built in. Light is the default; use the sun/moon
button in the header to switch, and your choice is remembered.

Optional, no-code upgrades for broader/higher-quality web results (set once in
your Vercel environment — still no per-query hassle):

- `SEARXNG_URL` — point at an open-source [SearXNG](https://searxng.org) instance
  (self-hosted or your own) to use its JSON API. No API key.
- `TAVILY_API_KEY` — a managed RAG search API (free tier available). Or paste a
  key under **Settings → Web-search grounding**.

> Note: SearXNG is a standalone service and can't run *inside* a Vercel function;
> host it separately and point `SEARXNG_URL` at it. Cloud providers can also use
> their own native web search (Gemini/Claude/OpenRouter) via the Settings
> toggle, but that's model-decided, so the keyless server-side research above is
> the primary path.

> ReliefWeb (UN OCHA) disaster history is included as code but off by default:
> since 1 Nov 2025 its API needs a pre-approved appname (a quick org
> registration at apidoc.reliefweb.int). Register one and re-add `reliefWebSource`
> in `lib/data/adapters/registry.ts` to enable it.

## Notes & limits

- **Large uploads:** Vercel's request body limit is ~4.5 MB; typical scorecards
  are well under this.
- **Overpass/Nominatim rate limits:** requests are server-side with a polite
  User-Agent and per-source timeouts; sources degrade gracefully.
- **Accuracy:** AI output is decision-support and depends on the model; the RAG
  step reduces hallucination but the model can still err — always review.

## License

Provided as-is for evaluation and decision support.
