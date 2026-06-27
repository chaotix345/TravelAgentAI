import type {
  FlightConditions,
  FlightLeg,
  FlightSegmentDetail,
  FlightSelection,
  FlightSummary,
  SliceBaggage,
} from "./schema";

// find_flights grounds the FLIGHTS of a plan — the one cost the budget tool deliberately leaves
// out ("excludes flights and intercity transport — no reliable free price source"). It is the
// FIRST tool in the agent loop that needs an API KEY, so it's where the project learns the
// keyed-tool + graceful-degradation pattern:
//
//   • No DUFFEL_API_KEY  → the loop never even offers this tool, and findFlights (if called) hands
//     back a typed "unavailable" result. The app stays exactly the keyless 5-tool app it was —
//     degradation is a first-class return value, never a thrown error or a half-broken UI.
//   • A Duffel TEST key  → real Duffel API calls, but the fares are SYNTHETIC (a fictional test
//     airline, "Duffel Airways"). The docs say plainly you "won't see realistic flight schedules
//     or prices", so testMode drives a loud "illustrative only" disclaimer — the same honest-
//     about-limits discipline the season tool uses for crowds.
//   • A Duffel LIVE key  → the very same flow returns real bookable fares (testMode false, no
//     disclaimer). Nothing else changes.
//
// Mechanics (confirmed against Duffel's v2 docs, raw fetch to keep the HTTP visible — same as
// every other tool, no SDK):
//   1. Resolve each city NAME to an IATA code via GET /places/suggestions (no hardcoded map).
//   2. POST /air/offer_requests?return_offers=false with TWO slices (out + return) = one
//      round-trip search. The body must be wrapped in { data: ... }; headers carry
//      Authorization: Bearer, Duffel-Version: v2 (a literal string, NOT a date), Content-Type.
//   3. GET /air/offers?offer_request_id=…&sort=total_amount&limit=1 → the cheapest offer.
//   4. The "server-enrich pass": GET /air/offers/{id} for that cheapest offer — the RICHER
//      single-offer endpoint Duffel flags as the "use when ready to book" call — to pull the
//      booking-ready detail the list omits (segment times, durations, baggage, fare conditions).
//      It's a deterministic server-side enrichment, structurally like lib/currency.ts's FX pass:
//      additive-or-nothing. Any failure degrades to the lean summary, so a priced plan never
//      becomes unpriced over a slow detail fetch.
// Like the verify verdict, the budget and the season, the price the UI shows is the TOOL's, never
// a number the model claimed.

const DUFFEL_API = "https://api.duffel.com";
// The version header is the literal string "v2" — an adversarial doc check refuted the intuitive
// "it's a date" assumption (v1 was sunset 2025-01-23). A wrong value here is a hard API rejection.
const DUFFEL_VERSION = "v2";
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";
// /places/suggestions and /air/offers are quick reads. The offer_requests POST is synchronous and
// can hold the connection open up to Duffel's ~20s supplier_timeout while it polls airlines, so it
// gets a much larger ceiling — but still bounded, so one slow search can't eat the whole plan's
// wall-clock. Any timeout/abort degrades to an "unavailable" result, never a failed plan.
const PLACES_TIMEOUT_MS = 6000;
const SEARCH_TIMEOUT_MS = 25000;
const OFFERS_TIMEOUT_MS = 9000;
// The booking-detail GET /air/offers/{id} (the server-enrich pass) is a single quick read like the
// offers list; bound it tightly so a slow enrichment can't stall a plan that's already priced. Any
// failure here degrades to the lean summary — the fare still shows, just without the detail panel.
const ENRICH_TIMEOUT_MS = 7000;
const DAY_MS = 86_400_000;
const DEFAULT_NIGHTS = 7; // return-date fallback when the model doesn't pass a night count
const DEFAULT_LEAD_DAYS = 56; // ~8 weeks out when no travel month is known at all
// How many of the cheapest offers to pull (was 1). We sort by total_amount ascending and take the
// cheapest BAND so a deterministic server rule can prefer a nonstop/fewer-stops fare within reach of
// the cheapest. Duffel's limit ranges 1-200 (default 50); 20 is plenty of price spread to find a
// lower-stop option without paying for a huge response. The search itself is unchanged: we leave
// max_connections at Duffel's default of 1, so the pool already mixes nonstop and 1-stop offers.
const OFFERS_LIMIT = 20;
// Smart-selection price band. We upgrade from the cheapest fare to a fewer-stops one ONLY when the
// fewer-stops fare costs no more than (1 + this) x the cheapest. 0.20 = "pay up to 20% more to drop
// a connection" -- a decisive travel agent's call, not a rock-bottom-at-all-costs one. It's a flat
// PERCENTAGE (currency-agnostic) because selection runs in native currency BEFORE the FX pass, so a
// home-currency absolute cap can't be applied here; the "Different flight option" refine chip is the
// traveler's recourse if they'd rather have the cheapest. Tunable knob -- the whole feature's dial.
const STOP_PREMIUM_THRESHOLD = 0.2;

