// End-to-end test: fixtures are validated against Spoke's published OpenAPI 3.1 schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_KEY, AUTH, BASE_PATH } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://developer.dispatch.spoke.com/openapi-v1.json";
if (!existsSync(`${root}spec.json`)) {
  try {
    const text = await (await fetch(SPEC_URL)).text();
    JSON.parse(text); // fail here, not later, if the download was an error page
    writeFileSync(`${root}spec.json`, text);
  } catch (err) {
    console.error(`Could not download the Spoke spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
assert.equal(spec.openapi, "3.1.0", "the Spoke spec is OpenAPI 3.1 (JSON Schema 2020-12)");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "spoke", components: spec.components });
// Inline operation schemas (list responses, request bodies) refer to "#/components/schemas/..." relative
// to the document, so their refs are pointed at the registered "spoke" schema.
const inline = (schema) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"spoke#/components/'));
const compiled = new Map();
const validateWith = (schema, obj, label) => {
  const key = typeof schema === "string" ? schema : schema;
  if (!compiled.has(key)) compiled.set(key, typeof schema === "string" ? ajv.getSchema(`spoke#/components/schemas/${schema}`) ?? ajv.compile({ $ref: `spoke#/components/schemas/${schema}` }) : ajv.compile(inline(schema)));
  const v = compiled.get(key);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors, { dataVar: label })}`);
};
const validate = (schemaName, obj, id = "") => validateWith(schemaName, obj, `${schemaName} ${id}`);
const responseSchema = (path, method, status = "200") => spec.paths[path][method].responses[status].content["application/json"].schema;
const requestSchema = (path, method) => spec.paths[path][method].requestBody.content["application/json"].schema;

console.log("fixtures vs OpenAPI spec");
await check("plans, stops, unassigned stops, routes, drivers, depots and operations match their component schemas (additionalProperties: false)", async () => {
  [...fx.plans, fx.restrictedPlan].forEach((p) => validate("planSchema", p, p.id));
  fx.allStops.forEach((s) => validate("stopSchema", s, s.id));
  fx.unassignedStops.forEach((s) => validate("unassignedStopSchema", s, s.id));
  fx.routes.forEach((r) => validate("routeSchema", r, r.id));
  fx.drivers.forEach((d) => validate("driverSchema", d, d.id));
  fx.depots.forEach((d) => validate("depotSchema", d, d.id));
  fx.operations.forEach((o) => validate("operationSchema", o, o.id));
  assert.equal(fx.plans.length, 26);
  assert.equal(fx.todayStops.length, 25);
  // Negative controls, so a schema that accepted anything would be noticed.
  const v = ajv.compile({ $ref: "spoke#/components/schemas/planSchema" });
  assert.equal(v({ ...fx.plans[0], id: "plan-without-prefix" }), false, "the id pattern must reject a bare id");
  assert.equal(v({ ...fx.plans[0], extra: 1 }), false, "additionalProperties: false must reject an unknown key");
  const vs = ajv.compile({ $ref: "spoke#/components/schemas/stopSchema" });
  const { recipient, ...noRecipient } = fx.todayStops[1];
  assert.equal(vs(noRecipient), false, "recipient is required on a stop");
});

// 2. The mock's responses (lists, single records, writes, errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm, created } = await startMock();
const base = `http://127.0.0.1:${port}${BASE_PATH}`;
const raw = async (method, path, init = {}) => {
  const res = await fetch(base + path, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, ...init });
  return { status: res.status, json: await res.json() };
};
await check("mock: list, detail, search, import, optimize and distribute responses match the documented schemas; 401, 403, 404, 409 and 400 use the documented shapes", async () => {
  const plans = await raw("GET", "/plans?maxPageSize=20");
  validateWith(responseSchema("/plans", "get"), plans.json, "GET /plans");
  assert.equal(plans.json.plans.length, 20);
  assert.equal(plans.json.nextPageToken, "pt-20");
  const page2 = await raw("GET", "/plans?maxPageSize=20&pageToken=pt-20");
  validateWith(responseSchema("/plans", "get"), page2.json, "GET /plans page 2");
  assert.deepEqual([page2.json.plans.length, page2.json.nextPageToken], [6, null]);
  validateWith(responseSchema("/plans/{planId}", "get"), (await raw("GET", `/${fx.PLAN_TODAY}`)).json, "GET /plans/{planId}");
  const stops = await raw("GET", `/${fx.PLAN_TODAY}/stops?maxPageSize=10`);
  validateWith(responseSchema("/plans/{planId}/stops", "get"), stops.json, "GET /plans/{planId}/stops");
  assert.equal(stops.json.nextPageToken, "pt-10");
  const search = await raw("GET", `/stops:search?maxPageSize=19&filter=${encodeURIComponent('recipient.externalId = "ORD-1099" or recipient.externalId = "ORD-1002"')}`);
  validateWith(responseSchema("/stops:search", "get"), search.json, "GET /stops:search");
  assert.deepEqual(search.json.stops.map((h) => h.type), ["stop", "stop", "unassignedStop"], "the search answers with both item kinds (ORD-1002 is a stop in two plans)");
  assert.equal((await raw("GET", `/stops:search?keyword=bristol&maxPageSize=20`)).status, 400, "maxPageSize 20 is above the search's exclusiveMaximum");
  validateWith(responseSchema("/routes", "get"), (await raw("GET", "/routes")).json, "GET /routes");
  validateWith(responseSchema("/routes/{routeId}", "get"), (await raw("GET", `/${fx.ROUTE_1}`)).json, "GET /routes/{routeId}");
  validateWith(responseSchema("/routes/{routeId}/stops", "get"), (await raw("GET", `/${fx.ROUTE_1}/stops`)).json, "GET /routes/{routeId}/stops");
  validateWith(responseSchema("/drivers", "get"), (await raw("GET", "/drivers?filter.active=true")).json, "GET /drivers");
  validateWith(responseSchema("/drivers/{driverId}", "get"), (await raw("GET", `/${fx.DRIVER_SAM}`)).json, "GET /drivers/{driverId}");
  const limited = await raw("GET", "/depots"); // the mock answers the first depots call with a 429
  assert.equal(limited.status, 429);
  validateWith(responseSchema("/depots", "get", "default"), limited.json, "429 body vs the default error model");
  validateWith(responseSchema("/depots", "get"), (await raw("GET", "/depots")).json, "GET /depots");
  validateWith(responseSchema("/operations", "get"), (await raw("GET", "/operations?filter.done=true&filter.type=plan_optimization")).json, "GET /operations");
  validateWith(responseSchema("/operations/{operationId}", "get"), (await raw("GET", `/${fx.OP_DONE}`)).json, "GET /operations/{operationId}");
  // Errors.
  const noAuth = await fetch(base + "/plans", { headers: { Authorization: "Basic " + Buffer.from("spk-wrong-key:").toString("base64") } });
  assert.equal(noAuth.status, 401);
  validateWith(responseSchema("/plans", "get", "401"), await noAuth.json(), "401");
  const restricted = await raw("GET", `/${fx.PLAN_RESTRICTED}`);
  assert.equal(restricted.status, 403);
  validateWith(responseSchema("/plans/{planId}", "get", "403"), restricted.json, "403 plan_inaccessible");
  const missing = await raw("GET", "/plans/nope");
  assert.equal(missing.status, 404);
  validateWith(responseSchema("/plans/{planId}", "get", "404"), missing.json, "404 Plan not found");
  validateWith(responseSchema("/routes/{routeId}", "get", "404"), (await raw("GET", "/routes/nope")).json, "404 Route not found");
  validateWith(responseSchema("/drivers/{driverId}", "get", "404"), (await raw("GET", "/drivers/nope")).json, "404 Driver not found");
  validateWith(responseSchema("/operations/{operationId}", "get", "404"), (await raw("GET", "/operations/nope")).json, "404 operation_not_found");
  validateWith(responseSchema("/plans", "get", "400"), (await raw("GET", "/plans?filter.startsGte=today")).json, "400 bad date");
  // The search's 400 is a oneOf whose first branch (any {message, code?, param?, url?}) also matches the
  // specific "Invalid filter string" branch, so no body can satisfy "exactly one"; the mock's answer is
  // checked against the specific branch instead.
  const badFilterSchema = responseSchema("/stops:search", "get", "400").oneOf.find((s) => s.title === "Invalid filter string");
  validateWith(badFilterSchema, (await raw("GET", "/stops:search?filter=%3D%3D")).json, "400 bad filter");
  // Writes.
  const createBody = { title: "Mock plan", starts: { day: 1, month: 10, year: 2026 }, drivers: [fx.DRIVER_SAM] };
  validateWith(requestSchema("/plans", "post"), createBody, "POST /plans mock body");
  const createdPlan = await raw("POST", "/plans", { body: JSON.stringify(createBody) });
  assert.equal(createdPlan.status, 200);
  validateWith(responseSchema("/plans", "post"), createdPlan.json, "POST /plans response");
  validateWith(responseSchema("/plans", "post", "404"), (await raw("POST", "/plans", { body: JSON.stringify({ ...createBody, drivers: ["drivers/nope"] }) })).json, "POST /plans 404");
  validateWith(responseSchema("/plans", "post", "400"), (await raw("POST", "/plans", { body: JSON.stringify({ title: "x" }) })).json, "POST /plans 400");
  const imported = await raw("POST", `/${createdPlan.json.id}/stops:import`, { body: JSON.stringify([{ address: { addressLineOne: "1 Test Street", city: "Bristol" } }, { address: {} }]) });
  assert.equal(imported.status, 200);
  validateWith(responseSchema("/plans/{planId}/stops:import", "post"), imported.json, "POST stops:import response");
  assert.deepEqual([imported.json.success.length, imported.json.failed.length], [1, 1]);
  validateWith(responseSchema("/plans/{planId}/stops:import", "post", "409"), (await raw("POST", `/${fx.PLAN_OLD}/stops:import`, { body: "[{\"address\":{\"city\":\"Bath\"}}]" })).json, "409 plan_not_writable");
  const op = await raw("POST", `/${createdPlan.json.id}:optimize`);
  assert.equal(op.status, 200);
  validateWith(responseSchema("/plans/{planId}:optimize", "post"), op.json, "POST :optimize response");
  validateWith(responseSchema("/plans/{planId}:optimize", "post", "409"), (await raw("POST", `/${fx.PLAN_TODAY}:optimize`)).json, "409 plan_already_optimized");
  validateWith(responseSchema("/plans/{planId}:distribute", "post", "409"), (await raw("POST", `/${fx.PLAN_TOMORROW}:distribute`)).json, "409 plan_not_optimized");
  const distributed = await raw("POST", `/${fx.PLAN_READY}:distribute`);
  assert.equal(distributed.status, 200);
  validateWith(responseSchema("/plans/{planId}:distribute", "post"), distributed.json, "POST :distribute response");
  fx.plans.find((p) => p.id === fx.PLAN_READY).distributed = false; // put the fixture back for the MCP run
  created.plans.length = 0;
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP. `writes` is the literal SPOKE_ALLOW_WRITES value; null leaves it unset.
const connect = async (key, writes = "true") => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, SPOKE_API_KEY: key, SPOKE_BASE_URL: base };
  delete env.SPOKE_ALLOW_WRITES;
  if (writes !== null) env.SPOKE_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const READS = ["list_plans", "get_plan", "list_plan_stops", "search_stops", "list_routes", "get_route", "list_route_stops", "list_drivers", "get_driver", "list_depots", "list_operations", "get_operation"];
const WRITES = ["create_plan", "import_stops", "optimize_plan", "distribute_plan"];

const client = await connect(API_KEY);
console.log("mcp tools");

await check("tools/list exposes 16 tools; reads are read-only, distribute_plan is destructive, the other writes are not", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READS, ...WRITES].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, READS.includes(t.name), `${t.name} readOnlyHint`);
    if (WRITES.includes(t.name)) assert.equal(t.annotations?.destructiveHint, t.name === "distribute_plan", `${t.name} destructiveHint`);
  }
});

