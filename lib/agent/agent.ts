/**
 * The fill-out agent.
 *
 * It helps a city complete the UNDRR ARISE Preliminary scorecard, either
 * autonomously ("fill it out for my city") or as a step-by-step chat. Because
 * our LLM providers expose a plain text `complete()` (not a provider-specific
 * function-calling API), the agent uses a simple, universal protocol: each turn
 * the model replies with ONE JSON action, we run it, feed back the result, and
 * loop. This works identically across Gemini, Claude, GLM, Llama, GPT, etc.
 *
 * Actions: research_city, web_search, set_scores, message (ask/tell the user and
 * wait), finish (all done).
 */

import type { LLMProvider } from "@/lib/llm";
import { PRELIMINARY_INDICATORS, TOTAL_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";
import { ESSENTIAL_NAMES } from "@/lib/scorecard/schema";
import { applyScores, applyInfo, filledCount, unfilledCodes, type Draft, type CityInfo } from "./draft";

export type TranscriptItem =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string };

export type AgentEvent =
  | { type: "thinking"; on: boolean }
  | { type: "stream"; text: string }
  | { type: "thought"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; label: string; detail?: string }
  | { type: "draft" }
  | { type: "info" }
  | { type: "done" }
  | { type: "stopped" }
  | { type: "error"; text: string; canContinue?: boolean };

export interface AgentContext {
  provider: LLMProvider;
  transcript: TranscriptItem[];
  draft: Draft;
  info: CityInfo; // the City Information page (name, country + profile fields), mutated by set_info
  searchKey?: string | null;
  city?: string;
  country?: string;
  attachments?: Array<{ name: string; text: string }>;
  mode?: "autonomous" | "assist";
  drainInput?: () => string | null; // pull a queued user message (for mid-run steering)
}

const MAX_STEPS = 16;
const STEP_PACING_MS = 700; // small gap between steps to ease free-tier rate limits

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function isRateLimit(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b429\b|quota|rate.?limit|resource_exhausted|too many requests|overloaded|\b503\b/.test(m);
}

/**
 * Call the model, riding out the rate limits that free tiers (e.g. Gemini)
 * throw when the agent makes several quick calls. Waits and retries on 429-style
 * errors; other errors bubble up immediately.
 */
async function completeWithRetry(
  ctx: AgentContext,
  user: string,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal
): Promise<string> {
  const waits = [5000, 12000];
  let lastErr: unknown;
  const handlers = { onToken: (t: string) => onEvent({ type: "stream", text: t }) };
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      return await ctx.provider.complete(SYSTEM, user, handlers, signal);
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
      if (!isRateLimit(e) || attempt === waits.length) throw e;
      const s = Math.round(waits[attempt] / 1000);
      onEvent({ type: "tool", label: `Model is rate-limited, waiting ${s}s and retrying…` });
      onEvent({ type: "thinking", on: false });
      await sleep(waits[attempt], signal);
      onEvent({ type: "thinking", on: true });
    }
  }
  throw lastErr;
}

// ── System prompt ────────────────────────────────────────────
function indicatorList(): string {
  const byE = new Map<number, string[]>();
  for (const ind of PRELIMINARY_INDICATORS) {
    if (!byE.has(ind.essential)) byE.set(ind.essential, []);
    byE.get(ind.essential)!.push(`  ${ind.code}: ${ind.text}`);
  }
  const parts: string[] = [];
  for (let e = 1; e <= 10; e++) {
    parts.push(`E${e}, ${ESSENTIAL_NAMES[e]}`);
    parts.push((byE.get(e) || []).join("\n"));
  }
  return parts.join("\n");
}

