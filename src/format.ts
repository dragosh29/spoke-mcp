// Turn Spoke API records into compact objects an assistant can read quickly.
// Field names follow the component schemas in Spoke's OpenAPI spec (planSchema, stopSchema,
// unassignedStopSchema, routeSchema, driverSchema, depotSchema, operationSchema).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123);
//   North American national (NANP, 10 digits, area code and exchange starting 2-9, the area code
//     optionally bracketed): (415) 555-0123, 415-555-0123, 415.555.0123, 415 555 0123, 4155550123.
// Bounded by characters other than letters, digits, "_" and "-", so Spoke IDs (plans/plan-1), epoch
// timestamps and hyphenated references such as ORD-0001-000123 are left alone. Any other 9-11 digit
// string starting with 0, or 10-digit string starting with 2-9 (an order number, say), is redacted
// too; the raw text is available with include_contact_details. A 7-digit local number without an area
// code is not matched.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10}|\(?[2-9]\d{2}\)?[ .-]?[2-9]\d{2}[ .-]?\d{4})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (titles, notes, custom
 * property values, names, error messages) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

// customProperties is a flat map of string values in the spec, but the walk is generic and bounded
// so a deeper value from the live API is never returned unredacted.
const MAX_DEPTH = 20;

/** Apply redactContacts to every string key and value inside an arbitrary JSON value. */
export function redactDeep(value: unknown, includeContact: boolean, depth = 0): unknown {
  if (includeContact) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[value nested deeper than ${MAX_DEPTH} levels omitted; available with include_contact_details]`;
    return value.map((v) => redactDeep(v, includeContact, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return `[value nested deeper than ${MAX_DEPTH} levels omitted; available with include_contact_details]`;
    const out: Rec = {};
    for (const [k, v] of Object.entries(value as Rec)) out[redactString(k)] = redactDeep(v, includeContact, depth + 1);
    return out;
  }
  return value;
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
/** Seconds since epoch (the spec's timestamp unit) as ISO 8601. */
const iso = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : new Date(n * 1000).toISOString();
};
/** dateSchema {day, month, year} as YYYY-MM-DD. */
const ymd = (d: Rec | null | undefined) =>
  d && typeof d === "object" && num(d.year) !== undefined ? `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined;
/** timeOfDaySchema {hour, minute} as HH:MM. */
const hm = (t: Rec | null | undefined) => (t && typeof t === "object" && num(t.hour) !== undefined ? `${String(t.hour).padStart(2, "0")}:${String(t.minute ?? 0).padStart(2, "0")}` : undefined);

/** The bare part of a prefixed Spoke ID: "plans/abc" -> "abc", "plans/abc/stops/xyz" -> "xyz". */
export function bareId(id: unknown): string | undefined {
  const s = str(id);
  return s ? s.split("/").filter(Boolean).pop() : undefined;
}

// Postal codes that name a single building or a handful of them are cut down to their area part, and
// codes that are all digits are dropped, so the summary keeps only the locality:
//   UK: outward code kept (BS7 8QH -> BS7, SW1A 1AA -> SW1A);
//   Ireland (Eircode): routing key kept (D02 X285 -> D02);
//   Canada: forward sortation area kept (K1A 0B1 -> K1A);
//   Netherlands: "1012 AB" dropped;
//   any token of 4 or more digits, with an optional -dddd extension, dropped (US ZIP 20500 and
//     20500-0003, German 10115, French 75008, Australian 2000).
// The digit-only rule is the general one; the named formats come first so their letters are not left
// behind as a stray "X285" or "AB". House numbers (1-3 digits) survive, see addressArea.
const UK_POSTCODE = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*\d[A-Za-z]{2}\b/g;
const EIRCODE = /\b([A-Za-z]\d{2})\s*[A-Za-z\d]{4}\b/g;
const CA_POSTCODE = /\b([A-Za-z]\d[A-Za-z])\s*\d[A-Za-z]\d\b/g;
const NL_POSTCODE = /\b\d{4}\s?[A-Za-z]{2}\b/g;
const DIGIT_CODE = /(?<![\w-])\d{4,}(?:-\d{4})?(?![\w-])/g;

/**
 * A stop's address summarised to the locality: the part after the street line (addressLineTwo, or the
 * full address after its first comma) with postal codes cut to their area part or dropped (see above)
 * and any email or phone number redacted. A heuristic: what the summary contains depends on how Spoke
 * split the address into lines; when the street is in addressLineTwo (say "Flat 3" in line one), the
 * street and its house number are in the summary. Coordinates and the place ID are left out entirely.
 */
export function addressArea(a: Rec | null | undefined): string | undefined {
  if (!a || typeof a !== "object") return undefined;
  const full = str(a.address);
  const line2 = str(a.addressLineTwo);
  const src = line2 ?? (full && full.includes(",") ? full.slice(full.indexOf(",") + 1) : undefined);
  if (!src) return undefined;
  const area = src.replace(UK_POSTCODE, "$1").replace(EIRCODE, "$1").replace(CA_POSTCODE, "$1").replace(NL_POSTCODE, "").replace(DIGIT_CODE, "");
  // Tidy what the removals leave behind: doubled spaces, a comma with nothing before it, trailing commas.
  return (
    redactString(area)
      .split(",")
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(", ") || undefined
  );
}

// stopSchema.address (also the plan/driver routeOverrides start/end addresses).
export function fullAddress(a: Rec | null | undefined, includeContact: boolean) {
  if (!a || typeof a !== "object") return undefined;
  return {
    address: redactContacts(a.address, includeContact),
    line_one: redactContacts(a.addressLineOne, includeContact),
    line_two: redactContacts(a.addressLineTwo, includeContact),
    latitude: num(a.latitude),
    longitude: num(a.longitude),
    place_id: str(a.placeId),
    ...(str(a.countryCode) ? { country_code: str(a.countryCode) } : {}),
  };
}

/** A recipient's or driver's address: the locality only unless contact details were requested. */
function personalAddress(a: Rec | null | undefined, includeContact: boolean) {
  if (!a || typeof a !== "object") return undefined;
  return includeContact ? fullAddress(a, true) : { area: addressArea(a), note: "street, coordinates and place ID available with include_contact_details" };
}

export function plan(p: Rec, includeContact: boolean) {
  const ro = p.routeOverrides && typeof p.routeOverrides === "object" ? p.routeOverrides : undefined;
  return {
    id: str(p.id),
    title: redactContacts(p.title, includeContact),
    starts: ymd(p.starts),
    depot: str(p.depot),
    distributed: bool(p.distributed),
    writable: bool(p.writable),
    optimization: str(p.optimization),
    drivers: Array.isArray(p.drivers) ? p.drivers.map(str) : [],
    routes: Array.isArray(p.routes) ? p.routes.map(str) : [],
    // Plan-level route settings. The start and end addresses here are where every route of the plan
    // begins and ends (a depot or a yard), not a person's address, so they are returned as stored.
    route_overrides: ro
      ? {
          start_time: hm(ro.startTime),
          end_time: hm(ro.endTime),
          start_address: fullAddress(ro.startAddress, includeContact),
          end_address: fullAddress(ro.endAddress, includeContact),
          max_stops: num(ro.maxStops),
          driving_speed: str(ro.drivingSpeed),
          delivery_speed: str(ro.deliverySpeed),
          vehicle_type: str(ro.vehicleType),
          optimization: ro.optimizationSettings && typeof ro.optimizationSettings === "object" ? { objective: str(ro.optimizationSettings.objective), sub_objective: str(ro.optimizationSettings.subObjective) } : undefined,
        }
      : undefined,
  };
}

export function routeSummary(r: Rec, includeContact: boolean) {
  const s = r.state && typeof r.state === "object" ? r.state : undefined;
  return {
    id: str(r.id),
    title: redactContacts(r.title, includeContact),
    stop_count: num(r.stopCount),
    driver: str(r.driver),
    plan: str(r.plan),
    state: s
      ? {
          distributed: bool(s.distributed),
          distributed_at: iso(s.distributedAt),
          started: bool(s.started),
          started_at: iso(s.startedAt),
          completed: bool(s.completed),
          completed_at: iso(s.completedAt),
          recipients_notified: bool(s.notifiedRecipients),
          recipients_notified_at: iso(s.notifiedRecipientsAt),
        }
      : undefined,
  };
}

// stopSchema.eta / deliveryInfo.timeAtStopInfo / serviceInfo share a {status, value?} shape with
// "restricted" (feature not in the team's subscription) and "pending" variants.
function statusValue(x: Rec | null | undefined) {
  if (!x || typeof x !== "object") return undefined;
  const status = str(x.status);
  if (status === "restricted") return { status, restriction: str(x.restrictionCode), required_feature: str(x.requiredFeature) };
  if (status === "pending") return { status, reason: str(x.pendingReason) };
  return { status };
}

function timing(t: Rec | null | undefined) {
  if (!t || typeof t !== "object") return undefined;
  return { earliest: hm(t.earliestAttemptTime), latest: hm(t.latestAttemptTime), estimated_attempt_duration_s: num(t.estimatedAttemptDuration) };
}

/**
 * Recipient block of a stop. Name, email, phone and the external ID all identify the customer, so by
 * default only their presence is reported.
 */
function recipient(r: Rec | null | undefined, includeContact: boolean) {
  if (!r || typeof r !== "object") return undefined;
  if (includeContact) return { name: str(r.name), email: str(r.email), phone: str(r.phone), external_id: str(r.externalId) };
  const present = ["name", "email", "phone", "externalId"].filter((k) => str(r[k]) !== undefined);
  return present.length ? { withheld: present.map((k) => (k === "externalId" ? "external_id" : k)), note: "available with include_contact_details" } : undefined;
}

function orderInfo(o: Rec | null | undefined, includeContact: boolean) {
  if (!o || typeof o !== "object") return undefined;
  const out = {
    products: Array.isArray(o.products) ? o.products.map((p: unknown) => redactContacts(p, includeContact)) : undefined,
    invoice_number: str(o.invoiceNumber),
    seller_name: redactContacts(o.sellerName, includeContact),
    seller_order_id: str(o.sellerOrderId),
    seller_website: redactContacts(o.sellerWebsite, includeContact),
  };
  return Object.values(out).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0)) ? out : undefined;
}