await check("list_plans pages with maxPageSize 20 and pageToken until nextPageToken is null; titles are redacted by default", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_plans", { max_results: 100 });
  assert.deepEqual([data.count, data.pages_fetched, data.complete, data.next_page_token], [26, 2, true, undefined]);
  assert.deepEqual(since(n).map((r) => [r.path, r.query.maxPageSize, r.query.pageToken]), [["/plans", "20", undefined], ["/plans", "20", "pt-20"]]);
  assert.equal(data.plans[0].id, fx.PLAN_TODAY);
  assert.equal(data.plans[0].starts, "2026-09-28");
  assert.deepEqual(data.plans[0].routes, [fx.ROUTE_1, fx.ROUTE_2]);
  assert.equal(data.plans[1].title, "Bath Tuesday (queries to [phone redacted])");
  assert.equal(data.plans[1].route_overrides.start_time, "08:30");
  assert.equal(data.plans[1].route_overrides.start_address.line_one, "Unit 4, Avonmouth Way", "plan-level route addresses are returned as stored");
  assert.equal(data.plans[1].route_overrides.optimization.sub_objective, "equalize_workload");
  const withContact = await call(client, "list_plans", { max_results: 2, include_contact_details: true });
  assert.equal(withContact.data.plans[1].title, "Bath Tuesday (queries to 07700 900123)");
});

