import { NextRequest, NextResponse } from "next/server";
import { agentWebSearch } from "@/lib/data/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/search
 * Body: { query: string, searchApiKey?: string }
 * A general web search for the fill-out assistant (Tavily / SearXNG / DuckDuckGo).
 * Stateless; the key (if any) is used once and not stored.
 */
export async function POST(req: NextRequest) {
  let body: { query?: string; searchApiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.query || !body.query.trim()) {
    return NextResponse.json({ error: "Missing query." }, { status: 400 });
  }
  const result = await agentWebSearch(body.query.trim(), body.searchApiKey);
  return NextResponse.json(result);
}