function deliveryInfo(d: Rec | null | undefined, includeContact: boolean) {
  if (!d || typeof d !== "object") return undefined;
  const tas = d.timeAtStopInfo && typeof d.timeAtStopInfo === "object" ? d.timeAtStopInfo : undefined;
  const photos = Array.isArray(d.photoUrls) ? d.photoUrls.filter((u: unknown) => typeof u === "string" && u !== "") : [];
  return {
    state: str(d.state),
    attempted: bool(d.attempted),
    attempted_at: iso(d.attemptedAt),
    succeeded: bool(d.succeeded),
    time_at_stop: tas
      ? {
          ...statusValue(tas),
          ...(tas.value && typeof tas.value === "object" ? { arrived_at: iso(tas.value.arrivedAt), departed_at: iso(tas.value.departedAt), estimated: bool(tas.value.isEstimated) } : {}),
        }
      : undefined,
    driver_internal_notes: redactContacts(d.driverProvidedInternalNotes, includeContact),
    driver_recipient_notes: redactContacts(d.driverProvidedRecipientNotes, includeContact),
    recipient_notes: redactContacts(d.recipientProvidedNotes, includeContact),
    // Who signed, where the attempt happened, and the proof-of-delivery photo and signature links
    // identify the recipient and their home, so they are only returned on request. The links are
    // passed through as URLs; nothing is downloaded.
    ...(includeContact
      ? {
          signee_name: str(d.signeeName),
          attempted_location: d.attemptedLocation && typeof d.attemptedLocation === "object" ? { latitude: num(d.attemptedLocation.latitude), longitude: num(d.attemptedLocation.longitude) } : undefined,
          photo_urls: photos,
          signature_url: str(d.signatureUrl),
        }
      : {
          signee_name: str(d.signeeName) ? "[withheld; available with include_contact_details]" : undefined,
          proof: photos.length || str(d.signatureUrl) ? `${photos.length} photo(s)${str(d.signatureUrl) ? " and a signature" : ""}; links available with include_contact_details` : undefined,
        }),
  };
}

