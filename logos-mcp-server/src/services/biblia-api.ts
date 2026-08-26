import { BIBLIA_API_KEY, BIBLIA_API_BASE, DEFAULT_BIBLE } from "../config.js";
import type { BibleTextResult, BibleSearchResult, BibleSearchHit, ScanResult, CompareResult, BibleInfo } from "../types.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const MAX_RETRIES = 2;

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const responseCache = new Map<string, CacheEntry>();

export class BibliaApiError extends Error {
  code:
    | "missing_api_key"
    | "authentication_failed"
    | "rate_limited"
    | "network_error"
    | "service_unavailable"
    | "unexpected_response"
    | "invalid_request"
    // A 2xx that carried no text: the reference did not resolve in this
    // version. Distinct from `unexpected_response` so a caller that built the
    // reference itself (get_passage_context widens a range without knowing the
    // chapter's length) can retry with a narrower one instead of reporting a
    // failure the user did not cause.
    | "passage_not_found";
  status?: number;
  retryAfterSeconds?: number;

  constructor(
    code: BibliaApiError["code"],
    message: string,
    options: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {}
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "BibliaApiError";
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function getCachedValue(cacheKey: string): unknown | undefined {
  const cached = responseCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return undefined;
  }
  return cached.value;
}

function setCachedValue(cacheKey: string, value: unknown): void {
  // Bound the cache: evict the oldest entries (Map preserves insertion order).
  while (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey === undefined) break;
    responseCache.delete(oldestKey);
  }
  responseCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });
}

