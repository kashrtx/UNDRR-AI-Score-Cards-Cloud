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
import { applyScores, filledCount, unfilledCodes, type Draft } from "./draft";

export type TranscriptItem =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string };

export type AgentEvent =
  | { type: "thinking"; on: boolean }
  | { type: "assistant"; text: string }
  | { type: "tool"; label: string; detail?: string }
  | { type: "draft" }
  | { type: "done" }
  | { type: "error"; text: string };

export interface AgentContext {
  provider: LLMProvider;
  transcript: TranscriptItem[];
  draft: Draft;
  searchKey?: string | null;
}

const MAX_STEPS = 16;

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

const SYSTEM = `You are a careful, friendly assistant that helps a city official complete the UNDRR ARISE "Disaster Resilience Scorecard for Cities" (Preliminary version). There are ${TOTAL_INDICATORS} indicators grouped under the Ten Essentials. Each indicator is scored 0 to 3.

SCORING RUBRIC (0-3):
  0 = No / none / not in place at all.
  1 = Limited or ad hoc; early efforts only; major gaps.
  2 = Substantial but incomplete; in place with notable gaps.
  3 = Comprehensive; fully in place, resourced, and reviewed.

THE INDICATORS:
${indicatorList()}

HOW YOU WORK:
- You reply with EXACTLY ONE JSON object per turn and NOTHING else. No prose outside the JSON, no markdown fences.
- Choose the single best next action:
  {"action":"research_city","city":"<name>","country":"<name>"}  — gather open data + web facts about the city (climate, hazards, infrastructure, population). Do this once early when you know the city.
  {"action":"web_search","query":"<query>"}  — look up a specific fact (e.g. "Toronto emergency management office budget", "Toronto early warning system").
  {"action":"set_scores","scores":[{"code":"P1.1","score":2,"note":"<one short sentence on the basis>"}, ...]}  — fill one or more indicators. You may set many at once.
  {"action":"message","text":"<what you want to say or ask the user>"}  — talk to the user and WAIT for their reply. Use this to ask for information only the city would know.
  {"action":"finish","text":"<friendly wrap-up>"}  — only when ALL ${TOTAL_INDICATORS} indicators have a score.

RULES:
- Base every score on evidence: the user's statements, research results, or open data. Never invent specific facts, budgets, or programme names.
- When an indicator depends on internal information only the city would know (plans, budgets, procedures) and you have no evidence, either ask the user with a "message", or set a conservative score with a note that clearly says it is an assumption to verify.
- Keep notes to one short sentence naming the basis (e.g. "Based on city's flood plan mentioned by user" or "Assumption — please verify").
- Prefer to set scores in reasonable batches (for example, one Essential at a time). Re-check the "unfilled" list before finishing.
- Be efficient: research once, then fill. Do not repeat the same search.
- If the user asked you to fill it autonomously, only use "message" when you genuinely need information you cannot research.`;

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
  action: string;
  city?: string;
  country?: string;
  query?: string;
  text?: string;
  scores?: Array<{ code?: string; score?: number; note?: string }>;
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
async function researchTool(city: string, country: string | undefined, searchKey?: string | null): Promise<string> {
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
    if (dataRes.status === "fulfilled" && dataRes.value) {
      const dp = dataRes.value as { data?: Array<{ label: string; value: unknown; unit?: string }> };
      const pts = (dp.data || [])
        .slice(0, 18)
        .map((p) => `- ${p.label}: ${p.value}${p.unit ? " " + p.unit : ""}`);
      if (pts.length) lines.push("Open data:", ...pts);
    }
    if (refRes.status === "fulfilled" && refRes.value) {
      const rf = refRes.value as { answer?: string; passages?: Array<{ text: string }> };
      if (rf.answer) lines.push("", "Web summary:", rf.answer.slice(0, 900));
      for (const p of (rf.passages || []).slice(0, 4)) lines.push("- " + p.text.slice(0, 240));
    }
    return lines.length ? lines.join("\n") : "No open data or web results were found for that city.";
  } catch (e) {
    return `Research failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function searchTool(query: string, searchKey?: string | null): Promise<string> {
  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, searchApiKey: searchKey || undefined }),
    });
    if (!res.ok) return `Search failed (HTTP ${res.status}).`;
    const r = (await res.json()) as { answer?: string; results?: Array<{ title: string; content: string }> };
    const lines: string[] = [];
    if (r.answer) lines.push(r.answer.slice(0, 800));
    for (const it of (r.results || []).slice(0, 5)) lines.push(`- ${it.title}: ${(it.content || "").slice(0, 200)}`);
    return lines.length ? lines.join("\n") : "No results.";
  } catch (e) {
    return `Search failed: ${e instanceof Error ? e.message : String(e)}`;
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

  return `${history || "(no messages yet)"}

CURRENT DRAFT: ${filled}/${TOTAL_INDICATORS} filled.${draftLines ? ` Scores so far: ${draftLines}.` : ""}
${unfilled.length ? `Still unfilled: ${unfilled.join(", ")}.` : "All indicators are filled."}

Output ONLY the next action as a single JSON object.`;
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
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return;
    onEvent({ type: "thinking", on: true });

    let raw = "";
    try {
      raw = await ctx.provider.complete(SYSTEM, buildUser(ctx), undefined, signal);
    } catch (e) {
      onEvent({ type: "thinking", on: false });
      if (signal?.aborted) return;
      onEvent({ type: "error", text: e instanceof Error ? e.message : String(e) });
      return;
    }
    onEvent({ type: "thinking", on: false });

    const action = parseAction(raw);
    if (!action) {
      ctx.transcript.push({ role: "tool", content: "Your last reply was not a single valid JSON action. Reply with exactly one JSON object." });
      continue;
    }

    switch (action.action) {
      case "research_city": {
        const city = action.city || "";
        onEvent({ type: "tool", label: `Researching ${city || "the city"}…` });
        const obs = await researchTool(city, action.country, ctx.searchKey);
        ctx.transcript.push({ role: "tool", content: `research_city(${city}):\n${obs}` });
        onEvent({ type: "tool", label: `Researched ${city || "the city"}`, detail: "open data + web" });
        break;
      }
      case "web_search": {
        const q = action.query || "";
        onEvent({ type: "tool", label: `Searching: ${q}` });
        const obs = await searchTool(q, ctx.searchKey);
        ctx.transcript.push({ role: "tool", content: `web_search(${q}):\n${obs}` });
        break;
      }
      case "set_scores": {
        const n = applyScores(ctx.draft, action.scores || []);
        onEvent({ type: "draft" });
        const filled = filledCount(ctx.draft);
        ctx.transcript.push({ role: "tool", content: `Applied ${n} score(s). ${filled}/${TOTAL_INDICATORS} filled.` });
        onEvent({ type: "tool", label: `Filled ${n} indicator${n === 1 ? "" : "s"}`, detail: `${filled}/${TOTAL_INDICATORS} complete` });
        break;
      }
      case "message": {
        const text = action.text || "…";
        ctx.transcript.push({ role: "assistant", content: text });
        onEvent({ type: "assistant", text });
        return; // wait for the user
      }
      case "finish": {
        const text = action.text || "All done. Review the draft, then load it into the analyzer or download it.";
        ctx.transcript.push({ role: "assistant", content: text });
        onEvent({ type: "assistant", text });
        onEvent({ type: "done" });
        return;
      }
      default:
        ctx.transcript.push({ role: "tool", content: `Unknown action "${action.action}". Use research_city, web_search, set_scores, message, or finish.` });
    }
  }

  const msg = "I've taken several steps. Let me pause so you can review the draft and tell me what to adjust or continue.";
  ctx.transcript.push({ role: "assistant", content: msg });
  onEvent({ type: "assistant", text: msg });
}