await check("list_plans returns whole pages, reports the next page token, and a continuation repeats the original filters with pageToken", async () => {
  const n = requests.length;
  const first = await call(client, "list_plans", { max_results: 5, starts_from: "2026-08-01", starts_to: "2026-09-30" });
  assert.deepEqual([first.data.count, first.data.complete, first.data.next_page_token], [5, false, "pt-5"]);
  assert.match(first.data.note, /page_token "pt-5"/);
  assert.deepEqual(since(n).map((r) => r.query), [{ "filter.startsGte": "2026-08-01", "filter.startsLte": "2026-09-30", maxPageSize: "5" }]);
  const next = await call(client, "list_plans", { max_results: 5, starts_from: "2026-08-01", starts_to: "2026-09-30", page_token: "pt-5" });
  assert.equal(requests.at(-1).query.pageToken, "pt-5");
  assert.deepEqual(requests.at(-1).query, { "filter.startsGte": "2026-08-01", "filter.startsLte": "2026-09-30", maxPageSize: "5", pageToken: "pt-5" }, "all the original query parameters are repeated");
  assert.equal(next.data.plans[0].id, "plans/pl-bulk-3", "the January plan is outside the range, so page 2 starts after today, tomorrow, ready, bulk-1 and bulk-2");
  assert.equal(first.data.plans.length + next.data.plans.length, 10);
});

await check("list_plans passes filter.title, filter.startsGte and filter.startsLte through exactly as documented, and refuses a bad date before any call", async () => {
  const byTitle = await call(client, "list_plans", { title: "Bristol north Monday" });
  assert.deepEqual(byTitle.data.plans.map((p) => p.id), [fx.PLAN_TODAY]);
  assert.equal(requests.at(-1).query["filter.title"], "Bristol north Monday");
  assert.equal(requests.at(-1).query["filter.startsGte"], undefined);
  const byDate = await call(client, "list_plans", { starts_from: "2026-09-29", starts_to: "2026-09-29" });
  assert.deepEqual(byDate.data.plans.map((p) => p.id), [fx.PLAN_TOMORROW, fx.PLAN_READY]);
  assert.deepEqual([requests.at(-1).query["filter.startsGte"], requests.at(-1).query["filter.startsLte"]], ["2026-09-29", "2026-09-29"]);
  const n = requests.length;
  for (const starts_from of ["29/09/2026", "2026-02-30", "2026-13-01"]) {
    const bad = await client.callTool({ name: "list_plans", arguments: { starts_from } });
    assert.ok(bad.isError, `${starts_from} should be refused`);
  }
  assert.equal(requests.length, n, "no request for a bad date");
  const leap = await call(client, "list_plans", { starts_from: "2028-02-29" });
  assert.ok(!leap.res.isError, "a real leap day is a valid date");
  assert.equal(requests.at(-1).query["filter.startsGte"], "2028-02-29");
});

await check("get_plan returns the plan; a plan behind the subscription's history limit gives the documented 403 with an explanation", async () => {
  const { data } = await call(client, "get_plan", { plan_id: fx.PLAN_TODAY });
  assert.deepEqual([data.plan.id, data.plan.distributed, data.plan.writable, data.plan.optimization, data.plan.depot], [fx.PLAN_TODAY, true, true, "optimized", fx.DEPOT_BRISTOL]);
  assert.equal(requests.at(-1).path, `/${fx.PLAN_TODAY}`);
  const bare = await call(client, "get_plan", { plan_id: "pl-today-1" });
  assert.equal(bare.data.plan.id, fx.PLAN_TODAY, "a bare id is accepted");
  const restricted = await call(client, "get_plan", { plan_id: fx.PLAN_RESTRICTED });
  assert.ok(restricted.res.isError);
  assert.match(restricted.text, /refused GET \/plans\/pl-restricted-5 \(403\)\. Plan is no longer accessible.*\(code plan_inaccessible\).*delivery-history period/);
});

await check("list_plan_stops pages 10/10/5 and withholds recipients, summarises addresses and redacts notes, custom properties and proof-of-delivery data by default", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_plan_stops", { plan_id: fx.PLAN_TODAY, max_results: 25 });
  assert.deepEqual([data.count, data.pages_fetched, data.complete], [25, 3, true]);
  assert.deepEqual(since(n).map((r) => [r.query.maxPageSize, r.query.pageToken]), [["10", undefined], ["10", "pt-10"], ["10", "pt-20"]]);
  const s = data.stops[1];
  assert.equal(s.id, `${fx.PLAN_TODAY}/stops/st-2`);
  assert.deepEqual([s.type, s.position, s.activity, s.plan, s.route.id, s.route.driver], ["stop", 2, "delivery", fx.PLAN_TODAY, fx.ROUTE_1, fx.DRIVER_SAM]);
  assert.deepEqual(s.address, { area: "Bristol, BS7, UK", note: "street, coordinates and place ID available with include_contact_details" }, "address reduced to town and outward postcode");
  assert.deepEqual(s.recipient, { withheld: ["name", "email", "phone", "external_id"], note: "available with include_contact_details" });
  assert.equal(s.notes, "Leave in porch. Contact: [phone redacted] or [email redacted]");
  assert.deepEqual(s.custom_properties, { "cp-notreal-1": "Neighbour [phone redacted]", "cp-notreal-2": "fragile" });
  assert.equal(s.tracking_link, undefined);
  assert.equal(s.eta.estimated_arrival, "2026-09-28T08:20:00.000Z");
  assert.deepEqual(s.travel_from_previous, { duration_s: 420, distance_m: 2100 });
  assert.equal(s.order.invoice_number, "INV-1002");
  const d = data.stops[2].delivery;
  assert.deepEqual([d.state, d.attempted, d.succeeded, d.attempted_at], ["delivered_to_third_party", true, true, "2026-09-28T08:30:00.000Z"]);
  assert.deepEqual(d.time_at_stop, { status: "available", arrived_at: "2026-09-28T08:28:00.000Z", departed_at: "2026-09-28T08:31:00.000Z", estimated: false });
  assert.equal(d.driver_internal_notes, "Gate code 4321, neighbour is on [phone redacted]");
  assert.equal(d.recipient_notes, "Ring the bell twice, or email me at [email redacted]");
  assert.equal(d.signee_name, "[withheld; available with include_contact_details]");
  assert.equal(d.proof, "1 photo(s) and a signature; links available with include_contact_details");
  assert.deepEqual([d.photo_urls, d.signature_url, d.attempted_location], [undefined, undefined, undefined]);
  assert.equal(data.stops[3].delivery.state, "failed_not_home");
  const pickup = data.stops[4];
  assert.deepEqual([pickup.activity, pickup.payment_on_delivery, pickup.weight, pickup.timing, pickup.allowed_drivers, pickup.eta], ["pickup", { amount_minor_units: 1250, currency: "GBP" }, { amount: 2.5, unit: "kilogram" }, { earliest: "09:00", latest: "12:00", estimated_attempt_duration_s: 300 }, [fx.DRIVER_SAM], { status: "pending", reason: "not_optimized" }]);
  assert.deepEqual(pickup.service, { status: "available", identifier: "svc-next-day", name: "Next day", sla_starts_at: "2026-09-27T08:00:00.000Z", sla_due_date: "2026-09-28", sla_due_time: "17:00", delivery_horizon: "1 days", price: { minor_units: 599, currency: "GBP" }, payment_on_delivery: true });
  assert.equal(data.stops[0].recipient, undefined, "a route start with no recipient reports nothing to withhold");
  assert.equal(data.stops[15].address.area, "Bristol, BS34, UK");
  const text = JSON.stringify(data);
  assert.ok(!text.includes("@example."), "no email address anywhere in the default output");
  assert.ok(!text.includes("Recipient ") && !text.includes("ORD-10") && !text.includes("Melbourne Road") && !text.includes("8QH"), "recipient names, external IDs, streets and full postcodes are withheld by default");
  assert.ok(!text.includes(fx.PHOTO_URL) && !text.includes(fx.SIGNATURE_URL) && !text.includes("track.example.invalid") && !text.includes("S. Evans"), "proof-of-delivery links, tracking links and signee names are withheld by default");
  for (const phone of ["07700 900222", "07700 900333", "07700 900789", "+447700900002"]) assert.ok(!text.includes(phone), `phone number ${phone} leaked`);
  assert.ok(text.includes("PKG-0002") && text.includes("A-1002") && text.includes("st-2"), "barcodes, seller order IDs and stop IDs are not mistaken for phone numbers");
});

