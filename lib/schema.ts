import { z } from "zod";

// Narrative fields (`why`, `country`) are optional: the model usually fills them,
// but one omitted sentence shouldn't fail-validate an otherwise perfect plan.
// Structural fields (name, type, nights, label) stay required. The .max() bounds are
// generous — well above any real plan — so they never trip a legitimate emit, but they cap
// how much adversarial text a refine's client-supplied prior plan can smuggle into the
// model's context (that plan is user input and gets embedded verbatim before planning).
export const activitySchema = z.object({
  name: z.string().max(400).describe("A specific, real place or thing to do."),
  type: z.enum([
    "food",
    "sight",
    "activity",
    "nature",
    "nightlife",
    "shopping",
    "rest",
    "transit",
  ]),
  why: z
    .string()
    .max(1000)
    .optional()
    .describe("One sentence: why this is here for this traveler."),
});

export const daySchema = z.object({
  label: z.string().max(120).describe('e.g. "Day 1" or a real date.'),
  morning: activitySchema,
  afternoon: activitySchema,
  evening: activitySchema,
});

export const citySchema = z.object({
  name: z.string().max(120),
  country: z.string().max(120).optional(),
  // .min(1): a city you sleep in has at least one night; this also flows into the tool's
  // JSON Schema (below) so the model is told the bound, and Zod rejects "-3 nights".
  nights: z.number().int().min(1).describe("How many nights in this city."),
  why: z.string().max(1000).optional().describe("Why this city, and why this many nights."),
  // .min(1): never render a city header with no days under it.
  days: z.array(daySchema).min(1),
});

export const itinerarySchema = z.object({
  summary: z.string().max(600).describe("One line: what this trip is."),
  totalNights: z.number().int().min(1),
  cities: z.array(citySchema).min(1).describe("Ordered list — the route."),
});

export type Activity = z.infer<typeof activitySchema>;
export type Day = z.infer<typeof daySchema>;
export type City = z.infer<typeof citySchema>;
export type Itinerary = z.infer<typeof itinerarySchema>;

// JSON Schema for the Claude tool's input_schema, generated from the Zod schema
// above (single source of truth). Zod 4 ships this natively. The .min(1) bounds above
// become `minimum` / `minItems` here, so the model sees them too. Strip the top-level
// `$schema` key — it's valid JSON Schema but isn't expected in a tool input_schema.
const full = z.toJSONSchema(itinerarySchema, { target: "draft-7" }) as Record<string, unknown>;
const { $schema: _omit, ...rest } = full;
export const itineraryJsonSchema = rest;

// Approach B layer: the model emits the schema above unchanged. After it does, the route
// runs each named place through the verify tool and attaches a verdict. These enriched
// types describe that annotated shape — the verdict is OURS, not part of what the model
// returns, so the UI can trust the badge.
export type VerifyStatus = "confirmed" | "unconfirmed";
export type VerifiedActivity = Activity & { verified?: VerifyStatus; matched?: string };
export type VerifiedDay = {
  label: string;
  morning: VerifiedActivity;
  afternoon: VerifiedActivity;
  evening: VerifiedActivity;
};

