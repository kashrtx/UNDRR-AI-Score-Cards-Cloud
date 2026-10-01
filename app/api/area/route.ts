import { NextRequest, NextResponse } from "next/server";
import { checkCity, describeArea, searchPlaces } from "@/lib/geo/placeLookup";
import { makeArea, validateArea, type LonLat } from "@/lib/geo/area";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/area
 * Body: { action: "search", q: string }            → { results: PlaceHit[] }
 *     | { action: "describe", ring: [lon, lat][] } → AreaDescription
 *     | { action: "checkCity", city, country?, countryCode?, regionCode? } → { found, displayName }
 *
 * Runs server-side so Nominatim gets our polite User-Agent. Stateless.
 */
export async function POST(req: NextRequest) {
  let body: {
    action?: string; q?: string; ring?: LonLat[];
    city?: string; country?: string; countryCode?: string; regionCode?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    if (body.action === "search") {
      const q = (body.q ?? "").trim().slice(0, 200);
      if (!q) return NextResponse.json({ error: "Missing 'q'." }, { status: 400 });
      return NextResponse.json({ results: await searchPlaces(q) });
    }
    if (body.action === "checkCity") {
      const city = (body.city ?? "").trim().slice(0, 120);
      if (!city) return NextResponse.json({ error: "Missing 'city'." }, { status: 400 });
      const cc = /^[A-Za-z]{2}$/.test(body.countryCode ?? "") ? body.countryCode : undefined;
      const rc = /^[A-Za-z]{2}-[A-Za-z0-9]{1,3}$/.test(body.regionCode ?? "") ? body.regionCode : undefined;
      return NextResponse.json(await checkCity(city, (body.country ?? "").trim().slice(0, 120) || undefined, cc, rc));
    }
    if (body.action === "describe") {
      if (!Array.isArray(body.ring)) return NextResponse.json({ error: "Missing 'ring'." }, { status: 400 });
      const area = makeArea(body.ring.slice(0, 5000), "polygon");
      const problem = validateArea(area);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      return NextResponse.json(await describeArea(area.ring));
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: `Place lookup failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