export type FlightInput = {
  origin: string; // departure city or IATA, inferred from the brief
  arriveCity: string; // first city of the trip — the one you fly into
  arriveCountry?: string;
  departCity?: string; // last city — the one you fly home from; defaults to arriveCity
  departCountry?: string;
  month?: string | null; // "YYYY-MM" the trip is for; null → a default forward date
  nights?: number; // total trip nights → return date = outbound + nights
};

// A reason the tool couldn't price flights, returned as data (not thrown) so the model can react
// and the route can simply skip attaching a flight block.
export type FlightUnavailable = {
  source: "unavailable";
  origin: string;
  reason: "no-key" | "no-origin" | "no-route" | "no-offers" | "error";
  note: string;
};
export type FlightResult = FlightSummary | FlightUnavailable;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// --- pure helpers (no network — easy to reason about and test) --------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");
const toISO = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

// Pick a representative outbound date. With a target month we use the 15th (a neutral mid-month
// proxy — the price is explicitly a "sample for that month", not a quote for a real flight). The
// date must be comfortably in the FUTURE or Duffel rejects it, so a month already in the past
// rolls forward a year. With no month at all we default to ~8 weeks out.
export function outboundDate(month: string | null | undefined, now: Date): Date {
  const earliest = new Date(now.getTime() + 7 * DAY_MS); // never search inside a week from today
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    if (m >= 1 && m <= 12) {
      let d = new Date(Date.UTC(y, m - 1, 15));
      while (d.getTime() < earliest.getTime()) {
        d = new Date(Date.UTC(d.getUTCFullYear() + 1, m - 1, 15));
      }
      return d;
    }
  }
  return new Date(now.getTime() + DEFAULT_LEAD_DAYS * DAY_MS);
}

const returnDate = (out: Date, nights: number) =>
  new Date(out.getTime() + Math.max(1, nights) * DAY_MS);

// --- Duffel HTTP ------------------------------------------------------------------------------