// Same Approach-B idea applied to BUDGET: when the model calls estimate_costs, the route
// grounds each city's cost level (bundled World Bank price levels + live Wikivoyage anchors)
// and attaches the result here. Like the verify verdict, this is OURS — the displayed budget
// is the tool's output, not a number the model asserted. Self-contained (no import from the
// server-only cost module) so this file stays safe to pull types from in the client bundle.
export type CostTier = "cheap" | "moderate" | "pricey" | "expensive" | "unknown";
export type CityCostSummary = {
  tier: CostTier;
  dailyUsd: number | null; // per-person, per-day, all-in, for the chosen style (native, USD)
  dailyHome: number | null; // same figure converted to the traveler's home currency, or null
  anchors: string[]; // verbatim real price examples from Wikivoyage (left in their local currency)
};
// Currency is now TWO-layered, the same way places carry a verdict and the budget a tier: the
// NATIVE figure is what the grounding source speaks (World Bank price levels are USD-denominated,
// so the budget is always native USD), and the HOME figure is that amount converted to the
// traveler's currency (default AUD) at a live European Central Bank reference rate. The conversion
// is a pure SERVER-SIDE transform (lib/currency.ts) — not a tool the model calls — because an
// exchange rate is a deterministic live fact, not a planning decision. Both are kept so the UI can
// show "≈ £1,840 ($2,420)" honestly; `*Home` is null when no conversion ran (home === native, or
// the FX fetch failed → we degrade to native-only, like flights/season degrade to "no data").
export type BudgetSummary = {
  style: "budget" | "mid-range" | "luxury";
  currency: string; // the native currency the figures are computed in (always "USD" for the budget)
  totalUsd: number | null; // per person, lodging+food+local; excludes flights/intercity (native)
  perDayUsd: number | null;
  homeCurrency?: string; // ISO 4217 the figures were converted to (e.g. "GBP"); absent when no conversion
  totalHome?: number | null; // totalUsd converted to homeCurrency
  perDayHome?: number | null; // perDayUsd converted to homeCurrency
  rate?: number; // the native→home rate actually used (e.g. 0.76 USD→GBP)
  rateDate?: string; // the ECB publish date of that rate (YYYY-MM-DD)
  note: string;
  flags: string[]; // already rewritten into homeCurrency when a conversion ran
};
// Same Approach-B idea applied to TIMING: when the model calls best_time_to_go, the route grounds
// each city's seasonality in real climate normals (Open-Meteo ERA5) and attaches the result here.
// Like the verify verdict and the budget, the displayed labels are OURS (computed in lib/season.ts),
// not a claim the model made. Self-contained (no server-only import) so the client bundle stays clean.
export type SeasonLabel = "peak" | "shoulder" | "off" | "best-available";
export type MonthSeason = {
  month: number; // 1–12
  label: SeasonLabel;
  comfort: number; // 0–10 traveler-comfort score
  meanMaxC: number; // mean daily high, °C
  meanTempC: number; // mean daily temp, °C
  precipMm: number; // average monthly precipitation total, mm
  rainDays: number; // average days/month with ≥1mm
  temp: string; // descriptor, e.g. "warm"
  rain: string; // descriptor, e.g. "mostly dry"
  flags: string[]; // e.g. "rainy season — expect downpours"
  // Sunrise-to-sunset day length (hours) for a representative mid-month day, computed from the
  // city's latitude (lib/daylight.ts) — pure astronomy, not Open-Meteo data, so it's attributed
  // separately in the season note. Raw value; formatted as "~Xh" at each display site.
  daylightHours: number;
  // Server-computed hemisphere-neutral planning advisory for this month's daylight ("~4h of
  // daylight — front-load outdoor sightseeing…"), or null when daylight isn't a signal worth a line
  // (the unremarkable 9-16h band, or an equatorial city). The threshold logic lives server-side so
  // the model view and the UI render the same verdict; the UI prints this verbatim or omits it.
  daylightAdvisory: string | null;
  // "Feels-like" afternoon high (°C): the monthly mean of ERA5 daily APPARENT-temperature highs,
  // which fold humidity, wind and solar radiation into the dry-bulb temperature. It rides the SAME
  // ERA5 archive fetch the comfort score uses (just one more daily field) — so, like daylight, it's
  // a derived signal computed server-side, never the model's claim. null when ERA5 didn't return
  // the field (degrades independently — it never nulls out the whole city's season). Rounded for
  // display, like meanMaxC.
  meanApparentMaxC: number | null;
  // Server-computed heat advisory when the feels-like high is genuinely taxing — CAUTION at ~37°C+,
  // DANGER at ~42°C+ (bands on the ROUNDED feels-like, so the advisory's cited figure always matches
  // the displayed one — the daylight raw-vs-rounded lesson). null below ~37°C. Advisory-only: it
  // NEVER adjusts the comfort score or label (the comfort score already penalises dry heat from the
  // dry-bulb temperature; this catches the humidity load that the dry-bulb misses, e.g. Bangkok).
  heatAdvisory: string | null;
  // Typical monthly PM2.5 concentration (µg/m³) from the Copernicus CAMS global model via Open-Meteo,
  // averaged over ~2 recent years. A monthly NORMAL, not a live reading — and a coarse global model
  // can understate short, localised pollution spikes (crop-burning season). null when CAMS has no
  // data for this city/month. Truncated to 0.1 µg/m³ for display, the SAME value aqiBand is computed
  // from, so the displayed figure and the band can never disagree.
  meanPm25: number | null;
  // US EPA (2024) AQI category computed SERVER-SIDE from meanPm25 ("Good" | "Moderate" | "Unhealthy
  // for Sensitive Groups" | "Unhealthy" | "Very Unhealthy" | "Hazardous"), or null when no PM2.5
  // data. Computed from the raw concentration (not a provider index field, which can be absent or use
  // pre-2024 breakpoints) so the band always exists when the concentration does.
  aqiBand: string | null;
  // Server-computed air-quality advisory when aqiBand is "Unhealthy for Sensitive Groups" or worse,
  // null for Good/Moderate (Moderate doesn't warrant a traveler warning). Framed as a typical
  // monthly normal, not a live 24-hour reading. Like daylight/heat, the threshold lives server-side.
  aqiAdvisory: string | null;
};
export type CitySeasonSummary = {
  name: string;
  country?: string;
  geocoded: boolean;
  source: "open-meteo" | "none";
  tropical: boolean; // season driven by rain, not temperature
  challenging: boolean; // no genuinely comfortable month (we label the least-bad)
  months: MonthSeason[]; // length 12 (index 0 = January), or [] when source === "none"
  bestWindow: string; // headline "best months to go", e.g. "Best: Apr–Jun & Sep–Oct"
};
export type SeasonSummary = {
  cities: CitySeasonSummary[];
  targetMonth: number | null; // 1–12, the month the model inferred the trip is for (if any)
  targetAssessment: string | null; // one-line verdict on the target month across the cities
  note: string; // data-source disclosure
  caveat: string; // weather-vs-crowds honesty disclaimer
};
// Same Approach-B idea applied to PUBLIC HOLIDAYS: when the model calls check_holidays, the route
// grounds the trip's countries in statutory public holidays (Nager.Date) and attaches the result
// here. Like the verify verdict, the budget and the season, what the UI shows is OURS (computed in
// lib/holidays.ts), not a claim the model made. Holidays are a proxy for CLOSURES + likely
// long-weekend domestic travel — never measured tourist crowds (same honest-about-limits stance the
// season tool takes). Self-contained (no server-only import) so the client bundle stays clean.
export type HolidayItem = {
  date: string; // YYYY-MM-DD
  name: string; // English name, e.g. "Bastille Day"
  localName: string; // native-language name, e.g. "Fête nationale"
  dayOfWeek: string; // "Monday" … computed server-side from the date
  weekend: boolean; // falls on Sat/Sun — already a day off, so less disruptive
  longWeekend: boolean; // Mon/Fri — bridges a weekend → heavier domestic travel likely
  closure: boolean; // a Public/Bank holiday → government, banks, some attractions closed
};
export type CountryHolidays = {
  country: string; // display name, as the plan uses it
  iso2: string | null; // resolved ISO 3166-1 alpha-2 (e.g. "FR"), or null when unresolved
  source: "nager" | "none"; // "none" → country not covered / lookup failed → show "no data", not "no holidays"
  holidays: HolidayItem[]; // target-month nationwide closures; [] when covered-but-none, or no data
  islamicCaveat: boolean; // Nager omits Islamic holidays (Eid/Ramadan) for this country → say so
};
export type HolidaySummary = {
  targetMonth: number; // 1–12, the month the trip is for
  year: number; // the calendar year inferred for that month
  countries: CountryHolidays[];
  note: string; // data-source disclosure
  caveat: string; // closures-vs-crowds honesty disclaimer
};
// Same Approach-B idea applied to FLIGHTS — but this is the FIRST tool that needs an API KEY
// (Duffel). When a Duffel key is configured the agent can call find_flights, and the route
// attaches the cheapest round-trip the tool found here. Like every other grounded value, this is
// OURS (the tool's result), not a price the model asserted. When NO key is set the tool isn't
// even offered, so this stays undefined and the app degrades cleanly to its keyless feature set —
// that graceful degradation IS the point of the milestone. In Duffel TEST mode the fares are
// SYNTHETIC (a fictional test airline), so `testMode` drives a loud "illustrative, not a real
// fare" disclaimer in the UI — the same honest-about-limits stance the season tool takes on
// crowds. Self-contained (no server-only import) so it's safe in the client bundle.
export type FlightLeg = {
  fromCity: string;
  fromCode: string; // IATA airport/city code Duffel actually searched
  toCity: string;
  toCode: string;
  date: string; // YYYY-MM-DD representative departure date for this leg
  stops: number | null; // 0 = nonstop; null if Duffel didn't break out segments
};
// Booking-ready detail, fetched by the "server-enrich pass" — a second, server-to-server GET
// /air/offers/{id} (the richer single-offer endpoint Duffel flags as the "use when ready to book"
// call). Shown only in the UI's "what you'd book" panel; never sent to the model (which can't cite
// times or baggage it never received). Every field degrades to null when the rich response omits
// it, so a partial payload still renders. Self-contained (no server-only import) for the client bundle.
export type FlightSegmentDetail = {
  departingAt: string | null; // ISO 8601 local departure time
  arrivingAt: string | null; // ISO 8601 local arrival time
  durationMinutes: number | null; // parsed from Duffel's ISO-8601 duration (e.g. "PT6H30M")
  origin: string | null; // departure airport IATA code
  originCity: string | null; // departure city name (null for some regional airports)
  destination: string | null; // arrival airport IATA code
  destinationCity: string | null; // arrival city name
  flightDesignator: string | null; // marketing carrier + number, e.g. "BA234"
  carrierName: string | null; // marketing carrier name
};

