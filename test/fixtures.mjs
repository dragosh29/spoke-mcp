// Fake Spoke Dispatch data shaped exactly like the component schemas in the published OpenAPI spec
// (validated in e2e.mjs). Every ID is an obviously made-up, low-entropy value; nothing here comes from
// the vendor's documentation examples.

// The spec's timestamps are seconds since epoch. A fixed "today" keeps the fixtures deterministic.
export const TODAY = "2026-09-28";
const T0 = Date.UTC(2026, 8, 28, 8, 0, 0) / 1000; // 2026-09-28T08:00:00Z
const date = (y, m, d) => ({ year: y, month: m, day: d });
const time = (hour, minute) => ({ hour, minute });

// ---- Depots (depotSchema) ----
export const DEPOT_BRISTOL = "depots/dep-bristol-1";
export const DEPOT_BATH = "depots/dep-bath-2";
const depotAddress = (address, line1, line2, lat, lng) => ({ address, addressLineOne: line1, addressLineTwo: line2, latitude: lat, longitude: lng, placeId: "place-not-real-depot", countryCode: "GB" });
export const depots = [
  {
    id: DEPOT_BRISTOL,
    name: "Bristol hub",
    routeOverrides: {
      startTime: time(7, 30),
      startAddress: depotAddress("Unit 4, Avonmouth Way, Bristol, BS11 9YA, UK", "Unit 4, Avonmouth Way", "Bristol, BS11 9YA, UK", 51.5011, -2.6968),
      defaultTimeAtStop: 180,
      endAddress: null,
      endTime: time(18, 0),
      maxStops: 60,
      roadSide: "any",
      vehicleType: "small_truck",
      roundTrip: true,
    },
  },
  // A depot whose name has a phone number typed into it, to prove names are redacted by default.
  { id: DEPOT_BATH, name: "Bath (call 07700 900111)", routeOverrides: null },
];

// ---- Drivers (driverSchema) ----
export const DRIVER_SAM = "drivers/drv-sam-1";
export const DRIVER_PRIYA = "drivers/drv-priya-2";
export const DRIVER_LEE = "drivers/drv-lee-3";
export const DRIVER_JO = "drivers/drv-jo-4";
const homeAddress = (address, line1, line2, lat, lng) => ({ address, addressLineOne: line1, addressLineTwo: line2, latitude: lat, longitude: lng, placeId: "place-not-real-home", placeTypes: ["street_address"] });
const overrides = (start, end, extra = {}) => ({
  startTime: time(8, 0),
  endTime: time(17, 0),
  startAddress: start,
  endAddress: end,
  maxStops: null,
  drivingSpeed: "average",
  deliverySpeed: "average",
  vehicleType: "car",
  ...extra,
});
export const drivers = [
  {
    id: DRIVER_SAM,
    name: "Sam Evans",
    email: "sam.evans@example.com",
    phone: "+447700900123",
    displayName: "Sam",
    active: true,
    depots: [DEPOT_BRISTOL],
    routeOverrides: overrides(homeAddress("5 Plymouth Road, Penarth, CF64 3DH, UK", "5 Plymouth Road", "Penarth, CF64 3DH, UK", 51.4321, -3.1765), null, { vehicleType: "small_truck", maxStops: 40 }),
  },
  { id: DRIVER_PRIYA, name: "Priya Shah", email: "priya.shah@example.com", phone: "07700 900456", displayName: "Priya", active: true, depots: [DEPOT_BRISTOL], routeOverrides: overrides(null, null) },
  // A paused driver, and one whose display name has an email typed into it.
  { id: DRIVER_LEE, name: "Lee Chen", email: "lee.chen@example.net", phone: null, displayName: "Lee (lee.chen@example.net)", active: false, depots: [DEPOT_BATH], routeOverrides: overrides(null, null, { vehicleType: "bike" }) },
  { id: DRIVER_JO, name: null, email: null, phone: null, displayName: "Jo", active: true, depots: [DEPOT_BATH], routeOverrides: overrides(null, null) },
];