await check("list_plan_stops returns recipients, full addresses, proof links and unredacted notes when explicitly asked", async () => {
  const { data } = await call(client, "list_plan_stops", { plan_id: fx.PLAN_TODAY, max_results: 10, include_contact_details: true });
  const s = data.stops[1];
  assert.deepEqual(s.recipient, { name: "Recipient 2", email: "recipient2@example.org", phone: "+447700900002", external_id: "ORD-1002" });
  assert.deepEqual(s.address, { address: "2 Melbourne Road, Bristol, BS7 8QH, UK", line_one: "2 Melbourne Road", line_two: "Bristol, BS7 8QH, UK", latitude: 51.472, longitude: -2.592, place_id: "place-not-real-2" });
  assert.equal(s.notes, "Leave in porch. Contact: 07700 900222 or jane@example.org");
  assert.equal(s.custom_properties["cp-notreal-1"], "Neighbour 07700 900333");
  assert.equal(s.tracking_link, "https://track.example.invalid/t/stop-2-not-real");
  const d = data.stops[2].delivery;
  assert.deepEqual([d.signee_name, d.photo_urls, d.signature_url, d.attempted_location], ["S. Evans", [fx.PHOTO_URL], fx.SIGNATURE_URL, { latitude: 51.473, longitude: -2.593 }]);
  assert.equal(d.driver_internal_notes, "Gate code 4321, neighbour is on 07700 900789");
});

await check("address summary: Irish and US postal codes are cut to the area or dropped like UK ones, a street stored in addressLineTwo stays (documented); a North-American phone number in notes is redacted", async () => {
  const { data } = await call(client, "list_plan_stops", { plan_id: fx.PLAN_TOMORROW });
  assert.deepEqual(data.stops.map((s) => s.address.area), ["Bath, BA2, UK", "Dublin, D02, Ireland", "Washington, DC, USA", "2 Melbourne Road, Bristol, BS7, UK"]);
  assert.equal(data.stops[2].notes, "US contact [phone redacted] or [phone redacted]");
  const text = JSON.stringify(data);
  for (const leak of ["X285", "20500", "8QH", "Fitzwilliam", "Pennsylvania", "555-0123", "555-0199", "@example."]) assert.ok(!text.includes(leak), `${leak} leaked by default`);
  const withContact = await call(client, "list_plan_stops", { plan_id: fx.PLAN_TOMORROW, include_contact_details: true });
  assert.equal(withContact.data.stops[1].address.address, "12 Fitzwilliam Square, Dublin, D02 X285, Ireland");
  assert.equal(withContact.data.stops[2].notes, "US contact (415) 555-0123 or 415-555-0199");
  // The helpers themselves, on formats the fixtures do not carry, plus negative controls for the phone pattern.
  const { addressArea, redactContacts } = await import(`${root}dist/format.js`);
  const area = (address) => addressArea({ address });
  assert.deepEqual(
    ["80 Wellington St, Ottawa, ON K1A 0A2, Canada", "Dam 1, 1012 JS Amsterdam, Netherlands", "Unter den Linden 1, 10117 Berlin, Germany", "1 George St, Sydney NSW 2000, Australia", "10 Downing Street, London, SW1A 2AA, UK", "1600 Pennsylvania Ave NW, Washington, DC 20500-0003, USA", "Somewhere, 20500"].map(area),
    ["Ottawa, ON K1A, Canada", "Amsterdam, Netherlands", "Berlin, Germany", "Sydney NSW, Australia", "London, SW1A, UK", "Washington, DC, USA", undefined],
  );
  for (const phone of ["(415) 555-0123", "415-555-0123", "415.555.0123", "415 555 0123", "4155550123", "+1 415 555 0123", "07700 900123", "020 7946 0958", "(020) 7946 0958", "0044 20 7946 0958"]) assert.equal(redactContacts(`call ${phone} now`, false), "call [phone redacted] now", phone);
  const keep = "PKG-0002 A-1002 INV-1002 ORD-0001-000123 st-2 2026-09-28 1790000000 10:30 code 4321 amount 1250 ref 4155550123x";
  assert.equal(redactContacts(keep, false), keep, "barcodes, order references, dates, epoch seconds, times and short codes are not phone numbers");
});

await check("list_plan_stops and list_route_stops pass filter.externalId through exactly; list_route_stops pages 10/5", async () => {
  const one = await call(client, "list_plan_stops", { plan_id: fx.PLAN_TODAY, external_id: "ORD-1005", include_contact_details: true });
  assert.deepEqual(one.data.stops.map((s) => s.recipient.external_id), ["ORD-1005"]);
  assert.deepEqual(requests.at(-1).query, { "filter.externalId": "ORD-1005", maxPageSize: "10" });
  const n = requests.length;
  const route = await call(client, "list_route_stops", { route_id: fx.ROUTE_1, max_results: 15 });
  assert.deepEqual([route.data.route, route.data.count, route.data.pages_fetched, route.data.complete], [fx.ROUTE_1, 15, 2, true]);
  assert.deepEqual(since(n).map((r) => [r.path, r.query.maxPageSize, r.query.pageToken]), [[`/${fx.ROUTE_1}/stops`, "10", undefined], [`/${fx.ROUTE_1}/stops`, "10", "pt-10"]]);
  assert.deepEqual(route.data.stops.map((s) => s.type).filter((t) => t !== "stop"), ["start", "end"]);
  const filtered = await call(client, "list_route_stops", { route_id: "rt-sam-1", external_id: "ORD-1003" });
  assert.equal(filtered.data.count, 1);
  assert.equal(requests.at(-1).query["filter.externalId"], "ORD-1003");
});

