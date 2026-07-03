import { NextResponse } from "next/server";
import { listSources } from "@/lib/data/adapters/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "undrr-arise-scorecard-analyzer",
    version: "1.0.0",
    // All LLM calls run in the browser; the server only hosts data + parsing.
    dataSources: listSources(),
    timestamp: new Date().toISOString(),
  });
}
