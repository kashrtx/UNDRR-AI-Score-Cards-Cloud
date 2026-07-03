import { NextRequest, NextResponse } from "next/server";
import { parseXlsmBuffer } from "@/lib/scorecard/parseXlsm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/scorecard/parse
 * Body: multipart/form-data with a "file" field (.xlsm / .xlsx / .xls).
 * Returns: the NormalizedScorecard JSON. Stateless — the client keeps the result.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "No file uploaded. Attach a completed scorecard under the 'file' field." },
        { status: 400 }
      );
    }

    const blob = file as File;
    const name = blob.name || "scorecard.xlsx";
    if (!/\.(xlsm|xlsx|xls)$/i.test(name)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${name}. Please upload a .xlsm, .xlsx or .xls file.` },
        { status: 400 }
      );
    }

    const buffer = new Uint8Array(await blob.arrayBuffer());
    if (buffer.byteLength === 0) {
      return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });
    }

    const scorecard = parseXlsmBuffer(buffer);
    return NextResponse.json(scorecard);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "Could not read that scorecard. Make sure it's an official UNDRR " +
          "Preliminary/Detailed Scorecard workbook. " +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 422 }
    );
  }
}
