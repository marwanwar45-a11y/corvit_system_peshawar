// Netlify Function: secure proxy between the Corvit website and the Dify.ai chat API.
// The Dify API key is read from the DIFY_API_KEY environment variable and never reaches the browser.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const MAX_QUERY_LENGTH = 2000;
const UPSTREAM_TIMEOUT_MS = 25000;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Default base URL is https://dify.ai (as configured). Dify Cloud serves its API from
// https://api.dify.ai/v1, so the bare dify.ai domain is mapped there automatically.
// For self-hosted Dify, set DIFY_BASE_URL to e.g. https://your-host/v1.
function resolveBaseUrl() {
  let base = (process.env.DIFY_BASE_URL || "https://dify.ai").trim().replace(/\/+$/, "");
  if (/^https?:\/\/(www\.)?dify\.ai$/i.test(base)) {
    base = "https://api.dify.ai/v1";
  }
  return base;
}

async function callDify({ url, apiKey, query, conversationId, user, signal }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: {},
      query,
      response_mode: "blocking",
      conversation_id: conversationId || "",
      user,
    }),
    signal,
  });

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  return { res, data, raw };
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed. Please use POST." });
  }

  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) {
    return json(500, {
      error:
        "Server is not configured: DIFY_API_KEY is missing. Add it in Netlify under Site configuration > Environment variables, then redeploy.",
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) {
    return json(400, { error: "The 'query' field is required." });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return json(400, {
      error: `Message is too long. Please keep it under ${MAX_QUERY_LENGTH} characters.`,
    });
  }

  const conversationId =
    typeof body?.conversation_id === "string" ? body.conversation_id.trim() : "";
  const user =
    (typeof body?.user === "string" && body.user.trim().slice(0, 100)) || "corvit-student";

  const url = `${resolveBaseUrl()}/chat-messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let result = await callDify({
      url,
      apiKey,
      query,
      conversationId,
      user,
      signal: controller.signal,
    });

    // If the stored conversation no longer exists on Dify, start a fresh one transparently.
    if (result.res.status === 404 && conversationId) {
      result = await callDify({
        url,
        apiKey,
        query,
        conversationId: "",
        user,
        signal: controller.signal,
      });
    }

    const { res, data, raw } = result;

    if (!res.ok) {
      const upstreamMessage =
        (data && (data.message || data.error)) ||
        (raw ? raw.slice(0, 300) : `Dify returned HTTP ${res.status}`);

      let status = 502;
      let error = "The AI service returned an error. Please try again.";
      if (res.status === 401 || res.status === 403) {
        error = "The AI service rejected the API key. Please check DIFY_API_KEY in Netlify.";
      } else if (res.status === 429) {
        status = 429;
        error = "The AI service is busy right now. Please wait a moment and try again.";
      } else if (res.status === 404) {
        error =
          "The AI service endpoint was not found. Check DIFY_BASE_URL and make sure the key belongs to a Chat or Chatflow app.";
      }

      return json(status, {
        error,
        upstream_status: res.status,
        details: String(upstreamMessage),
      });
    }

    if (!data || typeof data.answer !== "string") {
      return json(502, { error: "The AI service returned an unexpected response." });
    }

    return json(200, {
      answer: data.answer,
      conversation_id: data.conversation_id || conversationId || "",
      message_id: data.message_id || data.id || "",
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return json(504, { error: "The AI service took too long to respond. Please try again." });
    }
    return json(502, {
      error: "Could not reach the AI service. Please try again shortly.",
      details: String(err?.message || err),
    });
  } finally {
    clearTimeout(timer);
  }
};
