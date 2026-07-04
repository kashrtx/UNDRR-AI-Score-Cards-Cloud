/**
 * LLM proxy — a thin, streaming pass-through for OpenAI-compatible providers
 * that don't allow direct browser calls (OpenAI, xAI, z.AI, NVIDIA NIM, Meta).
 *
 * Why this exists: the app calls LLMs from the browser to avoid serverless
 * timeouts on long streams and to keep keys off any shared server. Providers
 * like Anthropic, Gemini and OpenRouter allow browser (CORS) calls, so those
 * stay client-side. The five here block browser CORS, so we forward the request
 * from this route (same origin as the app, no CORS problem) and stream the
 * response straight back.
 *
 * The API key is sent per-request from the browser and used once here; it is
 * never stored or logged. The upstream base URL is whitelisted (the client
 * sends a provider id, not a URL) to avoid SSRF.
 *
 * Note: on Vercel Hobby, a function may run up to 60s. A very slow reasoning
 * model could exceed that and get cut off; use a faster model or Vercel Pro
 * (maxDuration up to 300s) for heavy reasoning workloads.
 */

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  nvidia: "https://integrate.api.nvidia.com/v1",
  meta: "https://api.llama.com/compat/v1",
};

export async function POST(req: NextRequest) {
  let payload: { provider?: string; apiKey?: string; body?: unknown };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body." } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const base = payload.provider ? BASE[payload.provider] : undefined;
  if (!base || !payload.apiKey || !payload.body) {
    return new Response(
      JSON.stringify({ error: { message: "Missing or unknown provider, apiKey, or body." } }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${payload.apiKey}`,
      },
      body: JSON.stringify(payload.body),
      signal: req.signal,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: { message: `Could not reach the provider: ${err instanceof Error ? err.message : String(err)}` },
      }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  // Stream the upstream body straight back, preserving status + content type
  // (text/event-stream when streaming, application/json for the test ping).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}