// ---- Plans (planSchema) ----
export const PLAN_TODAY = "plans/pl-today-1";
export const PLAN_TOMORROW = "plans/pl-tomorrow-2";
export const PLAN_READY = "plans/pl-ready-3";
export const PLAN_OLD = "plans/pl-old-4";
export const PLAN_RESTRICTED = "plans/pl-restricted-5"; // answers 403 plan_inaccessible in the mock
export const ROUTE_1 = "routes/rt-sam-1";
export const ROUTE_2 = "routes/rt-priya-2";
export const ROUTE_OLD = "routes/rt-old-3";

const planRouteOverrides = {
  startTime: time(8, 30),
  endTime: time(16, 30),
  startAddress: homeAddress("Unit 4, Avonmouth Way, Bristol, BS11 9YA, UK", "Unit 4, Avonmouth Way", "Bristol, BS11 9YA, UK", 51.5011, -2.6968),
  endAddress: null,
  maxStops: 30,
  drivingSpeed: "average",
  deliverySpeed: "faster",
  vehicleType: "car",
  optimizationSettings: { objective: "distribute_services", subObjective: "equalize_workload" },
};
const mkPlan = (id, title, starts, extra = {}) => ({
  id,
  title,
  starts,
  depot: DEPOT_BRISTOL,
  distributed: false,
  writable: true,
  optimization: "creating",
  drivers: [],
  routes: [],
  routeOverrides: null,
  ...extra,
});
const named = [
  mkPlan(PLAN_TODAY, "Bristol north Monday", date(2026, 9, 28), { distributed: true, optimization: "optimized", drivers: [DRIVER_SAM, DRIVER_PRIYA], routes: [ROUTE_1, ROUTE_2] }),
  // A title with a phone number typed into it, to prove titles are redacted by default.
  mkPlan(PLAN_TOMORROW, "Bath Tuesday (queries to 07700 900123)", date(2026, 9, 29), { depot: DEPOT_BATH, drivers: [DRIVER_JO], routeOverrides: planRouteOverrides }),
  mkPlan(PLAN_READY, "Bristol south Tuesday", date(2026, 9, 29), { optimization: "optimized", drivers: [DRIVER_SAM], routes: [] }),
  mkPlan(PLAN_OLD, "January clear-out", date(2026, 1, 5), { distributed: true, writable: false, optimization: "optimized", drivers: [DRIVER_SAM], routes: [ROUTE_OLD] }),
];
// 22 more plans in August 2026 so the list spans two pages of 20 (26 plans in all).
const bulk = Array.from({ length: 22 }, (_, i) => mkPlan(`plans/pl-bulk-${i + 1}`, `Bulk plan ${i + 1}`, date(2026, 8, 1 + i), { distributed: true, optimization: "optimized", drivers: [DRIVER_PRIYA] }));
export const plans = [...named, ...bulk];
export const restrictedPlan = mkPlan(PLAN_RESTRICTED, "Old restricted plan", date(2025, 1, 5), { distributed: true, writable: false, optimization: "optimized" });

// ---- Routes (routeSchema) ----
const state = (over = {}) => ({ completed: false, completedAt: null, distributed: true, distributedAt: T0 - 3600, notifiedRecipients: true, notifiedRecipientsAt: T0 - 3500, started: false, startedAt: null, ...over });
export const routes = [
  { id: ROUTE_1, title: "Sam - Bristol north", stopCount: 15, driver: DRIVER_SAM, state: state({ started: true, startedAt: T0 }), plan: PLAN_TODAY },
  { id: ROUTE_2, title: "Priya - Bristol north (ring 07700 900456)", stopCount: 10, driver: DRIVER_PRIYA, state: state(), plan: PLAN_TODAY },
  { id: ROUTE_OLD, title: "Sam - January", stopCount: 2, driver: DRIVER_SAM, state: state({ started: true, startedAt: T0 - 86400 * 200, completed: true, completedAt: T0 - 86400 * 200 + 20000 }), plan: PLAN_OLD },
];
export const routeById = Object.fromEntries(routes.map((r) => [r.id, r]));

