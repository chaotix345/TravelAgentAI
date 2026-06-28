import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import {
  itineraryJsonSchema,
  itinerarySchema,
  type BudgetSummary,
  type CitySeasonSummary,
  type FlightSummary,
  type HolidaySummary,
  type Itinerary,
  type SeasonSummary,
  type VerifiedItinerary,
  type VerifyStatus,
} from "@/lib/schema";
import { SYSTEM_PROMPT, FLIGHTS_CLAUSE, ORIGIN_CLAUSE, currencyClause } from "@/lib/prompt";
import { verifyPlaces, type VerifyResult } from "@/lib/verify";
import { checkRoute, buildRouteSummary, type StoredRouteMatrix } from "@/lib/route";
import { estimateCosts, parseStyle, type CostEstimate, type CityCost } from "@/lib/cost";
import { assessSeason, seasonModelView, seasonTargetLine, parseTargetMonth, buildSeasonNote } from "@/lib/season";
import { assessHolidays, holidayModelView, recomputeHolidays } from "@/lib/holidays";
import { findFlights, flightModelView, type FlightResult } from "@/lib/flights";
import { homeCurrency, getRate, applyFxToCost, applyFxToFlights, costModelView } from "@/lib/currency";

// The Anthropic SDK needs the Node runtime (not edge).
export const runtime = "nodejs";
// The route streams progress as an agent loop runs (plan -> verify places ->
// check the route -> revise -> emit). Streaming keeps the connection alive so the
// browser sees live progress instead of a blank spinner, and dodges the
// gateway/client timeout that a blocking response hits on long trips. The
// function's own wall-clock cap still applies on serverless (Vercel Hobby ~60s,
// Pro up to this maxDuration); locally (npm run dev) there's no cap.
export const maxDuration = 300;

// Single knob. claude-opus-4-8 is the highest-quality planner; switch to
// claude-sonnet-4-6 to cut cost roughly in half for a small quality trade.
const MODEL = "claude-opus-4-8";
const MAX_BRIEF_CHARS = 4000;
// A refine request carries the prior plan JSON, which is user-supplied via the client.
// Cap its serialized size so a pathological payload can't blow up token cost or memory; a
// real 4-week plan is far under this. Over the cap → we ignore the refine and plan fresh.
const MAX_REFINE_ITINERARY_CHARS = 200_000;
// Hard ceiling on the raw request body, checked BEFORE we parse it (App Router route
// handlers have no built-in body-size limit). Generous enough for a brief + a fully
// annotated prior plan, but stops a multi-MB body from being buffered and parsed at all.
const MAX_BODY_CHARS = 1_000_000;
// Backstop on agent-loop iterations. Happy path: 2 model turns for a single-city trip with no
// budget/timing angle (verify, then a forced emit). Each optional grounding tool the agent
// chooses to use adds one turn: estimate_costs, best_time_to_go and (when a Duffel key is set)
// find_flights for a single-city trip, or check_route + those three for multi-city — each gated to
// a single use. So the longest legitimate path is verify-retry -> verify -> check_route ->
// estimate_costs -> best_time_to_go -> check_holidays -> find_flights -> emit = 8 turns. The repair round
// (a second forced verify when round 1 finds places that don't exist) adds one to the longest path:
// empty-verify -> verify -> repair-verify -> check_route -> estimate_costs -> best_time_to_go ->
// check_holidays -> find_flights -> emit = 9 turns; 10 leaves a turn of headroom. Each optional tool (and the repair
// round) is gated to one use, so the loop can't spin. Guards against anything unexpected so a
// request can't run forever.
// When the traveler gives an explicit origin, emit is withheld until find_flights runs — but that
// just FILLS the already-budgeted flights turn rather than adding one, so this bound is unchanged.
const MAX_TURNS = 10;
// Genuine not-found places (absent from the free geo database — NOT a lookup that just errored)
// that are a small slice of the plan trigger one repair round. But when they reach this fraction of
// all submitted places, the draft is broadly broken (or the geo backend is flaking) and re-inventing
// most of the plan would only churn — so we SKIP the repair and emit with honest "unconfirmed" badges
// plus the per-activity "find alternative" affordance instead.
const REPAIR_SUPPRESS_THRESHOLD = 0.6;
// How many times the model may call verify_places with nothing checkable before
// we give up with a clear error (instead of silently burning the turn budget).
const EMPTY_VERIFY_RETRIES = 1;

// Lightweight in-memory rate limit. Best-effort: it lives per server instance, so
// on serverless it isn't global — but it stops accidental hammering and protects
// your key from a runaway client loop in local/dev. For real production, back this
// with a durable store (Redis, Vercel KV).
const RATE_LIMIT = 12; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    // Don't record a blocked attempt — otherwise a hammering client keeps pushing
    // timestamps and extends its own cooldown well past the intended window.
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  // Opportunistically drop IPs whose window has fully expired so the map can't grow
  // without bound on a long-lived instance.
  if (hits.size > 1000) {
    for (const [k, ts] of hits) {
      if (ts.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return false;
}

// The tools the planner can use. verify_places, check_route, estimate_costs and best_time_to_go
// are OURS to execute (they call free, keyless databases); emit_itinerary is the structured
// "I'm done" signal. Which tools are offered — and which one is forced — varies per turn (see
// the loop), so verify-then-emit stays structural: a plan can't be emitted before its places
// are grounded.
const VERIFY_PLACES_TOOL: Anthropic.Tool = {
  name: "verify_places",
  description:
    "Check whether named places (landmarks, neighbourhoods, markets, museums, restaurants) actually exist, using a free geographic database. Batch every place from your draft into a single call. Returns, for each, whether it was found. Use the results to drop or replace places that don't check out before finalizing. A result with checkFailed:true means the lookup itself errored (timeout or rate limit) — that is NOT evidence the place is fake, so treat it like a confirmed place, never a miss.",
  input_schema: {
    type: "object",
    properties: {
      places: {
        type: "array",
        minItems: 1,
        description: "The named places to check.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The place name as it appears in your plan." },
            city: { type: "string", description: "The city the place is in (for disambiguation)." },
          },
          required: ["name", "city"],
        },
      },
    },
    required: ["places"],
  } as Anthropic.Tool.InputSchema,
};

const CHECK_ROUTE_TOOL: Anthropic.Tool = {
  name: "check_route",
  description:
    "Sanity-check the geography of a multi-city route. List your cities IN THE ORDER you plan to visit them. Returns, per leg, the real ROAD travel time and distance between consecutive cities (driving via the OSRM road network), flags long hops, marks any leg that has no road route (an island or overseas hop the traveler would fly or ferry), and suggests a tighter order when one clearly exists. Use it to reorder cities, merge stops that sit right next to each other, drop an extreme outlier, or switch a punishing leg to a flight before you finalize. The road times are for ROUTING decisions, not a travel-time claim: a train or flight is often faster, so never cite a leg's road hours as how long the journey takes. If real road data is unavailable it falls back to straight-line distance. Only useful for trips with two or more cities.",
  input_schema: {
    type: "object",
    properties: {
      cities: {
        type: "array",
        minItems: 2,
        description: "Your cities in planned visit order.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "City name." },
            country: {
              type: "string",
              description: "Country (helps locate the city accurately).",
            },
          },
          required: ["name"],
        },
      },
    },
    required: ["cities"],
  } as Anthropic.Tool.InputSchema,
};

const ESTIMATE_COSTS_TOOL: Anthropic.Tool = {
  name: "estimate_costs",
  description:
    "Ground the BUDGET of your plan in real cost data. Pass your cities (with country and the nights you plan in each) and the traveler's travel style. Returns, per city, a cost level (cheap/moderate/pricey/expensive) and a realistic per-person daily spend for that style — derived from World Bank price-level data — plus real example prices pulled from Wikivoyage, and a total estimate. Use it to right-size nights to the budget, flag or swap an expensive base, and tell the traveler where to save. Figures cover lodging, food, local transport and activities per person; they exclude flights and intercity transport. Call this when budget matters — the brief mentions a budget, money, or 'cheap/mid/luxury', or it's a longer or multi-city trip where cost shapes the decisions. There's no reliable free source for live flight or hotel prices, so this grounds cost LEVEL, not live quotes — never invent exact prices yourself.",
  input_schema: {
    type: "object",
    properties: {
      style: {
        type: "string",
        enum: ["budget", "mid-range", "luxury"],
        description: "The traveler's travel style, inferred from the brief. Default mid-range.",
      },
      cities: {
        type: "array",
        minItems: 1,
        description: "Your cities, with the nights you plan in each.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "City name." },
            country: { type: "string", description: "Country (to locate cost data)." },
            nights: { type: "number", description: "Nights you plan to spend in this city." },
          },
          required: ["name", "country", "nights"],
        },
      },
    },
    required: ["style", "cities"],
  } as Anthropic.Tool.InputSchema,
};

