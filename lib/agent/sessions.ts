/**
 * Assistant chat sessions — saved in the browser so you can leave, come back,
 * and pick up any scorecard you were working on. Each session holds the place
 * (city or area), notes and attached reference docs, plus one "lane" per AI
 * helper: that helper's chat, agent transcript, working draft and City
 * Information. Nothing leaves the browser.
 */

import type { Draft, CityInfo } from "./draft";
import type { TranscriptItem } from "./agent";
import type { FillRecord } from "./usageLog";
import type { SourceRegistry } from "./sources";
import { filledCount } from "./draft";
import { formatKm2, type AreaSelection } from "@/lib/geo/area";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "reasoning"; summary: string; detail?: string; seconds?: number }
  | { kind: "tool"; label: string; detail?: string; /** Ids of chosen data sources this step cites (shown as chips). */ sources?: string[] };

export interface Attachment {
  name: string;
  text: string;
}

/** One AI helper's own copy of the scorecard and its conversation. */
export interface LaneData {
  chat: ChatItem[];
  transcript: TranscriptItem[];
  draft: Draft;
  profile?: CityInfo;
  /** Requests, tokens and cost of this helper's current fill (see usageLog). */
  fill?: FillRecord | null;
  /** The tagged sources this helper was shown, so its answers' links survive a reload. */
  sources?: SourceRegistry;
}

export function emptyLane(): LaneData {
  return { chat: [], transcript: [], draft: {} };
}

export interface AssistantSession {
  id: string;
  title: string;
  city: string;
  country: string;
  /** ISO alpha-2 behind the Country dropdown (older sessions only have the name). */
  countryCode?: string;
  /** State/province name, for countries that have them. */
  region?: string;
  info: string;
  /** Each AI helper's lane, keyed by provider id. */
  lanes?: Record<string, LaneData>;
  /** Single-helper sessions saved before lanes existed (read once, then moved into a lane). */
  chat?: ChatItem[];
  transcript?: TranscriptItem[];
  draft?: Draft;
  profile?: CityInfo;
  attachments: Attachment[];
  /** "area" when the scorecard is for a drawn/loaded area rather than a whole city. */
  setupMode?: "city" | "area";
  area?: AreaSelection | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  filled: number;
  preview: string;
}

function previewOf(chat: ChatItem[]): string {
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m.kind === "user" || m.kind === "assistant" || m.kind === "thought") {
      if (m.text && m.text.trim()) return m.text.trim().slice(0, 100);
    } else if (m.kind === "reasoning" && m.summary) {
      return m.summary.trim().slice(0, 100);
    } else if (m.kind === "tool" && m.label) {
      return m.label.slice(0, 100);
    }
  }
  return "No messages yet";
}

const INDEX_KEY = "undrr.assistant.index";
const ACTIVE_KEY = "undrr.assistant.active";
const sessionKey = (id: string) => `undrr.assistant.s.${id}`;

function safeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFor(s: Pick<AssistantSession, "city" | "country" | "region" | "area" | "setupMode">): string {
  if (s.setupMode === "area" && s.area) {
    return `Area · ${s.area.label || s.city?.trim() || formatKm2(s.area.areaKm2)}`;
  }
  const c = s.city?.trim();
  if (c) return [c, s.region?.trim(), s.country?.trim()].filter(Boolean).join(", ");
  return "New scorecard";
}

export function createSession(partial?: Partial<AssistantSession>): AssistantSession {
  const now = Date.now();
  const base: AssistantSession = {
    id: newId(),
    title: "New scorecard",
    city: "",
    country: "",
    info: "",
    lanes: {},
    attachments: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
  base.title = titleFor(base);
  return base;
}

export function listSessions(): SessionMeta[] {
  const idx = safeGet<SessionMeta[]>(INDEX_KEY) ?? [];
  return [...idx].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSession(id: string): AssistantSession | null {
  return safeGet<AssistantSession>(sessionKey(id));
}

export function saveSession(s: AssistantSession): void {
  try {
    s.updatedAt = Date.now();
    s.title = titleFor(s);
    localStorage.setItem(sessionKey(s.id), JSON.stringify(s));
    const idx = (safeGet<SessionMeta[]>(INDEX_KEY) ?? []).filter((m) => m.id !== s.id);
    const lanes = Object.values(s.lanes || {});
    const filled = Math.max(0, filledCount(s.draft || {}), ...lanes.map((l) => filledCount(l.draft || {})));
    const busiest = lanes.reduce<LaneData | undefined>((a, l) => ((l.chat?.length || 0) > (a?.chat?.length || 0) ? l : a), undefined);
    idx.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, filled, preview: previewOf(busiest?.chat || s.chat || []) });
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch {
    /* quota — non-fatal */
  }
}

/**
 * The session's lanes, moving a pre-lanes session's single chat and draft into
 * the lane of `fallbackProvider` (the first helper picked in Settings).
 */
export function lanesOf(s: AssistantSession, fallbackProvider: string): Record<string, LaneData> {
  if (s.lanes && Object.keys(s.lanes).length) return s.lanes;
  if (s.chat?.length || Object.keys(s.draft || {}).length) {
    return { [fallbackProvider]: { chat: s.chat || [], transcript: s.transcript || [], draft: s.draft || {}, profile: s.profile } };
  }
  return {};
}

export function deleteSession(id: string): void {
  try {
    localStorage.removeItem(sessionKey(id));
    const idx = (safeGet<SessionMeta[]>(INDEX_KEY) ?? []).filter((m) => m.id !== id);
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch {
    /* non-fatal */
  }
}

export function getActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* non-fatal */
  }
}
