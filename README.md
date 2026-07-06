# UNDRR ARISE Scorecard Analyzer

Upload a completed disaster resilience scorecard for a city, and this app turns it into a clear, readable analysis: what the city is doing well, where it is weak, and a prioritized list of actions that would raise its score the most.

Do not have a completed scorecard yet? There is also an **Assistant** that fills one out with you. Tell it about your city and it researches and drafts every answer, or you chat through it step by step, then hand the result straight to the analyzer.

It is built to be genuinely useful for a city planner, and genuinely cheap to run (it can live on a free Vercel account). If you are new to the project, this page should get you from "no idea" to "I understand what we built" in about ten minutes.

---

## The two tabs, in a nutshell

**Assistant** helps you *create* a scorecard. You give it a city and whatever you know, and an AI agent researches the city, searches the web, and fills in the 47 indicators, building a live draft you can edit. You can watch it think in real time, stop and continue later (even after switching model), attach reference documents for it to learn from, and keep a saved history of scorecards you can switch between. When it looks right, one click loads it into the analyzer, or downloads the **real official .xlsm** — the assistant fills the actual UNDRR template (every sheet, all the formatting, and the macros) by setting the answer cells, so it opens and totals correctly in Excel just like a hand-filled one.

**Dashboard** *analyzes* a scorecard, whether you uploaded a real one or built it in the Assistant. This is the part described in most of this guide.

---

## What it actually does

Someone fills out the official UNDRR ARISE "Disaster Resilience Scorecard for Cities" in Excel. That file has dozens of questions, each scored 0 to 3, grouped under the "Ten Essentials" of resilience.

You drop that file into the app. Then it:

1. Reads the scores out of the spreadsheet.
2. Gathers free public data about the city (its climate, elevation, infrastructure, earthquake history, and some country level indicators).
3. Researches the city on the web for extra context.
4. Asks an AI model to write the analysis, using the scorecard as the source of truth and the gathered data as supporting evidence.
5. Shows the result as a summary, a radar chart, an impact-vs-difficulty map of the suggested actions, a full action plan, and a "what if we did these" score projection you can toggle.

The person using it never has to touch code, a terminal, or a spreadsheet formula.

---

## The three ideas that shape the whole project

Understanding these three choices explains almost every file you will read later.

**1. The AI runs in your browser, not on our server.**
When you pick a model and paste an API key, the request goes straight from your browser to that AI provider. Your key is stored on your own device (encrypted), never on ours. This also means a long analysis will not time out, because it is not waiting on a small serverless function.

**2. The boring data work runs on tiny server routes.**
Some public data APIs refuse requests that come straight from a browser. So the open-data gathering and the web research run on small stateless server routes instead. They hold no database and remember nothing between requests.

**3. Everything favors the free tier.**
Free hosting, free data sources, and free or bring-your-own AI keys. You can run the whole thing without paying for anything.

---

## How a single analysis flows

Here is the life of one "Run Analysis" click, in order:

1. **Parse.** The Excel file is read into a clean, predictable shape (the Ten Essentials, each indicator, and the totals).
2. **Open data.** The app geocodes the city, then asks each data source for what it knows (climate, infrastructure counts, quakes, and so on). If one source fails, the others still run.
3. **Web research.** It pulls a few paragraphs of context about the city. If Tavily (a web search tool) is switched on, it trusts Tavily alone. If not, it falls back to Wikipedia and Wikidata plus a light web search.
4. **Prompt.** All of that is packed into instructions for the AI. The scorecard is treated as fact; the research is there to cross-check and enrich, not to override it.
5. **Stream.** Your chosen model writes the analysis, and you watch it appear live.
6. **Check and show.** The app validates the AI's answer against a strict format. If the answer is malformed it tries one repair, and if that fails it shows a basic built-in fallback so you are never left with a blank screen. Then it renders the charts and the action plan.

---

## The tech, in one minute