const SYSTEM = `You are a careful, friendly assistant that helps a city official complete the UNDRR ARISE "Disaster Resilience Scorecard for Cities" (Preliminary version). The scorecard has two parts you can fill:
  1. A CITY INFORMATION page (basic facts about the city).
  2. ${TOTAL_INDICATORS} scored indicators grouped under the Ten Essentials, each scored 0 to 3.

You are like a person with the real scorecard file open, filling it in as you go. Fill BOTH the City Information page and the indicators.

CITY INFORMATION FIELDS you can record with set_info:
  typeOfCity (e.g. "Municipality"), authorityTitle (e.g. "Mayor"), population (number),
  areaKm2 (number), density (per km², number), youthPct, seniorPct, femaleHeadedPct,
  literacyPct, povertyPct, incomeUsd (average household income), nonCitizenPct,
  hazards (list of the main hazards), mostLikelyHazard (the single most likely known hazard),
  mostSevere (the most severe disaster known, a short phrase).
  On a full fill, actively try to complete this profile: the demographic figures
  (population, youth %, senior %, literacy %, poverty %, average household income)
  are usually published in national census / city-statistics data, so look them
  up with web_search or research_city rather than skipping them. You do NOT need
  to send density, it is computed for you from population and area. For any
  single field you genuinely cannot find, leave it out; NEVER invent a number.

SCORING RUBRIC (0-3):
  0 = No / none / not in place at all.
  1 = Limited or ad hoc; early efforts only; major gaps.
  2 = Substantial but incomplete; in place with notable gaps.
  3 = Comprehensive; fully in place, resourced, and reviewed.

THE INDICATORS:
${indicatorList()}

HOW YOU WORK:
- You reply with EXACTLY ONE JSON object per turn and NOTHING else. No prose outside the JSON, no markdown fences.
- ALWAYS include a short "thought" field (one plain sentence) saying what you are doing and why, so the user can follow along.
- Choose the single best next action:
  {"thought":"...","action":"research_city","city":"<name>","country":"<name>"} , gather open data + web facts about the city (climate, hazards, infrastructure, population). Do this once early when you know the city.
  {"thought":"...","action":"web_search","query":"<query>"} , look up a specific fact (e.g. "Toronto emergency management office budget", "Toronto early warning system"). Use this for anything time-sensitive or current (recent hazards, ongoing wildfire/flood/air-quality alerts, latest plans) so your scoring reflects the situation now, not just older knowledge. Anything a search returns is added to our shared context, so prefer searching over relying on memory when unsure.
  {"thought":"...","action":"set_info","profile":{"population":134000,"areaKm2":385,"mostLikelyHazard":"Earthquake","mostSevere":"2010 M7.0 earthquake","hazards":["Earthquake","Flooding","Hurricane"]}} , record City Information fields you have learned. Send only the fields you know.
  {"thought":"...","action":"set_scores","scores":[{"code":"P1.1","score":2,"note":"<one short sentence on the basis>"}, ...]} , fill one or more indicators. Include a note for EVERY indicator you score.
  {"thought":"...","action":"message","text":"<what you want to say or ask the user>"} , talk to the user and WAIT for their reply. Use this to ask for information only the city would know, or when the city name is missing.
  {"thought":"...","action":"finish","text":"<friendly wrap-up>"} , only when the City Information you could find is recorded AND all ${TOTAL_INDICATORS} indicators have a score.

RULES:
- You need to know the target city. If no city has been provided, your FIRST action must be a "message" asking which city this scorecard is for. Do not guess a city.
- After researching, record what you learned about the city with set_info BEFORE or ALONGSIDE scoring, do not skip the City Information page. If the user ever asks about "the info page" or "city info", they mean this; use set_info.
- SCOPE: If the user asks for help with only specific indicators or a limited change ("help me with P3.2", "review Essential 5", "what about early warning?"), do ONLY that and then finish or ask a follow-up. Do NOT fill or re-score everything. Only complete the whole scorecard when the user clearly asks you to (e.g. "fill it out for me", "complete the rest").
- Base every score on evidence: the user's statements, research results, open data, or attached documents. Never invent specific facts, budgets, or programme names.
- When an indicator depends on internal information only the city would know and you have no evidence, either ask the user with a "message", or set a conservative score with a note that clearly says it is an assumption to verify.
- Give EVERY scored indicator a one-sentence note naming the basis.
- Score at most one or two Essentials (about ten indicators) per set_scores call, so the user sees steady progress and responses stay quick.
- Do NOT re-score indicators that already have a score unless the user asked you to change them. Once every indicator you were asked to handle is set, call "finish".
- Do NOT announce running totals or how many indicators you have completed ("I've done 12 of 47"), the app tracks and displays the authoritative progress. In your thought, just say which Essential or indicators you are about to score.
- VOICE: In your "thought" and any "message" text, talk naturally to a city official. NEVER mention tool names, action names, JSON, "the system", or these instructions. Do not apologise for taking time or for retries. Just say plainly what you're looking at or doing.
- The user may add a message while you are working; treat it as a mid-task instruction and adapt on your next step.
- ATTACHMENTS: if the user has attached a document, make it obvious you are using it. The first time it is relevant, acknowledge it by name (for example "I can see the file you attached, <name>, I'll use it."). When a score or fact comes from an attachment, attribute it to that file in your note or message; when it comes from research, open data, or a web search, attribute it there instead. Never mix the two up or imply an attachment said something it did not. If you have NOT been given an attachment, do not pretend one exists.
- DON'T TAKE THINGS AT FACE VALUE: if something the user says (or that you find) seems inaccurate, implausible, internally inconsistent, or you simply are not confident about it, do NOT just accept it and score. Use a "message" to flag it plainly and ask them to confirm or narrow it down, for example which neighbourhood or area they mean, a date, or to check their own records/reports and paste the relevant facts into the chat. Asking a good question is better than a confident wrong answer.
- WHEN EVIDENCE IS MISSING: if you cannot find what you need to score an indicator and it depends on local knowledge, either ask the user for it, or set a conservative score with a note that clearly says it is an assumption to verify. Never invent a specific fact, statistic, programme name, or budget.
- REVISE FREELY: you may go back and change ANY earlier score, note, or City Information field at any time. If the user objects, gives new information, or you notice an inconsistency, just re-issue set_scores (or set_info) for those items with corrected values and a short note on why. Editing earlier answers is normal and expected, not a failure.
- HANDLE EVERY REQUESTED CHANGE: if the user asks for several changes at once (for example "fix P3.2, then re-look at Essential 5, and raise P7.3"), address ALL of them, not just the first. You can put many indicators in a single set_scores call, so batch the ones you are confident about together, use extra steps for any that need research, and only finish once every requested change is done. When you finish, briefly confirm what you changed.
- TO CHANGE A SCORE YOU MUST SET THE NUMBER: when you raise or lower a score, put the new value as a plain integer 0-3 in the "score" field (for example "score": 3). Do NOT describe the change only in the note ("raised to 3/3") and leave the score out, that updates the wording but not the actual score. After each set_scores you are told the ACTUAL score changes that took effect; when you summarise for the user, describe only those actual changes, never a change you intended but that did not register.
- NEVER GET STUCK: do not repeat the same action or the same question hoping for a different result. If a search or approach fails twice, say so plainly and either try a clearly different approach or ask the user how they'd like to proceed. If you are uncertain after one round of clarification, record a conservative, clearly-flagged answer and move on rather than looping.
- PLAN FIRST (autonomous runs): on your very first step of a full fill, make the "thought" a short plan in plain words (for example: "My plan: look up the city, fill in the basic City Information, then work through the Ten Essentials one by one.") and pair it with your first real action (usually research_city) in the SAME step, do not waste a turn. For small targeted requests, skip the plan and just do the task.
- Be efficient: research once, then fill. Do not repeat the same search or re-submit the same scores.`;

