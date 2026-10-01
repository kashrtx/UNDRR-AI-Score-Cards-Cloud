import { NextRequest, NextResponse } from "next/server";
import { buildDataPack, type AreaInput } from "@/lib/data/adapters/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/data/fetch
 * Body: { city: string, country?: string, area?: { ring: [lon, lat][], label?, countryCode? } }
 *   With `area`, data is gathered for that drawn polygon instead of the city name
 *   (city/country then just name the jurisdiction it sits in).
 * Returns: the DataPack evidence bundle (sources, dataPoints, data, provenance).
 *
 * Runs server-side so open APIs that dislike browser CORS (Nominatim, Overpass)
 * work, and so we can send polite User-Agent + rate-limit-friendly requests.
 */
export async function POST(req: NextRequest) {
  let body: { city?: string; country?: string; area?: AreaInput };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const city = (body.city ?? "").trim();
  const country = (body.country ?? "").trim() || undefined;
  const area = body.area && Array.isArray(body.area.ring) && body.area.ring.length >= 3
    ? { ring: body.area.ring.slice(0, 5000), label: body.area.label, countryCode: body.area.countryCode }
    : undefined;
  if (!city && !area) {
    return NextResponse.json(
      { error: "Missing 'city'. Provide the city name to fetch open data for." },
      { status: 400 }
    );
  }

  try {
    const pack = await buildDataPack(city, country, area);
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
