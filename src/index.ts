#!/usr/bin/env node
// Spoke Dispatch MCP server: lets Claude, ChatGPT and other MCP clients work with a Spoke Dispatch team's
// plans, stops, routes, drivers, depots and optimization operations.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SpokeClient, SpokeError, PAGE_SIZES, SEARCH_MIN_PAGE } from "./client.js";
import * as fmt from "./format.js";

const apiKey = process.env.SPOKE_API_KEY?.trim();
if (!apiKey) {
  console.error("SPOKE_API_KEY is not set. Generate an API key in Spoke Dispatch under Settings > Integrations > API.");
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.SPOKE_ALLOW_WRITES ?? "");
const api = new SpokeClient(apiKey, process.env.SPOKE_BASE_URL || undefined);

const server = new McpServer(
  { name: "spoke", version: "0.1.0" },
  {
    instructions: [
      "Tools for a Spoke Dispatch team (delivery route planning and driver dispatch): plans, stops, routes, drivers, depots and plan-optimization operations.",
      "IDs are prefixed: plans/<id>, plans/<id>/stops/<id>, routes/<id>, drivers/<id>, depots/<id>, operations/<id>. Tools accept either the prefixed form or the bare <id>.",
      "A plan is one day's work: it has drivers, is optimized into routes (one per driver), then distributed to the drivers' phones. Plan optimization states: creating, editing, preview, optimized, optimizing.",
      "Typical flow for 'how is today going?': list_plans with starts_from and starts_to set to today, then list_plan_stops for the plan (delivery state and ETA per stop) or list_routes and get_route for progress per driver.",
      "Lists are token-paginated: when a result has next_page_token, call the same tool again with page_token and the same filters.",
      "Timestamps are ISO 8601 (the API's epoch seconds converted). Recipient names, addresses, emails, phones, external IDs, driver contact details and proof-of-delivery links are only returned when include_contact_details is true.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Path parameters are documented as ^[a-zA-Z0-9---_]{1,50}$ (letters, digits, "-" and "_"); resource
// IDs in bodies and responses carry the collection prefix ("plans/<id>"). Either form is accepted.
const idArg = (prefix: string, what: string) =>
  z
    .string()
    .regex(new RegExp(`^(?:${prefix}\\/)?[A-Za-z0-9_-]{1,50}$`), `${what} IDs look like ${prefix}/abc123 or abc123 (letters, digits, - and _, up to 50 characters)`)
    .describe(`${what} ID (${prefix}/<id> or the bare <id>)`);
const bare = (id: string) => id.split("/").pop() as string;
const prefixed = (prefix: string, id: string) => `${prefix}/${bare(id)}`;

const toDate = (s: string) => ({ year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)), day: Number(s.slice(8, 10)) });
// A real calendar date (month 1-12, day valid for that month, e.g. no 2026-02-30), not just the shape.
const isCalendarDate = (s: string) => {
  const { year, month, day } = toDate(s);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
};
const DATE = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "Dates must be YYYY-MM-DD").refine(isCalendarDate, "Not a real calendar date (month 1-12, day valid for that month)");
// POST /plans documents starts.year as 2000-2100 (and month 1-12, day 1-31), so a plan date outside that
// is refused before any request instead of being posted as a body the schema forbids.
const PLAN_DATE = DATE.refine((s) => toDate(s).year >= 2000 && toDate(s).year <= 2100, "The API documents plan start years 2000 to 2100");
const TIME = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Times must be HH:MM on a 24-hour clock");
const toTime = (s: string) => ({ hour: Number(s.split(":")[0]), minute: Number(s.split(":")[1]) });

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof SpokeError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

const pageNote = (r: { complete: boolean; next_page_token?: string }) =>
  r.complete ? undefined : `More results exist; call again with page_token "${r.next_page_token}" and the same filters to continue.`;
const contactArg = (what: string) => z.boolean().default(false).describe(`Include ${what}`);
const maxResults = (def: number) => z.number().int().min(1).max(500).default(def).describe("Minimum number of records to return; whole pages are returned, so a few more may come back");
const pageToken = z.string().min(1).max(255).optional().describe("next_page_token from a previous call, to continue the same list");

