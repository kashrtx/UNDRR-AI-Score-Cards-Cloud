/**
 * Assistant chat sessions — saved in the browser so you can leave, come back,
 * and pick up any scorecard you were working on. Each session holds its chat,
 * the agent transcript, the working draft, any attached reference docs, and the
 * city. Nothing leaves the browser.
 */

import type { Draft } from "./draft";
import type { TranscriptItem } from "./agent";
import { filledCount } from "./draft";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; label: string; detail?: string };

export interface Attachment {
  name: string;
  text: string;
}

export interface AssistantSession {
  id: string;
  title: string;
  city: string;
  country: string;
  info: string;
  chat: ChatItem[];
  transcript: TranscriptItem[];
  draft: Draft;
  attachments: Attachment[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  filled: number;
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

export function titleFor(s: Pick<AssistantSession, "city" | "country">): string {
  const c = s.city?.trim();
  if (c) return s.country?.trim() ? `${c}, ${s.country.trim()}` : c;
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
    chat: [],
    transcript: [],
    draft: {},
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
    idx.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, filled: filledCount(s.draft) });
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch {
    /* quota — non-fatal */
  }
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
