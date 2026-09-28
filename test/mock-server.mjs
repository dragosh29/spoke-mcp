// Local stand-in for https://api.spoke.com/public/v1, serving the fixtures with the documented
// pageToken/nextPageToken/maxPageSize pagination, the documented filter parameters and error shapes.
import http from "node:http";
import * as fx from "./fixtures.mjs";

// An obviously fake, low-entropy key. Never a value from the vendor's documentation: secret scanners
// flag those in a public repository.
export const API_KEY = "spk-test-key-not-real";
// Spec securitySchemes.BasicAuth: the key as the username, empty password. Bearer is the documented
// alternative and the mock accepts it too, so the test can prove which one the server sends.
export const AUTH = "Basic " + Buffer.from(`${API_KEY}:`).toString("base64");
export const BASE_PATH = "/public/v1";

// Documented error bodies: {message, code?, param?, url?}. The messages and codes below are the ones
// the spec fixes with enums (Plan not found, plan_inaccessible, plan_not_writable, ...); "Unauthorized"
// and the 400 texts are placeholders, since the spec only gives those responses a description.
const err = (message, extra = {}) => ({ message, ...extra });
const PLAN_INACCESSIBLE = err("Plan is no longer accessible due to data access restrictions. Upgrade to a plan that supports a longer delivery history period to access it.", { code: "plan_inaccessible", url: "https://dispatch.spoke.com/paywall" });

// maxPageSize maximum per list endpoint, from the spec. GET /stops:search has exclusiveMaximum 20.
const PAGE_MAX = { plans: 20, planStops: 10, routes: 20, routeStops: 10, drivers: 50, depots: 20, operations: 20, search: 19 };