// ── Robust JSON extraction (mirrors the analyzer's) ──────────
function extractJson(text: string): string {
  let cleaned = text;
  if (/<\/think>/i.test(cleaned)) cleaned = cleaned.split(/<\/think>/i).pop() ?? cleaned;
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

interface AgentAction {
  thought?: string;
  action: string;
  city?: string;
  country?: string;
  query?: string;
  text?: string;
  scores?: Array<{ code?: string; score?: number; note?: string }>;
  profile?: Record<string, unknown>;
  info?: Record<string, unknown>;
}

function parseAction(raw: string): AgentAction | null {
  try {
    const obj = JSON.parse(extractJson(raw));
    if (obj && typeof obj.action === "string") return obj as AgentAction;
  } catch {
    /* ignore */
  }
  return null;
}

// ── Tools ────────────────────────────────────────────────────
async function researchTool(
  city: string,
  country: string | undefined,
  searchKey?: string | null
): Promise<{ text: string; method: string }> {
  try {
    const [dataRes, refRes] = await Promise.allSettled([
      fetch("/api/data/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city, country }),
      }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city, country, searchApiKey: searchKey || undefined }),
      }).then((r) => (r.ok ? r.json() : null)),
    ]);

    const lines: string[] = [];
    let method = "open data";
    if (dataRes.status === "fulfilled" && dataRes.value) {
      const dp = dataRes.value as { data?: Array<{ label: string; value: unknown; unit?: string }> };
      const pts = (dp.data || [])
        .slice(0, 18)
        .map((p) => `- ${p.label}: ${p.value}${p.unit ? " " + p.unit : ""}`);
      if (pts.length) lines.push("Open data:", ...pts);
    }
    if (refRes.status === "fulfilled" && refRes.value) {
      const rf = refRes.value as { answer?: string; passages?: Array<{ text: string }>; webSearchMethod?: string };
      if (rf.webSearchMethod) method = `${rf.webSearchMethod} + open data`;
      if (rf.answer) lines.push("", "Web summary:", rf.answer.slice(0, 900));
      for (const p of (rf.passages || []).slice(0, 4)) lines.push("- " + p.text.slice(0, 240));
    }
    return { text: lines.length ? lines.join("\n") : "No open data or web results were found for that city.", method };
  } catch (e) {
    return { text: `Research failed: ${e instanceof Error ? e.message : String(e)}`, method: "failed" };
  }
}

