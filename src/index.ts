const MCP_URL = "https://twilog-mcp.togetter.dev/mcp";
const MCP_TIMEOUT_MS = 10_000;
const DEFAULT_TTL = 60;
const TTL_MIN = 0;
const TTL_MAX = 600;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const QUERY_MIN_LENGTH = 1;
const QUERY_MAX_LENGTH = 1_000;
const LIMIT_DEFAULT = 20;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const MAX_ERROR_BODY_PREVIEW = 2_048;

const rateLimitStore = new Map<string, number[]>();

export interface Env {
  TWILOG_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const requestId = generateRequestId();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    let response: Response | undefined;

    try {
      if (method !== "GET") {
        response = jsonResponse(
          { error: "method_not_allowed", detail: "GET のみ利用できます。" },
          {
            status: 405,
            requestId,
            cacheControl: "no-store",
            extraHeaders: { Allow: "GET" },
          },
        );
      } else {
        const rateResult = applyRateLimit(getClientIp(request));
        if (!rateResult.allowed) {
          response = jsonResponse(
            {
              error: "too_many_requests",
              detail: "一定時間あたりのリクエスト数を超過しました。",
            },
            {
              status: 429,
              requestId,
              cacheControl: "no-store",
              extraHeaders: { "Retry-After": String(rateResult.retryAfterSeconds) },
            },
          );
        } else {
          switch (url.pathname) {
            case "/tools":
              response = await handleTools(request, env, requestId, url);
              break;
            case "/search":
              response = await handleSearch(request, env, requestId, url);
              break;
            case "/health":
              response = jsonResponse(
                {
                  ok: true,
                  service: "twilog-bridge",
                  time: new Date().toISOString(),
                },
                { status: 200, requestId, cacheControl: "no-store" },
              );
              break;
            default:
              response = jsonResponse(
                { error: "not_found", detail: "指定されたパスは存在しません。" },
                { status: 404, requestId, cacheControl: "no-store" },
              );
              break;
          }
        }
      }
    } catch (error) {
      console.error("handler_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      response = jsonResponse(
        { error: "bad_gateway", detail: "上流処理で障害が発生しました。" },
        { status: 502, requestId, cacheControl: "no-store" },
      );
    } finally {
      const elapsed = Date.now() - start;
      const status = response ? response.status : 500;
      console.log(
        JSON.stringify({
          method,
          path: url.pathname,
          status,
          ms: elapsed,
          requestId,
        }),
      );
    }

    if (!response) {
      response = jsonResponse(
        { error: "bad_gateway", detail: "内部で不明なエラーが発生しました。" },
        { status: 502, requestId, cacheControl: "no-store" },
      );
    }

    return response;
  },
};

async function handleTools(
  request: Request,
  env: Env,
  requestId: string,
  url: URL,
): Promise<Response> {
  if (!env.TWILOG_TOKEN) {
    return jsonResponse(
      { error: "bad_gateway", detail: "上流認証情報が設定されていません。" },
      { status: 502, requestId, cacheControl: "no-store" },
    );
  }

  const payload = {
    jsonrpc: "2.0",
    id: generateRequestId(),
    method: "tools/list",
    params: {},
  };

  const result = await fetchMcp(payload, env);
  if (result.kind === "timeout") {
    return jsonResponse(
      { error: "upstream_timeout" },
      { status: 504, requestId, cacheControl: "no-store" },
    );
  }

  if (result.kind === "http_error") {
    return jsonResponse(
      {
        upstreamStatus: result.status,
        body: truncate(result.text, MAX_ERROR_BODY_PREVIEW),
      },
      {
        status: result.status,
        requestId,
        cacheControl: "no-store",
      },
    );
  }

  const ttl = parseTtl(url);
  const cacheControl = `public, max-age=${ttl}`;

  if (result.json !== undefined) {
    const responseText = result.text;
    const etag = await createEtag(responseText);
    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return notModifiedResponse(requestId, { "Cache-Control": cacheControl, ETag: etag });
    }
    return jsonTextResponse(responseText, {
      status: result.status,
      requestId,
      cacheControl,
      extraHeaders: { ETag: etag },
    });
  }

  const fallbackBody = { raw: result.text };
  const fallbackText = JSON.stringify(fallbackBody);
  const etag = await createEtag(fallbackText);
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return notModifiedResponse(requestId, { "Cache-Control": cacheControl, ETag: etag });
  }

  return jsonResponse(fallbackBody, {
    status: result.status,
    requestId,
    cacheControl,
    extraHeaders: { ETag: etag },
    includeRequestId: false,
  });
}