/** Value at a dotted path ("deliveryInfo.state", "address.address"). */
const at = (obj, path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

/**
 * A small subset of the documented stop-search filter DSL, enough to make the mock's answers depend
 * on the filter: `field op value` terms (ops = != ~= > >= < <=, string/number/boolean/null values)
 * joined by and/or, no parentheses. planId and routeId are the documented aliases for the stop's plan
 * and route.
 */
function compileFilter(text) {
  const term = /^\s*([A-Za-z0-9_.-]+)\s*(!=|~=|>=|<=|=|>|<)\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*$/i;
  const orGroups = text.split(/\s+or\s+/i).map((g) => g.split(/\s+and\s+/i));
  const parsed = orGroups.map((g) =>
    g.map((t) => {
      const m = term.exec(t);
      if (!m) throw new Error(`bad term: ${t}`);
      const [, field, op, raw] = m;
      const value = raw.startsWith('"') ? JSON.parse(raw) : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === "true" : /^null$/i.test(raw) ? null : Number(raw);
      return { field, op, value };
    }),
  );
  const get = (rec, field) => (field === "planId" ? rec.plan : field === "routeId" ? rec.route?.id ?? null : at(rec, field));
  const test = (rec, { field, op, value }) => {
    const v = get(rec, field);
    switch (op) {
      case "=": return v === value;
      case "!=": return v !== value;
      case "~=": return typeof v === "string" && typeof value === "string" && v.toLowerCase().includes(value.toLowerCase());
      case ">": return v > value;
      case ">=": return v >= value;
      case "<": return v < value;
      case "<=": return v <= value;
      default: return false;
    }
  };
  return (rec) => parsed.some((group) => group.every((t) => test(rec, t)));
}

const TEXT_FIELDS = ["address.address", "notes", "recipient.name", "orderInfo.sellerName", "orderInfo.sellerOrderId", "orderInfo.invoiceNumber", "packageLabel"];
const matchesKeyword = (rec, kw) => TEXT_FIELDS.some((f) => String(at(rec, f) ?? "").toLowerCase().includes(kw.toLowerCase()));

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes one
  // "time" and gets that status instead of the normal answer (body undefined = a non-JSON gateway page).
  // The suite starts with a single 429 on GET /depots so the retry path is exercised by the schema
  // check and the MCP run alike. Spoke documents no 429 body; {message} is the default error model.
  // Retry-After is 2 s: a wait the client's no-header fallback (1 s plus up to 300 ms) cannot produce,
  // so the timing check proves the header was honoured.
  const failure429 = () => ({ method: "GET", path: "/depots", status: 429, times: 1, headers: { "Retry-After": "2" }, body: err("Too many requests") });
  let failures = [failure429()];
  const created = { plans: [], stopsByPlan: {} }; // records created through POST, served alongside the fixtures
  let nextId = 1;

  const allPlans = () => [...fx.plans, ...created.plans];
  const planStops = (planId) => [...(fx.stopsByPlan[planId] ?? []), ...(created.stopsByPlan[planId] ?? [])];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType: req.headers["content-type"], body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const bad = (message, param) => send(400, err(message, param ? { param } : {}));
    if (req.headers.authorization !== AUTH && req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, err("Unauthorized"));

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    // Spec, "On List endpoints": nextPageToken in every list response, sent back as pageToken; maxPageSize
    // has a per-endpoint maximum. Tokens here encode the offset; a real token is opaque.
    const q = url.searchParams;
    const paged = (items, key, max, { search = false } = {}) => {
      const requested = q.has("maxPageSize") ? Number(q.get("maxPageSize")) : undefined;
      if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > max || (search && requested < 2))) return bad(`maxPageSize must be between ${search ? 2 : 1} and ${max}`, "maxPageSize");
      const size = requested ?? Math.min(10, max);
      const token = q.get("pageToken");
      if (token !== null && !/^pt-\d+$/.test(token)) return bad("Invalid page token", "pageToken");
      const offset = token ? Number(token.slice(3)) : 0;
      const data = items.slice(offset, offset + size);
      const nextPageToken = offset + size < items.length ? `pt-${offset + size}` : null;
      return send(200, { [key]: data, nextPageToken });
    };
    // Filters are documented as `?filter[title]=foo` or `?filter.title=foo`; both spellings are read.
    const filter = (name) => q.get(`filter.${name}`) ?? q.get(`filter[${name}]`);
    const filterKeys = [...q.keys()].filter((k) => /^filter[.[]/.test(k)).map((k) => k.replace(/^filter[.[]/, "").replace(/\]$/, ""));
    const onlyFilters = (...allowed) => {
      const unknown = filterKeys.find((k) => !allowed.includes(k));
      if (unknown) return bad(`Unknown filter ${unknown}`, `filter.${unknown}`);
      return null;
    };

    const p = path.split("/").filter(Boolean);
    const m = req.method;

    if (p[0] === "plans" && p.length === 1) {
      if (m === "GET") {
        const rejected = onlyFilters("title", "startsGte", "startsLte");
        if (rejected !== null) return rejected;
        const ymd = (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
        for (const k of ["startsGte", "startsLte"]) if (filter(k) !== null && !/^\d{4}-\d{2}-\d{2}$/.test(filter(k))) return bad("The date must be in the format YYYY-MM-DD", `filter.${k}`);
        const items = allPlans().filter((pl) => (filter("title") === null || pl.title === filter("title")) && (filter("startsGte") === null || ymd(pl.starts) >= filter("startsGte")) && (filter("startsLte") === null || ymd(pl.starts) <= filter("startsLte")));
        return paged(items, "plans", PAGE_MAX.plans);
      }
      if (m === "POST") {
        if (req.headers["content-type"] !== "application/json") return bad("Content-type must be application/json");
        if (!body || typeof body.title !== "string" || !body.starts) return bad("title and starts are required", !body?.title ? "title" : "starts");
        for (const d of body.drivers ?? []) if (!fx.drivers.some((x) => x.id === d)) return send(404, err("Driver not found"));
        if (body.depot && !fx.depots.some((x) => x.id === body.depot)) return send(404, err("Depot not found"));
        const plan = {
          id: `plans/pl-new-${nextId++}`,
          title: body.title,
          starts: body.starts,
          depot: body.depot ?? fx.DEPOT_BRISTOL,
          distributed: false,
          writable: true,
          optimization: "creating",
          drivers: [...new Set(body.drivers ?? [])],
          routes: [],
          routeOverrides: null,
        };
        created.plans.push(plan);
        return send(200, plan);
      }
    }
    if (p[0] === "plans" && p.length >= 2) {
      // Action endpoints are spelled plans/{planId}:optimize and plans/{planId}:distribute.
      const [planId, action] = p[1].split(":");
      const fullId = `plans/${planId}`;
      if (fullId === fx.PLAN_RESTRICTED) return send(403, PLAN_INACCESSIBLE);
      const plan = allPlans().find((x) => x.id === fullId);
      if (!plan) return send(404, err("Plan not found"));
      if (p.length === 2 && !action && m === "GET") return send(200, plan);
      if (p.length === 2 && action === "optimize" && m === "POST") {
        if (!plan.writable) return send(409, err("Plan is not writable", { code: "plan_not_writable" }));
        if (plan.optimization === "optimized") return send(409, err("Plan already optimized", { code: "plan_already_optimized" }));
        if (plan.optimization === "optimizing") return send(409, err("Plan optimization in progress", { code: "plan_optimization_in_progress" }));
        if (plan.drivers.length === 0) return send(409, err("Plan has no drivers. Either the plan's depot has no drivers, if the optimization is for minimizing drivers, or the plan has no assigned drivers.", { code: "no_drivers_available" }));
        plan.optimization = "optimizing";
        const t = Math.floor(Date.now() / 1000);
        return send(200, { id: `operations/op-new-${nextId++}`, type: "plan_optimization", done: false, metadata: { canceled: false, startedAt: t, finishedAt: null, startedBy: "api", targetPlanId: plan.id }, result: null });
      }
      if (p.length === 2 && action === "distribute" && m === "POST") {
        if (plan.distributed) return send(409, err("Plan already distributed", { code: "plan_already_distributed" }));
        if (plan.optimization === "optimizing") return send(409, err("Plan optimization in progress", { code: "plan_optimization_in_progress" }));
        if (plan.optimization !== "optimized") return send(409, err("Plan not optimized", { code: "plan_not_optimized" }));
        plan.distributed = true;
        return send(200, plan);
      }
      if (p.length === 3 && p[2] === "stops" && m === "GET") {
        const rejected = onlyFilters("externalId");
        if (rejected !== null) return rejected;
        const items = planStops(plan.id).filter((s) => filter("externalId") === null || s.recipient.externalId === filter("externalId"));
        return paged(items, "stops", PAGE_MAX.planStops);
      }
      if (p.length === 3 && p[2] === "stops:import" && m === "POST") {
        if (req.headers["content-type"] !== "application/json") return bad("Content-type must be application/json");
        if (!Array.isArray(body) || body.length < 1 || body.length > 100) return bad("The request body must be an array of 1 to 100 stops");
        if (!plan.writable) return send(409, err("Plan is not writable", { code: "plan_not_writable" }));
        for (const s of body) for (const d of s.allowedDrivers ?? []) if (!plan.drivers.includes(d)) return send(412, err("Driver is not linked to plan", { param: "allowedDrivers" }));
        const success = [];
        const failed = [];
        // The failure echo documents an address with every field present (null-filled) and a recipient.
        const echo = (s) => ({
          ...s,
          address: Object.fromEntries(["addressName", "addressLineOne", "addressLineTwo", "city", "state", "zip", "country", "latitude", "longitude"].map((k) => [k, s.address?.[k] ?? null])),
          recipient: s.recipient ? Object.fromEntries(["externalId", "email", "phone", "name"].map((k) => [k, s.recipient[k] ?? null])) : null,
        });
        for (const s of body) {
          // Placeholder failure rule and message: the spec documents only {error: {message}, stop} per failure.
          if (!Object.values(s.address ?? {}).some((v) => v !== null && v !== undefined)) failed.push({ error: { message: "Address could not be geocoded" }, stop: echo(s) });
          else success.push(`${plan.id}/stops/st-new-${nextId++}`);
        }
        (created.stopsByPlan[plan.id] ??= []).push(...success.map((id, i) => ({ ...fx.tomorrowStops[0], id, plan: plan.id, route: null, recipient: body[i].recipient ?? { name: null, email: null, phone: null, externalId: null } })));
        return send(200, { success, failed });
      }
    }

    if (p[0] === "stops:search" && m === "GET") {
      if (q.get("sortOrder") !== null && !["asc", "desc"].includes(q.get("sortOrder"))) return bad("sortOrder must be asc or desc", "sortOrder");
      let hits = [...fx.allStops.map((s) => ({ type: "stop", stop: s })), ...fx.unassignedStops.map((u) => ({ type: "unassignedStop", unassignedStop: u }))];
      const rec = (h) => h.stop ?? h.unassignedStop;
      const kw = q.get("keyword");
      if (kw !== null) hits = hits.filter((h) => matchesKeyword(rec(h), kw));
      if (q.get("filter") !== null) {
        let pass;
        try {
          pass = compileFilter(q.get("filter"));
        } catch {
          return send(400, err("Invalid filter string", { param: "filter" }));
        }
        hits = hits.filter((h) => pass(rec(h)));
      }
      if (q.get("sortField") !== null) {
        const f = q.get("sortField");
        const dir = q.get("sortOrder") === "desc" ? -1 : 1;
        hits.sort((a, b) => ((at(rec(a), f) ?? 0) > (at(rec(b), f) ?? 0) ? dir : (at(rec(a), f) ?? 0) < (at(rec(b), f) ?? 0) ? -dir : 0));
      }
      return paged(hits, "stops", PAGE_MAX.search, { search: true });
    }

    if (p[0] === "routes" && m === "GET") {
      if (p.length === 1) return paged(fx.routes, "routes", PAGE_MAX.routes);
      const r = fx.routes.find((x) => x.id === `routes/${p[1]}`);
      if (!r) return send(404, err("Route not found"));
      if (p.length === 2) return send(200, r);
      if (p.length === 3 && p[2] === "stops") {
        const rejected = onlyFilters("externalId");
        if (rejected !== null) return rejected;
        const items = fx.allStops.filter((s) => s.route?.id === r.id && (filter("externalId") === null || s.recipient.externalId === filter("externalId")));
        return paged(items, "stops", PAGE_MAX.routeStops);
      }
    }

    if (p[0] === "drivers" && m === "GET") {
      if (p.length === 1) {
        const rejected = onlyFilters("active");
        if (rejected !== null) return rejected;
        if (filter("active") !== null && !["true", "false"].includes(filter("active"))) return bad("filter.active must be true or false", "filter.active");
        const items = fx.drivers.filter((d) => filter("active") === null || String(d.active) === filter("active"));
        return paged(items, "drivers", PAGE_MAX.drivers);
      }
      const d = fx.drivers.find((x) => x.id === `drivers/${p[1]}`);
      if (!d) return send(404, err("Driver not found"));
      if (p.length === 2) return send(200, d);
    }

    if (p[0] === "depots" && m === "GET" && p.length === 1) return paged(fx.depots, "depots", PAGE_MAX.depots);

    if (p[0] === "operations" && m === "GET") {
      if (p.length === 1) {
        const rejected = onlyFilters("done", "type");
        if (rejected !== null) return rejected;
        if (filter("done") !== null && !["true", "false"].includes(filter("done"))) return bad("filter.done must be true or false", "filter.done");
        if (filter("type") !== null && filter("type") !== "plan_optimization") return bad("filter.type must be plan_optimization", "filter.type");
        const items = fx.operations.filter((o) => (filter("done") === null || String(o.done) === filter("done")) && (filter("type") === null || o.type === filter("type")));
        return paged(items, "operations", PAGE_MAX.operations);
      }
      const o = fx.operations.find((x) => x.id === `operations/${p[1]}`);
      if (!o) return send(404, err("The operation was not found.", { code: "operation_not_found" }));
      if (p.length === 2) return send(200, o);
    }

    return send(404, err("Not found"));
  });

  /** Queue a failure for the next `times` requests matching method+path (body undefined = non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body }) => {
    failures.push({ method, path, status, times, headers, body });
  };
  const arm429 = ({ persistent = false, retryAfter = "2" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, created })));
}