async function searchTool(query: string, searchKey?: string | null): Promise<{ text: string; method: string }> {
  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, searchApiKey: searchKey || undefined }),
    });
    if (!res.ok) return { text: `Search failed (HTTP ${res.status}).`, method: "failed" };
    const r = (await res.json()) as { answer?: string; method?: string; results?: Array<{ title: string; content: string }> };
    const lines: string[] = [];
    if (r.answer) lines.push(r.answer.slice(0, 800));
    for (const it of (r.results || []).slice(0, 5)) lines.push(`- ${it.title}: ${(it.content || "").slice(0, 200)}`);
    return { text: lines.length ? lines.join("\n") : "No results.", method: r.method || "web" };
  } catch (e) {
    return { text: `Search failed: ${e instanceof Error ? e.message : String(e)}`, method: "failed" };
  }
}

// ── Prompt assembly ──────────────────────────────────────────
function buildUser(ctx: AgentContext): string {
  // Keep the prompt bounded on long autonomous runs: always keep the first user
  // instruction (the task), plus the most recent exchanges. This avoids ballooning
  // token cost and hitting the model's context limit mid-run.
  const MAX_HISTORY = 24;
  let items = ctx.transcript;
  if (items.length > MAX_HISTORY) {
    const firstUserIdx = items.findIndex((t) => t.role === "user");
    const recent = items.slice(-MAX_HISTORY);
    if (firstUserIdx !== -1 && firstUserIdx < items.length - MAX_HISTORY) {
      items = [items[firstUserIdx], ...recent];
    } else {
      items = recent;
    }
  }
  const history = items
    .map((t) =>
      t.role === "user" ? `USER: ${t.content}` : t.role === "assistant" ? `YOU: ${t.content}` : `TOOL RESULT: ${t.content}`
    )
    .join("\n\n");

  const filled = filledCount(ctx.draft);
  const unfilled = unfilledCodes(ctx.draft);
  const draftLines = PRELIMINARY_INDICATORS.filter((i) => ctx.draft[i.code]?.score != null)
    .map((i) => `${i.code}=${ctx.draft[i.code].score}`)
    .join(", ");

  const cityLine = ctx.city && ctx.city.trim()
    ? `Target city: ${ctx.city}${ctx.country && ctx.country.trim() ? ", " + ctx.country : ""}.`
    : "No city has been provided yet, ask the user which city this is for before scoring.";

  const atts = ctx.attachments || [];
  const attBlock = atts.length
    ? `DOCUMENTS THE USER ATTACHED (${atts.map((a) => a.name).join(", ")}). These are the USER'S OWN uploaded files. Treat them as user-provided evidence and keep them DISTINCT from anything you find via research_city, web_search, or open data. When you rely on one, say so and name it (for example: "Based on the file you attached, <name>, ..."). Do not blend attachment facts with web/open-data facts or misattribute one as the other; if they conflict, say which is which.\n` +
      atts.map((a) => `--- ${a.name} (user attachment) ---\n${a.text.slice(0, 4000)}${a.text.length > 4000 ? "\n…(truncated)" : ""}`).join("\n\n") +
      "\n\n"
    : "";

  const modeLine =
    ctx.mode === "autonomous"
      ? "TASK: complete the ENTIRE scorecard, record the City Information you can find (set_info) AND score all indicators."
      : "TASK: respond to the user's specific request only; do not fill or change everything unless they asked.";

  // Summarise what the City Information page already holds, and what's still blank.
  const info = ctx.info || ({} as CityInfo);
  const infoParts: string[] = [];
  if (info.population != null) infoParts.push(`population ${info.population}`);
  if (info.areaKm2 != null) infoParts.push(`area ${info.areaKm2} km²`);
  if (info.incomeUsd != null) infoParts.push(`income $${info.incomeUsd}`);
  if (info.mostLikelyHazard) infoParts.push(`most-likely hazard "${info.mostLikelyHazard}"`);
  if (info.mostSevere) infoParts.push(`most-severe "${info.mostSevere}"`);
  if (info.hazards && info.hazards.length) infoParts.push(`hazards ${info.hazards.join("/")}`);
  const infoLine = infoParts.length
    ? `CITY INFORMATION recorded so far: ${infoParts.join("; ")}.`
    : "CITY INFORMATION page is still EMPTY, record what you can with set_info.";

  return `${attBlock}${history || "(no messages yet)"}

${cityLine}
${modeLine}
${infoLine}
CURRENT DRAFT: ${filled}/${TOTAL_INDICATORS} filled.${draftLines ? ` Scores so far: ${draftLines}.` : ""}
${unfilled.length ? `Still unfilled: ${unfilled.join(", ")}.` : "All indicators are filled."}

Output ONLY the next action as a single JSON object (remember the "thought" field).`;
}