server.registerTool(
  "list_plans",
  {
    title: "List plans",
    description:
      "Plans (one per working day, each with its drivers and routes) in the order the API returns them. Filter by an exact title and/or a start-date range. Plan titles are free text: email addresses and phone numbers in them are redacted unless include_contact_details is true.",
    inputSchema: {
      title: z.string().min(1).max(255).optional().describe("Exact plan title (the API's filter.title; no partial match)"),
      starts_from: DATE.optional().describe("Plans starting on or after this date, YYYY-MM-DD (filter.startsGte)"),
      starts_to: DATE.optional().describe("Plans starting on or before this date, YYYY-MM-DD (filter.startsLte)"),
      max_results: maxResults(50),
      page_token: pageToken,
      include_contact_details: contactArg("email addresses and phone numbers typed into plan titles and route override addresses"),
    },
    annotations: READ,
  },
  safe(async ({ title, starts_from, starts_to, max_results, page_token, include_contact_details }) => {
    const r = await api.list("/plans", "plans", {
      maxItems: max_results,
      pageSize: PAGE_SIZES.plans,
      pageToken: page_token,
      query: { "filter.title": title, "filter.startsGte": starts_from, "filter.startsLte": starts_to },
    });
    return { count: r.items.length, pages_fetched: r.pages, complete: r.complete, next_page_token: r.next_page_token, note: pageNote(r), plans: r.items.map((p) => fmt.plan(p, include_contact_details)) };
  }),
);

server.registerTool(
  "get_plan",
  {
    title: "Get a plan",
    description: "One plan: start date, depot, optimization and distribution state, driver IDs, route IDs and route overrides.",
    inputSchema: { plan_id: idArg("plans", "Plan"), include_contact_details: contactArg("email addresses and phone numbers typed into the title and route override addresses") },
    annotations: READ,
  },
  safe(async ({ plan_id, include_contact_details }) => ({ plan: fmt.plan(await api.get(`/plans/${bare(plan_id)}`), include_contact_details) })),
);

const stopListTool = (name: string, title: string, description: string, prefix: "plans" | "routes", what: string, key: "planStops" | "routeStops") =>
  server.registerTool(
    name,
    {
      title,
      description: `${description} By default recipients are withheld, addresses are summarised to the locality, and proof-of-delivery links, signee names and recipient tracking links are left out; set include_contact_details to get them.`,
      inputSchema: {
        [`${what}_id`]: idArg(prefix, what[0].toUpperCase() + what.slice(1)),
        external_id: z.string().min(1).max(255).optional().describe("Only the stop(s) whose recipient.externalId equals this value exactly (the API's filter.externalId)"),
        max_results: maxResults(50),
        page_token: pageToken,
        include_contact_details: contactArg("recipient name, email, phone and external ID, the full address with coordinates, signee names, proof-of-delivery photo and signature links, the tracking link, and unredacted notes"),
      },
      annotations: READ,
    },
    safe(async (args: Record<string, any>) => {
      const id = bare(args[`${what}_id`]);
      const r = await api.list(`/${prefix}/${id}/stops`, "stops", {
        maxItems: args.max_results,
        pageSize: PAGE_SIZES[key],
        pageToken: args.page_token,
        query: { "filter.externalId": args.external_id },
      });
      const stops = r.items.map((s) => fmt.stop(s, args.include_contact_details));
      return { [what]: prefixed(prefix, id), count: stops.length, pages_fetched: r.pages, complete: r.complete, next_page_token: r.next_page_token, note: pageNote(r), stops };
    }),
  );

stopListTool("list_plan_stops", "Stops of a plan", "Every stop of one plan with its type (start/stop/end), route, position, delivery state and outcome, ETA, time window and packages.", "plans", "plan", "planStops");
stopListTool("list_route_stops", "Stops of a route", "The stops of one route (one driver's run) in the order the API returns them, with delivery state and outcome, ETA, time window and packages.", "routes", "route", "routeStops");