function cacheKeyFor(path: string, params: Record<string, string>): string {
  const normalized = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${path}?${normalized}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeErrorBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

/**
 * Longest `Retry-After` this client will actually wait out, in seconds.
 * Anything longer is reported to the caller instead of slept through — see
 * the 429 branch in `bibliaFetch`.
 */
const MAX_RETRY_AFTER_SECONDS = 10;

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

async function bibliaFetch(path: string, params: Record<string, string>): Promise<unknown> {
  if (!BIBLIA_API_KEY) {
    throw new BibliaApiError(
      "missing_api_key",
      "BIBLIA_API_KEY is not set. Configure it to use Biblia-backed tools such as get_bible_text, search_bible, and get_cross_references."
    );
  }

  const cacheKey = cacheKeyFor(path, params);
  const cached = getCachedValue(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const url = new URL(`${BIBLIA_API_BASE}${path}`);
  url.searchParams.set("key", BIBLIA_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let res: Response;

    try {
      res = await fetch(url.toString());
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      throw new BibliaApiError(
        "network_error",
        "Could not reach the Biblia API. Check your internet connection and try again.",
        { cause: error }
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = describeErrorBody(body);
      const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("retry-after"));

      if (res.status === 401 || res.status === 403) {
        throw new BibliaApiError(
          "authentication_failed",
          detail
            ? `Biblia API rejected the configured key (${res.status}). ${detail}`
            : `Biblia API rejected the configured key (${res.status}). Verify BIBLIA_API_KEY and your Biblia account status.`,
          { status: res.status }
        );
      }

      if (res.status === 429) {
        // Honour Retry-After only up to MAX_RETRY_AFTER_SECONDS. The server
        // (or any CDN/proxy answering 429) can send `Retry-After: 86400`, or
        // an HTTP-date hours ahead, and this loop used to sleep for exactly
        // that — twice. MCP stdio has no per-tool timeout, so the client just
        // appeared hung and the user never saw the rate-limit message, which
        // is only thrown once the retries are exhausted. Past the cap, skip
        // the retry and throw now: the error already carries
        // `retryAfterSeconds` so the caller can decide for itself.
        const waitTooLong =
          retryAfterSeconds !== undefined && retryAfterSeconds > MAX_RETRY_AFTER_SECONDS;
        if (attempt < MAX_RETRIES && !waitTooLong) {
          const delayMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 500 * 2 ** attempt;
          await sleep(delayMs);
          continue;
        }

        throw new BibliaApiError(
          "rate_limited",
          retryAfterSeconds
            ? `Biblia API rate limit exceeded. Retry after about ${retryAfterSeconds} seconds.`
            : "Biblia API rate limit exceeded. Wait a moment and try again.",
          { status: res.status, retryAfterSeconds }
        );
      }

      if (res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await sleep(500 * 2 ** attempt);
          continue;
        }

        throw new BibliaApiError(
          "service_unavailable",
          detail
            ? `Biblia API is temporarily unavailable (${res.status}). ${detail}`
            : `Biblia API is temporarily unavailable (${res.status}). Try again shortly.`,
          { status: res.status }
        );
      }

      throw new BibliaApiError(
        "unexpected_response",
        detail
          ? `Biblia API error ${res.status}: ${detail}`
          : `Biblia API error ${res.status}.`,
        { status: res.status }
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await res.json()
      : await res.text();
    setCachedValue(cacheKey, payload);
    return payload;
  }

  throw new BibliaApiError(
    "service_unavailable",
    "Biblia API request did not complete successfully."
  );
}

/**
 * Validate a Bible version identifier before it is interpolated into a URL
 * path. Biblia ids are alphanumeric (e.g. "LEB", "KJV1900", "TB010").
 */
function normalizeBibleId(bible: string): string {
  const trimmed = bible.trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) {
    throw new BibliaApiError(
      "invalid_request",
      `Invalid Bible version "${bible}". Use an alphanumeric version id such as LEB, KJV, ASV, DARBY, YLT, or WEB (see get_available_bibles for the full list).`
    );
  }
  return trimmed.toUpperCase();
}

export async function getBibleText(
  passage: string,
  bible: string = DEFAULT_BIBLE
): Promise<BibleTextResult> {
  const bibleId = normalizeBibleId(bible);
  const text = await bibliaFetch(`/content/${bibleId}.txt`, { passage });
  const trimmed = String(text).trim();
  // The Biblia /content endpoint answers HTTP 200 with an empty body for
  // passages it cannot resolve (e.g. out-of-range verses like "John 3:99").
  // Surface that as an error instead of a silent empty "success".
  if (trimmed.length === 0) {
    throw new BibliaApiError(
      "passage_not_found",
      `The Biblia API returned no text for "${passage}" (${bibleId}). The passage was not recognized — check the reference (book, chapter, and verse range) and that it exists in this Bible version.`
    );
  }
  return {
    passage,
    text: trimmed,
    bible: bibleId,
  };
}

export async function searchBible(
  query: string,
  options: { bible?: string; limit?: number; mode?: string } = {}
): Promise<BibleSearchResult> {
  const bible = normalizeBibleId(options.bible ?? DEFAULT_BIBLE);
  const data = await bibliaFetch(`/search/${bible}`, {
    query,
    mode: options.mode ?? "verse",
    limit: String(options.limit ?? 20),
  }) as { resultCount: number; results: Array<{ title: string; preview: string }> };

  return {
    query,
    resultCount: data.resultCount ?? 0,
    results: (data.results ?? []).map((r): BibleSearchHit => ({
      title: r.title ?? "",
      preview: r.preview ?? "",
    })),
  };
}

// ─── Scan References ────────────────────────────────────────────────────────

export async function scanReferences(
  text: string,
  tagChapters: boolean = true
): Promise<ScanResult[]> {
  const data = await bibliaFetch("/scan", {
    text,
    tagChapters: String(tagChapters),
  }) as { results: Array<{ passage: string; textIndex: number; textLength: number }> };

  return (data.results ?? []).map((r) => ({ passage: r.passage }));
}

// ─── Compare Passages ───────────────────────────────────────────────────────

export async function comparePassages(
  first: string,
  second: string
): Promise<CompareResult> {
  const data = await bibliaFetch("/compare", {
    first,
    second,
  }) as CompareResult;

  return {
    equal: data.equal ?? false,
    intersects: data.intersects ?? false,
    subset: data.subset ?? false,
    superset: data.superset ?? false,
    before: data.before ?? false,
    after: data.after ?? false,
  };
}

// ─── Get Available Bibles ───────────────────────────────────────────────────

export async function getAvailableBibles(
  query?: string
): Promise<BibleInfo[]> {
  const params: Record<string, string> = {};
  if (query) {
    params.query = query;
  }

  const data = await bibliaFetch("/find", params) as { bibles: BibleInfo[] };

  return data.bibles ?? [];
}