await check("search_stops passes keyword, filter, sortField and sortOrder through exactly, never asks for more than 19 per page, and returns both stops and unassigned stops redacted", async () => {
  const n = requests.length;
  const { data } = await call(client, "search_stops", { keyword: "Whiteladies", filter: 'notes ~= "awaiting" or planId = "plans/pl-today-1"', sort_field: "createdAt", sort_order: "desc", max_results: 50 });
  assert.deepEqual(since(n)[0].query, { keyword: "Whiteladies", filter: 'notes ~= "awaiting" or planId = "plans/pl-today-1"', sortField: "createdAt", sortOrder: "desc", maxPageSize: "19" });
  assert.deepEqual(data.stops.map((s) => s.kind), ["unassigned_stop"]);
  assert.deepEqual([data.stops[0].id, data.stops[0].depot, data.stops[0].address.area, data.stops[0].recipient.withheld], [fx.UNASSIGNED_1, fx.DEPOT_BRISTOL, "Bristol, BS8, UK", ["name", "email", "phone", "external_id"]]);
  const m = requests.length;
  const many = await call(client, "search_stops", { filter: 'planId = "plans/pl-today-1"', max_results: 50 });
  assert.deepEqual([many.data.count, many.data.pages_fetched, many.data.complete], [25, 2, true]);
  assert.deepEqual(since(m).map((r) => [r.query.maxPageSize, r.query.pageToken, r.query.filter]), [["19", undefined, 'planId = "plans/pl-today-1"'], ["19", "pt-19", 'planId = "plans/pl-today-1"']]);
  assert.ok(many.data.stops.every((s) => s.kind === "stop" && s.plan === fx.PLAN_TODAY));
  const failed = await call(client, "search_stops", { filter: 'deliveryInfo.state = "failed_not_home"', include_contact_details: true });
  assert.deepEqual(failed.data.stops.map((s) => [s.id, s.recipient.name]), [[`${fx.PLAN_TODAY}/stops/st-4`, "Recipient 4"]]);
  // The search's maxPageSize has exclusiveMinimum 1 (the smallest legal value is 2), so max_results 1
  // must not ask for a page of 1; the mock answers 400 to maxPageSize=1 like the schema says.
  const one = await call(client, "search_stops", { filter: 'planId = "plans/pl-today-1"', max_results: 1 });
  assert.ok(!one.res.isError, one.text);
  assert.equal(requests.at(-1).query.maxPageSize, "2", "max_results 1 asks for the smallest documented page, 2");
  assert.deepEqual([one.data.count, one.data.complete, one.data.next_page_token], [2, false, "pt-2"]);
  const badFilter = await call(client, "search_stops", { filter: "==" });
  assert.ok(badFilter.res.isError);
  assert.match(badFilter.text, /refused GET \/stops:search \(400\)\. Invalid filter string \(parameter filter\)/);
  const nothing = await client.callTool({ name: "search_stops", arguments: {} });
  assert.ok(nothing.isError && /keyword, a filter, or both/.test(nothing.content[0].text));
});

await check("list_routes and get_route expose driver, plan and state with ISO timestamps; route titles are redacted by default", async () => {
  const { data } = await call(client, "list_routes");
  assert.deepEqual(data.routes.map((r) => [r.id, r.driver, r.plan, r.stop_count]), [[fx.ROUTE_1, fx.DRIVER_SAM, fx.PLAN_TODAY, 15], [fx.ROUTE_2, fx.DRIVER_PRIYA, fx.PLAN_TODAY, 10], [fx.ROUTE_OLD, fx.DRIVER_SAM, fx.PLAN_OLD, 2]]);
  assert.deepEqual(data.routes[0].state, { distributed: true, distributed_at: "2026-09-28T07:00:00.000Z", started: true, started_at: "2026-09-28T08:00:00.000Z", completed: false, recipients_notified: true, recipients_notified_at: "2026-09-28T07:01:40.000Z" });
  assert.equal(data.routes[1].title, "Priya - Bristol north (ring [phone redacted])");
  const one = await call(client, "get_route", { route_id: fx.ROUTE_OLD });
  assert.deepEqual([one.data.route.state.completed, one.data.route.state.completed_at], [true, "2026-03-12T13:33:20.000Z"]);
  assert.equal(requests.at(-1).path, `/${fx.ROUTE_OLD}`);
});

await check("list_drivers passes filter.active through, hides email, phone and home addresses by default; get_driver returns them on request", async () => {
  const all = await call(client, "list_drivers");
  assert.equal(all.data.count, 4);
  assert.equal(requests.at(-1).query["filter.active"], undefined);
  assert.deepEqual(all.data.drivers[0], {
    id: fx.DRIVER_SAM, name: "Sam Evans", display_name: "Sam", active: true, depots: [fx.DEPOT_BRISTOL],
    route_overrides: { start_time: "08:00", end_time: "17:00", start_address: { area: "Penarth, CF64, UK", note: "street, coordinates and place ID available with include_contact_details" }, max_stops: 40, driving_speed: "average", delivery_speed: "average", vehicle_type: "small_truck" },
  });
  assert.equal(all.data.drivers[2].display_name, "Lee ([email redacted])");
  const text = JSON.stringify(all.data);
  assert.ok(!text.includes("@example.") && !text.includes("07700 900456") && !text.includes("+447700900123") && !text.includes("Plymouth Road"));
  const active = await call(client, "list_drivers", { active: false });
  assert.deepEqual(active.data.drivers.map((d) => d.id), [fx.DRIVER_LEE]);
  assert.equal(requests.at(-1).query["filter.active"], "false");
  const sam = await call(client, "get_driver", { driver_id: "drv-sam-1", include_contact_details: true });
  assert.deepEqual([sam.data.driver.email, sam.data.driver.phone, sam.data.driver.route_overrides.start_address.line_one], ["sam.evans@example.com", "+447700900123", "5 Plymouth Road"]);
  assert.equal(requests.at(-1).path, `/${fx.DRIVER_SAM}`);
});

