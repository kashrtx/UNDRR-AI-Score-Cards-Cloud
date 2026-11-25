# UNDRR ARISE Scorecard Analyzer

Build or upload a disaster resilience scorecard for a city (or for a part of a city you outline on a map), and this app turns it into a clear, readable analysis: what the city is doing well, where it is weak, and a prioritized list of actions that would raise its score the most.

Do not have a completed scorecard yet? The **Assistant** fills one out for you. Name a city, or draw the area you care about on a map, and one or more AI helpers research it and answer all 47 indicators, each in its own copy you can compare and edit.

Once an analysis is done, an **analysis advisor** sits beside it. You can ask what the analysis might have missed, paste in real data you found, and re-run so your own local knowledge shapes the result.

It is built to be genuinely useful for a city planner, and genuinely cheap to run (it can live on a free Vercel account). If you are new to the project, this page should get you from "no idea" to "I understand what we built" in about ten minutes.

---

## The parts, in a nutshell

The app has four tabs, in the order you use them: **Assistant**, **Scorecard**, **Analysis** and **Settings**, plus a **Find data** link in the header.

**Assistant** (the first tab, open by default) *creates* a scorecard. In its setup panel you choose the place one of two ways:

- **By city name.** Type the city and pick the Country and, where the country has them, the State or Province from dropdowns. The app checks that the place exists (a popup says so if it does not, and the boxes clear) and looks up the city's official boundary.
- **Draw an area.** Use a map instead (see *Area mode* below). City, Country and State or Province fill in from whatever you pick.

You can add anything you already know in the notes box and attach reference documents (PDF or text). Then **Fill it out for me** sends every AI helper chosen in Settings off at once, in parallel. Each helper has its own sub-tab with its own chat and its own copy of the scorecard, so you can watch each one think in real time, stop it, steer it with a message, or continue later (even after switching model). A **Scorecard** button in the session bar fills green as answers come in and lists every helper's progress. **Clear all Information** (red) resets the place, notes, documents, every helper's answers and chat, after a Proceed/Cancel confirmation.

Every scorecard is saved in your browser, and the history list lets you switch between them, start a new one, or delete one. Each scorecard belongs to one city:

- Once it has at least one answer, choosing a different city asks whether to **save** it or **discard** it. Nothing is asked while no indicator is answered yet.
- Coming back to a city that has a saved scorecard asks whether to **reload** it or **clear** it. That applies whether you type the city, click it on the map, or draw a shape around it.
- The Scorecard tab always shows the city chosen on the Assistant tab.