// GET /stops:search documents these sortable fields.
const SORT_FIELDS = ["address.latitude", "address.longitude", "createdAt", "arrivalAt", "packageCount", "estimatedTravelDuration", "estimatedTravelDistance", "timing.estimatedAttemptDuration", "deliveryInfo.attemptedAt", "paymentOnDelivery.amount"] as const;

server.registerTool(
  "search_stops",
  {
    title: "Search stops",
    description:
      "Full-text search across all stops (assigned and unassigned) within the team's data retention, by keyword and/or the API's filter language, e.g. `deliveryInfo.state = \"failed_not_home\" and createdAt >= \"2026-09-01T00:00:00Z\"` or `address.address ~= \"Bristol\"`. Filterable fields include planId, routeId, type, activity, notes, address.*, recipient.name/email/phone/externalId, deliveryInfo.state/attempted/succeeded/attemptedAt, orderInfo.*, barcodes, packageLabel, createdAt, arrivalAt and customProperties.<id>. String comparisons with >, >=, <, <= work on ISO-8601 dates only. The search index lags the live data slightly, so a stop created seconds ago may not be found yet.",
    inputSchema: {
      keyword: z.string().min(1).max(255).optional().describe("Keywords, fuzzy-matched across the stops' text fields"),
      filter: z.string().min(1).max(2048).optional().describe("Filter expression in Spoke's SQL-like syntax (sent as-is, the API validates it)"),
      sort_field: z.enum(SORT_FIELDS).optional().describe("Sort field; relevance when omitted"),
      sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction (the API's default is asc)"),
      max_results: maxResults(19),
      page_token: pageToken,
      include_contact_details: contactArg("recipient details, full addresses, proof-of-delivery links, tracking links and unredacted notes"),
    },
    annotations: READ,
  },
  safe(async ({ keyword, filter, sort_field, sort_order, max_results, page_token, include_contact_details }) => {
    if (!keyword && !filter) throw new SpokeError("Give a keyword, a filter, or both.");
    const r = await api.list("/stops:search", "stops", {
      maxItems: max_results,
      pageSize: PAGE_SIZES.search,
      // The search's maxPageSize has exclusiveMinimum 1, so max_results 1 still asks for a page of 2.
      minPageSize: SEARCH_MIN_PAGE,
      pageToken: page_token,
      query: { keyword, filter, sortField: sort_field, sortOrder: sort_order },
    });
    return { count: r.items.length, pages_fetched: r.pages, complete: r.complete, next_page_token: r.next_page_token, note: pageNote(r), stops: r.items.map((h) => fmt.searchHit(h, include_contact_details)) };
  }),
);

server.registerTool(
  "list_routes",
  {
    title: "List routes",
    description: "Routes (one driver's run within a plan) with stop count, driver, plan and state (distributed, started, completed, recipients notified, with timestamps).",
    inputSchema: { max_results: maxResults(50), page_token: pageToken, include_contact_details: contactArg("email addresses and phone numbers typed into route titles") },
    annotations: READ,
  },
  safe(async ({ max_results, page_token, include_contact_details }) => {
    const r = await api.list("/routes", "routes", { maxItems: max_results, pageSize: PAGE_SIZES.routes, pageToken: page_token });
    return { count: r.items.length, pages_fetched: r.pages, complete: r.complete, next_page_token: r.next_page_token, note: pageNote(r), routes: r.items.map((x) => fmt.routeSummary(x, include_contact_details)) };
  }),
);

server.registerTool(
  "get_route",
  {
    title: "Get a route",
    description: "One route with its stop count, driver, plan and state. Use list_route_stops for the stops.",
    inputSchema: { route_id: idArg("routes", "Route"), include_contact_details: contactArg("email addresses and phone numbers typed into the title") },
    annotations: READ,
  },
  safe(async ({ route_id, include_contact_details }) => ({ route: fmt.routeSummary(await api.get(`/routes/${bare(route_id)}`), include_contact_details) })),
);

server.registerTool(
  "list_drivers",
  {
    title: "List drivers",
    description: "Drivers on the team with their active status, depots and route overrides (working hours, vehicle, max stops). Email, phone and a driver's own start/end address are only returned with include_contact_details.",
    inputSchema: {
      active: z.boolean().optional().describe("Only active (true) or only paused (false) drivers; paused drivers are not assigned to routes (the API's filter.active)"),
      max_results: maxResults(100),
      page_token: pageToken,
      include_contact_details: contactArg("driver email addresses, phone numbers and full start/end addresses"),
    },
    annotations: READ,
  },
  safe(async ({ active, max_results, page_token, include_contact_details }) => {
    const r = await api.list("/drivers", "drivers", { maxItems: max_results, pageSize: PAGE_SIZES.drivers, pageToken: page_token, query: { "filter.active": active === undefined ? undefined : String(active) } });
    return { count: r.items.length, pages_fetched: r.pages, complete: r.complete, next_page_token: r.next_page_token, note: pageNote(r), drivers: r.items.map((d) => fmt.driver(d, include_contact_details)) };
  }),
);

server.registerTool(
  "get_driver",
  {
    title: "Get a driver",
    description: "One driver: name, active status, depots and route overrides. Email, phone and start/end address only with include_contact_details.",
    inputSchema: { driver_id: idArg("drivers", "Driver"), include_contact_details: contactArg("the driver's email address, phone number and full start/end addresses") },
    annotations: READ,
  },
  safe(async ({ driver_id, include_contact_details }) => ({ driver: fmt.driver(await api.get(`/drivers/${bare(driver_id)}`), include_contact_details) })),
);

server.registerTool(
  "list_depots",
  {
    title: "List depots",
    description: "Depots (the team's operating bases) with their default route settings: start time, start and end address, round trip, time at stop, max stops, vehicle type.",
    inputSchema: { max_results: maxResults(50), page_token: pageToken, include_contact_details: contactArg("email addresses and phone numbers typed into depot names or addresses") },
    annotations: READ,
  },
  safe(async ({ max_results, page_token, include_contact_details }) => {
    const r = await api.list("/depots", "depots", { maxItems: max_results, pageSize: PAGE_SIZES.depots, pageToken: page_token });
    return { count: r.items.length, pages_fetched: r.pages, complete: r.complete, next_page_token: r.next_page_token, note: pageNote(r), depots: r.items.map((d) => fmt.depot(d, include_contact_details)) };
  }),
);

server.registerTool(
  "list_operations",
  {
    title: "List operations",
    description: "Long-running operations (currently only plan_optimization) with whether they are done, who started them, the target plan and the result (stops optimized, stops skipped with reasons, or an error).",
    inputSchema: {
      done: z.boolean().optional().describe("Only finished (true) or only running (false) operations (the API's filter.done)"),
      type: z.enum(["plan_optimization"]).optional().describe("Only operations of this type (the API's filter.type)"),
      max_results: maxResults(50),
      page_token: pageToken,
    },
    annotations: READ,
  },
  safe(async ({ done, type, max_results, page_token }) => {
    const r = await api.list("/operations", "operations", { maxItems: max_results, pageSize: PAGE_SIZES.operations, pageToken: page_token, query: { "filter.done": done === undefined ? undefined : String(done), "filter.type": type } });
    return { count: r.items.length, pages_fetched: r.pages, complete: r.complete, next_page_token: r.next_page_token, note: pageNote(r), operations: r.items.map((o) => fmt.operation(o, false)) };
  }),
);

server.registerTool(
  "get_operation",
  {
    title: "Get an operation",
    description: "One operation, to poll a plan optimization started with optimize_plan: done, timestamps, and the result or error once finished.",
    inputSchema: { operation_id: idArg("operations", "Operation") },
    annotations: READ,
  },
  safe(async ({ operation_id }) => ({ operation: fmt.operation(await api.get(`/operations/${bare(operation_id)}`), false) })),
);

if (allowWrites) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
  const IRREVERSIBLE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

  // Request-body shapes from the spec: POST /plans and the items of POST /plans/{planId}/stops:import.
  // Every optional field is nullable in the spec; strict objects catch misspelt keys before any call.
  const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
  const writeAddress = z
    .strictObject({
      addressName: nullable(z.string().min(1).max(255)).describe("Display name only, not used for geocoding"),
      addressLineOne: nullable(z.string().min(1).max(255)),
      addressLineTwo: nullable(z.string().min(1).max(255)),
      city: nullable(z.string().min(1).max(100)),
      state: nullable(z.string().min(1).max(100)),
      zip: nullable(z.string().min(1).max(100)),
      country: nullable(z.string().min(1).max(100)),
      latitude: nullable(z.number().min(-90).max(90)),
      longitude: nullable(z.number().min(-180).max(180)),
    })
    .describe("Address fields as documented; latitude and longitude, when both set, override the text fields");
  const SPEEDS = ["slower", "average", "faster"] as const;
  const VEHICLES = ["bike", "scooter", "car", "small_truck", "truck", "electric_cargo_bike"] as const;
  const CURRENCIES = ["AED", "ARS", "AUD", "BRL", "CAD", "CHF", "CLP", "CNY", "COP", "DKK", "EGP", "EUR", "GBP", "HKD", "HUF", "ILS", "INR", "JPY", "KRW", "MYR", "MXN", "NOK", "NZD", "PEN", "RON", "RUB", "SAR", "SEK", "SGD", "TRY", "USD", "UYU", "ZAR"] as const;
  // POST /plans documents drivers as at most 50; a stop's allowedDrivers in the import as at most 100.
  const driverIdList = z.array(idArg("drivers", "Driver")).max(50);
  const allowedDriverList = z.array(idArg("drivers", "Driver")).max(100);
  const hasAnyField = (o: Record<string, unknown>) => Object.values(o).some((v) => v !== undefined && v !== null);

  server.registerTool(
    "create_plan",
    {
      title: "Create a plan",
      description:
        "Create a new (empty) plan for a date, optionally with drivers, a depot and route overrides. Then import_stops, optimize_plan and distribute_plan. If Spoke answers with a gateway error (502/503/504) the request is NOT retried, because the plan may already exist: check list_plans before calling again. Only available when SPOKE_ALLOW_WRITES=true.",
      inputSchema: {
        title: z.string().min(1).max(255).describe("Plan title"),
        starts: PLAN_DATE.describe("Start date, YYYY-MM-DD, a real calendar date in 2000-2100 (the API rejects dates too far in the past or future)"),
        drivers: driverIdList.default([]).describe("Driver IDs to assign (drivers/<id> or bare); their depot must match the plan's depot"),
        depot: idArg("depots", "Depot").optional().describe("Depot ID; the team's main depot when omitted"),
        route_overrides: z
          .strictObject({
            start_address: writeAddress.optional().describe("Start location for every route in this plan"),
            end_address: writeAddress.optional().describe("End location for every route in this plan"),
            start_time: TIME.optional().describe("Start of the drivers' working day, HH:MM"),
            end_time: TIME.optional().describe("End of the drivers' working day, HH:MM"),
            max_stops: z.number().int().nonnegative().optional().describe("Maximum stops per route, 0 or more as the API documents it (ignored when vehicle capacity or pickups are used)"),
            driving_speed: z.enum(SPEEDS).optional(),
            delivery_speed: z.enum(SPEEDS).optional(),
            vehicle_type: z.enum(VEHICLES).optional(),
            optimization_objective: z.enum(["distribute_services"]).optional().describe("Primary optimization objective (the only value the create schema documents)"),
            optimization_sub_objective: z.enum(["equalize_workload", "equalize_time", "maximize_efficiency"]).optional(),
          })
          .optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ title, starts, drivers, depot, route_overrides }) => {
      const ro = route_overrides;
      const body = {
        title,
        starts: toDate(starts),
        ...(drivers.length ? { drivers: [...new Set(drivers.map((d) => prefixed("drivers", d)))] } : {}),
        ...(depot ? { depot: prefixed("depots", depot) } : {}),
        ...(ro
          ? {
              routeOverrides: {
                ...(ro.start_address ? { startAddress: ro.start_address } : {}),
                ...(ro.end_address ? { endAddress: ro.end_address } : {}),
                ...(ro.start_time ? { startTime: toTime(ro.start_time) } : {}),
                ...(ro.end_time ? { endTime: toTime(ro.end_time) } : {}),
                ...(ro.max_stops !== undefined ? { maxStops: ro.max_stops } : {}),
                ...(ro.driving_speed ? { drivingSpeed: ro.driving_speed } : {}),
                ...(ro.delivery_speed ? { deliverySpeed: ro.delivery_speed } : {}),
                ...(ro.vehicle_type ? { vehicleType: ro.vehicle_type } : {}),
                ...(ro.optimization_objective || ro.optimization_sub_objective
                  ? { optimizationSettings: { ...(ro.optimization_objective ? { objective: ro.optimization_objective } : {}), ...(ro.optimization_sub_objective ? { subObjective: ro.optimization_sub_objective } : {}) } }
                  : {}),
              },
            }
          : {}),
      };
      const created = await api.request("POST", "/plans", { body });
      return { created: fmt.plan(created, false) };
    }),
  );

  const stopInput = z.strictObject({
    address: writeAddress.refine(hasAnyField, "address needs at least one field"),
    recipient: nullable(
      z.strictObject({
        name: nullable(z.string()),
        email: nullable(z.string().email()).describe("One email address; multiple are not supported"),
        phone: nullable(z.string()),
        externalId: nullable(z.string()).describe("Your own reference for the recipient; usable later as a filter"),
      }),
    ),
    notes: nullable(z.string()).describe("Notes for the driver"),
    packageCount: nullable(z.number()),
    weight: nullable(z.strictObject({ amount: z.number().min(0).max(999999), unit: z.enum(["kilogram", "pound", "metric-ton"]) })),
    barcodes: z.array(z.string()).max(200).optional(),
    timing: nullable(
      z.strictObject({
        earliestAttemptTime: nullable(TIME).describe("HH:MM"),
        latestAttemptTime: nullable(TIME).describe("HH:MM"),
        estimatedAttemptDuration: nullable(z.number().int().min(0).max(8 * 3600)).describe("Seconds at the stop, up to 8 hours; omit for the team default"),
      }),
    ),
    orderInfo: nullable(
      z.strictObject({
        products: z.array(z.string()).max(100).optional(),
        invoiceNumber: nullable(z.string()),
        sellerOrderId: nullable(z.string()),
        sellerName: nullable(z.string()),
        sellerWebsite: nullable(z.string()),
      }),
    ),
    paymentOnDelivery: nullable(z.strictObject({ amount: nullable(z.number().int().min(0)).describe("Minor units, e.g. pence"), currency: nullable(z.enum(CURRENCIES)) })),
    proofOfAttemptRequirements: nullable(z.strictObject({ enabled: nullable(z.boolean()) })),
    allowedDrivers: nullable(allowedDriverList).describe("Drivers allowed to take this stop (up to 100); they must be part of the plan"),
    activity: nullable(z.enum(["delivery", "pickup"])),
    optimizationOrder: nullable(z.enum(["first", "last", "default"])),
    clientId: nullable(z.string()).describe("Spoke Connect client ID"),
    customProperties: nullable(z.record(z.string(), z.string().nullable())).describe("Keyed by custom stop property ID (not name), as defined for the team"),
    serviceInfo: nullable(z.strictObject({ identifier: nullable(z.string()), slaStartsAt: nullable(z.number().int()).describe("Seconds since epoch") })),
  });

  server.registerTool(
    "import_stops",
    {
      title: "Import stops into a plan",
      description:
        "Batch-import up to 100 stops into a writable plan (POST /plans/{planId}/stops:import). Field names are the API's own (address, recipient, notes, packageCount, weight, barcodes, timing, orderInfo, paymentOnDelivery, proofOfAttemptRequirements, allowedDrivers, activity, optimizationOrder, clientId, customProperties, serviceInfo); only address is required and it needs at least one field. The result lists the IDs created and the stops Spoke rejected with its reason for each; a rejected stop is identified by the external ID and first address line that were sent in this same call (with any email or phone number redacted), since the API echoes the stop back rather than its position in the array. If Spoke answers with a gateway error the import is NOT retried, because the stops may already be in the plan: check list_plan_stops before calling again. Only available when SPOKE_ALLOW_WRITES=true.",
      inputSchema: {
        plan_id: idArg("plans", "Plan"),
        stops: z.array(stopInput).min(1).max(100).describe("Stops to import (1 to 100 per call, the documented maximum)"),
      },
      annotations: WRITE,
    },
    safe(async ({ plan_id, stops }) => {
      const body = stops.map((s) => {
        const { timing, allowedDrivers, ...rest } = s;
        const out: Record<string, unknown> = { ...rest };
        if (timing !== undefined) {
          out.timing =
            timing === null
              ? null
              : {
                  ...(timing.earliestAttemptTime !== undefined ? { earliestAttemptTime: timing.earliestAttemptTime === null ? null : toTime(timing.earliestAttemptTime) } : {}),
                  ...(timing.latestAttemptTime !== undefined ? { latestAttemptTime: timing.latestAttemptTime === null ? null : toTime(timing.latestAttemptTime) } : {}),
                  ...(timing.estimatedAttemptDuration !== undefined ? { estimatedAttemptDuration: timing.estimatedAttemptDuration } : {}),
                };
        }
        if (allowedDrivers !== undefined) out.allowedDrivers = allowedDrivers === null ? null : allowedDrivers.map((d) => prefixed("drivers", d));
        return out;
      });
      const res = await api.request("POST", `/plans/${bare(plan_id)}/stops:import`, { body });
      const success: string[] = Array.isArray(res?.success) ? res.success : [];
      const failed: any[] = Array.isArray(res?.failed) ? res.failed : [];
      return {
        plan: prefixed("plans", plan_id),
        imported: success.length,
        rejected: failed.length,
        stop_ids: success,
        // The rejected stops are echoed by the API with the recipient data that was sent. Only the reason,
        // the first address line and the external ID are reported back, so the caller can tell which of
        // the stops it just submitted failed; both are the caller's own input from this call, and the
        // reason and address line get the free-text redaction in case they carry an email or phone.
        failures: failed.map((f) => ({ reason: fmt.redactContacts(f?.error?.message, false), address_line_one: fmt.redactContacts(f?.stop?.address?.addressLineOne, false), external_id: f?.stop?.recipient?.externalId ?? undefined })),
      };
    }),
  );

  server.registerTool(
    "optimize_plan",
    {
      title: "Optimize a plan",
      description:
        "Start optimizing a plan's stops into routes for its drivers (POST /plans/{planId}:optimize). Returns the plan_optimization operation to poll with get_operation; the plan's optimization state becomes optimizing, then optimized. Spoke limits this to 30 requests a minute and 100 per 10 minutes. Refused by the API when the plan is already optimized, is being optimized, has no drivers, or is not writable. Not retried after a gateway error: check list_operations first. Only available when SPOKE_ALLOW_WRITES=true.",
      inputSchema: { plan_id: idArg("plans", "Plan") },
      annotations: WRITE,
    },
    safe(async ({ plan_id }) => ({ operation: fmt.operation(await api.request("POST", `/plans/${bare(plan_id)}:optimize`), false) })),
  );

  server.registerTool(
    "distribute_plan",
    {
      title: "Distribute a plan to its drivers",
      description:
        "Send an optimized plan's routes to the drivers' Spoke apps (POST /plans/{planId}:distribute). This notifies real drivers and cannot be undone through the API, so confirm with the user first. Refused by the API when the plan is not optimized, is optimizing, or was already distributed. Not retried after a gateway error: check get_plan (distributed) first. Only available when SPOKE_ALLOW_WRITES=true.",
      inputSchema: { plan_id: idArg("plans", "Plan") },
      annotations: IRREVERSIBLE,
    },
    safe(async ({ plan_id }) => ({ plan: fmt.plan(await api.request("POST", `/plans/${bare(plan_id)}:distribute`), false) })),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Spoke MCP server running (writes ${allowWrites ? "enabled" : "disabled"}).`);