await check("list_depots (after a 429 retry that waited for Retry-After) returns depots with their route defaults", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_depots");
  const tries = since(n).filter((r) => r.path === "/depots");
  assert.equal(tries.length, 2, "depots should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  // The no-header fallback on the first retry waits 1000-1300 ms, so only an honoured header gives 2 s.
  assert.ok(gap >= 2000 && gap < 2400, `retry should wait the Retry-After of 2 s, which the 1 s + jitter fallback cannot produce (waited ${gap} ms)`);
  assert.deepEqual(data.depots.map((d) => [d.id, d.name]), [[fx.DEPOT_BRISTOL, "Bristol hub"], [fx.DEPOT_BATH, "Bath (call [phone redacted])"]]);
  assert.deepEqual(data.depots[0].route_defaults, { start_time: "07:30", end_time: "18:00", start_address: { address: "Unit 4, Avonmouth Way, Bristol, BS11 9YA, UK", line_one: "Unit 4, Avonmouth Way", line_two: "Bristol, BS11 9YA, UK", latitude: 51.5011, longitude: -2.6968, place_id: "place-not-real-depot", country_code: "GB" }, round_trip: true, default_time_at_stop_s: 180, max_stops: 60, road_side: "any", vehicle_type: "small_truck" });
  assert.equal(data.depots[1].route_defaults, undefined);
});

await check("list_operations passes filter.done and filter.type through; get_operation shows results, skipped stops and errors", async () => {
  const done = await call(client, "list_operations", { done: true, type: "plan_optimization" });
  assert.deepEqual(requests.at(-1).query, { "filter.done": "true", "filter.type": "plan_optimization", maxPageSize: "20" });
  assert.deepEqual(done.data.operations.map((o) => o.id), [fx.OP_DONE, fx.OP_FAILED]);
  assert.deepEqual(done.data.operations[0].result, { optimized_stops: 23, skipped_stops: [{ id: `${fx.PLAN_TODAY}/stops/st-5`, reason: "impossible_time_window" }] });
  assert.deepEqual(done.data.operations[1].result, { error: { code: "no_drivers_available", message: "Plan has no drivers" } });
  const running = await call(client, "list_operations", { done: false });
  assert.deepEqual(running.data.operations.map((o) => [o.id, o.done, o.plan, o.started_by, o.result]), [[fx.OP_RUNNING, false, fx.PLAN_READY, "api", undefined]]);
  assert.equal(requests.at(-1).query["filter.done"], "false");
  const one = await call(client, "get_operation", { operation_id: fx.OP_DONE });
  assert.deepEqual([one.data.operation.started_at, one.data.operation.finished_at, one.data.operation.started_by], ["2026-09-28T06:00:00.000Z", "2026-09-28T06:01:40.000Z", "dispatcher"]);
});

await check("create_plan posts a body that validates against the spec's POST /plans request schema", async () => {
  const n = requests.length;
  const { data } = await call(client, "create_plan", {
    title: "Bristol east Wednesday",
    starts: "2026-09-30",
    drivers: ["drv-sam-1", fx.DRIVER_PRIYA, fx.DRIVER_SAM],
    depot: "dep-bristol-1",
    route_overrides: { start_time: "07:45", end_time: "16:00", max_stops: 35, vehicle_type: "car", delivery_speed: "faster", optimization_objective: "distribute_services", optimization_sub_objective: "equalize_time", start_address: { addressLineOne: "Unit 4, Avonmouth Way", city: "Bristol", zip: "BS11 9YA", country: "UK" } },
  });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["POST /plans"]);
  const post = requests.at(-1);
  assert.equal(post.contentType, "application/json");
  validateWith(requestSchema("/plans", "post"), post.body, "POST /plans body vs request schema");
  assert.deepEqual(post.body, {
    title: "Bristol east Wednesday",
    starts: { year: 2026, month: 9, day: 30 },
    drivers: [fx.DRIVER_SAM, fx.DRIVER_PRIYA],
    depot: fx.DEPOT_BRISTOL,
    routeOverrides: { startAddress: { addressLineOne: "Unit 4, Avonmouth Way", city: "Bristol", zip: "BS11 9YA", country: "UK" }, startTime: { hour: 7, minute: 45 }, endTime: { hour: 16, minute: 0 }, maxStops: 35, deliverySpeed: "faster", vehicleType: "car", optimizationSettings: { objective: "distribute_services", subObjective: "equalize_time" } },
  });
  assert.deepEqual([data.created.title, data.created.starts, data.created.optimization, data.created.drivers], ["Bristol east Wednesday", "2026-09-30", "creating", [fx.DRIVER_SAM, fx.DRIVER_PRIYA]]);
  const minimal = await call(client, "create_plan", { title: "Minimal", starts: "2026-10-01" });
  assert.deepEqual(requests.at(-1).body, { title: "Minimal", starts: { year: 2026, month: 10, day: 1 } });
  validateWith(requestSchema("/plans", "post"), requests.at(-1).body, "minimal POST /plans body");
  assert.equal(minimal.data.created.depot, fx.DEPOT_BRISTOL);
  const unknownDriver = await call(client, "create_plan", { title: "x", starts: "2026-10-01", drivers: ["drivers/nope"] });
  assert.ok(unknownDriver.res.isError);
  assert.match(unknownDriver.text, /Not found: \/plans\. Check the ID\. Driver not found/);
  // The request schema documents starts as day 1-31, month 1-12, year 2000-2100; a date-shaped string
  // outside that (or not a real calendar date) is refused before any request.
  const m = requests.length;
  for (const starts of ["2026-13-01", "2026-02-30", "0000-00-00", "1999-12-31", "2101-01-01", "2026-00-10"]) {
    const bad = await client.callTool({ name: "create_plan", arguments: { title: "x", starts } });
    assert.ok(bad.isError, `create_plan should refuse starts ${starts}`);
  }
  assert.equal(requests.length, m, "no request for an invalid plan date");
  const zero = await call(client, "create_plan", { title: "Zero", starts: "2026-10-04", route_overrides: { max_stops: 0 } });
  assert.ok(!zero.res.isError, zero.text);
  assert.equal(requests.at(-1).body.routeOverrides.maxStops, 0, "maxStops 0 is documented (minimum 0)");
  validateWith(requestSchema("/plans", "post"), requests.at(-1).body, "POST /plans body with maxStops 0");
});

const stopsToImport = [
  { address: { addressLineOne: "7 Cotham Hill", city: "Bristol", zip: "BS6 6LD", country: "UK" }, recipient: { name: "Pat Recipient", email: "pat@example.org", phone: "07700 900777", externalId: "ORD-2001" }, notes: "Side door", packageCount: 2, timing: { earliestAttemptTime: "09:00", latestAttemptTime: "12:30", estimatedAttemptDuration: 240 }, allowedDrivers: ["drv-sam-1"], barcodes: ["PKG-2001"], customProperties: { "cp-notreal-2": "fragile" }, paymentOnDelivery: { amount: 500, currency: "GBP" } },
  { address: { latitude: 51.46, longitude: -2.6 }, activity: "pickup", optimizationOrder: "first", weight: { amount: 12, unit: "kilogram" }, orderInfo: { products: ["Crate"], invoiceNumber: "INV-2002", sellerOrderId: null, sellerName: "Acme", sellerWebsite: null } },
];