function serviceInfo(s: Rec | null | undefined) {
  if (!s || typeof s !== "object") return undefined;
  const base = statusValue(s);
  const v = s.value && typeof s.value === "object" ? s.value : undefined;
  if (!v) return base;
  return {
    ...base,
    identifier: str(v.identifier),
    name: str(v.name),
    sla_starts_at: iso(v.slaStartsAt),
    sla_due_date: ymd(v.slaDueDate),
    sla_due_time: hm(v.slaDueTime),
    delivery_horizon: v.deliveryHorizon && typeof v.deliveryHorizon === "object" ? `${v.deliveryHorizon.value} ${v.deliveryHorizon.unit}` : undefined,
    price: v.price && typeof v.price === "object" ? { minor_units: num(v.price.value), currency: str(v.price.currency) } : undefined,
    payment_on_delivery: bool(v.hasPaymentOnDelivery),
  };
}

/** Fields shared by stopSchema and unassignedStopSchema. */
function stopCommon(s: Rec, includeContact: boolean) {
  const pod = s.paymentOnDelivery && typeof s.paymentOnDelivery === "object" ? s.paymentOnDelivery : undefined;
  return {
    id: str(s.id),
    activity: str(s.activity),
    address: personalAddress(s.address, includeContact),
    recipient: recipient(s.recipient, includeContact),
    notes: redactContacts(s.notes, includeContact),
    package_count: num(s.packageCount),
    weight: s.weight && typeof s.weight === "object" ? { amount: num(s.weight.amount), unit: str(s.weight.unit) } : undefined,
    barcodes: Array.isArray(s.barcodes) && s.barcodes.length ? s.barcodes.map(str) : undefined,
    order: orderInfo(s.orderInfo, includeContact),
    timing: timing(s.timing),
    optimization_order: str(s.optimizationOrder),
    allowed_drivers: Array.isArray(s.allowedDrivers) && s.allowedDrivers.length ? s.allowedDrivers.map(str) : undefined,
    payment_on_delivery: pod ? { amount_minor_units: num(pod.amount), currency: str(pod.currency) } : undefined,
    proof_of_attempt_required: s.proofOfAttemptRequirements && typeof s.proofOfAttemptRequirements === "object" ? bool(s.proofOfAttemptRequirements.enabled) : undefined,
    // Custom properties are free text typed by the team; values get the same redaction as notes.
    custom_properties: s.customProperties && typeof s.customProperties === "object" ? redactDeep(s.customProperties, includeContact) : undefined,
    client_id: str(s.clientId),
    // The recipient tracking link shows the recipient's delivery, so it is treated like their contact details.
    ...(includeContact ? { tracking_link: str(s.trackingLink) } : {}),
  };
}