It is a single [Next.js](https://nextjs.org) app (the App Router style) written in TypeScript and React, styled with Tailwind CSS, with charts drawn by Recharts. It deploys to Vercel with no configuration. There is no database and no login. State you care about (your settings and your last result) is saved in your browser's local storage.

You do not need to know all of these to help. If you know a little React, you can already be useful in the `components` folder.

---

## Project map (where things live)

| Folder | What is inside | Think of it as |
|---|---|---|
| `app/` | The page you see, plus the small server routes under `app/api` | The front door |
| `app/page.tsx` | The whole dashboard screen and the app's state | The main screen |
| `app/api/` | Server routes: parse the file, fetch data, do research, proxy some AI calls | The back office |
| `components/` | The visual building blocks (charts, panels, the settings screen, buttons) | The furniture |
| `lib/` | The actual logic, with no UI in it | The brains |

Inside `lib/`, the brains are split by job:

| Folder | Job |
|---|---|
| `lib/scorecard/` | Turn the messy Excel file into clean, typed data |
| `lib/data/` | Fetch open data (each source is its own small file) and do web research |
| `lib/agent/` | The Assistant's fill-out agent and its working draft |
| `lib/llm/` | One file per AI provider, plus a factory that picks the right one |
| `lib/analysis/` | Build the prompt, run the model, and validate the result |
| `lib/settings/` | Save your choices and encrypt your API keys |
| `lib/export/` | Build the downloadable report and JSON |
| `lib/theme.ts` | Light and dark mode |

A nice detail worth knowing: the AI providers all share one small interface, so adding a new one is mostly copying a pattern, not inventing anything.

---

## The AI models you can choose

You pick a provider in Settings and paste a key. The friendliest starting points are Gemini (free tier) and NVIDIA NIM (free credits, lots of open models).

| Provider | Cost | Notes |
|---|---|---|
| Gemini | Free tier | Fast and easy. The default. |
| OpenRouter | Free open models | One key, many models. |
| NVIDIA NIM | Free credits | Over 100 open models, including Llama, DeepSeek, Kimi, and GLM. |
| z.AI | Free flash models, paid rest | The GLM family, including GLM 5.2. |
| Claude | Paid | Anthropic's models, high quality. |
| OpenAI | Paid | The GPT-5 family. |
| xAI | Paid | Grok models. |
| Meta | Paid (experimental) | Llama via Meta's own API. Llama is also free on NVIDIA NIM. |
| Ollama or LM Studio | Free and private | Runs a model on your own computer, no key needed. |

**One thing to know about the last group of cloud providers.** Gemini, OpenRouter, Claude, and the local options can be called straight from your browser. OpenAI, xAI, z.AI, NVIDIA, and Meta block browser calls, so those requests hop through a tiny same-origin route in this app (`/api/llm`) that just forwards them. Your key is used once for that request and is never stored on the server. On Vercel's free plan that route can run for up to 60 seconds, so a very slow "reasoning" model can occasionally get cut off. If that happens, pick a faster model or use a provider that runs directly in the browser.

---

## Where the data comes from

**Open data** (always gathered, no key needed):

- Open-Meteo for climate and elevation.
- OpenStreetMap (via Overpass) for counts of local infrastructure like hospitals and shelters.
- USGS for recent earthquake history near the city.
- World Bank for a few country-level indicators.

**Web research** (for extra context):

- If you turn on Tavily and add its free key, Tavily does the searching and is trusted on its own.
- If not, the app uses Wikipedia and Wikidata plus a light keyless web search.

The AI is always told to treat the scorecard as the truth and to cross-check these extras rather than trust any single number.

---

## Run it on your own computer

You will need [Node.js](https://nodejs.org) version 18.18 or newer.

```bash
# 1. get the code, then from the project folder:
npm install

# 2. start it
npm run dev
```

Now open `http://localhost:3000`. Go to **Settings**, pick a provider, paste a key, and hit **Test connection**. Then go back to **Dashboard**, upload a completed scorecard, and click **Run Analysis**.

That is the entire local setup.

---

## Put it online (Vercel)

1. Push this project to a GitHub repository.
2. In [Vercel](https://vercel.com), choose "Add New Project" and import that repository.
3. Click Deploy. There is nothing to configure.

Two optional environment variables exist if you want them:

- `TAVILY_API_KEY` lets everyone using your deployment get web search without pasting their own key.
- `SEARXNG_URL` points at your own private search server instead.

Neither is required.

---

## Is it private and safe?

Yes, by design. Your API keys are encrypted and kept in your own browser, and they are never sent to this app's server or saved in the code. The only things that ever reach a server are the open-data and research lookups (which are about the city, not about you) and, for the few providers that need it, the one forwarded AI request whose key is used immediately and then dropped.

---

## Bonus: connect it to Claude Desktop

The app also exposes its open-data engine as a small [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/api/mcp`. That lets Claude Desktop (or any MCP client) pull disaster-resilience evidence for any city directly. It is optional and separate from the main app.

---

## Want to change something? Start here

A quick map so you do not have to go hunting:

- **Ask the AI something different, or change its tone:** edit `lib/analysis/prompt.ts`.
- **Change the shape of the result (new fields, new sections):** edit `lib/analysis/schema.ts`, then use them in `components/`.
- **Add a new AI provider:** add a file in `lib/llm/`, wire it into `lib/llm/index.ts`, and register it in `lib/settings/store.ts` and `components/SettingsTab.tsx`.
- **Add a simple new data source:** often you only edit `lib/data/adapters/data-sources.json`, no code needed. For a trickier source, add a small adapter next to the others.
- **Change how the web research behaves:** edit `lib/data/research.ts`.
- **Change how the fill-out Assistant thinks or which tools it can call:** edit `lib/agent/agent.ts` (its instructions and the tool loop) and `lib/agent/draft.ts` (the draft it builds). Saved chat history lives in `lib/agent/sessions.ts`.
- **Change the look, colors, or charts:** the pieces are in `components/`, and the color and theme tokens live in `app/globals.css`.

---

## Handy commands

```bash
npm run dev     # run locally with live reload
npm run build   # make a production build
npm run start   # run that production build
npm run lint    # check the code style
```

---

## A note on the analysis itself

The AI is a helpful assistant, not an oracle. Different models, and even repeated runs of the same model, can surface different strengths, gaps, and recommendations. Treat the output as a strong first draft to review with your team, not as a final verdict. For important decisions, it is worth comparing a couple of models.