// ── The turn loop ────────────────────────────────────────────
/**
 * Runs the agent until it needs the user (message), finishes, or hits the step
 * cap. Mutates ctx.transcript and ctx.draft. Emits events for the UI.
 */
export async function runAgentTurn(
  ctx: AgentContext,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  let parseFailures = 0;
  let prevFilled = filledCount(ctx.draft);
  let stagnantScores = 0; // consecutive set_scores that add nothing
  let stagnantInfo = 0;   // consecutive set_info calls that change nothing
  let lastSig = "";       // signature of the previous action
  let sigRepeat = 0;      // how many times the exact same action has repeated
  let infoNudged = false;
  const autonomous = ctx.mode === "autonomous";

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) {
      onEvent({ type: "stopped" });
      return;
    }
    // Gentle pacing between steps: spread calls out a little so a fast autonomous
    // run doesn't hammer free-tier rate limits in bursts. Abortable.
    if (step > 0) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, STEP_PACING_MS);
        signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
      });
      if (signal?.aborted) { onEvent({ type: "stopped" }); return; }
    }
    // Let the user steer mid-run: pull in anything they typed while we were
    // working and fold it into the conversation before the next decision.
    if (ctx.drainInput) {
      let extra = ctx.drainInput();
      while (extra) {
        ctx.transcript.push({ role: "user", content: extra });
        extra = ctx.drainInput();
      }
    }
    onEvent({ type: "thinking", on: true });

    let raw = "";
    try {
      raw = await completeWithRetry(ctx, buildUser(ctx), onEvent, signal);
    } catch (e) {
      onEvent({ type: "thinking", on: false });
      if (signal?.aborted) {
        onEvent({ type: "stopped" });
        return;
      }
      if (isRateLimit(e)) {
        onEvent({
          type: "error",
          canContinue: true,
          text:
            "the model hit its rate limit or quota. Free tiers (like Gemini) allow only a few calls a minute, and the assistant makes several. Wait a minute and press Continue, or switch to a model with more headroom (such as NVIDIA NIM) in Settings and then Continue",
        });
        return;
      }
      onEvent({
        type: "error",
        canContinue: true,
        text: (e instanceof Error ? e.message : String(e)) + ", you can press Continue to retry, or switch model in Settings first",
      });
      return;
    }
    onEvent({ type: "thinking", on: false });

    const action = parseAction(raw);
    if (!action) {
      parseFailures++;
      if (parseFailures >= 3) {
        onEvent({ type: "error", canContinue: true, text: "the model kept replying in a format I couldn't read. Press Continue to retry, or switch to another model in Settings" });
        return;
      }
      ctx.transcript.push({ role: "tool", content: "Your last reply was not a single valid JSON action. Reply with exactly one JSON object with a \"thought\" and an \"action\"." });
      continue;
    }
    parseFailures = 0;
    if (action.thought) onEvent({ type: "thought", text: action.thought });

    // Loop guard: fingerprint the action (ignoring the free-text thought). If the
    // model repeats the exact same action several times, we'll stop rather than
    // spin, which some models (especially search-focused ones) are prone to.
    const sig = JSON.stringify([
      action.action,
      action.scores ?? null,
      action.profile ?? action.info ?? null,
      action.query ?? null,
      (action.city ?? "") + "|" + (action.country ?? ""),
    ]);
    if (sig === lastSig) sigRepeat++; else sigRepeat = 0;
    lastSig = sig;

    switch (action.action) {
      case "research_city": {
        const cityName = action.city || ctx.city || "";
        onEvent({ type: "tool", label: `Researching ${cityName || "the city"}…` });
        const { text, method } = await researchTool(cityName, action.country || ctx.country, ctx.searchKey);
        ctx.transcript.push({ role: "tool", content: `research_city(${cityName}):\n${text}` });
        onEvent({ type: "tool", label: `Researched ${cityName || "the city"}`, detail: method });
        stagnantScores = 0; stagnantInfo = 0;
        break;
      }
      case "web_search": {
        const q = action.query || "";
        onEvent({ type: "tool", label: "Searching the web for", detail: q.slice(0, 70) });
        const { text, method } = await searchTool(q, ctx.searchKey);
        ctx.transcript.push({ role: "tool", content: `web_search(${q}):\n${text}` });
        onEvent({ type: "tool", label: `Searched (${method})`, detail: q.slice(0, 60) });
        stagnantScores = 0; stagnantInfo = 0;
        break;
      }
      case "set_scores": {
        const reqs = (action.scores || []) as Array<{ code?: string; score?: unknown; note?: string }>;
        const norm = (c?: string) => (c || "").toUpperCase().replace(/\s+/g, "");
        const before = new Map<string, number | null>();
        for (const r of reqs) {
          const c = norm(r.code);
          if (c in ctx.draft) before.set(c, ctx.draft[c].score);
        }
        const n = applyScores(ctx.draft, reqs);
        // Build an ACCURATE list of what actually changed, so the model's own
        // summary reflects reality instead of what it intended.
        const scoreChanges: string[] = [];
        for (const r of reqs) {
          const c = norm(r.code);
          if (!(c in ctx.draft)) continue;
          const oldv = before.has(c) ? before.get(c)! : null;
          const newv = ctx.draft[c].score;
          if (oldv !== newv) scoreChanges.push(`${c} ${oldv ?? "blank"}→${newv}`);
        }
        onEvent({ type: "draft" });
        const nowFilled = filledCount(ctx.draft);
        const added = Math.max(0, nowFilled - prevFilled); // newly-filled indicators
        ctx.transcript.push({
          role: "tool",
          content:
            `Applied ${n} score(s). ${nowFilled}/${TOTAL_INDICATORS} filled. ` +
            `Actual score changes: ${scoreChanges.length ? scoreChanges.join(", ") : "none (notes only or values unchanged)"}. ` +
            "When you summarise, describe ONLY these actual changes.",
        });
        onEvent({
          type: "tool",
          label: `${nowFilled}/${TOTAL_INDICATORS} indicators filled`,
          detail: added > 0 ? `+${added} just now` : scoreChanges.length ? `revised ${scoreChanges.length}` : "no score change",
        });

        if (nowFilled <= prevFilled) stagnantScores++;
        else stagnantScores = 0;
        prevFilled = nowFilled;

        if (nowFilled === TOTAL_INDICATORS) {
          ctx.transcript.push({ role: "tool", content: "All indicators now have a score. Call finish now (do not re-score existing answers unless the user asks)." });
        }
        if (stagnantScores >= 3) {
          const done = nowFilled === TOTAL_INDICATORS;
          const msg = done
            ? "All indicators are filled. I'll stop here so you can review, tell me if you'd like any specific changes."
            : "I'm not making further progress on my own. I'll pause so you can tell me what to adjust or what information to use.";
          ctx.transcript.push({ role: "assistant", content: msg });
          onEvent({ type: "assistant", text: msg });
          onEvent(done ? { type: "done" } : { type: "stopped" });
          return;
        }
        break;
      }
      case "set_info": {
        const patch = (action.profile || action.info || {}) as Record<string, unknown>;
        const { info, changed } = applyInfo(ctx.info || ({ name: ctx.city || "", country: ctx.country || "" } as CityInfo), patch);
        ctx.info = info;
        onEvent({ type: "info" });
        const keys = Object.keys(patch).filter((k) => patch[k] != null && patch[k] !== "");
        ctx.transcript.push({ role: "tool", content: `Recorded City Information: ${keys.join(", ") || "(nothing usable)"}.` });
        onEvent({ type: "tool", label: "City information updated", detail: keys.slice(0, 6).join(", ") });
        stagnantScores = 0;
        if (changed) stagnantInfo = 0; else stagnantInfo++;
        break;
      }
      case "message": {
        const text = action.text || "…";
        ctx.transcript.push({ role: "assistant", content: text });
        onEvent({ type: "assistant", text });
        return; // wait for the user
      }
      case "finish": {
        const remaining = unfilledCodes(ctx.draft);
        if (autonomous && remaining.length > 0) {
          onEvent({ type: "tool", label: `Not done yet, ${remaining.length} still to fill`, detail: "completing them" });
          ctx.transcript.push({
            role: "tool",
            content: `You cannot finish yet: ${remaining.length} indicator(s) are still unfilled: ${remaining.join(", ")}. Score every one of them now (use a conservative estimate with a note if you must), then finish.`,
          });
          break;
        }
        // One-time nudge: don't finish an autonomous run while required City
        // Information fields are still blank. List exactly what's missing so the
        // agent researches and fills what it can (leaving truly-unknown blank).
        const info = ctx.info || ({} as CityInfo);
        const wantStr: Array<[keyof CityInfo, string]> = [
          ["typeOfCity", "type of city"], ["authorityTitle", "title of highest authority"],
          ["mostLikelyHazard", "most likely hazard"], ["mostSevere", "most severe disaster"],
        ];
        const wantNum: Array<[keyof CityInfo, string]> = [
          ["population", "population"], ["areaKm2", "area (km²)"], ["youthPct", "youth %"],
          ["seniorPct", "senior %"], ["literacyPct", "literacy %"], ["povertyPct", "poverty %"],
          ["incomeUsd", "average household income"],
        ];
        const missing = [
          ...wantStr.filter(([k]) => !info[k]).map(([, l]) => l),
          ...wantNum.filter(([k]) => info[k] == null).map(([, l]) => l),
        ];
        if (autonomous && missing.length >= 2 && !infoNudged) {
          infoNudged = true;
          onEvent({ type: "tool", label: "Filling in the city profile", detail: `${missing.length} field(s) still blank` });
          ctx.transcript.push({
            role: "tool",
            content:
              `The City Information page still has blank fields: ${missing.join(", ")}. ` +
              `Look these up (census / city statistics / reliable sources) and record them with set_info. ` +
              `For any value you genuinely cannot find, leave it out, do NOT invent a number. Then finish.`,
          });
          break;
        }
        const text = action.text || "Done. Review the draft, then load it into the analyzer or download it.";
        ctx.transcript.push({ role: "assistant", content: text });
        onEvent({ type: "assistant", text });
        onEvent({ type: "done" });
        return;
      }
      default:
        ctx.transcript.push({ role: "tool", content: `Unknown action "${action.action}". Use research_city, web_search, set_info, set_scores, message, or finish.` });
    }

    // Global loop guard: if the model keeps repeating the same action, or keeps
    // re-recording City Information that changes nothing, stop rather than spin.
    if (sigRepeat >= 2 || stagnantInfo >= 3) {
      const msg =
        "I seem to be repeating the same step without making progress, so I'll stop here rather than loop. Tell me what you'd like to change, or add any details you have. Tip: if this keeps happening, a search-focused model can struggle with this kind of step-by-step filling, OpenRouter or NVIDIA tend to handle the Assistant best.";
      ctx.transcript.push({ role: "assistant", content: msg });
      onEvent({ type: "assistant", text: msg });
      onEvent({ type: "stopped" });
      return;
    }
  }

  const remaining = unfilledCodes(ctx.draft).length;
  const msg =
    remaining > 0 && autonomous
      ? `I've done a lot of steps and there are still ${remaining} indicator(s) to go. Press Continue and I'll keep filling them.`
      : "Pausing here, review the draft, and tell me anything you'd like to change.";
  ctx.transcript.push({ role: "assistant", content: msg });
  onEvent({ type: "assistant", text: msg });
  onEvent(remaining === 0 ? { type: "done" } : { type: "stopped" });
}