async function duffelFetch(
  path: string,
  apiKey: string,
  opts: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  return fetch(`${DUFFEL_API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Duffel-Version": DUFFEL_VERSION,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
}

type Place = { code: string; name: string };

type PlaceSuggestion = { iata_code?: string | null; name?: string; type?: string };

// Resolve a city name — or a bare IATA code — to an airport/city code via Duffel's own Places
// endpoint. No third-party geocoder, no stale hardcoded map, and crucially no client-side guess at
// what's a code: a 3-letter input like "Goa", "Hue" or "Fes" is a real city, not an IATA code, so
// letting Duffel decide avoids sending a fake code that 4xx's into a silent "error". Duffel
// resolves genuine codes too (returning them as airport results). We prefer a `city` result (its
// code searches every airport serving the city) and fall back to the first result that carries an
// IATA code. Cached per request so a city used as both an arrival and a return-from point costs one
// lookup.
async function resolvePlace(
  query: string,
  apiKey: string,
  cache: Map<string, Place | null>,
  signal: AbortSignal | undefined,
): Promise<Place | null> {
  const q = query.trim();
  if (!q) return null;
  const key = fold(q);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let resolved: Place | null = null;
  try {
    const res = await duffelFetch(
      `/places/suggestions?query=${encodeURIComponent(q)}`,
      apiKey,
      { timeoutMs: PLACES_TIMEOUT_MS, signal },
    );
    if (res.ok) {
      const json = (await res.json()) as { data?: PlaceSuggestion[] };
      const list = Array.isArray(json.data) ? json.data : [];
      const city = list.find((p) => p.type === "city" && p.iata_code);
      const any = list.find((p) => p.iata_code);
      const pick = city ?? any;
      if (pick?.iata_code) resolved = { code: pick.iata_code.toUpperCase(), name: pick.name ?? q };
    }
  } catch {
    resolved = null; // timeout / network / abort → unresolved; the caller degrades gracefully
  }
  cache.set(key, resolved);
  return resolved;
}

// --- offer parsing (pure given a parsed JSON body) --------------------------------------------

type DuffelSegment = unknown;
type DuffelSlice = { segments?: DuffelSegment[] };
type DuffelOffer = {
  id?: string; // the offer ID — needed for the enrich GET and any future hold/order step
  expires_at?: string | null; // ISO 8601; offers typically expire ~30 min after search
  total_amount?: string;
  total_currency?: string;
  live_mode?: boolean;
  owner?: { name?: string; iata_code?: string };
  slices?: DuffelSlice[];
};

// The RICHER shape returned by GET /air/offers/{id} (the single-offer endpoint). The offers LIST
// endpoint omits all of this — segment times, durations, per-passenger baggage, fare conditions —
// which is why the enrich pass re-fetches the chosen offer by ID. Everything is optional: a missing
// field just becomes null in the parsed FlightSummary, never a throw.
type DuffelAirport = { iata_code?: string | null; city_name?: string | null };
type DuffelCarrier = { iata_code?: string | null; name?: string | null };
type DuffelPassengerBaggage = { type?: string; quantity?: number | null };
type DuffelRichSegment = {
  departing_at?: string | null;
  arriving_at?: string | null;
  duration?: string | null;
  origin?: DuffelAirport;
  destination?: DuffelAirport;
  marketing_carrier?: DuffelCarrier;
  marketing_carrier_flight_number?: string | null;
  passengers?: { baggages?: DuffelPassengerBaggage[] }[];
};
type DuffelConditionClause = {
  allowed?: boolean;
  penalty_amount?: string | null;
  penalty_currency?: string | null;
} | null;
type DuffelConditions = {
  refund_before_departure?: DuffelConditionClause;
  change_before_departure?: DuffelConditionClause;
};
type DuffelRichSlice = { segments?: DuffelRichSegment[]; conditions?: DuffelConditions };
type DuffelRichOffer = DuffelOffer & { slices?: DuffelRichSlice[]; conditions?: DuffelConditions };

// Stops in one slice = segments - 1. An EMPTY segments array is "no routing data", NOT a nonstop:
// Math.max(0, [].length - 1) would wrongly read 0 (nonstop), so a missing/empty list returns null
// (unknown). Selection treats null as Infinity so an offer with unknown routing is never preferred
// over one with a counted, genuinely-lower stop count.
const stopsFor = (slice: DuffelSlice | undefined): number | null =>
  slice && Array.isArray(slice.segments) && slice.segments.length > 0
    ? Math.max(0, slice.segments.length - 1)
    : null;

// Parse a Duffel money string ("451.20") to a finite number, or null when missing/malformed. Used
// to compare offers in the price band — a non-finite price drops the offer from the comparison
// rather than poisoning it with NaN.
const parseAmount = (v: string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Total stops across ALL slices of an offer (out + return). null when ANY slice's routing is unknown
// (a missing/empty segments array) -- we won't claim a stop count we can't fully see. Pure.
function totalStops(offer: DuffelOffer): number | null {
  const slices = Array.isArray(offer.slices) ? offer.slices : [];
  if (slices.length === 0) return null;
  let total = 0;
  for (const s of slices) {
    const st = stopsFor(s);
    if (st === null) return null; // one unknown leg makes the whole-trip count unknown
    total += st;
  }
  return total;
}

// The result of the smart-selection rule: which offer to price, the absolute-cheapest it was chosen
// against, and whether that was an upgrade (a strictly-fewer-stops pick) vs just keeping the cheapest.
export type OfferChoice = {
  chosen: DuffelOffer;
  cheapest: DuffelOffer;
  isUpgrade: boolean;
  chosenStops: number | null;
  cheapestStops: number | null;
};

// SMART FLIGHT SELECTION (pure, no network -- the heart of this milestone, fully unit-testable).
// Given the cheapest-first offers list, pick the fare a decisive travel agent would: among offers
// within STOP_PREMIUM_THRESHOLD of the cheapest price, take the one with the FEWEST total stops; if
// none beats the cheapest on stops, KEEP the cheapest exactly (never pay more for equal/worse
// routing). offers[0] is the absolute cheapest because the caller sorts by total_amount ascending.
// Degrades safely: empty list -> null; unparseable/zero cheapest price, or a cheapest with unknown or
// already-zero stops -> keep cheapest (no upgrade). Compares only same-currency offers as a guard,
// though one Duffel search returns a single currency.
export function chooseOffer(
  offers: DuffelOffer[],
  threshold: number = STOP_PREMIUM_THRESHOLD,
): OfferChoice | null {
  if (!offers.length) return null;
  const cheapest = offers[0];
  const cheapestStops = totalStops(cheapest);
  const base: OfferChoice = {
    chosen: cheapest,
    cheapest,
    isUpgrade: false,
    chosenStops: cheapestStops,
    cheapestStops,
  };
  const cheapestAmount = parseAmount(cheapest.total_amount);
  // Can't band-filter without a valid positive baseline price -> take the sort-order winner.
  if (cheapestAmount === null || cheapestAmount <= 0) return base;
  // Nothing to improve: the cheapest is already nonstop, or its routing is unknown (don't gamble on
  // an "upgrade" when we can't even count the baseline's stops).
  if (cheapestStops === null || cheapestStops === 0) return base;

  const cap = cheapestAmount * (1 + threshold);
  let best = cheapest;
  let bestStops = cheapestStops;
  for (const o of offers) {
    if (o === cheapest) continue;
    // Same-currency band only (belt-and-suspenders; one offer_request returns one currency).
    if ((o.total_currency ?? null) !== (cheapest.total_currency ?? null)) continue;
    const amt = parseAmount(o.total_amount);
    if (amt === null || amt > cap) continue; // outside the price band
    const st = totalStops(o);
    if (st === null) continue; // unknown routing is never preferred
    // Strictly fewer stops wins; ties go to the lower price, which -- since the list is
    // price-ascending -- is already the earlier offer, so we only replace on a STRICT improvement.
    if (st < bestStops) {
      best = o;
      bestStops = st;
    }
  }
  return best !== cheapest && bestStops < cheapestStops
    ? { chosen: best, cheapest, isUpgrade: true, chosenStops: bestStops, cheapestStops }
    : base;
}

// Parse Duffel's ISO-8601 segment duration ("PT6H30M", "P1DT2H15M") to whole minutes, or null on a
// missing/malformed value. Days/hours/minutes only — flight legs never carry months or years.
function parseDurationMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  // Days/hours/minutes/seconds — Duffel often appends a seconds component ("PT8H58M00S"); without
  // the S group the anchored regex would reject the whole string and silently drop the duration.
  // Seconds round down into minutes. Flight legs never carry months or years.
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (
    !m ||
    (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined)
  ) {
    return null;
  }
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const mins = m[3] ? parseInt(m[3], 10) : 0;
  const secs = m[4] ? parseInt(m[4], 10) : 0;
  return days * 1440 + hours * 60 + mins + Math.floor(secs / 60);
}

// Collapse a slice's per-segment, per-passenger baggage into ONE allowance: the MIN quantity across
// every segment (if any leg bans a checked bag, the whole routing effectively does). null when no
// segment reports that type — shown as "allowance not specified" rather than a misleading "0".
function sliceBaggageFor(slice: DuffelRichSlice): SliceBaggage {
  let checked: number | null = null;
  let carryOn: number | null = null;
  for (const seg of slice.segments ?? []) {
    for (const pax of seg.passengers ?? []) {
      for (const bag of pax.baggages ?? []) {
        if (typeof bag.quantity !== "number") continue;
        if (bag.type === "checked") {
          checked = checked === null ? bag.quantity : Math.min(checked, bag.quantity);
        } else if (bag.type === "carry_on") {
          carryOn = carryOn === null ? bag.quantity : Math.min(carryOn, bag.quantity);
        }
      }
    }
  }
  return { checkedQuantity: checked, carryOnQuantity: carryOn };
}

// Flatten Duffel's offer-level refund/change clauses into our FlightConditions. The *Home fields are
// filled later by a server-side FX pass (the penalty currency can differ from the fare currency). A
// penalty_amount is a STRING ("75.00") and may be null while allowed is true — "refundable, penalty
// unknown" — which the UI distinguishes from a genuine zero penalty.
function parseConditions(c: DuffelConditions | undefined): FlightConditions | null {
  if (!c) return null;
  const r = c.refund_before_departure;
  const ch = c.change_before_departure;
  const amt = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    refundable: r ? (r.allowed ?? null) : null,
    refundPenaltyAmount: amt(r?.penalty_amount),
    refundPenaltyCurrency: r?.penalty_currency ?? null,
    refundPenaltyHome: null,
    changeable: ch ? (ch.allowed ?? null) : null,
    changePenaltyAmount: amt(ch?.penalty_amount),
    changePenaltyCurrency: ch?.penalty_currency ?? null,
    changePenaltyHome: null,
    penaltyHomeCurrency: null,
  };
}

// Turn the cheapest Duffel offer + the search context into the FlightSummary the UI renders.
// Pure (no network) so the shaping logic can be checked against a recorded payload without a key.
export function summarizeOffer(
  offer: DuffelOffer,
  ctx: {
    origin: string;
    out: { fromCity: string; fromCode: string; toCity: string; toCode: string; date: string };
    back: { fromCity: string; fromCode: string; toCity: string; toCode: string; date: string } | null;
    month: string | null | undefined;
    apiKey: string;
    // Smart-selection context. smartSelected flips the note from "Cheapest" to "Selected for fewer
    // stops" so the card AND the model's tool_result are truthful about a non-cheapest pick.
    // selection is the UI's "why this flight" record, threaded through ctx so it survives the
    // enrich pass (which re-summarizes from the rich payload using this same ctx). Both default
    // to the cheapest-kept behaviour, so existing callers/tests are unaffected.
    smartSelected?: boolean;
    selection?: FlightSelection | null;
  },
): FlightSummary {
  // Trust the offer's own live_mode flag for the test-mode verdict; fall back to the token prefix
  // if Duffel ever omits it. Either way, synthetic test fares get the disclaimer.
  const testMode =
    offer.live_mode === false || ctx.apiKey.startsWith("duffel_test_");
  const amount = offer.total_amount != null ? Number.parseFloat(offer.total_amount) : NaN;
  const slices = Array.isArray(offer.slices) ? offer.slices : [];

  const legs: FlightLeg[] = [
    { ...ctx.out, stops: stopsFor(slices[0]) },
    ...(ctx.back ? [{ ...ctx.back, stops: stopsFor(slices[1]) }] : []),
  ];

  // Guard the month index (outboundDate guards the same way) so a malformed but regex-passing
  // "2026-13"/"2026-00" can't index MONTHS out of range and print "mid-undefined".
  const mn = ctx.month && /^\d{4}-\d{2}$/.test(ctx.month) ? Number(ctx.month.slice(5, 7)) : 0;
  const monthName = mn >= 1 && mn <= 12 ? MONTHS[mn - 1] : null;
  const lead = ctx.smartSelected
    ? "Economy round-trip for 1 adult, selected for fewer stops,"
    : "Cheapest economy round-trip for 1 adult,";
  const basis = `${lead} ${
    monthName ? `a representative mid-${monthName} date` : "a representative near-term date"
  } (excludes bags and seat fees).`;
  const note = testMode
    ? `${basis} ⚠ TEST DATA: these are synthetic fares from Duffel's test environment, not real bookable prices — set a live Duffel key for real fares.`
    : `${basis} A live fare snapshot — prices move, and Duffel offers typically expire within ~30 minutes of search; treat this as a planning reference, not a booking confirmation.`;

  return {
    source: "duffel",
    testMode,
    origin: ctx.origin,
    offerId: offer.id,
    expiresAt: offer.expires_at ?? null,
    legs,
    totalAmount: Number.isFinite(amount) ? Math.round(amount) : null,
    currency: offer.total_currency ?? null,
    airline: offer.owner?.name ?? null,
    cabin: "economy",
    note,
    // Attach the smart-selection record (UI-only) when one was made. Threaded via ctx so the enrich
    // re-summarize keeps it -- the summary would otherwise be rebuilt from the rich payload and lose it.
    ...(ctx.selection ? { selection: ctx.selection } : {}),
  };
}

const unavailable = (
  origin: string,
  reason: FlightUnavailable["reason"],
  note: string,
): FlightUnavailable => ({ source: "unavailable", origin, reason, note });

// Build the booking-ready detail from the RICH single-offer payload and merge it onto the lean
// summary. Pure (no network) so it's testable against a recorded /air/offers/{id} body. An expired
// offer keeps its (authoritative) price but withholds the segment/baggage/conditions detail — we
// won't dress an unbookable offer as "the flight you'd book"; we flag it and prompt a re-search.
export function enrichSummary(lean: FlightSummary, rich: DuffelRichOffer): FlightSummary {
  const offerId = rich.id ?? lean.offerId;
  const expiresAt = rich.expires_at ?? null;
  const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
  if (expired) {
    return {
      ...lean,
      offerId,
      expiresAt,
      note:
        "This offer has expired and can no longer be booked — the price shown was valid at search time; re-plan to get a current fare.",
    };
  }
  const richSlices = (rich.slices ?? []) as DuffelRichSlice[];
  return {
    ...lean,
    offerId,
    expiresAt,
    sliceSegments: richSlices.map((sl) =>
      (sl.segments ?? []).map(
        (seg): FlightSegmentDetail => ({
          departingAt: seg.departing_at ?? null,
          arrivingAt: seg.arriving_at ?? null,
          durationMinutes: parseDurationMinutes(seg.duration),
          origin: seg.origin?.iata_code ?? null,
          originCity: seg.origin?.city_name ?? null,
          destination: seg.destination?.iata_code ?? null,
          destinationCity: seg.destination?.city_name ?? null,
          flightDesignator:
            [seg.marketing_carrier?.iata_code, seg.marketing_carrier_flight_number]
              .filter(Boolean)
              .join("") || null,
          carrierName: seg.marketing_carrier?.name ?? null,
        }),
      ),
    ),
    sliceBaggage: richSlices.map(sliceBaggageFor),
    conditions:
      parseConditions(rich.conditions) ?? parseConditions(richSlices[0]?.conditions) ?? null,
  };
}

// --- public entry point — executes the find_flights tool --------------------------------------

export async function findFlights(
  input: FlightInput,
  apiKey: string | undefined,
  // Optional: called with a short label as each phase runs, so the route can stream live
  // "resolving Lisbon… searching fares…" progress the way verification streams per-place progress.
  onProgress?: (label: string) => void,
  signal?: AbortSignal,
): Promise<FlightResult> {
  // The graceful-degradation gate. The loop already withholds this tool when there's no key, but
  // we guard here too so the tool is honest if ever called directly — and so the "no-key" reason
  // is a first-class value the model could react to, not a crash.
  if (!apiKey) {
    return unavailable("", "no-key", "Flight pricing is off — set DUFFEL_API_KEY to enable it.");
  }
  const origin = input.origin?.trim() ?? "";
  if (!origin) {
    return unavailable("", "no-origin", "No departure city was given, so flights can't be priced.");
  }
  const arriveCity = input.arriveCity?.trim() ?? "";
  if (!arriveCity) {
    return unavailable(origin, "no-route", "No destination city was given to price flights to.");
  }
  const departCity = input.departCity?.trim() || arriveCity;

  const cache = new Map<string, Place | null>();
  try {
    onProgress?.(`Locating ${origin}`);
    const o = await resolvePlace(origin, apiKey, cache, signal);
    onProgress?.(`Locating ${arriveCity}`);
    const a = await resolvePlace(
      input.arriveCountry ? `${arriveCity} ${input.arriveCountry}` : arriveCity,
      apiKey,
      cache,
      signal,
    );
    onProgress?.(`Locating ${departCity}`);
    const d =
      fold(departCity) === fold(arriveCity)
        ? a
        : await resolvePlace(
            input.departCountry ? `${departCity} ${input.departCountry}` : departCity,
            apiKey,
            cache,
            signal,
          );

    if (signal?.aborted) return unavailable(origin, "error", "Search was cancelled.");
    if (!o || !a) {
      return unavailable(
        origin,
        "no-route",
        `Couldn't find an airport for ${!o ? origin : arriveCity}, so flights can't be priced.`,
      );
    }
    const back = d ?? a; // if the return city didn't resolve, fly home from the arrival city
    // Display the city we ACTUALLY searched the return from — the resolved depart city, or the
    // arrival city when that lookup failed and we fell back to it — so the shown city always
    // matches the IATA code we searched (keeps an open-jaw or a fallback internally consistent).
    const returnFromCity = d ? departCity : arriveCity;

    const now = new Date();
    const out = outboundDate(input.month, now);
    const ret = returnDate(out, input.nights ?? DEFAULT_NIGHTS);
    const outISO = toISO(out);
    const retISO = toISO(ret);

    // Two slices in ONE offer request = a round-trip (or open-jaw) search priced together, so the
    // cheapest offer's total_amount is the whole there-and-back fare in a single call.
    const offerBody = {
      data: {
        slices: [
          { origin: o.code, destination: a.code, departure_date: outISO },
          { origin: back.code, destination: o.code, departure_date: retISO },
        ],
        passengers: [{ type: "adult" }],
        cabin_class: "economy",
      },
    };

    onProgress?.("Searching fares");
    const reqRes = await duffelFetch("/air/offer_requests?return_offers=false", apiKey, {
      method: "POST",
      body: offerBody,
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal,
    });
    if (!reqRes.ok) {
      console.warn(`Duffel offer_requests HTTP ${reqRes.status}`);
      return unavailable(origin, "error", `Flight search failed (Duffel HTTP ${reqRes.status}).`);
    }
    const reqJson = (await reqRes.json()) as { data?: { id?: string } };
    const offerRequestId = reqJson.data?.id;
    if (!offerRequestId) {
      return unavailable(origin, "error", "Flight search returned no results to price.");
    }

    // Pull the cheapest BAND of offers (sorted ascending), not just the single cheapest, so the
    // server rule below can prefer a fewer-stops fare within reach of the cheapest price.
    const offersRes = await duffelFetch(
      `/air/offers?offer_request_id=${encodeURIComponent(offerRequestId)}&sort=total_amount&limit=${OFFERS_LIMIT}`,
      apiKey,
      { timeoutMs: OFFERS_TIMEOUT_MS, signal },
    );
    if (!offersRes.ok) {
      console.warn(`Duffel offers HTTP ${offersRes.status}`);
      return unavailable(origin, "error", `Couldn't read fares (Duffel HTTP ${offersRes.status}).`);
    }
    const offersJson = (await offersRes.json()) as { data?: DuffelOffer[] };
    const offers = Array.isArray(offersJson.data) ? offersJson.data : [];
    // SMART SELECTION: choose the fare a decisive agent would (fewest stops within the price band),
    // falling back to the absolute cheapest. A null result means the list was empty.
    const choice = chooseOffer(offers);
    if (!choice) {
      return unavailable(origin, "no-offers", "No flights came back for those cities and dates.");
    }
    const chosen = choice.chosen;
    // The "why this flight" record -- attached ONLY when we upgraded off the cheapest. cheapestAmount
    // is native currency; the route's FX pass converts it alongside the fare so the UI can show the
    // premium in the home currency without mixing currencies. NEVER reaches the model (UI-only).
    const cheapestNative = parseAmount(choice.cheapest.total_amount);
    const selection: FlightSelection | null = choice.isUpgrade
      ? {
          reason: "fewer-stops",
          chosenStops: choice.chosenStops,
          cheapestStops: choice.cheapestStops,
          // Round to whole units like the fare's own totalAmount (Math.round in summarizeOffer), so
          // the UI's "X more than the cheapest" difference is never a fractional money string.
          cheapestAmount: cheapestNative == null ? null : Math.round(cheapestNative),
          cheapestCurrency: choice.cheapest.total_currency ?? null,
          cheapestHomeAmount: null,
          homeCurrency: null,
        }
      : null;

    // Progress sub-labels are appended after "Pricing flights..." in the UI, so use a bare noun
    // phrase (not another "Pricing ...") to avoid a doubled word.
    onProgress?.(choice.isUpgrade ? "best-value fare" : "cheapest fare");
    const ctx = {
      origin,
      out: { fromCity: origin, fromCode: o.code, toCity: arriveCity, toCode: a.code, date: outISO },
      back: { fromCity: returnFromCity, fromCode: back.code, toCity: origin, toCode: o.code, date: retISO },
      month: input.month,
      apiKey,
      smartSelected: choice.isUpgrade,
      selection,
    };
    // Lean summary from the LIST offer — always valid, always has the price and route. If the
    // enrich pass below fails, this is exactly what we return (additive-or-nothing, like the FX pass).
    let summary = summarizeOffer(chosen, ctx);

    // --- The server-enrich pass ---------------------------------------------------------------
    // A second, server-to-server GET /air/offers/{id} pulls the booking-ready detail the LIST
    // endpoint omits (segment times, durations, baggage, fare conditions). The offer ID is Duffel's
    // own (never the model's), so it's trusted; encodeURIComponent is belt-and-suspenders. We
    // re-summarize from the AUTHORITATIVE single-offer payload (its price can differ from the
    // list's), keeping the ID, price, legs, and detail mutually consistent. Any failure — timeout,
    // 429, 404 on an already-expired offer, a malformed body — degrades to the lean summary: a
    // priced plan never becomes unpriced over a slow or failed detail fetch.
    if (chosen.id) {
      try {
        onProgress?.("Fetching booking detail");
        const enrichRes = await duffelFetch(
          `/air/offers/${encodeURIComponent(chosen.id)}`,
          apiKey,
          { timeoutMs: ENRICH_TIMEOUT_MS, signal },
        );
        if (enrichRes.ok) {
          const rich = ((await enrichRes.json()) as { data?: DuffelRichOffer }).data;
          // Enrich ONLY when the body POSITIVELY confirms it's the offer we asked for. A mismatched
          // OR ABSENT id could overwrite the chosen fare's price/detail with another offer's body,
          // silently breaking the "displayed price/stops are the tool's" invariant -- so require a
          // matching id; anything else keeps the lean summary.
          if (rich && rich.id === chosen.id) {
            // Re-price from the authoritative single-offer body, but if it came back without a
            // total_amount (a 200 with an incomplete body), keep the list price — a priced plan must
            // never silently become unpriced over the detail fetch (the additive-or-nothing rule).
            // ctx carries the selection record, so the re-summarize keeps it (summary would otherwise
            // be rebuilt from the rich payload and drop it).
            const richLean = summarizeOffer(rich, ctx);
            summary = enrichSummary(
              richLean.totalAmount != null
                ? richLean
                : { ...richLean, totalAmount: summary.totalAmount, currency: summary.currency },
              rich,
            );
          } else if (rich) {
            console.warn(
              `Duffel offer-detail id mismatch/absent: asked ${chosen.id}, got ${rich.id ?? "none"}; using lean summary.`,
            );
          }
        } else {
          console.warn(`Duffel offer-detail HTTP ${enrichRes.status}; using lean summary.`);
        }
      } catch {
        console.warn("Duffel offer-detail enrich failed; using lean summary.");
      }
    }
    // Re-validate the selection against the AUTHORITATIVE (post-enrich) chosen price. The enrich pass
    // can reprice the chosen offer, and if it drifted ABOVE the band we selected within, the UI's
    // "X% over the cheapest" line would exceed STOP_PREMIUM_THRESHOLD and contradict its own "chosen
    // for fewer stops within a small price band" rationale. Drop the selection RECORD (so no "why
    // this flight" line shows) while KEEPING the fewer-stops fare itself -- additive-or-nothing
    // applied to the explanation, not the price.
    if (
      summary.selection?.cheapestAmount != null &&
      summary.selection.cheapestAmount > 0 &&
      summary.totalAmount != null &&
      summary.totalAmount > summary.selection.cheapestAmount * (1 + STOP_PREMIUM_THRESHOLD)
    ) {
      summary = { ...summary, selection: null };
    }
    return summary;
  } catch (err) {
    if (signal?.aborted) return unavailable(origin, "error", "Search was cancelled.");
    console.warn("Duffel flight search error:", err);
    return unavailable(origin, "error", "Something went wrong searching for flights.");
  }
}

// A compact, model-facing view of the result for the tool_result — the model needs the gist (did
// it work, what's the round-trip price, is it test data) to weave one honest line into its plan,
// not the full structured payload. The full detail goes to the UI via the server attach. The
// booking-ready detail (segment times, baggage, conditions) is DELIBERATELY omitted here: the model
// can't cite specifics it never received, so it can't contradict the UI card the server attaches.
//
// `price` leads with the HOME-currency fare (attached by the route's FX pass) so the model cites
// the same figure the FlightsBlock shows — never the raw Duffel currency, which a test fare can
// quote as a stray "AUD 126". The native fare rides along as `nativePrice` only when it differs.
export function flightModelView(result: FlightResult): unknown {
  if (result.source === "unavailable") {
    return { available: false, reason: result.reason, note: result.note };
  }
  // An offer that expired between search and emit keeps its (authoritative) price for the UI's
  // expired card, but the MODEL must hear it's unavailable so its prose can't claim a bookable fare
  // while the card reads "expired" — keep the two consistent.
  if (result.expiresAt && new Date(result.expiresAt).getTime() < Date.now()) {
    return { available: false, reason: "expired", note: result.note };
  }
  const route = result.legs
    .map((l) => `${l.fromCode}→${l.toCode} ${l.date}`)
    .join(", ");
  const nativePrice =
    result.totalAmount != null ? `${result.currency ?? ""} ${result.totalAmount}`.trim() : null;
  const homePrice =
    result.homeAmount != null ? `${result.homeCurrency ?? ""} ${result.homeAmount}`.trim() : null;
  return {
    available: true,
    testMode: result.testMode,
    origin: result.origin,
    route,
    // Home figure first (what the traveler sees); fall back to native when no conversion ran.
    price: homePrice ?? nativePrice,
    nativePrice: homePrice && nativePrice !== homePrice ? nativePrice : undefined,
    airline: result.airline,
    note: result.note,
  };
}