// Checked/carry-on allowance for one slice, taken as the MIN across its segments — if any leg
// disallows a checked bag, the whole routing effectively does. null = Duffel didn't report it.
export type SliceBaggage = {
  checkedQuantity: number | null;
  carryOnQuantity: number | null;
};

// Offer-level fare rules (refundability + change terms). The *Home fields are the penalty converted
// to the traveler's home currency — the penalty currency can differ from the fare currency, so this
// is a SEPARATE conversion from the fare's — and stay null when no conversion ran.
export type FlightConditions = {
  refundable: boolean | null; // null = Duffel didn't say
  refundPenaltyAmount: number | null;
  refundPenaltyCurrency: string | null;
  refundPenaltyHome: number | null;
  changeable: boolean | null;
  changePenaltyAmount: number | null;
  changePenaltyCurrency: string | null;
  changePenaltyHome: number | null;
  penaltyHomeCurrency: string | null; // ISO currency the *Home penalty figures are converted to
};

// Why a non-cheapest offer was chosen -- the "smart selection" record. Attached ONLY when the
// server picked a lower-stop fare over the absolute cheapest (within a price band); absent when the
// cheapest was already the best, so its mere presence means "we upgraded you off the cheapest". The
// figures describe the fare we SKIPPED (the cheapest) so the UI can show an honest "nonstop, A$40
// (8%) over the cheapest 1-stop fare" line. cheapestAmount is native currency (the same currency as
// the fare, since all offers in one Duffel search share it); cheapestHomeAmount is that figure
// converted by the same FX pass that converts the fare, so the UI never mixes currencies. Self-
// contained (no server-only import) for the client bundle. NEVER sent to the model -- UI-only.
export type FlightSelection = {
  reason: "fewer-stops";
  chosenStops: number | null; // total stops across both legs of the fare we CHOSE
  cheapestStops: number | null; // total stops of the absolute-cheapest fare we skipped
  cheapestAmount: number | null; // the skipped cheapest fare's price, native currency
  cheapestCurrency: string | null; // ISO 4217 of cheapestAmount (matches the fare's currency)
  cheapestHomeAmount?: number | null; // cheapestAmount converted to home currency by the FX pass
  homeCurrency?: string | null; // ISO the *Home figure is in
};

