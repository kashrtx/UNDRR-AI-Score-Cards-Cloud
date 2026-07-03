import { NextRequest, NextResponse } from "next/server";
import { buildDataPack, listSources } from "@/lib/data/adapters/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Model Context Protocol endpoint (Streamable HTTP transport).
 *
 * A dependency-free, spec-compliant JSON-RPC 2.0 handler exposing this app's
 * open-data engine as MCP tools, so Claude Desktop / any MCP client can connect
 * to  https://<your-deployment>/api/mcp  and pull disaster-resilience evidence
 * for any city.
 *
 * Tools:
 *   • list_sources          — list every open-data source the engine can query.
 *   • fetch_location_data   — geocode a city and return the full evidence bundle.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "undrr-arise-scorecard", version: "1.0.0" };

const TOOLS = [
  {
    name: "list_sources",
    description:
      "List every free open-data source this engine can query for a city " +
      "(geocoding, climate, OpenStreetMap infrastructure, USGS earthquakes, " +
      "World Bank indicators, ReliefWeb disaster history, and config-driven APIs).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "fetch_location_data",
    description:
      "Geocode a city and gather a grounded, provenance-tagged evidence bundle " +
      "from every open-data source: climate statistics, infrastructure counts, " +
      "seismic history, national indicators and recent disasters. Returns JSON " +
      "with sources, dataPoints, data[] and warnings[].",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. 'Kathmandu'." },
        country: {
          type: "string",
          description: "Optional country to disambiguate the city, e.g. 'Nepal'.",
        },
      },
      required: ["city"],
      additionalProperties: false,
    },
  },
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcId, payload: unknown) {
  return { jsonrpc: "2.0" as const, id, result: payload };
}
function error(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === "list_sources") {
    return {
      content: [{ type: "text", text: JSON.stringify(listSources(), null, 2) }],
    };
  }
  if (name === "fetch_location_data") {
    const city = String(args.city ?? "").trim();
    if (!city) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: 'city' is required." }],
      };
    }
    const country = args.country ? String(args.country).trim() : undefined;
    const pack = await buildDataPack(city, country);
    return {
      content: [{ type: "text", text: JSON.stringify(pack, null, 2) }],
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
}

async function handleRpc(msg: JsonRpcRequest) {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Use fetch_location_data to gather disaster-resilience evidence for a city.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification — no response
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments as Record<string, unknown>) ?? {};
      try {
        return result(id, await callTool(name, args));
      } catch (err) {
        return error(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }
    default:
      return error(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(req: NextRequest) {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(error(null, -32700, "Parse error"), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  // Support JSON-RPC batches.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handleRpc))).filter(Boolean);
    if (!responses.length) return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
    return NextResponse.json(responses, { headers: CORS_HEADERS });
  }

  const response = await handleRpc(body);
  if (response === null) {
    // Pure notification — acknowledge with 202 and no body.
    return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  }
  return NextResponse.json(response, { headers: CORS_HEADERS });
}

export async function GET() {
  // This server does not open a server-initiated SSE stream; clients POST.
  return NextResponse.json(
    {
      service: "undrr-arise-scorecard MCP endpoint",
      transport: "streamable-http",
      protocolVersion: PROTOCOL_VERSION,
      tools: TOOLS.map((t) => t.name),
      hint: "POST JSON-RPC 2.0 messages here (initialize, tools/list, tools/call).",
    },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