await check("import_stops posts an array that validates against the documented request schema, with HH:MM windows converted and driver IDs prefixed, and reports Spoke's per-stop failures", async () => {
  const plan = created.plans[0].id;
  const n = requests.length;
  const empty = await call(client, "import_stops", { plan_id: plan, stops: [...stopsToImport, { address: {} }] });
  assert.ok(empty.res.isError, "an empty address is refused locally");
  assert.equal(requests.length, n, "an empty address is refused before any call");
  const ok = await call(client, "import_stops", { plan_id: plan, stops: stopsToImport });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`POST /${plan}/stops:import`]);
  const post = requests.at(-1);
  assert.equal(post.contentType, "application/json");
  validateWith(requestSchema("/plans/{planId}/stops:import", "post"), post.body, "POST stops:import body vs request schema");
  assert.deepEqual(post.body[0].timing, { earliestAttemptTime: { hour: 9, minute: 0 }, latestAttemptTime: { hour: 12, minute: 30 }, estimatedAttemptDuration: 240 });
  assert.deepEqual(post.body[0].allowedDrivers, [fx.DRIVER_SAM]);
  assert.deepEqual(post.body[0].recipient, stopsToImport[0].recipient);
  assert.deepEqual(post.body[1], stopsToImport[1]);
  assert.deepEqual([ok.data.imported, ok.data.rejected, ok.data.stop_ids.length, ok.data.failures], [2, 0, 2, []]);
  // A partial failure in the documented shape: Spoke echoes the rejected stop (address and recipient
  // null-filled) with a message; the message here deliberately quotes the recipient's email and phone.
  const echo = (s) => ({
    ...s,
    address: Object.fromEntries(["addressName", "addressLineOne", "addressLineTwo", "city", "state", "zip", "country", "latitude", "longitude"].map((k) => [k, s.address?.[k] ?? null])),
    recipient: s.recipient ? Object.fromEntries(["externalId", "email", "phone", "name"].map((k) => [k, s.recipient[k] ?? null])) : null,
  });
  const partial = { success: [`${plan}/stops/st-armed-1`], failed: [{ error: { message: "Could not geocode address for Pat Recipient (pat@example.org, 07700 900777)" }, stop: echo({ address: stopsToImport[0].address, recipient: stopsToImport[0].recipient, notes: "Side door", packageCount: 2 }) }] };
  validateWith(responseSchema("/plans/{planId}/stops:import", "post"), partial, "armed partial-failure response vs the documented schema");
  arm({ method: "POST", path: `/${plan}/stops:import`, status: 200, body: partial });
  const half = await call(client, "import_stops", { plan_id: plan, stops: stopsToImport });
  assert.ok(!half.res.isError, half.text);
  assert.deepEqual([half.data.imported, half.data.rejected, half.data.stop_ids], [1, 1, [`${plan}/stops/st-armed-1`]]);
  assert.deepEqual(half.data.failures, [{ reason: "Could not geocode address for Pat Recipient ([email redacted], [phone redacted])", address_line_one: "7 Cotham Hill", external_id: "ORD-2001" }]);
  assert.ok(!half.text.includes("pat@example.org") && !half.text.includes("900777") && !half.text.includes("Pat Recipient\","), "the echoed recipient block is not passed on");
  const notWritable = await call(client, "import_stops", { plan_id: fx.PLAN_OLD, stops: stopsToImport.slice(1) });
  assert.ok(notWritable.res.isError);
  assert.match(notWritable.text, /\(409, the resource is not in the right state\)\. Plan is not writable \(code plan_not_writable\)/);
  const notLinked = await call(client, "import_stops", { plan_id: fx.PLAN_TOMORROW, stops: [{ ...stopsToImport[1], allowedDrivers: ["drv-lee-3"] }] });
  assert.match(notLinked.text, /\(412\)\. Driver is not linked to plan \(parameter allowedDrivers\)/);
  const tooMany = await client.callTool({ name: "import_stops", arguments: { plan_id: plan, stops: Array.from({ length: 101 }, () => stopsToImport[1]) } });
  assert.ok(tooMany.isError, "more than 100 stops is refused locally");
  const typo = await client.callTool({ name: "import_stops", arguments: { plan_id: plan, stops: [{ address: { city: "Bath" }, recipientName: "x" }] } });
  assert.ok(typo.isError, "an unknown stop field is refused locally");
});

await check("optimize_plan returns the operation to poll, and distribute_plan the distributed plan; the documented 409s are passed on with their codes", async () => {
  const plan = created.plans[0].id;
  const op = await call(client, "optimize_plan", { plan_id: plan });
  assert.deepEqual([requests.at(-1).method, requests.at(-1).path, requests.at(-1).body], ["POST", `/${plan}:optimize`, undefined]);
  assert.deepEqual([op.data.operation.type, op.data.operation.done, op.data.operation.plan, op.data.operation.result], ["plan_optimization", false, plan, undefined]);
  const again = await call(client, "optimize_plan", { plan_id: plan });
  assert.match(again.text, /\(409.*Plan optimization in progress \(code plan_optimization_in_progress\)/);
  const optimized = await call(client, "optimize_plan", { plan_id: fx.PLAN_TODAY });
  assert.match(optimized.text, /Plan already optimized \(code plan_already_optimized\)/);
  const notOptimized = await call(client, "distribute_plan", { plan_id: fx.PLAN_TOMORROW });
  assert.match(notOptimized.text, /Plan not optimized \(code plan_not_optimized\)/);
  const distributed = await call(client, "distribute_plan", { plan_id: fx.PLAN_READY });
  assert.deepEqual([requests.at(-1).method, requests.at(-1).path], ["POST", `/${fx.PLAN_READY}:distribute`]);
  assert.deepEqual([distributed.data.plan.id, distributed.data.plan.distributed], [fx.PLAN_READY, true]);
  const twice = await call(client, "distribute_plan", { plan_id: fx.PLAN_READY });
  assert.match(twice.text, /Plan already distributed \(code plan_already_distributed\)/);
});

await check("bad IDs are rejected before any API call; unknown IDs give the documented 404 messages", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_plan", { plan_id: "plans/x/stops/y" }],
    ["get_plan", { plan_id: "../plans" }],
    ["list_plan_stops", { plan_id: "has space" }],
    ["get_route", { route_id: "routes/" }],
    ["list_route_stops", { route_id: "a".repeat(51) }],
    ["get_driver", { driver_id: "drivers/x:optimize" }],
    ["get_operation", { operation_id: "" }],
    ["optimize_plan", { plan_id: "plans/pl-today-1?x=1" }],
    ["create_plan", { title: "x", starts: "2026-10-01", depot: "depots/a b" }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  const missing = await call(client, "get_plan", { plan_id: "plans/pl-nope" });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/plans\/pl-nope\. Check the ID\. Plan not found/);
  assert.match((await call(client, "get_route", { route_id: "rt-nope" })).text, /Not found: \/routes\/rt-nope\. Check the ID\. Route not found/);
  assert.match((await call(client, "get_driver", { driver_id: "drv-nope" })).text, /Driver not found/);
  assert.match((await call(client, "get_operation", { operation_id: "op-nope" })).text, /The operation was not found\. \(code operation_not_found\)/);
  assert.match((await call(client, "list_plan_stops", { plan_id: "pl-nope" })).text, /Plan not found/);
});