export function stop(s: Rec, includeContact: boolean) {
  const eta = s.eta && typeof s.eta === "object" ? s.eta : undefined;
  const route = s.route && typeof s.route === "object" ? s.route : undefined;
  return {
    ...stopCommon(s, includeContact),
    type: str(s.type),
    plan: str(s.plan),
    route: route ? { id: str(route.id), title: redactContacts(route.title, includeContact), driver: str(route.driver) } : undefined,
    position: num(s.stopPosition),
    package_label: redactContacts(s.packageLabel, includeContact),
    eta: eta
      ? {
          ...statusValue(eta),
          ...(eta.value && typeof eta.value === "object"
            ? { estimated_arrival: iso(eta.value.estimatedArrivalAt), earliest: iso(eta.value.estimatedEarliestArrivalAt), latest: iso(eta.value.estimatedLatestArrivalAt) }
            : {}),
        }
      : undefined,
    travel_from_previous: num(s.estimatedTravelDuration) !== undefined || num(s.estimatedTravelDistance) !== undefined ? { duration_s: num(s.estimatedTravelDuration), distance_m: num(s.estimatedTravelDistance) } : undefined,
    delivery: deliveryInfo(s.deliveryInfo, includeContact),
    place_in_vehicle: s.placeInVehicle && typeof s.placeInVehicle === "object" ? { x: str(s.placeInVehicle.x), y: str(s.placeInVehicle.y), z: str(s.placeInVehicle.z) } : undefined,
    service: serviceInfo(s.serviceInfo),
    web_app_link: str(s.webAppLink),
  };
}

