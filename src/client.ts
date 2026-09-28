// Minimal Spoke Dispatch API client used by the MCP tools.
// Docs: https://developer.dispatch.spoke.com  Spec: https://developer.dispatch.spoke.com/openapi-v1.json
import { redactContacts } from "./format.js";

export class SpokeError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = "SpokeError";
  }
}

// Spec, "On Rate-Limiting": "we will reject requests that come in too fast" and the client "must wait
// before retrying". A rejected request was not processed, so a 429 is repeated for any method. A
// 502/503/504 from a gateway does not prove the upstream did not process the request, so those are
// only retried for GET: repeating POST /plans could create the same plan twice, repeating
// .../stops:import could import the same stops twice, and repeating :distribute could notify drivers twice.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;

export const DEFAULT_BASE_URL = "https://api.spoke.com/public/v1";

// Documented rate limits (spec, "On Rate-Limiting"): reads 10 requests per second, writes (POST, PATCH,
// DELETE) 5 per second, the stop batch import 100 per 10 minutes (at most 30 per minute), plan
// optimization 100 per 10 minutes (at most 30 per minute). Requests are spaced to stay under each of
// those; the intervals are a little wider than the limits so short bursts from several tool calls stay safe.
const READ_INTERVAL_MS = 120;
const WRITE_INTERVAL_MS = 250;
const SLOW_WRITE_INTERVAL_MS = 2100; // :import and :optimize, 30 per minute

// Maximum maxPageSize per list endpoint, from each operation's parameter schema.
export const PAGE_SIZES = {
  plans: 20,
  planStops: 10,
  routes: 20,
  routeStops: 10,
  drivers: 50,
  depots: 20,
  operations: 20,
  // GET /stops:search documents maxPageSize as an integer with exclusiveMinimum 1 and exclusiveMaximum
  // 20 (default 20), so the largest value the schema admits is 19 and the smallest is 2 (SEARCH_MIN_PAGE).
  search: 19,
} as const;
export const SEARCH_MIN_PAGE = 2;

export type QueryValue = string | number | boolean | undefined;

export interface ListResult<T> {
  items: T[];
  pages: number;
  complete: boolean;
  next_page_token?: string;
}