async function handleSearch(
  request: Request,
  env: Env,
  requestId: string,
  url: URL,
): Promise<Response> {
  if (!env.TWILOG_TOKEN) {
    return jsonResponse(
      { error: "bad_gateway", detail: "上流認証情報が設定されていません。" },
      { status: 502, requestId, cacheControl: "no-store" },
    );
  }

  const query = url.searchParams.get("q");
  if (!query || query.length < QUERY_MIN_LENGTH || query.length > QUERY_MAX_LENGTH) {
    return jsonResponse(
      { error: "bad_request", detail: "パラメータ q は 1〜1000 文字で指定してください。" },
      { status: 400, requestId, cacheControl: "no-store" },
    );
  }

  const limit = clampNumber(
    parseInteger(url.searchParams.get("limit")) ?? LIMIT_DEFAULT,
    LIMIT_MIN,
    LIMIT_MAX,
  );

  const payload = {
    jsonrpc: "2.0",
    id: generateRequestId(),
    method: "tools/call",
    params: {
      name: "get_twitter_posts",
      arguments: {
        query,
        limit,
      },
    },
  };

  const result = await fetchMcp(payload, env);
  if (result.kind === "timeout") {
    return jsonResponse(
      { error: "upstream_timeout" },
      { status: 504, requestId, cacheControl: "no-store" },
    );
  }

  if (result.kind === "http_error") {
    return jsonResponse(
      {
        upstreamStatus: result.status,
        body: truncate(result.text, MAX_ERROR_BODY_PREVIEW),
      },
      {
        status: result.status,
        requestId,
        cacheControl: "no-store",
      },
    );
  }

  const ttl = parseTtl(url);
  const cacheControl = `public, max-age=${ttl}`;

  if (result.json !== undefined) {
    const responseText = result.text;
    const etag = await createEtag(responseText);
    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return notModifiedResponse(requestId, { "Cache-Control": cacheControl, ETag: etag });
    }
    return jsonTextResponse(responseText, {
      status: result.status,
      requestId,
      cacheControl,
      extraHeaders: { ETag: etag },
    });
  }

  const fallbackBody = { raw: result.text };
  const fallbackText = JSON.stringify(fallbackBody);
  const etag = await createEtag(fallbackText);
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return notModifiedResponse(requestId, { "Cache-Control": cacheControl, ETag: etag });
  }

  return jsonResponse(fallbackBody, {
    status: result.status,
    requestId,
    cacheControl,
    extraHeaders: { ETag: etag },
    includeRequestId: false,
  });
}

type FetchMcpResult =
  | { kind: "ok"; status: number; text: string; json?: unknown }
  | { kind: "http_error"; status: number; text: string }
  | { kind: "timeout" };

async function fetchMcp(payload: unknown, env: Env): Promise<FetchMcpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

  try {
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.TWILOG_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let json: unknown | undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    } else {
      json = undefined;
    }

    if (!response.ok) {
      return { kind: "http_error", status: response.status, text };
    }

    return { kind: "ok", status: response.status, text, json };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "timeout" };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function jsonResponse(
  body: Record<string, unknown>,
  {
    status = 200,
    requestId,
    cacheControl,
    extraHeaders = {},
    includeRequestId = true,
  }: {
    status?: number;
    requestId: string;
    cacheControl?: string;
    extraHeaders?: Record<string, string>;
    includeRequestId?: boolean;
  },
): Response {
  const headers = buildBaseHeaders(requestId);
  headers.set("content-type", "application/json; charset=utf-8");
  if (cacheControl) {
    headers.set("cache-control", cacheControl);
  }
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  const payload = includeRequestId ? { ...body, requestId } : body;
  return new Response(JSON.stringify(payload), { status, headers });
}

function jsonTextResponse(
  text: string,
  {
    status = 200,
    requestId,
    cacheControl,
    extraHeaders = {},
  }: {
    status?: number;
    requestId: string;
    cacheControl?: string;
    extraHeaders?: Record<string, string>;
  },
): Response {
  const headers = buildBaseHeaders(requestId);
  headers.set("content-type", "application/json; charset=utf-8");
  if (cacheControl) {
    headers.set("cache-control", cacheControl);
  }
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Response(text, { status, headers });
}

function notModifiedResponse(
  requestId: string,
  extraHeaders: Record<string, string>,
): Response {
  const headers = buildBaseHeaders(requestId);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Response(null, { status: 304, headers });
}

function buildBaseHeaders(requestId: string): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("x-request-id", requestId);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function generateRequestId(length = 16): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseTtl(url: URL): number {
  const ttlParam = url.searchParams.get("ttl");
  if (ttlParam === null) {
    return DEFAULT_TTL;
  }

  const parsed = parseInteger(ttlParam);
  if (parsed === null) {
    return DEFAULT_TTL;
  }

  return clampNumber(parsed, TTL_MIN, TTL_MAX);
}

function parseInteger(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function createEtag(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `"${bufferToHex(new Uint8Array(digest))}"`;
}

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((candidate) => candidate === etag || candidate === `W/${etag}`);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function applyRateLimit(ip: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  const timestamps = rateLimitStore.get(ip) ?? [];
  const threshold = now - RATE_WINDOW_MS;
  const recent = timestamps.filter((ts) => ts > threshold);

  if (recent.length >= RATE_LIMIT) {
    const retryAfterMs = Math.max(recent[0] + RATE_WINDOW_MS - now, 1_000);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1_000);
    rateLimitStore.set(ip, recent);
    return { allowed: false, retryAfterSeconds };
  }

  recent.push(now);
  rateLimitStore.set(ip, recent);
  return { allowed: true };
}

function getClientIp(request: Request): string {
  const headerIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return headerIp || "unknown";
}