// ---- Stops (stopSchema) ----
const stopAddress = (n, street, town, postcode) => ({
  address: `${n} ${street}, ${town}, ${postcode}, UK`,
  addressLineOne: `${n} ${street}`,
  addressLineTwo: `${town}, ${postcode}, UK`,
  latitude: Math.round((51.47 + n / 1000) * 1000) / 1000,
  longitude: Math.round((-2.59 - n / 1000) * 1000) / 1000,
  placeId: `place-not-real-${n}`,
  placeTypes: ["street_address"],
});
const eta = (at) => ({ status: "available", value: { estimatedArrivalAt: at, estimatedLatestArrivalAt: at + 900, estimatedEarliestArrivalAt: at - 900 } });
const unattempted = () => ({
  attempted: false,
  attemptedAt: null,
  timeAtStopInfo: { status: "pending", pendingReason: "not_yet_arrived" },
  attemptedLocation: null,
  driverProvidedInternalNotes: null,
  driverProvidedRecipientNotes: null,
  photoUrls: [],
  recipientProvidedNotes: null,
  signatureUrl: null,
  signeeName: null,
  succeeded: false,
  state: "unattempted",
});
export const PHOTO_URL = "https://photos.example.invalid/pod/stop-3-not-real.jpg";
export const SIGNATURE_URL = "https://photos.example.invalid/pod/stop-3-signature-not-real.png";
const delivered = (at, signee) => ({
  ...unattempted(),
  attempted: true,
  attemptedAt: at,
  timeAtStopInfo: { status: "available", value: { arrivedAt: at - 120, departedAt: at + 60, isEstimated: false } },
  attemptedLocation: { latitude: 51.473, longitude: -2.593 },
  driverProvidedInternalNotes: "Gate code 4321, neighbour is on 07700 900789",
  driverProvidedRecipientNotes: "Left with neighbour at number 14",
  photoUrls: [PHOTO_URL],
  recipientProvidedNotes: "Ring the bell twice, or email me at sam.evans@example.com",
  signatureUrl: SIGNATURE_URL,
  signeeName: signee,
  succeeded: true,
  state: "delivered_to_third_party",
});
const failed = (at) => ({ ...unattempted(), attempted: true, attemptedAt: at, timeAtStopInfo: { status: "available", value: { arrivedAt: at, departedAt: at + 30, isEstimated: true } }, attemptedLocation: { latitude: 51.474, longitude: -2.594 }, state: "failed_not_home" });

const mkStop = (planId, n, routeId, type, extra = {}) => ({
  id: `${planId}/stops/st-${n}`,
  address: stopAddress(n, "Melbourne Road", "Bristol", "BS7 8QH"),
  barcodes: [`PKG-${String(n).padStart(4, "0")}`],
  allowedDrivers: [],
  estimatedTravelDuration: type === "start" ? null : 420,
  estimatedTravelDistance: type === "start" ? null : 2100,
  notes: null,
  packageCount: 1,
  weight: null,
  type,
  packageLabel: `A${n}`,
  stopPosition: n,
  trackingLink: `https://track.example.invalid/t/stop-${n}-not-real`,
  webAppLink: `https://dispatch.example.invalid/plans/${planId.split("/")[1]}/stops/st-${n}`,
  orderInfo: { products: ["Box"], invoiceNumber: `INV-${1000 + n}`, sellerName: "Acme Bakery", sellerOrderId: `A-${1000 + n}`, sellerWebsite: "https://acme.example.invalid" },
  placeInVehicle: null,
  recipient: { name: `Recipient ${n}`, email: `recipient${n}@example.org`, phone: `+4477009${String(n).padStart(5, "0")}`, externalId: `ORD-${1000 + n}` },
  activity: "delivery",
  deliveryInfo: unattempted(),
  paymentOnDelivery: null,
  proofOfAttemptRequirements: { enabled: false },
  plan: planId,
  route: routeId ? routeById[routeId] : null,
  eta: eta(T0 + n * 600),
  timing: { estimatedAttemptDuration: 180, earliestAttemptTime: null, latestAttemptTime: null },
  optimizationOrder: "default",
  customProperties: null,
  clientId: null,
  serviceInfo: { status: "empty" },
  ...extra,
});

