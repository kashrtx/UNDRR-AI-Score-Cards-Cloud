import { NextRequest, NextResponse } from "next/server";
import { readDocument } from "@/lib/data/document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/document
 * Body: { url: string, topic?: string, searchApiKey?: string }
 * (searchApiKey: the user's Tavily key, used for Tavily Extract when the site
 * refuses direct reading or the document is a PDF; never stored.)
 * Returns: DocumentResult — the passages of the page most relevant to `topic`.
 *
 * Used by the Assistant's read_document step to read a page an AI helper was
 * shown in full (see lib/data/document.ts for the safety limits). Stateless.
 */
export async function POST(req: NextRequest) {
  let body: { url?: string; topic?: string; searchApiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, url: "", passages: [], error: "Invalid JSON body." }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, url, passages: [], error: "Missing or invalid url." }, { status: 400 });
  }
  return NextResponse.json(await readDocument(url, (body.topic ?? "").slice(0, 300), body.searchApiKey));
}