await check("a persistent 429 without Retry-After gives up after 3 attempts with exponential backoff and the documented limits in the message", async () => {
  arm429({ persistent: true, retryAfter: null });
  const n = requests.length;
  const { res, text } = await call(client, "list_depots");
  assert.ok(res.isError);
  const tries = since(n).filter((r) => r.path === "/depots");
  assert.equal(tries.length, 3, "exactly three attempts");
  const gaps = [tries[1].t - tries[0].t, tries[2].t - tries[1].t];
  assert.ok(gaps[0] >= 1000 && gaps[0] < 1500 && gaps[1] >= 2000 && gaps[1] < 2500, `backoff should be about 1 s then 2 s plus jitter (waited ${gaps.join(", ")} ms)`);
  assert.match(text, /Spoke rate limit reached \(documented limits: 10 read requests per second, 5 write requests per second, 30 stop imports or plan optimizations per minute and 100 per 10 minutes\)/);
  disarm();
});

await check("a Retry-After longer than the cap makes the call give up at once; an HTTP-date and a fractional Retry-After are honoured", async () => {
  arm429({ retryAfter: "600" });
  let n = requests.length;
  const { res, text } = await call(client, "list_depots");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/depots").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(text, /asked to wait 600 seconds before retrying GET \/depots \(HTTP 429\)/);
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 1 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  n = requests.length;
  const dated = await call(client, "list_depots");
  assert.ok(!dated.res.isError);
  let tries = since(n).filter((r) => r.path === "/depots");
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the fallback (waited ${gap} ms)`);
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  n = requests.length;
  const fractional = await call(client, "list_depots");
  assert.ok(!fractional.res.isError);
  tries = since(n).filter((r) => r.path === "/depots");
  gap = tries[1].t - tries[0].t;
  assert.ok(tries.length === 2 && gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a 502 on a GET is retried even with a non-JSON gateway body; a GET failing three times with 503 reports advice without the HTML; a non-JSON 200 is an error", async () => {
  arm({ method: "GET", path: "/routes", status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  const ok = await call(client, "list_routes");
  assert.ok(!ok.res.isError, ok.text);
  assert.equal(since(n).filter((r) => r.path === "/routes").length, 2);
  arm({ method: "GET", path: "/routes", status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const { res, text } = await call(client, "list_routes");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/routes").length, 3);
  assert.match(text, /Spoke returned 503 for GET \/routes 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!text.includes("<html>"), "gateway HTML should not be passed on");
  arm({ method: "GET", path: "/routes", status: 200 }); // an HTML page with status 200
  const html = await call(client, "list_routes");
  assert.ok(html.res.isError);
  assert.match(html.text, /returned 200 for GET \/routes but the body was not JSON \(starts with: "<html>.*Check SPOKE_BASE_URL/);
  disarm();
});

await check("a 429 on a write is retried once; a 502/503/504 on POST /plans, stops:import, :optimize or :distribute is never retried and the error says what to check", async () => {
  const plan = created.plans[1].id;
  arm({ method: "POST", path: "/plans", status: 429, headers: { "Retry-After": "0" }, body: { message: "Too many requests" } });
  let n = requests.length;
  const retried = await call(client, "create_plan", { title: "After 429", starts: "2026-10-02" });
  assert.ok(!retried.res.isError, retried.text);
  assert.equal(since(n).filter((r) => r.method === "POST").length, 2, "one retry after the 429");
  for (const [tool, args, path, status, hint] of [
    ["create_plan", { title: "Gateway", starts: "2026-10-03" }, "/plans", 502, "check with list_plans"],
    ["import_stops", { plan_id: plan, stops: stopsToImport.slice(1) }, `/${plan}/stops:import`, 503, "check with list_plan_stops"],
    ["optimize_plan", { plan_id: plan }, `/${plan}:optimize`, 504, "check with list_operations"],
    ["distribute_plan", { plan_id: fx.PLAN_TODAY }, `/${fx.PLAN_TODAY}:distribute`, 502, "check with get_plan \\(distributed\\) and list_routes"],
  ]) {
    arm({ method: "POST", path, status, headers: { "Retry-After": "0" } });
    n = requests.length;
    const { res, text } = await call(client, tool, args);
    assert.ok(res.isError, `${tool}: a ${status} must surface as an error`);
    assert.equal(since(n).filter((r) => r.method === "POST").length, 1, `${tool}: exactly one POST`);
    assert.match(text, new RegExp(`returned ${status} for POST .*not retried because it may already have been processed: ${hint}`));
  }
  disarm();
});

await check("every request used Basic base64(key:) with an empty password, JSON content type on writes, and a documented method+path", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/[.]/g, "\\.").replace(/\{[^}]+\}/g, "[A-Za-z0-9_-]+") + "$") })));
  assert.ok(requests.length > 60, `expected a full run, got ${requests.length} requests`);
  for (const r of requests) {
    assert.equal(r.auth, `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`, `${r.method} ${r.path} auth`);
    if (r.method !== "GET") assert.equal(r.contentType, r.body === undefined ? undefined : "application/json", `${r.method} ${r.path} content type`);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/(plans|routes|drivers|operations)\/[A-Za-z0-9_-]+/g, "/$1/{id}")}`));
  assert.deepEqual(
    [...used].sort(),
    ["GET /depots", "GET /drivers", "GET /drivers/{id}", "GET /operations", "GET /operations/{id}", "GET /plans", "GET /plans/{id}", "GET /plans/{id}/stops", "GET /routes", "GET /routes/{id}", "GET /routes/{id}/stops", "GET /stops:search", "POST /plans", "POST /plans/{id}/stops:import", "POST /plans/{id}:distribute", "POST /plans/{id}:optimize"],
  );
});
await client.close();

await check("writes are off when SPOKE_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect(API_KEY, value);
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...READS].sort(), `writes exposed with SPOKE_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    await ro.close();
  }
});

await check("a wrong API key gives an actionable error naming the variable", async () => {
  const bad = await connect("spk-wrong-key");
  const { res, text } = await call(bad, "list_plans");
  assert.ok(res.isError);
  assert.match(text, /rejected the API key \(401\)\. Check SPOKE_API_KEY: .*Settings > Integrations > API.*HTTP Basic username with an empty password/);
  await bad.close();
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock.`);