export type FlightSummary = {
  source: "duffel"; // only ever attached when a real Duffel search ran
  testMode: boolean; // true → synthetic test data → show the disclaimer
  origin: string; // the departure city as the traveler phrased it
  legs: FlightLeg[]; // [outbound] or [outbound, return]
  totalAmount: number | null; // cheapest combined price, in `currency` (native, whatever Duffel quoted)
  currency: string | null; // ISO 4217 from Duffel (e.g. "GBP", "USD", or "AUD" for a sandbox fare)
  // Same native/home split as the budget: Duffel quotes in its own currency (a test fare can come
  // back as "A$126"), so we convert to the traveler's home currency at the ECB rate. `homeAmount`
  // is absent when no conversion ran (Duffel already quoted in the home currency, or FX failed).
  homeCurrency?: string; // ISO 4217 the fare was converted to (e.g. "GBP")
  homeAmount?: number | null; // totalAmount converted to homeCurrency
  rate?: number; // the native→home rate used
  rateDate?: string; // ECB publish date of that rate (YYYY-MM-DD)
  airline: string | null; // the cheapest offer's airline (e.g. "Duffel Airways" in test mode)
  cabin: string; // "economy" in v1
  note: string; // price basis + the test-mode disclaimer
  // --- Booking-ready detail (the "server-enrich pass") ----------------------------------------
  // All optional and additive: when the second GET /air/offers/{id} fails (timeout/429/404) the
  // tool degrades to the lean summary and these stay absent, so the flights block still renders
  // with price + route — additive-or-nothing, exactly like homeAmount. offerId is the scaffold a
  // future hold/book step plugs into (not PII, not a payment instrument); expiresAt drives the
  // honest "~30 min, re-search before booking" caveat. None of these reach the model.
  offerId?: string; // Duffel offer ID for a future hold/order step; never rendered as text
  expiresAt?: string | null; // ISO 8601 offer.expires_at; null when absent
  sliceSegments?: FlightSegmentDetail[][] | null; // [outbound segments, return segments]
  sliceBaggage?: SliceBaggage[] | null; // [outbound, return] baggage, parallel to sliceSegments
  conditions?: FlightConditions | null; // offer-level refund/change terms
  // Smart flight selection (server-side rule, not a model decision): present ONLY when we chose a
  // lower-stop fare over the absolute cheapest. Drives the UI's "why this flight" line; gated to
  // non-test fares in the UI since synthetic test spreads are meaningless. Absent => cheapest kept.
  selection?: FlightSelection | null;
};

