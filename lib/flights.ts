import type { FlightLeg, FlightSummary } from "./schema";

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
const DAY_MS = 86_400_000;
const DEFAULT_NIGHTS = 7; // return-date fallback when the model doesn't pass a night count
const DEFAULT_LEAD_DAYS = 56; // ~8 weeks out when no travel month is known at all

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
  total_amount?: string;
  total_currency?: string;
  live_mode?: boolean;
  owner?: { name?: string; iata_code?: string };
  slices?: DuffelSlice[];
};

const stopsFor = (slice: DuffelSlice | undefined): number | null =>
  slice && Array.isArray(slice.segments) ? Math.max(0, slice.segments.length - 1) : null;

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
  const basis = `Cheapest economy round-trip for 1 adult, ${
    monthName ? `a representative mid-${monthName} date` : "a representative near-term date"
  } (excludes bags and seat fees).`;
  const note = testMode
    ? `${basis} ⚠ TEST DATA: these are synthetic fares from Duffel's test environment, not real bookable prices — set a live Duffel key for real fares.`
    : `${basis} A live fare snapshot — prices move, so treat it as a ballpark.`;

  return {
    source: "duffel",
    testMode,
    origin: ctx.origin,
    legs,
    totalAmount: Number.isFinite(amount) ? Math.round(amount) : null,
    currency: offer.total_currency ?? null,
    airline: offer.owner?.name ?? null,
    cabin: "economy",
    note,
  };
}

const unavailable = (
  origin: string,
  reason: FlightUnavailable["reason"],
  note: string,
): FlightUnavailable => ({ source: "unavailable", origin, reason, note });

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

    const offersRes = await duffelFetch(
      `/air/offers?offer_request_id=${encodeURIComponent(offerRequestId)}&sort=total_amount&limit=1`,
      apiKey,
      { timeoutMs: OFFERS_TIMEOUT_MS, signal },
    );
    if (!offersRes.ok) {
      console.warn(`Duffel offers HTTP ${offersRes.status}`);
      return unavailable(origin, "error", `Couldn't read fares (Duffel HTTP ${offersRes.status}).`);
    }
    const offersJson = (await offersRes.json()) as { data?: DuffelOffer[] };
    const cheapest = Array.isArray(offersJson.data) ? offersJson.data[0] : undefined;
    if (!cheapest) {
      return unavailable(origin, "no-offers", "No flights came back for those cities and dates.");
    }

    onProgress?.("Pricing the cheapest fare");
    return summarizeOffer(cheapest, {
      origin,
      out: {
        fromCity: origin,
        fromCode: o.code,
        toCity: arriveCity,
        toCode: a.code,
        date: outISO,
      },
      back: {
        fromCity: returnFromCity,
        fromCode: back.code,
        toCity: origin,
        toCode: o.code,
        date: retISO,
      },
      month: input.month,
      apiKey,
    });
  } catch (err) {
    if (signal?.aborted) return unavailable(origin, "error", "Search was cancelled.");
    console.warn("Duffel flight search error:", err);
    return unavailable(origin, "error", "Something went wrong searching for flights.");
  }
}

// A compact, model-facing view of the result for the tool_result — the model needs the gist (did
// it work, what's the round-trip price, is it test data) to weave one honest line into its plan,
// not the full structured payload. The full detail goes to the UI via the server attach.
//
// `price` leads with the HOME-currency fare (attached by the route's FX pass) so the model cites
// the same figure the FlightsBlock shows — never the raw Duffel currency, which a test fare can
// quote as a stray "AUD 126". The native fare rides along as `nativePrice` only when it differs.
export function flightModelView(result: FlightResult): unknown {
  if (result.source === "unavailable") {
    return { available: false, reason: result.reason, note: result.note };
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
