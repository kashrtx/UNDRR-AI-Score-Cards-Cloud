import { NextRequest, NextResponse } from "next/server";
import { buildDataPack } from "@/lib/data/adapters/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/data/fetch
 * Body: { city: string, country?: string }
 * Returns: the DataPack evidence bundle (sources, dataPoints, data, provenance).
 *
 * Runs server-side so open APIs that dislike browser CORS (Nominatim, Overpass)
 * work, and so we can send polite User-Agent + rate-limit-friendly requests.
 */
export async function POST(req: NextRequest) {
  let body: { city?: string; country?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const city = (body.city ?? "").trim();
  const country = (body.country ?? "").trim() || undefined;
  if (!city) {
    return NextResponse.json(
      { error: "Missing 'city'. Provide the city name to fetch open data for." },
      { status: 400 }
    );
  }

  try {
    const pack = await buildDataPack(city, country);
    return NextResponse.json(pack);
  } catch (err) {
    // buildDataPack degrades gracefully, but guard anyway.
    return NextResponse.json(
      {
        city,
        country,
        resolved: null,
        sources: [],
        dataPoints: 0,
        data: [],
        warnings: [
          `Data fetch failed: ${err instanceof Error ? err.message : String(err)}. ` +
            "Analysis can still run on the scorecard alone.",
        ],
      },
      { status: 200 }
    );
  }
}
