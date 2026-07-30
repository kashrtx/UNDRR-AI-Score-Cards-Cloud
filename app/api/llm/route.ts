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
 * Note: on Vercel Hobby, a function may run up to 120s. A very slow reasoning
 * model could exceed that and get cut off; use a faster model or Vercel Pro
 * (maxDuration up to 300s) for heavy reasoning workloads.
 */

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  nvidia: "https://integrate.api.nvidia.com/v1",
  meta: "https://api.llama.com/compat/v1",
  perplexity: "https://api.perplexity.ai",
};

export async function POST(req: NextRequest) {
  let payload: {
    provider?: string;
    apiKey?: string;
    body?: unknown;
    azure?: { endpoint?: string; deployment?: string; apiVersion?: string };
  };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body." } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!payload.apiKey || !payload.body) {
    return new Response(
      JSON.stringify({ error: { message: "Missing apiKey or body." } }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // Build the upstream URL + auth headers. Azure OpenAI (Microsoft's API-key
  // service, and what Copilot runs on) has its own URL shape and uses an
  // `api-key` header instead of a bearer token.
  let url: string;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (payload.provider === "azure") {
    const az = payload.azure || {};
    const endpoint = (az.endpoint || "").trim().replace(/\/+$/, "");
    const deployment = (az.deployment || "").trim();
    const apiVersion = (az.apiVersion || "2024-10-21").trim();
    let host: string;
    try {
      host = new URL(endpoint).hostname;
    } catch {
      return new Response(JSON.stringify({ error: { message: "Invalid Azure endpoint URL." } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    // SSRF guard: only allow Azure hostnames.
    if (!/\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com|azure-api\.net)$/i.test(host)) {
      return new Response(JSON.stringify({ error: { message: "Azure endpoint must be an *.azure.com resource." } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (!deployment) {
      return new Response(JSON.stringify({ error: { message: "Missing Azure deployment name." } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    headers["api-key"] = payload.apiKey;
  } else {
    const base = payload.provider ? BASE[payload.provider] : undefined;
    if (!base) {
      return new Response(
        JSON.stringify({ error: { message: "Missing or unknown provider." } }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    url = `${base}/chat/completions`;
    headers.authorization = `Bearer ${payload.apiKey}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
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
