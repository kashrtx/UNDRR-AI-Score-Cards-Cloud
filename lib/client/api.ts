/**
 * Thin client wrappers around the two stateless server routes:
 *   • /api/scorecard/parse  — upload an .xlsm, get back the NormalizedScorecard
 *   • /api/data/fetch       — get the open-data evidence bundle for a city
 *
 * All state (scorecard, settings, results) lives in the browser; the server
 * holds nothing between requests.
 */

import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import type { DataPack, ReferenceFacts } from "@/lib/types";

export async function uploadScorecard(file: File): Promise<NormalizedScorecard> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/scorecard/parse", { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Upload failed");
  }
  return res.json();
}

export async function fetchDataPack(city: string, country?: string): Promise<DataPack> {
  const res = await fetch("/api/data/fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ city, country }),
  });
  if (!res.ok) throw new Error(`Failed to fetch open data: ${res.statusText}`);
  return res.json();
}

export async function fetchReferenceFacts(
  city: string,
  country?: string
): Promise<ReferenceFacts | null> {
  try {
    const res = await fetch("/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city, country }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ReferenceFacts | null;
  } catch {
    return null;
  }
}
