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
}

const MAX_STEPS = 16;

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
    parts.push(`E${e} — ${ESSENTIAL_NAMES[e]}`);
    parts.push((byE.get(e) || []).join("\n"));
  }
  return parts.join("\n");
}

const SYSTEM = `You are a careful, friendly assistant that helps a city official complete the UNDRR ARISE "Disaster Resilience Scorecard for Cities" (Preliminary version). The scorecard has two parts you can fill:
  1. A CITY INFORMATION page (basic facts about the city).
  2. ${TOTAL_INDICATORS} scored indicators grouped under the Ten Essentials, each scored 0 to 3.

You are like a person with the real scorecard file open, filling it in as you go. Fill BOTH the City Information page and the indicators.

CITY INFORMATION FIELDS you can record with set_info (fill any you can find from research; leave the rest):
  typeOfCity (e.g. "Municipality"), authorityTitle (e.g. "Mayor"), population (number),
  areaKm2 (number), density (per km², number), youthPct, seniorPct, femaleHeadedPct,
  literacyPct, povertyPct, incomeUsd (average household income), nonCitizenPct,
  hazards (list of the main hazards), mostLikelyHazard (the single most likely known hazard),
  mostSevere (the most severe disaster known, a short phrase).

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
  {"thought":"...","action":"research_city","city":"<name>","country":"<name>"}  — gather open data + web facts about the city (climate, hazards, infrastructure, population). Do this once early when you know the city.
  {"thought":"...","action":"web_search","query":"<query>"}  — look up a specific fact (e.g. "Toronto emergency management office budget", "Toronto early warning system").
  {"thought":"...","action":"set_info","profile":{"population":134000,"areaKm2":385,"mostLikelyHazard":"Earthquake","mostSevere":"2010 M7.0 earthquake","hazards":["Earthquake","Flooding","Hurricane"]}}  — record City Information fields you have learned. Send only the fields you know.
  {"thought":"...","action":"set_scores","scores":[{"code":"P1.1","score":2,"note":"<one short sentence on the basis>"}, ...]}  — fill one or more indicators. Include a note for EVERY indicator you score.
  {"thought":"...","action":"message","text":"<what you want to say or ask the user>"}  — talk to the user and WAIT for their reply. Use this to ask for information only the city would know, or when the city name is missing.
  {"thought":"...","action":"finish","text":"<friendly wrap-up>"}  — only when the City Information you could find is recorded AND all ${TOTAL_INDICATORS} indicators have a score.

RULES:
- You need to know the target city. If no city has been provided, your FIRST action must be a "message" asking which city this scorecard is for. Do not guess a city.
- After researching, record what you learned about the city with set_info BEFORE or ALONGSIDE scoring — do not skip the City Information page. If the user ever asks about "the info page" or "city info", they mean this; use set_info.
- SCOPE: If the user asks for help with only specific indicators or a limited change ("help me with P3.2", "review Essential 5", "what about early warning?"), do ONLY that and then finish or ask a follow-up. Do NOT fill or re-score everything. Only complete the whole scorecard when the user clearly asks you to (e.g. "fill it out for me", "complete the rest").
- Base every score on evidence: the user's statements, research results, open data, or attached documents. Never invent specific facts, budgets, or programme names.
- When an indicator depends on internal information only the city would know and you have no evidence, either ask the user with a "message", or set a conservative score with a note that clearly says it is an assumption to verify.
- Give EVERY scored indicator a one-sentence note naming the basis.
- Score at most one or two Essentials (about ten indicators) per set_scores call, so the user sees steady progress and responses stay quick.
- Do NOT re-score indicators that already have a score unless the user asked you to change them. Once every indicator you were asked to handle is set, call "finish".
- Do NOT announce running totals or how many indicators you have completed ("I've done 12 of 47") — the app tracks and displays the authoritative progress. In your thought, just say which Essential or indicators you are about to score.
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
  const history = ctx.transcript
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
    : "No city has been provided yet — ask the user which city this is for before scoring.";

  const atts = ctx.attachments || [];
  const attBlock = atts.length
    ? "REFERENCE DOCUMENTS THE USER ATTACHED (use these as evidence where relevant):\n" +
      atts.map((a) => `--- ${a.name} ---\n${a.text.slice(0, 4000)}${a.text.length > 4000 ? "\n…(truncated)" : ""}`).join("\n\n") +
      "\n\n"
    : "";

  const modeLine =
    ctx.mode === "autonomous"
      ? "TASK: complete the ENTIRE scorecard — record the City Information you can find (set_info) AND score all indicators."
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
    : "CITY INFORMATION page is still EMPTY — record what you can with set_info.";

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
  let infoNudged = false;
  const autonomous = ctx.mode === "autonomous";

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) {
      onEvent({ type: "stopped" });
      return;
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
        text: (e instanceof Error ? e.message : String(e)) + " — you can press Continue to retry, or switch model in Settings first",
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

    switch (action.action) {
      case "research_city": {
        const cityName = action.city || ctx.city || "";
        onEvent({ type: "tool", label: `Researching ${cityName || "the city"}…` });
        const { text, method } = await researchTool(cityName, action.country || ctx.country, ctx.searchKey);
        ctx.transcript.push({ role: "tool", content: `research_city(${cityName}):\n${text}` });
        onEvent({ type: "tool", label: `Researched ${cityName || "the city"}`, detail: method });
        stagnantScores = 0;
        break;
      }
      case "web_search": {
        const q = action.query || "";
        onEvent({ type: "tool", label: "Web search", detail: q.slice(0, 70) });
        const { text, method } = await searchTool(q, ctx.searchKey);
        ctx.transcript.push({ role: "tool", content: `web_search(${q}):\n${text}` });
        onEvent({ type: "tool", label: `Searched (${method})`, detail: q.slice(0, 60) });
        stagnantScores = 0;
        break;
      }
      case "set_scores": {
        const n = applyScores(ctx.draft, action.scores || []);
        onEvent({ type: "draft" });
        const nowFilled = filledCount(ctx.draft);
        const added = Math.max(0, nowFilled - prevFilled); // newly-filled indicators
        ctx.transcript.push({ role: "tool", content: `Applied ${n} score(s). ${nowFilled}/${TOTAL_INDICATORS} filled.` });
        onEvent({
          type: "tool",
          label: `${nowFilled}/${TOTAL_INDICATORS} indicators filled`,
          detail: added > 0 ? `+${added} just now` : n > 0 ? `revised ${n}` : "no change",
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
            ? "All indicators are filled. I'll stop here so you can review — tell me if you'd like any specific changes."
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
          onEvent({ type: "tool", label: `Not done yet — ${remaining.length} still to fill`, detail: "completing them" });
          ctx.transcript.push({
            role: "tool",
            content: `You cannot finish yet: ${remaining.length} indicator(s) are still unfilled: ${remaining.join(", ")}. Score every one of them now (use a conservative estimate with a note if you must), then finish.`,
          });
          break;
        }
        // One-time nudge: don't finish an autonomous run with a blank City
        // Information page if research clearly turned up city facts.
        const infoEmpty = !ctx.info || (ctx.info.population == null && !ctx.info.mostSevere && !ctx.info.mostLikelyHazard && !(ctx.info.hazards && ctx.info.hazards.length));
        if (autonomous && infoEmpty && !infoNudged) {
          infoNudged = true;
          onEvent({ type: "tool", label: "One more thing", detail: "recording city information" });
          ctx.transcript.push({
            role: "tool",
            content: "Before finishing, record the City Information page with set_info (population, area, main hazards, most severe disaster, income if known) using what your research found. Then finish.",
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
  }

  const remaining = unfilledCodes(ctx.draft).length;
  const msg =
    remaining > 0 && autonomous
      ? `I've done a lot of steps and there are still ${remaining} indicator(s) to go. Press Continue and I'll keep filling them.`
      : "Pausing here — review the draft, and tell me anything you'd like to change.";
  ctx.transcript.push({ role: "assistant", content: msg });
  onEvent({ type: "assistant", text: msg });
  onEvent(remaining === 0 ? { type: "done" } : { type: "stopped" });
}