// PLAN_TODAY: 25 stops across two routes (three pages of 10 through GET /plans/{id}/stops), with a
// delivered stop, a failed one, a pickup with a payment on delivery and a time window, and one whose
// notes and custom properties contain contact details.
export const todayStops = [
  mkStop(PLAN_TODAY, 1, ROUTE_1, "start", { recipient: { name: null, email: null, phone: null, externalId: null }, orderInfo: { products: [], invoiceNumber: null, sellerName: null, sellerOrderId: null, sellerWebsite: null }, barcodes: [], packageLabel: null, trackingLink: null, packageCount: null }),
  mkStop(PLAN_TODAY, 2, ROUTE_1, "stop", { notes: "Leave in porch. Contact: 07700 900222 or jane@example.org", customProperties: { "cp-notreal-1": "Neighbour 07700 900333", "cp-notreal-2": "fragile" } }),
  mkStop(PLAN_TODAY, 3, ROUTE_1, "stop", { deliveryInfo: delivered(T0 + 1800, "S. Evans") }),
  mkStop(PLAN_TODAY, 4, ROUTE_1, "stop", { deliveryInfo: failed(T0 + 2400) }),
  mkStop(PLAN_TODAY, 5, ROUTE_1, "stop", {
    activity: "pickup",
    address: stopAddress(5, "Gloucester Road", "Bristol", "BS7 8AA"),
    paymentOnDelivery: { amount: 1250, currency: "GBP" },
    weight: { amount: 2.5, unit: "kilogram" },
    timing: { estimatedAttemptDuration: 300, earliestAttemptTime: time(9, 0), latestAttemptTime: time(12, 0) },
    allowedDrivers: [DRIVER_SAM],
    eta: { status: "pending", pendingReason: "not_optimized" },
    serviceInfo: { status: "available", value: { identifier: "svc-next-day", name: "Next day", slaStartsAt: T0 - 86400, slaDueDate: date(2026, 9, 28), slaDueTime: time(17, 0), deliveryHorizon: { unit: "days", value: 1 }, price: { value: 599, currency: "GBP" }, hasPaymentOnDelivery: true, definedAt: T0 - 86400 } },
  }),
  ...Array.from({ length: 9 }, (_, i) => mkStop(PLAN_TODAY, 6 + i, ROUTE_1, "stop")),
  mkStop(PLAN_TODAY, 15, ROUTE_1, "end", { recipient: { name: null, email: null, phone: null, externalId: null }, trackingLink: null }),
  ...Array.from({ length: 10 }, (_, i) => mkStop(PLAN_TODAY, 16 + i, ROUTE_2, "stop", { address: stopAddress(16 + i, "Filton Avenue", "Bristol", "BS34 7AB") })),
];
// PLAN_TOMORROW: not yet optimized (no routes, ETAs pending). Stops 2-4 exist for the address summary:
// an Irish Eircode and a US ZIP (non-UK postal codes), and an address whose street Spoke put in
// addressLineTwo ("Flat 3" in line one), the documented weak spot of the summary. Stop 3's notes carry
// North-American-format phone numbers. Their external IDs avoid the ORD-10xx values of the other plans.
const splitAddress = (line1, line2, lat, lng, n) => ({ address: `${line1}, ${line2}`, addressLineOne: line1, addressLineTwo: line2, latitude: lat, longitude: lng, placeId: `place-not-real-tm-${n}`, placeTypes: ["street_address"] });
const tomorrowStop = (n, extra) => mkStop(PLAN_TOMORROW, n, null, "stop", { eta: { status: "pending", pendingReason: "not_optimized" }, route: null, recipient: { name: `Recipient ${n}`, email: `tomorrow${n}@example.org`, phone: `+4477009${String(300 + n).padStart(5, "0")}`, externalId: `ORD-${3000 + n}` }, ...extra });
export const tomorrowStops = [
  tomorrowStop(1, { address: stopAddress(1, "Great Pulteney Street", "Bath", "BA2 4BS") }),
  tomorrowStop(2, { address: splitAddress("12 Fitzwilliam Square", "Dublin, D02 X285, Ireland", 53.336, -6.253, 2) }),
  tomorrowStop(3, { address: splitAddress("1600 Pennsylvania Ave NW", "Washington, DC 20500, USA", 38.897, -77.036, 3), notes: "US contact (415) 555-0123 or 415-555-0199" }),
  tomorrowStop(4, { address: splitAddress("Flat 3", "2 Melbourne Road, Bristol, BS7 8QH, UK", 51.472, -2.592, 4) }),
];
export const oldStops = [mkStop(PLAN_OLD, 1, ROUTE_OLD, "start"), mkStop(PLAN_OLD, 2, ROUTE_OLD, "stop", { deliveryInfo: delivered(T0 - 86400 * 200 + 3600, "R. Old") })];
export const stopsByPlan = { [PLAN_TODAY]: todayStops, [PLAN_TOMORROW]: tomorrowStops, [PLAN_READY]: [], [PLAN_OLD]: oldStops };
export const allStops = Object.values(stopsByPlan).flat();

