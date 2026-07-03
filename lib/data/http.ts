/**
 * Tiny HTTP helper shared by every data adapter (server-side).
 * Sends a polite User-Agent (several open APIs require one),
 * applies per-request timeouts, and never throws for "no data".
 */

import type { Provenance } from "@/lib/types";

export const USER_AGENT =
  "UNDRR-ARISE-Scorecard/1.0 (disaster-resilience assessment tool)";

export function nowIso(): string {
  return new Date().toISOString();
}

export function provenance(
  source: string,
  dataset: string,
  query: string,
  url: string
): Provenance {
  return { source, dataset, retrievedAt: nowIso(), query, url };
}

export function buildUrl(base: string, params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) sp.set(k, String(v));
  }
  return `${base}?${sp.toString()}`;
}

export async function getJson<T = unknown>(
  url: string,
  opts: { timeoutMs?: number; retries?: number; headers?: Record<string, string> } = {}
): Promise<T> {
  const { timeoutMs = 8000, retries = 0, headers } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function postForm<T = unknown>(
  url: string,
  body: string,
  timeoutMs = 12000
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Overpass`);
  return (await res.json()) as T;
}
