# Spoke Dispatch MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with a Spoke Dispatch team (delivery route planning and driver dispatch, formerly Circuit for Teams): plans, stops, routes, drivers, depots and plan-optimization operations, and (when enabled) creating plans, importing stops, optimizing and distributing plans. It is built from Spoke's public API documentation and its published OpenAPI 3.1 spec (`https://developer.dispatch.spoke.com/openapi-v1.json`, "Spoke API" v1).

Once it's connected, a dispatcher can ask things like:

- "How is today's Bristol plan going? Which stops have failed, and what is the ETA for the rest?"
- "Where is Sam's route up to, and has it been started?"
- "Find every stop for order A-1005, and the ones in Bath that were not attempted last week."
- "Which drivers are paused, and which depot are they on?"
- With writes enabled: "Create tomorrow's plan for Sam and Priya, import these 40 stops, optimize it, and when the operation is done, distribute it."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `list_plans` | Plans (one per working day) with start date, depot, optimization and distribution state, driver and route IDs and route overrides. Filters by exact title and a start-date range; token-paginated. | `GET /plans` |
| `get_plan` | One plan. | `GET /plans/{planId}` |
| `list_plan_stops` | Every stop of a plan: type (start/stop/end), route, position, delivery state and outcome, ETA, time window, packages, order references, service and payment-on-delivery data. Filters by the recipient's external ID. | `GET /plans/{planId}/stops` |
| `search_stops` | Full-text keyword search plus Spoke's SQL-like filter language across all stops, assigned and unassigned, with the documented sort fields. | `GET /stops:search` |
| `list_routes` | Routes (one driver's run) with stop count, driver, plan and state (distributed, started, completed, recipients notified, with timestamps). | `GET /routes` |
| `get_route` | One route. | `GET /routes/{routeId}` |
| `list_route_stops` | The stops of one route, same shape as `list_plan_stops`. | `GET /routes/{routeId}/stops` |
| `list_drivers` | Drivers with active status, depots and route overrides (working hours, vehicle, max stops). Filters by active status. | `GET /drivers` |
| `get_driver` | One driver. | `GET /drivers/{driverId}` |
| `list_depots` | Depots with their default route settings (start time, start and end address, round trip, time at stop, max stops, vehicle). | `GET /depots` |
| `list_operations` | Plan-optimization operations: done or not, who started them, target plan, result (stops optimized, stops skipped with reasons) or error. Filters by done and type. | `GET /operations` |
| `get_operation` | One operation, to poll after `optimize_plan`. | `GET /operations/{operationId}` |
| `create_plan` | Creates an empty plan for a date with optional drivers, depot and route overrides. Writes only. | `POST /plans` |
| `import_stops` | Batch-imports 1 to 100 stops into a writable plan using the API's own field names; reports the IDs created and the stops Spoke rejected with its reason, each identified by the external ID and first address line sent in that same call. Writes only. | `POST /plans/{planId}/stops:import` |
| `optimize_plan` | Starts optimizing a plan into routes; returns the operation to poll. Writes only. | `POST /plans/{planId}:optimize` |
| `distribute_plan` | Sends an optimized plan's routes to the drivers' apps. Marked destructive: it notifies real drivers and the API has no way to undo it. Writes only. | `POST /plans/{planId}:distribute` |

Not covered on purpose: updating and deleting plans, stops, drivers, depots and members; creating stops one at a time; the live-plan endpoints (`:liveCreate`, `:liveUpdate`, `:liveImport`, `:liveDelete`, `:reoptimize`, `:redistribute`, `:save`); unassigned stops other than through search; custom stop property definitions; cancelling operations; members.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an API key for your Spoke Dispatch team, generated under **Settings > Integrations > API**. The API authenticates with HTTP Basic: the key is the username and the password is empty, and that is what this server sends (the spec also accepts the key as a Bearer token).

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spoke": {
      "command": "node",
      "args": ["/absolute/path/to/spoke-mcp/dist/index.js"],
      "env": { "SPOKE_API_KEY": "your-key" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add spoke -e SPOKE_API_KEY=your-key -- node /absolute/path/to/spoke-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `SPOKE_API_KEY` | yes | Your API key, sent as the HTTP Basic username with an empty password. |
| `SPOKE_ALLOW_WRITES` | no | `true` to register `create_plan`, `import_stops`, `optimize_plan` and `distribute_plan`. Off by default. |
| `SPOKE_BASE_URL` | no | Defaults to `https://api.spoke.com/public/v1`. Used by the tests. |

## Safety defaults

- Read-only unless `SPOKE_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation; `distribute_plan` is marked destructive because it pushes routes to real drivers and cannot be undone through the API.
- Recipients are third parties. By default a stop's recipient block only says which fields exist (`name`, `email`, `phone`, `external_id`), the address is reduced to its locality (the part after the street line, with postal codes cut to their area part or dropped: UK `BS7 8QH` becomes `BS7`, an Irish Eircode `D02 X285` becomes `D02`, a Canadian `K1A 0A2` becomes `K1A`, a Dutch `1012 JS` and any all-digit code such as a US ZIP `20500`, `20500-0003`, or a German, French or Australian code are dropped, so `2 Melbourne Road, Bristol, BS7 8QH, UK` becomes `Bristol, BS7, UK` and `1600 Pennsylvania Ave NW, Washington, DC 20500, USA` becomes `Washington, DC, USA`; coordinates and the Google place ID are left out), and the signee name, the location where the delivery was attempted, the proof-of-delivery photo and signature links and the recipient tracking link are withheld. The same applies to unassigned stops returned by `search_stops`. Everything is returned when the assistant explicitly asks (`include_contact_details`). Photo and signature URLs are passed through as links; nothing is ever downloaded.
- Drivers are employees. Their email, phone number and their own start/end addresses are only returned with `include_contact_details`; names and display names are returned (minus any email or phone typed into them).
- Plan and depot addresses (where routes start and end) are the team's own operating locations and are returned as stored.
- In free text (plan, route and depot titles and names, driver display names, stop notes, driver and recipient notes and custom property values; seller names, products, package labels and Spoke's own error messages take the same code path but are not exercised by the tests) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]` by default. The phone match is a heuristic pattern covering UK national numbers (`07700 900123`, `020 7946 0958`, `(020) 7946 0958`), `+`- and `00`-prefixed international numbers (`+447700900123`, `+1 415 555 0123`, `0044 20 7946 0958`) and North-American 10-digit national numbers (`(415) 555-0123`, `415-555-0123`, `415.555.0123`, `4155550123`), each with spaces, dots or hyphens between the groups; the tests exercise all of these forms. A 7-digit local number without an area code, and formats of other countries written without a leading `0` or `+`, are not matched. Other digit strings that happen to look like one of those shapes (a 9-11 digit string starting with `0`, a 10-digit string starting with `2`-`9`) are redacted too, while Spoke IDs, barcodes, dates, epoch timestamps and order references such as `A-1002` are left alone; the raw text is available with `include_contact_details`.
- The address summary is a heuristic: it takes `addressLineTwo` (or the full address after its first comma) as the locality, so what it contains depends on how Spoke split the address into lines. When Spoke stores the street in `addressLineTwo` (for instance `Flat 3` in line one and `2 Melbourne Road, Bristol, BS7 8QH, UK` in line two) the summary contains the house number and street; the tests show this case. Postal codes in formats other than the ones listed above are only removed when they are all digits.
- IDs are checked before any call is made: the spec's path parameters are `[a-zA-Z0-9---_]{1,50}` (letters, digits, `-` and `_`), and every tool accepts either that bare form or the prefixed form the API uses in bodies and responses (`plans/<id>`). Dates must be `YYYY-MM-DD` and a real calendar date (`2026-02-30` and `2026-13-01` are refused locally); `create_plan` additionally requires the year the request schema documents (2000 to 2100). Times must be `HH:MM`. Both are converted to the spec's `{year, month, day}` and `{hour, minute}` objects.
- `import_stops` validates every stop locally against the documented request shape (unknown fields, an empty address and more than 100 stops are refused before any call) and converts `HH:MM` windows and bare driver IDs to the documented forms. Its failure list has no `include_contact_details` switch: for each stop Spoke rejected it returns Spoke's reason plus the external ID and first address line that the caller sent in that same call (the API echoes the whole stop back rather than its position in the array), with the free-text redaction applied to the reason and the address line; the echoed recipient name, email and phone are not returned.
- Rate limits, as Spoke documents them ("On Rate-Limiting" in the spec): read endpoints 10 requests per second; write endpoints (POST, PATCH, DELETE) 5 per second, driver creation 1 per second; the stop batch imports 100 per 10 minutes with at most 30 per minute; the driver batch import 2 per minute; plan optimization and re-optimization 100 per 10 minutes with at most 30 per minute; bursts are tolerated briefly, sustained high rates are rejected, and a client that keeps retrying rejected requests keeps being rejected. Spoke recommends exponential backoff with a random delay and documents no `Retry-After` header. This server spaces reads 120 ms apart, writes 250 ms apart and imports and optimizations 2.1 s apart. A 429 is retried at most twice for any method (a rejected request was not processed), waiting for `Retry-After` when one is sent (whole or fractional seconds, or an HTTP-date) and otherwise 1 s then 2 s plus up to 300 ms of jitter. Each wait is capped at 10 seconds, so one request waits at most 20 seconds in all; a tool call that makes several requests (pages, lookups) can still run past the MCP client's default 60-second request timeout. Past the cap: if Spoke asks for a longer wait the call gives up at once and the message says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` only; when all three attempts fail the error says the service may be unavailable and to try again in a few minutes, without the gateway's HTML. The four write tools are never retried after a gateway error, because the request may already have been processed and a retry could create a plan, import stops, or notify drivers twice; the error names the read tool to check with first (`list_plans`, `list_plan_stops`, `list_operations`, `get_plan`).
- Spoke documents no idempotency keys, so none are sent.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `SPOKE_BASE_URL`, never as an empty list.
- A rejected API key produces a message that says which variable to fix and where keys come from. The documented 403 for a plan or route older than the subscription's delivery-history period (`plan_inaccessible`, `route_inaccessible`) is explained; 404s carry Spoke's message (`Plan not found`, `Route not found`, `Driver not found`, `The operation was not found.`); 409s pass on Spoke's message and code (`plan_not_writable`, `plan_already_optimized`, `plan_optimization_in_progress`, `plan_not_optimized`, `plan_already_distributed` are exercised; `no_drivers_available` takes the same path); 400 and 412 pass on the message, code and offending parameter, and 410 and 422 take the same path without being exercised.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record with Ajv (JSON Schema 2020-12, as the spec is OpenAPI 3.1) against the component schemas in Spoke's published spec (`planSchema`, `stopSchema`, `unassignedStopSchema`, `routeSchema`, `driverSchema`, `depotSchema`, `operationSchema`), all of which set `additionalProperties: false` and mark nearly every field required, with negative controls. The spec is downloaded from `developer.dispatch.spoke.com/openapi-v1.json` to `spec.json` on the first run.
2. Starts a local mock of the API under `/public/v1` that serves those fixtures with the documented `pageToken`/`nextPageToken`/`maxPageSize` pagination (including each endpoint's maximum page size and the search's `exclusiveMaximum` of 20), the documented `filter.*` parameters, Basic-auth 401s, the documented 403, 404 and 409 bodies, a subset of the stop-search filter language, and answers the first `GET /depots` with a 429. The mock's list, detail, search, create, import, optimize and distribute responses and its error responses are validated against the spec's response schemas. (One quirk: the search's documented 400 is a `oneOf` whose generic first branch also matches every specific branch, so nothing can satisfy it; the mock's answer is checked against the "Invalid filter string" branch.)
3. Starts the built server and drives it over stdio with the official MCP client: 25 checks covering every tool, tool annotations, token pagination across pages to the null token with whole pages and a continuation that repeats the original filters, every documented filter passed through exactly (`filter.title`, `filter.startsGte`, `filter.startsLte`, `filter.externalId`, `filter.active`, `filter.done`, `filter.type`, and the search's `keyword`, `filter`, `sortField`, `sortOrder`), a page size of 19 on the search and of 2 (its documented minimum) when one result is asked for, recipient, address, proof-of-delivery, tracking-link and free-text redaction by default and their return on request, the address summary on UK, Irish, US, Canadian, Dutch, German and Australian postal codes and on a street stored in `addressLineTwo`, the phone pattern on UK, international and North-American forms with negative controls, the `POST /plans` and `POST .../stops:import` bodies validated against the spec's request schemas, local refusal of dates that are not real calendar dates or outside the documented 2000-2100 plan years, local refusal of an empty address, an unknown stop field and more than 100 stops, a partially failed import reported with the redacted reason, external ID and address line, the documented 409s, ID validation before any call and the documented 404 and 403 messages, the 429 retry waiting for a `Retry-After` of 2 s (a wait the no-header fallback cannot produce) and in the fractional and HTTP-date forms, exponential backoff without the header, giving up after three attempts and at once above the cap, a 429 on a write retried once, a 502 retried for `GET` only and never for any of the four writes, a `GET` failing three times reported without the gateway HTML, a non-JSON 200 reported as an error, the write gate with the variable unset and set to `false`, and that every request used `Basic base64(key:)`, `Content-Type: application/json` on writes, and a documented method and path.

The suite makes 77 requests against the mock and takes about 40 seconds, most of it deliberate waits in the retry checks.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without a Spoke Dispatch account. Everything below is taken from the published spec and should be confirmed on a real account:

- Whether API keys are available during the free trial, and whether a Basic header with an empty password (`base64("<key>:")`) is accepted exactly as the spec describes; the Bearer form is the documented fallback.
- The real `nextPageToken` values and whether a continuation must repeat `maxPageSize` unchanged (the server repeats every query parameter, as the spec says to). What the API answers for a stale or foreign page token (the spec documents a 400 with `param: pageToken` for the search only).
- `GET /stops:search`: the spec documents `maxPageSize` with `exclusiveMaximum: 20` and a default of 20, which contradict each other; the server sends 19. Whether `keyword` and `filter` may be combined, the exact filter grammar the live API accepts (the mock implements a subset), how fresh the search index is, and whether `sortField` must be one of the ten documented fields.
- The filter parameter spelling: the spec documents both `?filter[title]=` and `?filter.title=`; the server sends the dot form.
- How addresses are split into `address`, `addressLineOne` and `addressLineTwo` on real stops, which decides what the default locality summary contains. Real coordinates are also left out by default.
- Whether `stopSchema.route` is really the full embedded route object on list responses (as the schema says) and whether `deliveryInfo` is `null` or an `unattempted` record before an attempt.
- `POST /plans`: the accepted date range for `starts` ("does not accept dates that are too far in the future or past"; the server only enforces the schema's 2000-2100), whether `routeOverrides.optimizationSettings.objective` accepts anything other than the single documented value `distribute_services`, and whether drivers must already belong to the plan's depot (the migration guide says so).
- `POST /plans/{planId}/stops:import`: the wording of the per-stop failure messages (the mock's "Address could not be geocoded" is a placeholder), whether the API geocodes from text fields alone, whether `customProperties` keys are property IDs as documented, and what a partially failed import returns beyond `success` and `failed`.
- `POST .../:optimize` and `:distribute`: whether the 409 bodies match the spec's enums exactly, how long optimization takes, and whether distribution notifies drivers immediately.
- The 401 body (the spec gives it only a description; the mock answers `{"message": "Unauthorized"}`) and whether any error message ever echoes request data such as a recipient's email. The server applies the free-text redaction to every error message; the tests exercise it on a per-stop import failure message, not on the message of an HTTP error response.
- How addresses outside the UK, Ireland, Canada and the Netherlands are formatted on real stops; a postal code in another format that is not all digits stays in the default summary.
- Whether Spoke sends `Retry-After` on 429 (nothing is documented), and whether a rate-limited write is indeed never processed; the server assumes so and retries a 429 on a write once.
- How many requests per second the API really tolerates from one key; the spacing here follows the documented limits with a margin.

## Going to production

This version runs locally over stdio, with the dispatcher's own API key. For teams to connect from claude.ai or ChatGPT without handling keys, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Spoke, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