export function unassignedStop(s: Rec, includeContact: boolean) {
  return { ...stopCommon(s, includeContact), depot: str(s.depot) };
}

/** One item of the GET /stops:search response: {type: "stop", stop} or {type: "unassignedStop", unassignedStop}. */
export function searchHit(h: Rec, includeContact: boolean) {
  if (h?.type === "unassignedStop" && h.unassignedStop) return { kind: "unassigned_stop", ...unassignedStop(h.unassignedStop, includeContact) };
  if (h?.type === "stop" && h.stop) return { kind: "stop", ...stop(h.stop, includeContact) };
  return { kind: str(h?.type) ?? "unknown" };
}

// driverSchema. Email, phone and the driver's own start/end addresses are personal data.
export function driver(d: Rec, includeContact: boolean) {
  const ro = d.routeOverrides && typeof d.routeOverrides === "object" ? d.routeOverrides : undefined;
  return {
    id: str(d.id),
    name: redactContacts(d.name, includeContact),
    display_name: redactContacts(d.displayName, includeContact),
    active: bool(d.active),
    depots: Array.isArray(d.depots) ? d.depots.map(str) : [],
    ...(includeContact ? { email: str(d.email), phone: str(d.phone) } : {}),
    route_overrides: ro
      ? {
          start_time: hm(ro.startTime),
          end_time: hm(ro.endTime),
          start_address: personalAddress(ro.startAddress, includeContact),
          end_address: personalAddress(ro.endAddress, includeContact),
          max_stops: num(ro.maxStops),
          driving_speed: str(ro.drivingSpeed),
          delivery_speed: str(ro.deliverySpeed),
          vehicle_type: str(ro.vehicleType),
        }
      : undefined,
  };
}

// depotSchema. A depot is the team's own operating base, so its address is returned as stored.
export function depot(d: Rec, includeContact: boolean) {
  const ro = d.routeOverrides && typeof d.routeOverrides === "object" ? d.routeOverrides : undefined;
  return {
    id: str(d.id),
    name: redactContacts(d.name, includeContact),
    route_defaults: ro
      ? {
          start_time: hm(ro.startTime),
          end_time: hm(ro.endTime),
          start_address: fullAddress(ro.startAddress, includeContact),
          end_address: fullAddress(ro.endAddress, includeContact),
          round_trip: bool(ro.roundTrip),
          default_time_at_stop_s: num(ro.defaultTimeAtStop),
          max_stops: num(ro.maxStops),
          road_side: str(ro.roadSide),
          vehicle_type: str(ro.vehicleType),
        }
      : undefined,
  };
}

export function operation(o: Rec, includeContact: boolean) {
  const m = o.metadata && typeof o.metadata === "object" ? o.metadata : undefined;
  const r = o.result && typeof o.result === "object" ? o.result : undefined;
  return {
    id: str(o.id),
    type: str(o.type),
    done: bool(o.done),
    canceled: m ? bool(m.canceled) : undefined,
    started_at: m ? iso(m.startedAt) : undefined,
    finished_at: m ? iso(m.finishedAt) : undefined,
    started_by: m ? str(m.startedBy) : undefined,
    plan: m ? str(m.targetPlanId) : undefined,
    result: r
      ? str(r.code) !== undefined && str(r.message) !== undefined && r.numOptimizedStops === undefined
        ? { error: { code: str(r.code), message: redactContacts(r.message, includeContact) } }
        : { optimized_stops: num(r.numOptimizedStops), skipped_stops: Array.isArray(r.skippedStops) ? r.skippedStops.map((s: Rec) => ({ id: str(s.id), reason: str(s.reason) })) : [] }
      : undefined,
  };
}