const BEST_TIME_TOOL: Anthropic.Tool = {
  name: "best_time_to_go",
  description:
    "Ground the TIMING of your plan in real climate data. Pass your cities (with country), and — if the brief implies WHEN they travel ('in August', 'next spring', specific dates) — the targetMonth (1-12) of the trip. Returns, per city, a 'best months to go' window and a peak/shoulder/off-season weather label for each month, derived from Open-Meteo climate normals (real observed weather, no key); if you gave a targetMonth, it assesses that month at each city. Use it to: time a flexible trip to the best window, WARN the traveler when their chosen month is harsh (peak heat, monsoon, deep winter) and suggest a better one, and tailor day plans to the actual conditions (indoor/early-start in extreme heat, rain backups in a wet month). It ALSO returns three derived signals per month: how much DAYLIGHT each month gives (sunrise-to-sunset hours from each city's latitude) so you can front-load outdoor plans on short days and use long light evenings; a 'feels-like' HEAT advisory when humidity and sun make the midday real-feel taxing (around 37°C feels-like) or dangerous (around 42°C) — so you can front-load mornings or move strenuous plans out of the midday heat; and an AIR-QUALITY advisory when typical PM2.5 pollution is unhealthy that month (so you can build in indoor backups or suggest a cleaner month). For any city that sits at high elevation it ALSO returns a per-city ALTITUDE / acclimatization advisory (a fixed property of the city, independent of the month) so you can pace a gentle arrival day and warn about altitude sickness. It grounds WEATHER comfort, DAYLIGHT, HEAT, AIR QUALITY and ALTITUDE only — not tourist crowds or prices, which depend on holidays and festivals — so never claim crowd levels from it. Call this when timing matters: the brief gives or leaves open the dates, the destination has a strong season (Mediterranean summer, tropical monsoon, far-north winter, dangerous summer heat, a pollution season), or shifting the month would clearly help — and ALSO whenever a city may sit at high elevation (the Andes, Himalaya/Tibet, Ethiopian highlands, Mexican plateau, a high Rocky Mountain town), even with no dates, to ground its altitude.",
  input_schema: {
    type: "object",
    properties: {
      cities: {
        type: "array",
        minItems: 1,
        description: "Your cities to assess for seasonality.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "City name." },
            country: { type: "string", description: "Country (to locate the city accurately)." },
          },
          required: ["name"],
        },
      },
      targetMonth: {
        type: "integer",
        minimum: 1,
        maximum: 12,
        description:
          "The calendar month the trip is for (1=January … 12=December), inferred from the brief. Use the actual month(s) of travel — never assume 'summer' means a fixed month, since that flips by hemisphere. Omit entirely if the brief gives no timing.",
      },
    },
    required: ["cities"],
  } as Anthropic.Tool.InputSchema,
};

const CHECK_HOLIDAYS_TOOL: Anthropic.Tool = {
  name: "check_holidays",
  description:
    "Ground the PUBLIC HOLIDAYS of the trip — the closures and domestic-travel surges best_time_to_go leaves out (it covers weather only). Pass your cities (each with its country) and the targetMonth (1-12) of the trip. Returns, per country, the nationwide statutory public holidays that fall in that month — each with its date, day of the week, and whether it forms a long weekend — from the free Nager.Date calendar. Use it to: WARN the traveler when a holiday closes museums, shops or banks on a day they'd visit them (and move that visit to an open day), note when a long weekend means heavier domestic travel and busier transport, and call out a holiday that's a genuine highlight worth being there for. It grounds CLOSURES and likely travel surges only — NOT measured tourist crowds, school-holiday timing or festivals. Some countries aren't covered, and Islamic holidays (Eid, Ramadan) are not in this source; the result flags both, so never imply a covered-but-empty country simply has no holidays. Call this only when the trip has a known month or dates (otherwise there's no window to check), once the cities are settled.",
  input_schema: {
    type: "object",
    properties: {
      cities: {
        type: "array",
        minItems: 1,
        description: "Your cities to check for public holidays. Include each city's country.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "City name." },
            country: {
              type: "string",
              description: "Country (required to look up its public holidays).",
            },
          },
          required: ["name"],
        },
      },
      targetMonth: {
        type: "integer",
        minimum: 1,
        maximum: 12,
        description:
          "The calendar month the trip is for (1=January … 12=December), inferred from the brief. Omit only if the trip has no dates — but then don't call this tool at all.",
      },
    },
    required: ["cities"],
  } as Anthropic.Tool.InputSchema,
};

// The first tool that needs an API KEY (Duffel). The loop only offers it when DUFFEL_API_KEY is
// set; without a key the app runs its keyless 6-tool self. origin is required — there's no sane
// default departure city — so when the brief gives none the prompt tells the model to skip flights
// rather than guess.
const FIND_FLIGHTS_TOOL: Anthropic.Tool = {
  name: "find_flights",
  description:
    "Price the FLIGHTS for the trip — the round-trip airfare that estimate_costs deliberately leaves out. Only useful when you know where the traveler DEPARTS FROM. Pass their origin (home city or IATA code), the first city they fly into (arriveCity + country), the last city they fly home from (departCity + country; omit for a single-base trip), the travel month as YYYY-MM, and the trip's total nights. Returns a recommended economy round-trip fare from a live flight-search API — usually the cheapest, but sometimes a fewer-stops fare within a small price band; the result's note says how it was chosen, so don't assume it's the cheapest. Some results are flagged as TEST DATA (synthetic prices from a test airline) — when so, treat the fare as illustrative only, never a real quote. Call once, after the cities and month are settled.",
  input_schema: {
    type: "object",
    properties: {
      origin: {
        type: "string",
        description:
          'The traveler\'s departure city or IATA code (e.g. "London" or "LON"). Required — infer it from the brief; if the brief names no home city, do NOT call this tool.',
      },
      arriveCity: {
        type: "string",
        description: "The first city of the trip — the one they fly into.",
      },
      arriveCountry: {
        type: "string",
        description: "Country of the arrival city (helps locate the airport).",
      },
      departCity: {
        type: "string",
        description:
          "The last city of the trip — the one they fly home from. Omit for a single-base trip (defaults to arriveCity).",
      },
      departCountry: { type: "string", description: "Country of the fly-home city." },
      month: {
        type: "string",
        description:
          'The travel month as YYYY-MM (e.g. "2026-09"). Use the actual future month of travel.',
      },
      nights: {
        type: "number",
        description: "Total nights of the trip, used to set the return date.",
      },
    },
    required: ["origin", "arriveCity"],
  } as Anthropic.Tool.InputSchema,
};

const EMIT_ITINERARY_TOOL: Anthropic.Tool = {
  name: "emit_itinerary",
  description:
    "Return the final, complete travel itinerary. Call this exactly once, after your named places have checked out.",
  input_schema: itineraryJsonSchema as Anthropic.Tool.InputSchema,
};

// The progress events we stream to the browser, one JSON object per line (NDJSON).
// The client switches on `type`. Phases mirror the agent loop: draft -> verify ->
// (route) -> (price) -> (timing) -> finalize. On routing/verifying/pricing/timing events,
// `done`/`total` drive the progress bar and `name` names the city being located.
type PlanEvent =
  | {
      type: "status";
      phase:
        | "drafting"
        | "verifying"
        | "regrounding"
        | "routing"
        | "pricing"
        | "timing"
        | "holidays"
        | "flights"
        | "finalizing";
      done?: number;
      total?: number;
      name?: string;
    }
  | { type: "progress"; done: number; total: number; name: string; found: boolean }
  | { type: "itinerary"; itinerary: VerifiedItinerary }
  | { type: "error"; message: string };