**Area mode** ("Draw an area" in the Assistant's setup) uses a Leaflet map with Map, Topo and Satellite basemaps, smooth scroll zoom, a place search, and a live latitude/longitude read-out (six decimals) that follows the cursor. Ways to choose the area:

- **Click a city's name.** It uses that city's official boundary from OpenStreetMap: the city's own boundary, or, for big cities mapped as a single point (Lagos, Cape Town, Istanbul…), the administrative area around it that fits its population. A population-sized circle is used only when neither exists. Like any map, only big cities are labelled when zoomed out, and smaller ones appear as you zoom in, down to places of about 1,000 people (GeoNames), whose data loads in tiles only when you zoom in close. Names grow when you hover over them. The basemaps are label-free so these names can be the map's own clickable labels.
- **Rectangle, Polygon or Circle.** Drag one out on the map. A circle is a centre click and a radius drag.
- **Lat/Lon.** Type a latitude, longitude and radius. Radii are in miles or km, defaulting by your country and remembered once changed.
- **Load area from file.** GeoJSON, KML/KMZ, a zipped Shapefile, or a GeoTIFF (only its outline is used).

Areas must be between 0.1 and 1,000 km² (a whole clicked city may be larger), and you get a warning if much of the area lies outside the city.

Whichever way you choose the place, the outline in use is saved as a zipped **Shapefile** (WGS84; `lib/geo/shapefile.ts`). Its name shows above **Fill it out for me**, with a download button beside it. Its exact boundary (vertices, centre, bounding box) goes into the AI's instructions together with anything you typed, and the open data is gathered for exactly that shape: OpenStreetMap counts inside the polygon, and an elevation profile sampled across it. For a drawn area, the twenty indicators that can really differ by location (hazard exposure, infrastructure, service loss, shelters, local communities) are scored for the area. The other 27 (plans, budgets, institutions) describe the whole city, and the scorecard labels each one "Area" or "City-wide". The pieces live in:

- `lib/geo/`: geometry, file parsing, place lookup, the Shapefile writer, units, smooth zoom and the indicator split;
- `components/AreaPicker.tsx` and `components/AreaMap.tsx`: Leaflet + Leaflet-Geoman;
- `app/api/area`: place search, the city check and city boundaries;
- `lib/data/adapters/areaElevation.ts`.

**Scorecard** shows each helper's copy of the scorecard, live while it fills, with the City Information and, for an area, a card describing the outline. Its heading reads like "Gemini: Tempe, Arizona, United States", or "Gemini: Area · Tempe, Arizona, United States" for a drawn area. You can:

- edit any answer or note;
- upload an existing official scorecard (.xlsm/.xlsx), whose answers and City Information fill in automatically;
- download the **real official .xlsm** or a plain .xlsx;
- press **Run analysis**.

The .xlsm download fills the actual UNDRR template (every sheet, all the formatting, and the macros) by setting the answer cells, so it opens and totals correctly in Excel just like a hand-filled one. **Run analysis** and **Clear Scorecard** (red, confirmed first, clears only that helper's answers) stay greyed out until at least one indicator is answered.

**Analysis** *shows the analysis* of a scorecard. On its Impact vs Difficulty chart each dot carries its Action Plan number; dots with identical ratings are spread apart, and when the AI's action plan couldn't be read the chart says its placements are the app's rough estimates. **Run analysis** opens the scorecard here and starts the analysis right away. Each helper's analysis appears under its own sub-tab. Every finished analysis is kept in a **saved analyses library**, grouped by city and labelled with the outline used, the helper and the date, so you can reopen, download or delete it even after the Assistant has moved on to another city. Analysing the same city with a different outline asks whether to replace the earlier analysis or keep both. This tab is the part described in most of this guide.

**Analysis advisor** (on the Analysis tab, once you have results) helps you *improve* it. It already knows the scores and the analysis, so you can ask what looks thin, question a score, or share real data you found. Anything substantial you share is saved automatically, and one press of Re-run rebuilds the analysis with it, while also showing the model its previous answer so it refines rather than starting over. Conversations are remembered per city, with a History list so you can keep several threads and pick any of them back up. If your model is a thinking model, its internal reasoning stays behind a quiet "Thinking it through" line instead of spilling into the reply.

**Settings** is where you pick one or more AI helpers, add their keys, and test the connection (Steps 1 and 2). **Step 3, Choose data sources** (all off by default, and remembered like the AI helpers) lists 26 free global datasets from a researcher's catalogue of hazard, exposure and vulnerability data (`lib/data/catalog.ts`), grouped as hazard datasets by hazard (drought, wildfire, inland flood, earthquake, storm surge and coastal flooding, sea-level rise, severe weather, tropical cyclones), exposure, vulnerability and coping capacity, historical impacts, multi-hazard risk models, and discovery portals. Ticked datasets are given to the AI helpers for both "Fill it out for me" and "Run analysis" as their primary evidence (general sources only supplement them or fill gaps they don't cover), with each dataset's caveat; the app does not download the datasets themselves. The app shows where they were used: the chat says which sources a fill is using, each answer on the Scorecard carries a green link for every chosen dataset its note cites (or a "general source" tag), and the Analysis tab has a "Your data sources" card with how often each was cited, plus links beside each statement that cites one. Step 4 is the optional Tavily web search.

**Find data** (a link in the header) opens a directory of free, credible places to get real numbers: the UN, World Bank, NASA, Copernicus, EM-DAT, ThinkHazard and more. The whole point is to make fact-checking easy: grab a real figure, paste it into the advisor or the Assistant, and let it shape the result.

A helper never works on two things at once. While a helper's analysis (or the advisor) is running, that helper sits out a new fill and says why, and while it is filling a scorecard its analysis waits. That way nothing clashes and nothing burns through your rate limits twice over.

---

## What it actually does

The official UNDRR ARISE "Disaster Resilience Scorecard for Cities" is an Excel workbook with dozens of questions, each scored 0 to 3, grouped under the "Ten Essentials" of resilience.

You either upload a filled-in copy of that file, or let the Assistant fill it in. Then the app:

1. Reads the scores (from the spreadsheet, or from the Assistant's scorecard).
2. Gathers free public data about the city or the drawn area (its climate, elevation, infrastructure, earthquake history, and some country level indicators).
3. Researches the city on the web for extra context.
4. Asks an AI model to write the analysis, using the scorecard as the source of truth and the gathered data as supporting evidence.
5. Shows the result as a summary, a radar chart, an impact-vs-difficulty map of the suggested actions, a full action plan, and a "what if we did these" score projection you can toggle.
6. Lets you talk it over with the advisor, add your own data, and re-run to get a sharper version.

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

Here is the life of one "Run analysis" click, in order:

1. **Parse.** The scorecard (an uploaded Excel file, or a helper's copy) is turned into a clean, predictable shape (the Ten Essentials, each indicator, and the totals).
2. **Open data.** The app geocodes the city, then asks each data source for what it knows (climate, infrastructure counts, quakes, and so on). If one source fails, the others still run.
3. **Web research.** It pulls a few paragraphs of context about the city. If Tavily (a web search tool) is switched on, it trusts Tavily alone. If not, it falls back to Wikipedia and Wikidata plus a light web search.
4. **Prompt.** All of that is packed into instructions for the AI. The scorecard is treated as fact; the research is there to cross-check and enrich, not to override it.
5. **Stream.** Your chosen model writes the analysis, and you watch it appear live.
6. **Check and show.** The app validates the AI's answer against a strict format. If the answer is malformed it tries one repair, and if that fails it shows a basic built-in fallback so you are never left with a blank screen. Then it renders the charts and the action plan.

---

## The tech, in one minute

It is a single [Next.js](https://nextjs.org) app (the App Router style) written in TypeScript and React, styled with Tailwind CSS, with charts drawn by Recharts. It deploys to Vercel with no configuration. There is no database and no login. Everything you would want to keep (your settings and encrypted keys, every saved scorecard with each helper's chat, the saved analyses library, and advisor conversations) is saved in your browser's local storage, on your own machine. It stays until you delete it in the app. Browsers allow each site only a few megabytes there, so very heavy use could eventually fill it.

You do not need to know all of these to help. If you know a little React, you can already be useful in the `components` folder.

---

## Project map (where things live)

| Folder | What is inside | Think of it as |
|---|---|---|
| `app/` | The page you see, plus the small server routes under `app/api` | The front door |
| `app/page.tsx` | The tabs, the Analysis screen and the app's state | The main screen |
| `app/data-sources/` | The standalone "Find data" directory page | The reading list |
| `app/api/` | Server routes: parse the file, fetch data, do research, proxy some AI calls | The back office |
| `components/` | The visual building blocks (the Assistant and Scorecard tabs, each helper's lane, the area map, charts, panels, the settings screen) | The furniture |
| `lib/` | The actual logic, with no UI in it | The brains |

Inside `lib/`, the brains are split by job:

| Folder | Job |
|---|---|
| `lib/scorecard/` | Turn the messy Excel file into clean, typed data |
| `lib/data/` | Fetch open data (each source is its own small file) and do web research |
| `lib/agent/` | The Assistant's fill-out agent, its working draft, and the saved scorecards |
| `lib/geo/` | Countries and states, area geometry, map files in and out (GeoJSON, KML, Shapefile, GeoTIFF), place lookup |
| `lib/llm/` | One file per AI provider, plus a factory that picks the right one |
| `lib/analysis/` | Build the prompt, run the model, validate the result, and keep the saved analyses library |
| `lib/settings/` | Save your choices and encrypt your API keys |
| `lib/export/` | Build the downloadable report and JSON |
| `lib/theme.ts` | Light and dark mode |

A nice detail worth knowing: the AI providers all share one small interface, so adding a new one is mostly copying a pattern, not inventing anything.

---

## The AI models you can choose

You pick one or more providers in Settings and paste their keys. Every provider you pick becomes its own helper on the Assistant, Scorecard and Analysis tabs. The friendliest starting points are Gemini (free tier) and NVIDIA NIM (free credits, lots of open models).

| Provider | Cost | Notes |
|---|---|---|
| Gemini | Free tier | Fast and easy. The default (3.6 Flash), and the best pick for the Analysis tab. |
| OpenRouter | Free open models | One key, many models. The best pick for the Assistant, since its free tier is not tightly rate-limited. |
| ASU CreateAI | Your ASU project's monthly budget | Arizona State University's platform: Claude, Gemini, GPT, Gemma and Llama models with one project API key from platform.aiml.asu.edu. **Load my models** lists what your key can use, with prices. A project "Service" key may answer with the model set on the project's Basic tab whatever model you pick; Test connection reports which model answered and how much of the monthly budget is used. ASU advises keeping Service keys out of browser apps, so use it for local development only. |
| NVIDIA NIM | Free credits | Over 100 open models, including Llama, DeepSeek, Kimi, and GLM. |
| z.AI | Free flash models, paid rest | The GLM family, including GLM 5.2. |
| Claude | Paid | Anthropic's models, high quality. |
| OpenAI | Paid | The GPT-5 family. |
| xAI | Paid | Grok models. |
| Meta | Paid (experimental) | Llama via Meta's own API. Llama is also free on NVIDIA NIM. |
| Perplexity | Paid credits | Sonar models that search the web as they answer. Good for research, but weaker at the Assistant's step-by-step filling. |
| Microsoft Azure OpenAI | Paid | Microsoft's own endpoint. Needs an endpoint URL, a deployment name, and a key. |
| Ollama or LM Studio | Free and private | Runs a model on your own computer, no key needed. |

**One thing to know about how these are reached.** Gemini, OpenRouter, Claude, and the local options can be called straight from your browser. OpenAI, xAI, z.AI, NVIDIA, Meta, Perplexity, Azure, and ASU CreateAI block (or are not known to allow) browser calls, so those requests hop through a tiny same-origin route in this app (`/api/llm`) that just forwards them. Your key is used once for that request and is never stored on the server. That route is capped at 120 seconds, so a very slow "reasoning" model can occasionally get cut off. Settings labels each provider with this ("Fast and reliable" versus "May time out on free hosting") so nobody has to guess, and if you do get cut off, pick a faster model or one that runs directly in the browser.

---

## Where the data comes from

**Open data** (always gathered, no key needed):

- Open-Meteo for climate and elevation.
- OpenStreetMap (via Overpass) for counts of local infrastructure like hospitals and shelters, inside the city boundary or drawn area.
- OpenStreetMap (via Nominatim) to check that a place exists and to find city boundaries.
- USGS for recent earthquake history near the city.
- World Bank for a few country-level indicators.

**Web research** (for extra context):

- If you turn on Tavily and add its free key, Tavily does the searching and is trusted on its own.
- If not, the app uses Wikipedia and Wikidata plus a light keyless web search.

The AI is always told to treat the scorecard as the truth and to cross-check these extras rather than trust any single number.

---

## The look

The nav bar, floating buttons, dialogs and the advisor panel use a translucent frosted treatment: a backdrop blur over a soft colour wash, so surfaces feel layered instead of flat. It is plain CSS, no extra dependencies and no SVG filters, so it is cheap to paint.

Selecting a section slides a pill behind it. You can also press and drag sideways across the bar and let go on the section you want; pull past either end and it resists rather than escaping.

If you find translucency distracting, the system settings for Reduce Transparency, Increase Contrast and Reduce Motion each turn it down: surfaces go solid, borders get firmer, and the slide becomes near-instant.

---

## How it stays reliable

A few deliberate guardrails, mostly learned the hard way:

- **No helper runs twice at once.** A helper filling a scorecard cannot also be analyzing, and while the advisor is writing, the helper it uses waits. Whichever is busy disables the others and says why, so you cannot accidentally fire two calls to the same model at the same time.
- **Nothing loops forever.** The Assistant's agent has a hard step ceiling, and it also stops itself if it repeats the same action or stops making progress. Some models (search-focused ones especially) do not know when to stop, so the app decides for them. Every step also carries a short "work so far" list of what has already been researched (with excerpts once the originals scroll out of the prompt). A search or city research that was already done returns its earlier result instead of running again, and after six lookups in a row without a new answer the Assistant is told to score with what it has. This matters because a runaway loop quietly eats your quota.
- **Every call path is bounded.** Retries are capped and only happen on rate limits, the analysis makes at most a few calls before falling back gracefully, and long conversations are trimmed so prompts do not balloon into the model's context limit.
- **Switching model mid-run is safe.** Each run captures its model when it starts, so a switch applies to the next run instead of corrupting the one in flight.
- **Nothing is deleted without asking.** All of these confirm first:
  - clearing results, a scorecard, or all information;
  - removing a saved scorecard or analysis;
  - loading a new file over existing work;
  - moving away from (or back to) a city with saved answers.

  Where it matters, they offer to download the report before it goes.
- **A thinking model's scratchpad stays private.** Providers stream internal reasoning on a separate channel from the answer, so a chat shows a discreet "thinking" line rather than leaking the model's notes (or its instructions) into the visible reply.
- **A crash does not brick the app.** If a screen ever throws, you get a calm recovery screen with reload and reset options instead of a blank page.

---

## Run it on your own computer

You will need [Node.js](https://nodejs.org) version 18.18 or newer.

```bash
# 1. get the code, then from the project folder:
npm install

# 2. start it
npm run dev
```

`npm run dev` first stops any dev server of this project left running from an earlier run (only this folder's, on ports 3000-3010), then starts a fresh one and opens it in your browser. Set `NO_OPEN=1` to skip opening the browser, or use `npm run dev:plain` for bare `next dev`.

Go to **Settings**, pick a provider, paste a key, and hit **Test connection**. Then build a scorecard on the **Assistant** tab (or upload a completed one on the **Scorecard** tab) and click **Run analysis** on the Scorecard tab.

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

Yes, by design. Your API keys are encrypted and kept in your own browser, and they are never sent to this app's server or saved in the code. The app writes no files on the server: uploaded scorecards are read in memory and dropped, and generated downloads (Shapefile, .xlsm, report) are built in your browser. The only things that ever reach a server are:

- the open-data, place and research lookups, which are about the city or area, not about you;
- for the few providers that need it, the one forwarded AI request, whose key is used immediately and then dropped.

Outside services (OpenStreetMap, Open-Meteo, your AI provider) may keep their own logs of what they receive. For fully private AI, use Ollama or LM Studio.

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
- **Change how the fill-out Assistant thinks or which tools it can call:** edit `lib/agent/agent.ts` (its instructions and the tool loop) and `lib/agent/draft.ts` (the draft it builds). Saved scorecards live in `lib/agent/sessions.ts`. The Assistant and Scorecard tabs, and the save and reload prompts when the city changes, are in `components/AssistantTab.tsx`; each helper's chat and scorecard are in `components/AgentLane.tsx`.
- **Change the area map or what it accepts:** `components/AreaPicker.tsx`, `components/AreaMap.tsx`, and `lib/geo/`.
- **Change the look, colors, or charts:** the pieces are in `components/`, and the color and theme tokens live in `app/globals.css`.
- **Change how the advisor behaves:** edit `components/AnalysisAdvisor.tsx` (its instructions, and the rule that decides what gets saved for a re-run).
- **Add or edit the data sources people can browse:** edit the list at the top of `app/data-sources/page.tsx`.

---

## Handy commands

```bash
npm run dev     # stop old local runs, start with live reload, open the browser
npm run build   # make a production build
npm run start   # run that production build
npm run lint    # check the code style
npm run build:regions  # regenerate the Country / State-or-Province lists (lib/geo/regions.json)
npm run build:cities   # regenerate the clickable place names on the area map (public/cities.json + public/cities/detail/ tiles)
```

---

## A note on the analysis itself

The AI is a helpful assistant, not an oracle. Different models, and even repeated runs of the same model, can surface different strengths, gaps, and recommendations. Treat the output as a strong first draft to review with your team, not as a final verdict. For important decisions, it is worth comparing a couple of models.

---

## License

Apache License 2.0. Copyright 2026 Kaushal Bhingaradia. See `LICENSE` for the full text and `NOTICE` for attribution.

The UNDRR Disaster Resilience Scorecard for Cities is the work of UNDRR and its partners. This tool is independent software built to work with that scorecard, and is not affiliated with or endorsed by UNDRR.