// ---- Unassigned stops (unassignedStopSchema), only reachable here through GET /stops:search ----
export const UNASSIGNED_1 = "unassignedStops/us-1";
export const unassignedStops = [
  {
    id: UNASSIGNED_1,
    depot: DEPOT_BRISTOL,
    address: stopAddress(99, "Whiteladies Road", "Bristol", "BS8 2QX"),
    barcodes: ["PKG-0099"],
    allowedDrivers: [],
    notes: "Awaiting a plan",
    packageCount: 2,
    weight: null,
    orderInfo: { products: ["Crate"], invoiceNumber: "INV-1099", sellerName: "Acme Bakery", sellerOrderId: "A-1099", sellerWebsite: null },
    recipient: { name: "Recipient 99", email: "recipient99@example.org", phone: "+447700900999", externalId: "ORD-1099" },
    activity: "delivery",
    trackingLink: null,
    timing: { estimatedAttemptDuration: null, earliestAttemptTime: null, latestAttemptTime: null },
    optimizationOrder: "default",
    paymentOnDelivery: null,
    proofOfAttemptRequirements: { enabled: null },
    customProperties: null,
    clientId: null,
  },
];

// ---- Operations (operationSchema) ----
export const OP_DONE = "operations/op-done-1";
export const OP_RUNNING = "operations/op-running-2";
export const OP_FAILED = "operations/op-failed-3";
const op = (id, done, plan, startedAt, finishedAt, result, startedBy = "api") => ({ id, type: "plan_optimization", done, metadata: { canceled: false, startedAt, finishedAt, startedBy, targetPlanId: plan }, result });
export const operations = [
  op(OP_DONE, true, PLAN_TODAY, T0 - 7200, T0 - 7100, { numOptimizedStops: 23, skippedStops: [{ id: `${PLAN_TODAY}/stops/st-5`, reason: "impossible_time_window" }] }, "dispatcher"),
  op(OP_RUNNING, false, PLAN_READY, T0 - 60, null, null),
  op(OP_FAILED, true, PLAN_OLD, T0 - 86400 * 200, T0 - 86400 * 200 + 30, { code: "no_drivers_available", message: "Plan has no drivers" }),
];