// Fold case and accents so "Pastéis de Belém" matches "pasteis de belem".
const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

// Tool inputs aren't strictly validated by the API, and the model occasionally returns an
// array-valued field as a JSON STRING ("[{...}]") rather than a real array — observed in the
// wild on verify_places. A bare Array.isArray check treats that as empty, which silently fails
// the plan (or burns the empty-verify retry). coerceArray passes a real array through and
// recovers a stringified one, so a quirk in the model's tool output doesn't sink the request.
function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* not JSON — fall through to [] */
    }
  }
  return [];
}

// The traveler's explicit departure city from the "Flying from?" field. It's the only user input
// that flows toward both the model's context AND an outbound API (Duffel), so we sanitize it
// server-side (the client maxLength is UX only): strip control characters — the prompt-injection
// vector, e.g. a stray newline that fakes a fresh instruction block — collapse whitespace, and
// hard-cap the length (a city/airport name never needs 120 chars). The cleaned value rides in the
// USER turn, never the system prompt, so this is defense-in-depth, not the sole boundary.
function sanitizeOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    // Strip C0/C1 control chars AND Unicode format chars (zero-width spaces, bidi overrides) — the
    // prompt-injection vector and the invisible-input vector both — then collapse whitespace and cap.
    .replace(/[\x00-\x1f\x7f-\x9f\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  // A real city/airport name carries at least one letter. Rejecting letter-less input stops an
  // invisible-only or punctuation-only origin from switching on the whole flights machinery (emit
  // withheld, ORIGIN_CLAUSE added, a Duffel search) with nothing real to actually search for.
  return /\p{L}/u.test(cleaned) ? cleaned : "";
}

// Attach our verification verdicts to the finished plan. The truth comes from what
// our tool actually found, not from anything the model claims about its own places.
//
// The model writes descriptive activity names ("Walk Alfama via Miradouro de Santa
// Luzia and the Sé"), so we can't match them to verified places by string equality.
// Instead we check containment: if a verified place name appears *inside* the
// activity name, that activity is grounded by it. A confirmed match wins over an
// unconfirmed one.
function annotateItinerary(
  itinerary: Itinerary,
  cache: Map<string, VerifyResult>,
  // The last estimate_costs result, if the agent ran one. We attach the budget the TOOL
  // computed — not anything the model wrote — so the displayed numbers are grounded, the same
  // way the verify verdict is ours. null when the agent didn't price the trip.
  costEstimate: CostEstimate | null,
  // The last best_time_to_go result, if the agent ran one. Same deal: the season labels the UI
  // shows are the tool's, not the model's. null when the agent didn't assess timing.
  season: SeasonSummary | null,
  // The last find_flights result, if the agent ran one. We attach only a successful Duffel search;
  // an "unavailable" result (no key/origin/offers) attaches nothing, leaving the keyless app shape.
  flights: FlightResult | null,
  // The last check_holidays result, if the agent ran one. recomputeHolidays filters it to the
  // countries of the cities that survived to emit (and drops it when none were covered) — the same
  // recompute-against-the-final-plan discipline the budget and season verdict follow.
  holidays: HolidaySummary | null,
  // The last check_route call's stored road-time matrix, if any. buildRouteSummary re-derives the
  // ordered legs from the FINAL emitted city order (so a displayed leg always matches the plan even
  // if the model reordered after the route check) and returns null when there's nothing worth showing
  // — the same recompute-against-the-final-plan discipline the budget and season verdict follow.
  routeEstimate: StoredRouteMatrix | null,
): VerifiedItinerary {
  const checked = [...cache.values()];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const verdict = (name: string): { verified?: VerifyStatus; matched?: string } => {
    const activity = norm(name);
    let unconfirmed = false;
    for (const place of checked) {
      const placeN = norm(place.name);
      if (!placeN) continue;
      // Ground the activity if the verified place name appears as a whole word/phrase in
      // it. Whole-word (not a bare substring) stops a short name like "Sé" (-> "se") from
      // falsely matching "Senso-ji". We don't filter by city: sub-areas (Mitaka, Kichijoji)
      // sit under a "Tokyo" entry and distinctive names rarely collide across cities.
      if (new RegExp(`\\b${esc(placeN)}\\b`).test(activity)) {
        if (place.found) return { verified: "confirmed", matched: place.matched };
        unconfirmed = true;
      }
    }
    return unconfirmed ? { verified: "unconfirmed" } : {};
  };
  // Index the tool's per-city cost by folded city name so we can hang it on the matching city.
  const costByCity = new Map<string, CityCost>();
  if (costEstimate) for (const c of costEstimate.cities) costByCity.set(norm(c.name), c);
  // Same for the per-city season summary.
  const seasonByCity = new Map<string, CitySeasonSummary>();
  if (season) for (const c of season.cities) seasonByCity.set(norm(c.name), c);

  // Build the cities, collecting the per-city costs/seasons that actually matched a city in the
  // FINAL plan. We recompute the headline budget (and target-month season verdict) from just
  // these, so what's shown always reflects the city set in the plan — even if the model changed
  // it between a grounding call and emit.
  const matched: CityCost[] = [];
  const matchedSeason: CitySeasonSummary[] = [];
  const cities = itinerary.cities.map((city) => {
    const cc = costByCity.get(norm(city.name));
    if (cc) matched.push(cc);
    const sc = seasonByCity.get(norm(city.name));
    if (sc) matchedSeason.push(sc);
    return {
      ...city,
      ...(cc
        ? { cost: { tier: cc.tier, dailyUsd: cc.dailyUsd, dailyHome: cc.dailyHome ?? null, anchors: cc.anchors } }
        : {}),
      ...(sc && sc.source === "open-meteo" ? { season: sc } : {}),
      days: city.days.map((day) => ({
        label: day.label,
        morning: { ...day.morning, ...verdict(day.morning.name) },
        afternoon: { ...day.afternoon, ...verdict(day.afternoon.name) },
        evening: { ...day.evening, ...verdict(day.evening.name) },
      })),
    };
  });

  // Attach a budget only if priced cities actually appear in the plan — this drops a vacuous
  // estimate (an empty/zero-city cost call) and ignores any city the model priced but then cut.
  let budget: BudgetSummary | undefined;
  if (costEstimate && matched.length > 0) {
    const priced = matched.filter((c) => c.subtotalUsd != null);
    const totalUsd =
      priced.length > 0 ? priced.reduce((sum, c) => sum + (c.subtotalUsd ?? 0), 0) : null;
    const totalNights = priced.reduce((sum, c) => sum + c.nights, 0);
    // Null the per-day headline when a shown city couldn't be priced — otherwise it reads as a
    // whole-trip daily rate while silently excluding the unpriced nights.
    const hasUnpriced = matched.some((c) => c.subtotalUsd == null);
    const perDayUsd =
      totalUsd != null && totalNights > 0 && !hasUnpriced
        ? Math.round(totalUsd / totalNights)
        : null;
    // Convert the recomputed headline figures with the SAME rate the FX pass used (carried on
    // costEstimate), so the home total reflects the FINAL city set — not a stale pre-emit total —
    // the same recompute-from-the-plan discipline the USD figures follow. Absent rate → native only.
    const rate = costEstimate.rate;
    const totalHome = rate != null && totalUsd != null ? Math.round(totalUsd * rate) : null;
    const perDayHome = rate != null && perDayUsd != null ? Math.round(perDayUsd * rate) : null;
    budget = {
      style: costEstimate.style,
      currency: costEstimate.currency,
      totalUsd,
      perDayUsd,
      homeCurrency: costEstimate.homeCurrency,
      totalHome,
      perDayHome,
      rate,
      rateDate: costEstimate.rateDate,
      note: costEstimate.note,
      flags: costEstimate.flags,
    };
  }

  // Attach the season only if a grounded city actually appears in the plan (drops a vacuous or
  // fully-cut assessment). Recompute the target-month verdict from the cities that survived, so
  // it can't name a city the model dropped after the assessment ran.
  let seasonOut: SeasonSummary | undefined;
  if (season && matchedSeason.some((c) => c.source === "open-meteo")) {
    seasonOut = {
      cities: matchedSeason,
      targetMonth: season.targetMonth,
      targetAssessment: season.targetMonth
        ? seasonTargetLine(matchedSeason, season.targetMonth)
        : null,
      // Recompute the note against the FINAL emitted cities (not the full assessed set), so a source
      // disclosure — elevation, feels-like heat, CAMS air quality — is credited only when that signal
      // actually survives to the plan, the same recompute-against-the-plan discipline targetAssessment
      // follows just above. (Fixes a stale disclosure when the model drops the only high/hot/polluted city.)
      note: buildSeasonNote(matchedSeason),
      caveat: season.caveat,
    };
  }

  // Attach flights only when a real Duffel search produced a priced result. An "unavailable"
  // result (no key, no origin, no offers) attaches nothing — the plan looks exactly like the
  // keyless app, which is the whole point of the graceful-degradation gate.
  const flightsOut: FlightSummary | undefined =
    flights && flights.source === "duffel" ? flights : undefined;

  // Recompute the holidays against the FINAL cities (drops countries the model cut after grounding,
  // and the whole block when no surviving country was actually covered) — the budget/season recompute.
  const holidaysOut = recomputeHolidays(holidays, cities) ?? undefined;

  // Recompute the route legs from the FINAL emitted city order (drops to null when there's no stored
  // matrix, fewer than two cities, or nothing worth flagging) — the same recompute discipline.
  const routeOut = buildRouteSummary(itinerary.cities.map((c) => c.name), routeEstimate) ?? undefined;

  return {
    ...itinerary,
    ...(budget ? { budget } : {}),
    ...(seasonOut ? { season: seasonOut } : {}),
    ...(flightsOut ? { flights: flightsOut } : {}),
    ...(holidaysOut ? { holidays: holidaysOut } : {}),
    ...(routeOut ? { route: routeOut } : {}),
    cities,
  };
}

export async function POST(req: Request) {
  // --- Pre-stream validation. These fail BEFORE we open the event stream, so they return
  // a normal JSON error with a non-200 status; the client reads res.ok and shows it. Once
  // the loop is streaming (status 200), any later failure arrives as an { type: "error" }
  // event instead.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests. Give it a minute." }, { status: 429 });
  }

  let brief = "";
  let origin = "";
  let clarifications: Array<{ prompt: string; answer: string }> = [];
  // A refine request carries the latest plan plus a single change to apply. We re-ground it
  // by running the SAME loop (forced verify → optional check_route → forced emit), so the
  // revision is re-verified and, if its cities changed, re-routed — no second loop needed.
  let refine: { itinerary: Itinerary; instruction: string } | null = null;
  try {
    // Read the body as text first so an oversized payload is rejected before it's buffered
    // and parsed in full — req.json() would do both before any size check could run.
    const raw = await req.text();
    if (raw.length > MAX_BODY_CHARS) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
    const body = JSON.parse(raw);
    brief = typeof body?.brief === "string" ? body.brief.trim() : "";
    // The explicit departure city (from the "Flying from?" field). Sanitized now so it's clean
    // wherever it's used; only acted on when flights are enabled (the keyed-tool gate, below).
    origin = sanitizeOrigin(body?.origin);
    if (Array.isArray(body?.clarifications)) {
      clarifications = (body.clarifications as unknown[])
        .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : null))
        .map((c) => ({
          prompt: typeof c?.prompt === "string" ? c.prompt.trim() : "",
          answer: typeof c?.answer === "string" ? c.answer.trim() : "",
        }))
        .filter((c) => c.prompt.length > 0 && c.answer.length > 0);
    }
    // Strip the server's verified/matched annotations off the incoming plan by re-parsing it
    // through the Zod schema — unknown keys are dropped, leaving a clean Itinerary to embed.
    // If the instruction is empty/oversized or the plan doesn't parse, we ignore the refine
    // and fall back to planning fresh from the brief.
    if (body?.refine && typeof body.refine === "object") {
      const r = body.refine as Record<string, unknown>;
      // Sanitize like the origin field: this instruction can be built client-side from a plan
      // activity name (the "find alternative" swap), and a refine's prior plan is user-supplied, so
      // strip control + Unicode-format chars (a newline could fake an instruction boundary in the
      // user turn) and collapse whitespace before it rides into the user turn.
      const instruction =
        typeof r.instruction === "string"
          ? r.instruction.replace(/[\x00-\x1f\x7f-\x9f\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()
          : "";
      const parsed = itinerarySchema.safeParse(r.itinerary);
      if (
        instruction.length > 0 &&
        instruction.length <= MAX_BRIEF_CHARS &&
        parsed.success &&
        JSON.stringify(parsed.data).length <= MAX_REFINE_ITINERARY_CHARS
      ) {
        refine = { itinerary: parsed.data, instruction };
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!brief) {
    return NextResponse.json({ error: "Tell me about your trip first." }, { status: 400 });
  }
  if (brief.length > MAX_BRIEF_CHARS) {
    return NextResponse.json(
      { error: `Brief is too long (max ${MAX_BRIEF_CHARS} characters).` },
      { status: 400 },
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    return NextResponse.json(
      { error: "Server configuration error. The site owner needs to set an API key." },
      { status: 500 },
    );
  }

  // The keyed-tool gate. find_flights is the ONLY tool that needs an API key (Duffel). When it's
  // absent we drop the flights clause from the system prompt AND never offer the tool, so the app
  // degrades cleanly to its keyless five-tool self — no errors, no dead UI, nothing for the model
  // to attempt. Present a key (a free Duffel test token) and the capability simply appears.
  const duffelKey = process.env.DUFFEL_API_KEY;
  const flightsEnabled = !!duffelKey;

  // The traveler's home/display currency (a user setting, default AUD). It drives a pure server-
  // side FX pass that converts the USD budget and the Duffel fare into this currency at a live ECB
  // rate — no extra model turn, since an exchange rate is a fact, not a decision. The clause is only
  // added when home isn't USD; when it is, there's nothing to convert and the prompt is unchanged.
  const HOME = homeCurrency();
  // The traveler's explicit departure city, acted on only when flights are actually enabled. The
  // clause added here is generic, server-controlled text (see ORIGIN_CLAUSE); the value itself rides
  // in the user turn (appended to the brief below), keeping raw user input out of the high-trust
  // system prompt. hasOrigin also makes flights a REQUIRED step in the loop: emit is withheld until
  // find_flights has run, so an explicit origin reliably lights up the fare instead of depending on
  // the model choosing to price it.
  const hasOrigin = flightsEnabled && origin.length > 0;
  const systemPrompt =
    SYSTEM_PROMPT +
    (flightsEnabled ? FLIGHTS_CLAUSE : "") +
    (hasOrigin ? ORIGIN_CLAUSE : "") +
    (HOME !== "USD" ? currencyClause(HOME) : "");

  const client = new Anthropic();
  const encoder = new TextEncoder();

  // The agent loop runs inside the stream so every phase boundary can flush an event.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: PlanEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          open = false; // client went away mid-write; stop trying to push.
        }
      };
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // The loop's memory: a messages array we grow across model calls within this one
      // request. Turn 1 the model verifies places (we run the tool, feed results back);
      // a multi-city trip then gets a turn to check the route; the last turn we force it
      // to emit the final itinerary.
      // Append the explicit origin to the brief as a labeled line in the USER turn (not the system
      // prompt). The model reads it for prose and to pick its first/last cities; the find_flights
      // handler overrides the tool's origin arg with this same server-held value, so the actual
      // search is grounded in it regardless of what the model echoes.
      const briefForModel = hasOrigin ? `${brief}\n\nFlying from: ${origin}` : brief;
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: briefForModel }];
      if (clarifications.length > 0) {
        // Replay the clarifying exchange as real prior turns so the planner conditions on
        // it. This is the multi-turn state (Approach C): the agent "remembers" what it
        // asked and what the traveler answered, then plans against those answers.
        messages.push(
          {
            role: "assistant",
            content:
              "Before I plan, a couple of quick things:\n" +
              clarifications.map((c) => `- ${c.prompt}`).join("\n"),
          },
          {
            role: "user",
            content: clarifications.map((c) => `${c.prompt}\n${c.answer}`).join("\n\n"),
          },
        );
      }
      if (refine) {
        // Cross-request state (the concierge step): seed the prior plan as a real assistant
        // turn and the requested change as the next user turn, then let the loop below
        // re-ground it from scratch. Because turn 0 still forces verify_places and the route
        // turn is re-gated on the revised plan's distinct cities, a refine that changes
        // cities re-detects multiCity and re-checks the route automatically. The client
        // sends the LATEST plan (prior refines already baked in), so we don't replay history.
        // The prior plan is user-supplied (client-sent) and seeded verbatim into a high-trust
        // assistant turn, so strip Unicode-format chars (zero-width/bidi) from its serialized form —
        // schema validation keeps string CONTENT, and these can fake structure in the model's context.
        // Same trust-boundary discipline as the sanitized origin and refine instruction.
        const priorPlanJson = JSON.stringify(refine.itinerary).replace(/\p{Cf}/gu, "");
        messages.push(
          {
            role: "assistant",
            content: `Here's the itinerary I built:\n${priorPlanJson}`,
          },
          { role: "user", content: refine.instruction },
        );
      }
      const verifyCache = new Map<string, VerifyResult>();
      let verifiedOnce = false; // have we run a real place-verification round yet?
      let routedOnce = false; // has the model used its one check_route round?
      let costedOnce = false; // has the model used its one estimate_costs round?
      let seasonedOnce = false; // has the model used its one best_time_to_go round?
      let holidayedOnce = false; // has the model used its one check_holidays round?
      let flightedOnce = false; // has the model used its one find_flights round?
      // The bounded auto-repair round (parallel to flightedOnce): when round 1's verify turns up
      // places that don't exist, the loop withholds emit and FORCES one more verify so the model can
      // replace and re-check them. Capped at one round by repairedOnce — which the verify handler
      // ALWAYS sets on the repair turn (like flightedOnce), so the withhold can't deadlock or spin.
      let repairedOnce = false;
      // Genuine not-found place names from round 1 (excludes lookup errors, and only when below the
      // suppress threshold). A non-empty set is what arms the owesReverify repair branch.
      const unconfirmedNames = new Set<string>();
      // The grounded budget from the last estimate_costs call, attached to the final plan.
      let costEstimate: CostEstimate | null = null;
      // The grounded seasonality from the last best_time_to_go call, attached to the final plan.
      let seasonEstimate: SeasonSummary | null = null;
      // The grounded public holidays from the last check_holidays call, attached to the final plan.
      let holidayEstimate: HolidaySummary | null = null;
      // The grounded flights from the last find_flights call (attached only when it's a successful
      // Duffel search; an "unavailable" result attaches nothing but still informs the model).
      let flightEstimate: FlightResult | null = null;
      // The grounded route (road-time matrix) from the last check_route call. The full matrix is kept
      // server-side and recomputed against the FINAL emitted city order at annotate time; never sent
      // to the model (it only ever sees the lean RouteModelView).
      let routeEstimate: StoredRouteMatrix | null = null;
      // Does the plan span 2+ cities? Gates the check_route turn. Seed it from the prior
      // plan on a refine so a multi-city refine still gets a route check even if the model's
      // verify batch happens to under-represent the cities; the post-verify recompute below
      // can only raise this floor, never lower it.
      let multiCity = refine !== null && refine.itinerary.cities.length >= 2;
      let emptyVerifyCount = 0; // verify_places calls that arrived with nothing checkable

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          if (req.signal.aborted) return; // client navigated away — stop burning tokens.

          // Decide what the model may do this turn. verify_places stays structurally
          // forced first — a plan can't be emitted ungrounded. Once places are verified,
          // a multi-city trip gets ONE optional check_route turn (the model chooses
          // route-or-emit), then emit is forced. Single-city trips skip straight to a
          // forced emit: there's no route to check.
          let phase:
            | "drafting"
            | "regrounding"
            | "routing"
            | "pricing"
            | "timing"
            | "holidays"
            | "flights"
            | "finalizing";
          let toolsForTurn: Anthropic.Tool[];
          let toolChoice: Anthropic.ToolChoice;
          if (!verifiedOnce) {
            phase = "drafting";
            toolsForTurn = [VERIFY_PLACES_TOOL];
            // disable_parallel_tool_use forces exactly ONE verify_places call, so every place
            // lands in a single batch. Without it the model can split a big plan into parallel
            // verify calls; the loop handles one tool_use per turn, so the extra calls would be
            // left without a tool_result and the API rejects the next turn. (Refines verify
            // more places, which is what surfaced this.)
            toolChoice = { type: "tool", name: "verify_places", disable_parallel_tool_use: true };
          } else if (!repairedOnce && unconfirmedNames.size > 0) {
            // Bounded auto-repair round. Round 1 turned up places that don't exist in the free geo
            // database, so WITHHOLD emit and force one more verify_places call for the model's
            // replacements. This is a DEDICATED branch, not an entry in the optional set below: that
            // block force-emits the moment its list empties, which would let the model skip the
            // repair entirely (the same structural-escape class the flights gate had to avoid). Capped
            // at one round by repairedOnce (the handler always sets it), so it can't spin or deadlock,
            // and it runs BEFORE route/cost/timing/flights so those ground the repaired plan. Same
            // forced single-tool choice as the turn-1 verify.
            phase = "regrounding";
            toolsForTurn = [VERIFY_PLACES_TOOL];
            toolChoice = { type: "tool", name: "verify_places", disable_parallel_tool_use: true };
          } else {
            // Places are grounded. Offer the OPTIONAL grounding tools the agent hasn't spent
            // yet — check_route (multi-city only), estimate_costs, best_time_to_go and (only when a
            // Duffel key is set) find_flights — alongside emit, and let the model choose (the
            // prompt steers when each earns its turn). Each is gated to a single use, so the loop
            // can't spin: at most one route + one cost + one timing + one flights turn before emit.
            // disable_parallel_tool_use keeps it to exactly one tool_use per response, the same
            // invariant every other turn relies on. When no optional tool is left, force the final
            // emit. (verify_places stays the sole forced tool on turn 0, so place grounding is
            // still structural — route/cost/timing/flights are the agent's call.)
            const optional: Anthropic.Tool[] = [];
            if (multiCity && !routedOnce) optional.push(CHECK_ROUTE_TOOL);
            // Offer cost, timing and flights only once the route is settled (or there's no route
            // to settle), so they're computed against the FINAL city set — no check_route can
            // still reorder or drop. Enforces the prompt's "ground once the cities are settled"
            // at the loop level instead of trusting the model to sequence it. find_flights is also
            // gated on a Duffel key being configured — the keyed-tool gate; no key, never offered.
            if (!costedOnce && (!multiCity || routedOnce)) optional.push(ESTIMATE_COSTS_TOOL);
            if (!seasonedOnce && (!multiCity || routedOnce)) optional.push(BEST_TIME_TOOL);
            // check_holidays grounds public-holiday closures once the cities are settled (like cost
            // and timing). It's keyless, so it's offered in the no-Duffel app too. The model calls it
            // only for a trip with a known month — the prompt steers that; a dateless trip just won't
            // trigger it. Gated to one use via holidayedOnce, like every other optional tool.
            if (!holidayedOnce && (!multiCity || routedOnce)) optional.push(CHECK_HOLIDAYS_TOOL);
            // find_flights goes last — only AFTER best_time_to_go has run (seasonedOnce), so the
            // fare is priced for the FINAL travel month, never one a later timing call would revise.
            // A trip worth pricing flights for names a month or dates, which the prompt routes
            // through best_time_to_go first, so flights still gets its turn; a dateless trip (where a
            // fare is barely meaningful) just won't trigger it. seasonedOnce also implies the route
            // was settled, so this inherits the cities-settled guarantee too.
            // Also gated on holidayedOnce: on an origin trip (emit withheld until flights run), this
            // forces check_holidays to ground the closures BEFORE flights are priced, so the
            // documented route -> timing -> holidays -> flights order holds at the loop level instead
            // of being left to the model. holidayedOnce is always set by its handler, so no deadlock.
            if (flightsEnabled && !flightedOnce && seasonedOnce && holidayedOnce)
              optional.push(FIND_FLIGHTS_TOOL);
            if (optional.length > 0) {
              // Pre-decision label: name the work most likely to run next so the UI shows a
              // sensible phase before the model picks. Routing comes first on a multi-city trip;
              // otherwise cost, then timing, then flights. The precise per-tool status fires when
              // the chosen tool actually runs (or finalizing if it emits instead).
              phase =
                multiCity && !routedOnce
                  ? "routing"
                  : !costedOnce
                    ? "pricing"
                    : !seasonedOnce
                      ? "timing"
                      : !holidayedOnce
                        ? "holidays"
                        : "flights";
              // When the traveler named an explicit departure city, pricing their flights is a
              // REQUIRED step (like verify_places), so withhold emit until find_flights has run —
              // the model can't finish without it. The gates above still enforce ORDER (route ->
              // timing -> holidays -> flights), so this only removes the early exit: a grounding tool is always
              // offered until flightedOnce, and find_flights' handler always sets flightedOnce (even
              // on an "unavailable" result), after which emit returns. No reorder, no deadlock.
              const owesFlights = flightsEnabled && hasOrigin && !flightedOnce;
              toolsForTurn = owesFlights ? [...optional] : [...optional, EMIT_ITINERARY_TOOL];
              toolChoice = { type: "any", disable_parallel_tool_use: true };
            } else {
              phase = "finalizing";
              toolsForTurn = [EMIT_ITINERARY_TOOL];
              // Same single-tool-per-turn invariant: force exactly one emit_itinerary.
              toolChoice = { type: "tool", name: "emit_itinerary", disable_parallel_tool_use: true };
            }
          }
          send({ type: "status", phase });

          // Stream the model call (not a blocking create): on the large emit turn this
          // avoids the SDK's HTTP timeout and lets max_tokens go high for long trips.
          // We don't forward partial tokens — finalMessage() gives us the complete turn,
          // and the user-facing progress comes from the phase/verify events instead.
          // Heartbeat: re-emit the current phase every few seconds while the (silent)
          // model call runs, so the stream stays visibly alive and the client's idle
          // timer can't trip during a long turn. The drafting turn only emits a small
          // verify call, so 16k is plenty; every other turn might emit the full itinerary,
          // so give it the full budget.
          const heartbeat = setInterval(() => send({ type: "status", phase }), 8000);
          let message: Anthropic.Message;
          try {
            message = await client.messages
              .stream(
                {
                  model: MODEL,
                  max_tokens: phase === "drafting" ? 16000 : 64000,
                  system: systemPrompt,
                  tools: toolsForTurn,
                  tool_choice: toolChoice,
                  messages,
                },
                { signal: req.signal },
              )
              .finalMessage();
          } finally {
            clearInterval(heartbeat);
          }

          if (message.stop_reason === "max_tokens") {
            send({
              type: "error",
              message:
                "That trip is too long to plan in one pass for now. Try a shorter trip or a single city.",
            });
            return;
          }

          const toolUse = message.content.find(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
          );
          if (!toolUse) {
            send({
              type: "error",
              message: "The planner didn't return an itinerary. Try rephrasing your brief.",
            });
            return;
          }

          // Record the assistant's turn (its tool request) before acting on it. Skipping
          // this breaks the conversation — the next call would carry a tool result with no
          // matching tool_use, and the API rejects it.
          messages.push({ role: "assistant", content: message.content });

          if (toolUse.name === "emit_itinerary") {
            const parsed = itinerarySchema.safeParse(toolUse.input);
            if (!parsed.success) {
              send({
                type: "error",
                message: "The planner returned an itinerary in an unexpected shape. Try again.",
              });
              return;
            }
            // Trust the server's arithmetic over the model's: derive the headline night
            // count from the per-city nights so the summary can't contradict the cities.
            const itinerary: Itinerary = {
              ...parsed.data,
              totalNights: parsed.data.cities.reduce((sum, c) => sum + c.nights, 0),
            };
            // If the model emitted straight off an optional turn (pricing/routing/timing was the
            // last label), transition cleanly to finalizing before the plan paints.
            send({ type: "status", phase: "finalizing" });
            send({
              type: "itinerary",
              itinerary: annotateItinerary(
                itinerary,
                verifyCache,
                costEstimate,
                seasonEstimate,
                flightEstimate,
                holidayEstimate,
                routeEstimate,
              ),
            });
            return;
          }

          if (toolUse.name === "verify_places") {
            const input = toolUse.input as { places?: unknown };
            // coerceArray passes a real array through and recovers a stringified one (the model
            // sometimes returns `places` as a JSON string, especially in the larger refine
            // context) — so a malformed-but-recoverable input doesn't fail the plan or burn the
            // empty-verify retry. A truly empty/unrecoverable input still falls through below.
            const rawPlaces = coerceArray(input.places) as Array<{ name?: unknown; city?: unknown }>;
            const places = rawPlaces
              .filter(
                (p): p is { name: string; city?: unknown } =>
                  !!p && typeof p.name === "string" && p.name.trim().length > 0,
              )
              .map((p) => ({
                name: p.name,
                city: typeof p.city === "string" ? p.city : undefined,
              }));

            // Round 1 is the forced turn-1 verify; the repair round is the second forced verify the
            // owesReverify branch triggers. verify_places is only ever offered on those two turns, so
            // this split is exhaustive.
            const isRepairRound = verifiedOnce && !repairedOnce;

            if (places.length === 0) {
              if (isRepairRound) {
                // Empty repair batch = the model decided no replacements were needed. Consume the
                // repair round (set repairedOnce so the withhold resolves — the same always-set
                // discipline find_flights uses) and emit. Never touch emptyVerifyCount: that single
                // retry belongs to round 1, not here.
                repairedOnce = true;
                messages.push({
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: toolUse.id,
                      content:
                        "No replacement places submitted — verification complete. Continue with the plan as usual.",
                    },
                  ],
                });
                continue;
              }
              // The model called verify with nothing checkable. Don't count this as the
              // verification round (leave verifiedOnce false). Give it one retry via the
              // forced tool_choice; if it whiffs again, fail clearly rather than silently
              // burning the turn budget toward "couldn't settle on a plan".
              if (++emptyVerifyCount > EMPTY_VERIFY_RETRIES) {
                send({
                  type: "error",
                  message:
                    "The planner couldn't pin down checkable places. Try rephrasing your brief with a few specific spots.",
                });
                return;
              }
              messages.push({
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content:
                      "No checkable places were provided. Call verify_places again with the specific named places from your draft, each with its city.",
                  },
                ],
              });
              continue;
            }

            // Repair-round progress paints under its own "regrounding" phase so the bar doesn't
            // reset and read as a stutter when a second pass runs after round 1 already hit 100%.
            const verifyPhase = isRepairRound ? "regrounding" : "verifying";
            send({ type: "status", phase: verifyPhase, done: 0, total: places.length });
            const results = await verifyPlaces(places, verifyCache, (done, total, last) =>
              isRepairRound
                ? send({ type: "status", phase: "regrounding", done, total, name: last.name })
                : send({ type: "progress", done, total, name: last.name, found: last.found }),
            );

            if (isRepairRound) {
              // The one repair round has run. Set repairedOnce UNCONDITIONALLY (like flightedOnce):
              // some genuinely real places are simply absent from OSM/Wikipedia, so forcing more
              // repair would spin and fight decisiveness. annotateItinerary reads the whole cache, so
              // the replacements (now verified) get a real badge instead of the old no-badge silence.
              repairedOnce = true;
              // A replacement could (rarely) introduce a new city; fold it into multiCity so a trip
              // that just became multi-city still gets its check_route turn. The swap prompt pins
              // replacements to the same city, so this is a structural backstop, not the common path.
              const repairCities = new Set(
                places.map((p) => (p.city ?? "").trim().toLowerCase()).filter(Boolean),
              );
              multiCity = multiCity || repairCities.size >= 2;
              messages.push({
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(results) },
                ],
              });
              continue;
            }

            // Round 1. Arm a repair round only for GENUINE misses (a checkFailed result is a lookup
            // error, not evidence the place is fake) AND only when they are a small enough slice of
            // the plan to be worth replacing — a mostly-missing batch means a broken draft or a geo
            // outage, where re-inventing everything just churns; we emit with honest badges instead.
            const genuineMisses = results.filter((r) => !r.found && !r.checkFailed);
            const checkFailedNames = results.filter((r) => r.checkFailed).map((r) => r.name);
            if (
              genuineMisses.length > 0 &&
              genuineMisses.length / results.length < REPAIR_SUPPRESS_THRESHOLD
            ) {
              for (const m of genuineMisses) unconfirmedNames.add(m.name);
            }
            // Feed back the raw results plus, when a repair round is armed, an explicit list of what
            // failed and how to act. This matches system-prompt step 3 (the repair round is FOR
            // replacements, not mandatory): keep a place you're sure is real, replace the ones you
            // doubt — fresh plans and refines use the same wording, so the loop and prompt agree.
            // Place names come from the model's tool input (shaped by the user's brief), so strip
            // control + format chars and quote each — symmetry with the refine.instruction
            // sanitization, and quoting stops a comma inside a name from reading as a list separator.
            const cleanName = (s: string) =>
              s.replace(/[\x00-\x1f\x7f-\x9f\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
            const quoteNames = (names: string[]) => names.map((n) => `"${cleanName(n)}"`).join(", ");
            let verifyResultContent = JSON.stringify(results);
            if (unconfirmedNames.size > 0) {
              verifyResultContent += ` These places were not found in the geo database: ${quoteNames([...unconfirmedNames])}. You get ONE more verify_places call. If you are confident a place is real (famous or well-known, just absent from the free database), keep it; otherwise replace it with a confident real alternative — then call verify_places again with your replacement names (confirmed places stay as they are).`;
              if (checkFailedNames.length > 0) {
                verifyResultContent += ` (${quoteNames(checkFailedNames)} had a temporary lookup error — not evidence they are fake, so you may keep them.)`;
              }
            }
            messages.push({
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: toolUse.id, content: verifyResultContent },
              ],
            });
            verifiedOnce = true;
            // A trip spans multiple cities if the verified places carry 2+ distinct cities.
            // This decides whether the next turn even offers check_route — single-city trips
            // skip it (no route to check) and go straight to a forced emit, staying snappy.
            const distinctCities = new Set(
              places.map((p) => (p.city ?? "").trim().toLowerCase()).filter(Boolean),
            );
            multiCity = multiCity || distinctCities.size >= 2;
            continue; // back to the top — next turn the model checks the route or emits
          }

          if (toolUse.name === "check_route") {
            const input = toolUse.input as { cities?: unknown };
            // Same coercion as verify_places: pass an array through, recover a stringified one.
            // An empty result just means checkRoute has nothing to check and we move to emit.
            const rawCities = coerceArray(input.cities) as Array<{ name?: unknown; country?: unknown }>;
            const cities = rawCities
              .filter(
                (c): c is { name: string; country?: unknown } =>
                  !!c && typeof c.name === "string" && c.name.trim().length > 0,
              )
              .map((c) => ({
                name: c.name.trim(),
                country: typeof c.country === "string" ? c.country.trim() : undefined,
              }));

            send({ type: "status", phase: "routing", done: 0, total: cities.length });
            const { model: routeModel, stored: routeStored } = await checkRoute(
              cities,
              (done, total, name) => send({ type: "status", phase: "routing", done, total, name }),
              req.signal,
            );
            // Keep the full matrix server-side for the annotate-time recompute; the model only sees
            // the lean view (ordered legs + flags + suggestion + note), like seasonModelView.
            routeEstimate = routeStored;
            messages.push({
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(routeModel) },
              ],
            });
            routedOnce = true;
            continue; // back to the top — next turn the model prices or emits
          }

          if (toolUse.name === "estimate_costs") {
            const input = toolUse.input as { style?: unknown; cities?: unknown };
            const style = parseStyle(input.style);
            // Same coercion as the other tools: pass an array through, recover a stringified one.
            const rawCities = coerceArray(input.cities) as Array<{
              name?: unknown;
              country?: unknown;
              nights?: unknown;
            }>;
            const cities = rawCities
              .filter(
                (c): c is { name: string; country?: unknown; nights?: unknown } =>
                  !!c && typeof c.name === "string" && c.name.trim().length > 0,
              )
              .map((c) => ({
                name: c.name.trim(),
                country: typeof c.country === "string" ? c.country.trim() : undefined,
                nights:
                  typeof c.nights === "number" && Number.isFinite(c.nights) ? c.nights : 1,
              }));

            if (cities.length === 0) {
              // Nothing priceable. Consume the option (so we don't re-offer and risk a loop) and
              // move on WITHOUT a budget rather than attach a vacuous "grounded" one.
              messages.push({
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content:
                      "No valid cities were provided to price. Emit the plan without a budget.",
                  },
                ],
              });
              costedOnce = true;
              continue;
            }

            send({ type: "status", phase: "pricing", done: 0, total: cities.length });
            const estimate = await estimateCosts(
              cities,
              style,
              (done, total, name) => send({ type: "status", phase: "pricing", done, total, name }),
              req.signal,
            );
            // Server-side FX pass: convert the (USD) estimate into the traveler's home currency at a
            // live ECB rate and rewrite the "$"-baked flags, then use the CONVERTED estimate for both
            // the model's tool_result (a single-currency costModelView, so its prose cites home
            // figures and never sees a stray USD number to echo) and the attached budget. A null rate
            // or home===USD leaves it untouched — graceful degradation to native USD.
            // Keep the stream alive across the (bounded) FX fetch, which fires after the per-city
            // pricing progress has stopped.
            send({ type: "status", phase: "pricing", done: cities.length, total: cities.length, name: "converting to " + HOME });
            const costFx = await getRate("USD", HOME, req.signal);
            costEstimate = applyFxToCost(estimate, HOME, costFx); // attached as the grounded budget
            // If conversion was EXPECTED (home isn't USD) but didn't land, tell the model plainly so
            // it cites USD rather than trusting the prompt's "you'll see <home>" promise (which the UI
            // also falls back from). When home is USD there's nothing to convert — no note.
            const costFxNote =
              HOME !== "USD" && costEstimate.homeCurrency == null
                ? ` NOTE: live conversion to ${HOME} was unavailable — the figures above are in USD; present them as US dollars.`
                : "";
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: JSON.stringify(costModelView(costEstimate)) + costFxNote,
                },
              ],
            });
            costedOnce = true;
            continue; // back to the top — next turn the model assesses timing or emits
          }

          if (toolUse.name === "best_time_to_go") {
            const input = toolUse.input as { cities?: unknown; targetMonth?: unknown };
            const targetMonth = parseTargetMonth(input.targetMonth);
            // Same coercion as the other tools: pass an array through, recover a stringified one.
            const rawCities = coerceArray(input.cities) as Array<{ name?: unknown; country?: unknown }>;
            const cities = rawCities
              .filter(
                (c): c is { name: string; country?: unknown } =>
                  !!c && typeof c.name === "string" && c.name.trim().length > 0,
              )
              .map((c) => ({
                name: c.name.trim(),
                country: typeof c.country === "string" ? c.country.trim() : undefined,
              }));

            if (cities.length === 0) {
              // Nothing to assess. Consume the option (so we don't re-offer and risk a loop) and
              // move on WITHOUT season grounding rather than attach a vacuous one.
              messages.push({
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content:
                      "No valid cities were provided. Emit the plan without season grounding.",
                  },
                ],
              });
              seasonedOnce = true;
              continue;
            }

            send({ type: "status", phase: "timing", done: 0, total: cities.length });
            const season = await assessSeason(
              cities,
              targetMonth,
              (done, total, name) => send({ type: "status", phase: "timing", done, total, name }),
              req.signal,
            );
            seasonEstimate = season; // attached to the final plan as the grounded seasonality
            // Send the model a trimmed view (the full 12-month × N-city payload is token-heavy).
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: JSON.stringify(seasonModelView(season)),
                },
              ],
            });
            seasonedOnce = true;
            continue; // back to the top — next turn the model prices/emits
          }

          if (toolUse.name === "check_holidays") {
            const input = toolUse.input as { cities?: unknown; targetMonth?: unknown };
            const targetMonth = parseTargetMonth(input.targetMonth);
            // Same coercion as the other tools: pass an array through, recover a stringified one.
            const rawCities = coerceArray(input.cities) as Array<{ name?: unknown; country?: unknown }>;
            const cities = rawCities
              .filter(
                (c): c is { name: string; country?: unknown } =>
                  !!c && typeof c.name === "string" && c.name.trim().length > 0,
              )
              .map((c) => ({
                name: c.name.trim(),
                country: typeof c.country === "string" ? c.country.trim() : undefined,
              }));

            // No checkable cities, or no travel month to anchor a year/window: consume the option
            // (set holidayedOnce so the optional set still drains — the same always-set discipline
            // every other *Once flag uses; skipping it could deadlock the owesFlights withhold) and
            // move on WITHOUT holiday grounding rather than attach a vacuous one.
            if (cities.length === 0 || targetMonth === null) {
              messages.push({
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content:
                      targetMonth === null
                        ? "No travel month was given, so public holidays can't be checked. Emit the plan without holiday grounding."
                        : "No valid cities were provided to check. Emit the plan without holiday grounding.",
                  },
                ],
              });
              holidayedOnce = true;
              continue;
            }

            send({ type: "status", phase: "holidays" });
            const holidays = await assessHolidays(
              cities,
              targetMonth,
              new Date(),
              (done, total, name) => send({ type: "status", phase: "holidays", done, total, name }),
              req.signal,
            );
            holidayEstimate = holidays; // attached to the final plan as the grounded holidays
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: JSON.stringify(holidayModelView(holidays)),
                },
              ],
            });
            holidayedOnce = true;
            continue; // back to the top — next turn the model prices flights or emits
          }

          if (toolUse.name === "find_flights") {
            const input = toolUse.input as {
              origin?: unknown;
              arriveCity?: unknown;
              arriveCountry?: unknown;
              departCity?: unknown;
              departCountry?: unknown;
              month?: unknown;
              nights?: unknown;
            };
            const str = (v: unknown) =>
              typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
            // Server-authoritative origin: when the traveler gave an explicit departure city, that
            // sanitized value wins over whatever the model echoed in the tool call (never trust the
            // model to faithfully reproduce user input). Falls back to the model's origin otherwise.
            const modelOrigin = str(input.origin);
            if (hasOrigin && modelOrigin && modelOrigin.toLowerCase() !== origin.toLowerCase()) {
              console.warn(
                `find_flights origin override: model sent "${modelOrigin}", using "${origin}".`,
              );
            }
            const flightInput = {
              origin: (hasOrigin ? origin : modelOrigin) ?? "",
              arriveCity: str(input.arriveCity) ?? "",
              arriveCountry: str(input.arriveCountry),
              departCity: str(input.departCity),
              departCountry: str(input.departCountry),
              month: str(input.month) ?? null,
              nights:
                typeof input.nights === "number" && Number.isFinite(input.nights)
                  ? input.nights
                  : undefined,
            };

            send({ type: "status", phase: "flights" });
            // Unlike the other tools (which stream per-city progress every ~1s), the Duffel
            // offer-request POST is one synchronous call that can hold for ~20s+ with no
            // intermediate event. Heartbeat the phase so the client's idle-abort timer can't trip
            // during that silent window.
            const flightHeartbeat = setInterval(
              () => send({ type: "status", phase: "flights" }),
              8000,
            );
            let result: FlightResult;
            try {
              result = await findFlights(
                flightInput,
                duffelKey,
                (label) => send({ type: "status", phase: "flights", name: label }),
                req.signal,
              );
            } finally {
              clearInterval(flightHeartbeat);
            }
            // Same server-side FX pass as the budget: convert the Duffel fare (quoted in its own
            // currency — a sandbox fare can come back as "A$126") into the home currency at a live
            // ECB rate, so the FlightsBlock and the model's prose both speak the traveler's currency.
            // No-op when Duffel already quoted in the home currency or the rate fetch fails. The
            // status keeps the stream alive across the bounded FX fetch (the Duffel heartbeat is gone).
            if (result.source === "duffel" && result.currency) {
              send({ type: "status", phase: "flights", name: "converting to " + HOME });
              const flightFx = await getRate(result.currency, HOME, req.signal);
              result = applyFxToFlights(result, HOME, flightFx);
              // Convert the smart-selection cheapest figure with the SAME rate the fare used (the
              // cheapest offer shares the fare's currency). This keeps the UI's "X over the cheapest"
              // comparison in one currency. Only when an upgrade was made and the fare actually
              // converted; otherwise the UI falls back to the native cheapest figure (home === native).
              if (
                result.selection &&
                result.rate != null &&
                result.selection.cheapestAmount != null &&
                result.selection.cheapestCurrency != null &&
                result.selection.cheapestCurrency !== HOME
              ) {
                result = {
                  ...result,
                  selection: {
                    ...result.selection,
                    cheapestHomeAmount: Math.round(result.selection.cheapestAmount * result.rate),
                    homeCurrency: HOME,
                  },
                };
              }
            }
            // Penalty-condition FX pass. The refund/change penalties the enrich pass attached can be
            // quoted in a DIFFERENT currency than the fare (some carriers price them in USD/EUR
            // regardless), so the fare conversion above never touched them. Convert each distinct
            // penalty currency that isn't already HOME; getRate caches per day, so when it matches
            // the fare currency it's a cache hit. A failed fetch just leaves the home figure null and
            // the UI shows the native penalty — the same graceful degradation as every money figure.
            if (result.source === "duffel" && result.conditions) {
              const updated = { ...result.conditions };
              const penaltyCurrencies = new Set(
                [updated.refundPenaltyCurrency, updated.changePenaltyCurrency].filter(
                  (c): c is string => !!c && c !== HOME,
                ),
              );
              if (penaltyCurrencies.size > 0) {
                for (const cur of penaltyCurrencies) {
                  // Heartbeat inside the loop: a second penalty currency means a second ~4s getRate,
                  // and the flight heartbeat is already cleared — keep an event flowing each iteration.
                  send({ type: "status", phase: "flights", name: "converting to " + HOME });
                  const penaltyFx = await getRate(cur, HOME, req.signal);
                  if (!penaltyFx) continue;
                  updated.penaltyHomeCurrency = HOME;
                  const conv = (amt: number | null) =>
                    amt == null ? null : Math.round(amt * penaltyFx.rate);
                  if (updated.refundPenaltyCurrency === cur)
                    updated.refundPenaltyHome = conv(updated.refundPenaltyAmount);
                  if (updated.changePenaltyCurrency === cur)
                    updated.changePenaltyHome = conv(updated.changePenaltyAmount);
                }
                result = { ...result, conditions: updated };
              }
            }
            // Attach only a real priced result to the plan (handled in annotateItinerary); an
            // "unavailable" result still goes back to the model so it won't claim a fare, but it
            // adds no flight block — the graceful-degradation path.
            flightEstimate = result;
            // Conversion expected (fare is in a non-home currency) but didn't land → tell the model
            // to cite the original currency rather than a home figure it never received.
            const flightFxNote =
              result.source === "duffel" &&
              result.currency &&
              result.currency !== HOME &&
              result.homeAmount == null
                ? ` NOTE: live conversion to ${HOME} was unavailable — the fare is in ${result.currency}; present it in ${result.currency}.`
                : "";
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: JSON.stringify(flightModelView(result)) + flightFxNote,
                },
              ],
            });
            flightedOnce = true;
            continue; // back to the top — next turn the model emits
          }

          // Unknown tool name — bail rather than loop forever.
          break;
        }

        // Ran out of turns without a final plan.
        send({ type: "error", message: "The planner couldn't settle on a plan. Try again." });
      } catch (err) {
        if (req.signal.aborted) return; // abort surfaces as an error; not worth reporting.
        if (err instanceof Anthropic.APIError) {
          console.error("Anthropic API error:", err.status, err.message);
          send({
            type: "error",
            message: `Planner error (status ${err.status ?? "?"}). Try again in a moment.`,
          });
        } else {
          console.error("Unexpected planner error:", err);
          send({ type: "error", message: "Something went wrong talking to the planner." });
        }
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Tell proxies (nginx/Vercel) not to buffer, so events flush as they're produced.
      "X-Accel-Buffering": "no",
    },
  });
}