// Same Approach-B idea applied to the ROUTE — the multi-city geography between cities. When the
// model calls check_route, the server geocodes the cities and grounds the legs in REAL road travel
// times + distances from the keyless OSRM road network (falling back to straight-line haversine when
// OSRM is unavailable), then attaches the result here. Like every other grounded value, the figures
// the UI shows are OURS, not the model's claim — and they are RECOMPUTED against the FINAL emitted
// city order (lib/route.ts buildRouteSummary), so a displayed leg always matches the plan even if the
// model adopted check_route's suggested reorder before emitting. HONEST ABOUT MODE + SOURCE: road
// times are NOT a recommendation to drive (a train or flight is often faster); a leg with no road
// route (an island/overseas hop) is flagged "fly or ferry", never a fake distance across water; and a
// fallback to straight-line is labelled as such, never dressed up as a real driving time. Self-
// contained (no server-only import) so it's safe in the client bundle.
export type RouteLeg = {
  from: string;
  to: string;
  // OSRM road figures for this leg. roadKm/roadHours are null when there's no road route (noRoadRoute),
  // when an endpoint failed to geocode, or under the straight-line fallback (source === "haversine").
  roadKm: number | null;
  roadHours: number | null; // driving duration in hours (e.g. 4.67 → "4h 40m"); UI formats h/m
  // Straight-line km between the two cities. Shown ONLY under the haversine fallback; in OSRM mode it
  // is server-side context (it sanity-checks the OSRM distance) and is null on a noRoadRoute leg, so
  // the UI can never display a driveable-looking distance across open water.
  haversineKm: number | null;
  // true ⇒ OSRM has no usable road route for this pair (an explicit null cell, or a distance shorter
  // than the straight line, which is geometrically impossible for a real road) ⇒ the traveler flies or
  // ferries this leg. Only ever set in OSRM mode; never under the haversine fallback.
  noRoadRoute: boolean;
  // A per-leg advisory string when this leg is a long haul ("~9h by road — a long travel day …"), else
  // null. Drives nothing structural; the UI shows it under the leg. The render gate is derived from the
  // leg figures, not from this string.
  flag: string | null;
};
export type RouteSummary = {
  source: "osrm" | "haversine"; // "osrm" = real road times; "haversine" = straight-line fallback
  legs: RouteLeg[]; // ordered, consecutive pairs from the FINAL emitted city list
  note: string; // data-source + mode-honesty disclosure
};

export type VerifiedCity = Omit<City, "days"> & {
  days: VerifiedDay[];
  cost?: CityCostSummary;
  season?: CitySeasonSummary;
};
export type VerifiedItinerary = Omit<Itinerary, "cities"> & {
  cities: VerifiedCity[];
  budget?: BudgetSummary;
  season?: SeasonSummary;
  flights?: FlightSummary;
  holidays?: HolidaySummary;
  route?: RouteSummary;
};