export class SpokeClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private nextSlot = 0;

  constructor(apiKey: string, baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    // Spec securitySchemes.BasicAuth: "Use the API key as the username and leave the password empty",
    // i.e. base64("<key>:"). (The spec also accepts "Authorization: Bearer <key>"; Basic is described as
    // the primary scheme and is what this client sends.)
    this.authHeader = "Basic " + Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  }

  private async throttle(intervalMs: number): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + intervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const interval = method === "GET" ? READ_INTERVAL_MS : /:(import|optimize)$/.test(path) ? SLOW_WRITE_INTERVAL_MS : WRITE_INTERVAL_MS;

    for (let attempt = 0; ; attempt++) {
      await this.throttle(interval);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            // Spec, "On resource types": requests with a body need Content-type: application/json.
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        throw new SpokeError(`Could not reach Spoke at ${this.baseUrl}: ${(err as Error).message}`);
      }

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new SpokeError(
            `Spoke asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`,
            res.status,
          );
        }
        // Spoke documents no Retry-After header and recommends exponential backoff with a random delay
        // ("On Rate-Limiting"). A missing or unparsable header therefore falls back to 1 s then 2 s, each
        // plus up to 300 ms of jitter; a Retry-After of 0 (or a date already passed) means retry now,
        // subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 1000 * 2 ** attempt + Math.random() * 300;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Spec, "On resource types": "Every response from the Spoke Public API will be as JSON Objects".
        // A 200 with HTML (a proxy, a captive portal, a login page) must not be mistaken for an empty list.
        if (!json || typeof json !== "object") {
          throw new SpokeError(
            `Spoke returned ${res.status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify(text.slice(0, 60))}). Check SPOKE_BASE_URL and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return json as T;
      }

      // Spoke's error bodies are {message, code?, param?, url?}. The message is free text; redact anything
      // that looks like a contact detail in case the live API ever echoes a recipient's email or phone.
      const code = typeof json?.code === "string" ? (json.code as string) : undefined;
      const detail = redactContacts(describeError(json) ?? text.slice(0, 300), false);
      if (res.status === 401) {
        throw new SpokeError(
          `Spoke rejected the API key (401). Check SPOKE_API_KEY: it must be an API key generated in Spoke Dispatch under Settings > Integrations > API, which the server sends as the HTTP Basic username with an empty password.${detail ? " " + detail : ""}`,
          res.status,
          code,
        );
      }
      if (res.status === 403) {
        const why =
          code === "plan_inaccessible" || code === "route_inaccessible"
            ? " The spec documents this for plans and routes older than the delivery-history period of the team's Spoke subscription; a longer history period makes them accessible again."
            : "";
        throw new SpokeError(`Spoke refused ${method} ${path} (403).${detail ? " " + detail : ""}${why}`, 403, code);
      }
      if (res.status === 404) throw new SpokeError(`Not found: ${path}. Check the ID.${detail ? " " + detail : ""}`, 404, code);
      if (res.status === 429) {
        throw new SpokeError(
          "Spoke rate limit reached (documented limits: 10 read requests per second, 5 write requests per second, 30 stop imports or plan optimizations per minute and 100 per 10 minutes). Wait a minute and try again.",
          429,
          code,
        );
      }
      if (res.status === 409) throw new SpokeError(`Spoke refused ${method} ${path} (409, the resource is not in the right state).${detail ? " " + detail : ""}`, 409, code);
      if (res.status === 400 || res.status === 410 || res.status === 412 || res.status === 422) {
        throw new SpokeError(`Spoke refused ${method} ${path} (${res.status}).${detail ? " " + detail : ""}`, res.status, code);
      }
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        throw new SpokeError(
          `Spoke returned ${res.status} for ${method} ${path}. The request was not retried because it may already have been processed: check with ${checkTool(path)} before repeating it.${detail ? " " + detail : ""}`,
          res.status,
          code,
        );
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a JSON
        // message is passed on.
        const jsonDetail = redactContacts(describeError(json), false);
        throw new SpokeError(
          `Spoke returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`,
          res.status,
          code,
        );
      }
      throw new SpokeError(`Spoke returned ${res.status} for ${method} ${path}.${detail ? " " + detail : ""}`, res.status, code);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Fetch a token-paginated collection (spec, "On List endpoints"): every list response carries
   * `nextPageToken`, which is sent back as `pageToken` together with **all the original query
   * parameters** until it comes back `null`. `key` is the array property of the response (plans, stops,
   * routes, drivers, depots, operations). The page size stays the same on every page, so whole pages
   * are returned: the walk stops after the page that reaches `maxItems`, at `maxPages`, or when the
   * token is null. A `next_page_token` is returned when more pages exist. The page size asked for is
   * `maxItems` clamped to [minPageSize, pageSize]: `minPageSize` is the smallest value the endpoint's
   * parameter schema admits (1 everywhere except the search, whose exclusiveMinimum 1 means 2).
   */
  async list<T = any>(
    path: string,
    key: string,
    { maxItems = 50, maxPages = 20, pageSize = 20, minPageSize = 1, pageToken = undefined as string | undefined, query = {} as Record<string, QueryValue> } = {},
  ): Promise<ListResult<T>> {
    const items: T[] = [];
    const size = Math.max(minPageSize, Math.min(pageSize, maxItems));
    let token: string | undefined = pageToken;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.get<Record<string, unknown>>(path, { ...query, maxPageSize: size, pageToken: token });
      const data = Array.isArray(res?.[key]) ? (res[key] as T[]) : [];
      items.push(...data);
      const next = res?.nextPageToken;
      token = typeof next === "string" && next !== "" ? next : undefined;
      if (!token) return { items, pages: page + 1, complete: true };
      if (items.length >= maxItems) return { items, pages: page + 1, complete: false, next_page_token: token };
    }
    return { items, pages: maxPages, complete: false, next_page_token: token };
  }
}

/** Which read tool to use to find out whether a write went through before repeating it. */
function checkTool(path: string): string {
  if (/:distribute$/.test(path)) return "get_plan (distributed) and list_routes";
  if (/:optimize$/.test(path)) return "list_operations (type plan_optimization, done false) and get_plan (optimization)";
  if (/stops:import$/.test(path)) return "list_plan_stops";
  return "list_plans";
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Spec error responses: {message (required), code?, param?, url?}.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  if (typeof json.message !== "string" || !json.message.trim()) return undefined;
  const extras = [json.code !== undefined ? `code ${json.code}` : "", json.param !== undefined ? `parameter ${json.param}` : ""].filter(Boolean).join(", ");
  return extras ? `${json.message.trim()} (${extras})` : json.message.trim();
}
