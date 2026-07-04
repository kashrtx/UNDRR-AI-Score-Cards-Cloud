import { NextRequest, NextResponse } from "next/server";
import { researchCity } from "@/lib/data/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/research
 * Body: { city: string, country?: string }
 * Returns: ReferenceFacts | null  (verified facts from Wikipedia + Wikidata)
 *
 * Best-effort grounding used by every provider. Always returns 200 with either
 * the facts or null so the analysis pipeline can proceed regardless.
 */
export async function POST(req: NextRequest) {
  let body: { city?: string; country?: string; searchApiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(null, { status: 200 });
  }
  const city = (body.city ?? "").trim();
  const country = (body.country ?? "").trim() || undefined;
  if (!city) return NextResponse.json(null, { status: 200 });

  try {
    const facts = await researchCity(city, country, body.searchApiKey);
    return NextResponse.json(facts, { status: 200 });
  } catch {
    return NextResponse.json(null, { status: 200 });
  }
}
