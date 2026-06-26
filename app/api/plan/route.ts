import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import {
  itineraryJsonSchema,
  itinerarySchema,
  type BudgetSummary,
  type CitySeasonSummary,
  type Itinerary,
  type SeasonSummary,
  type VerifiedItinerary,
  type VerifyStatus,
} from "@/lib/schema";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { verifyPlaces, type VerifyResult } from "@/lib/verify";
import { checkRoute } from "@/lib/route";
import { estimateCosts, parseStyle, type CostEstimate, type CityCost } from "@/lib/cost";
import { assessSeason, seasonModelView, seasonTargetLine, parseTargetMonth } from "@/lib/season";

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
// chooses to use adds one turn: estimate_costs and best_time_to_go (single-city), or
// check_route + estimate_costs + best_time_to_go (multi-city), each gated to a single use. So
// the longest legitimate path is verify-retry -> verify -> check_route -> estimate_costs ->
// best_time_to_go -> emit = 6 turns; 7 leaves a turn of headroom. Each optional tool is gated
// to one use, so the loop can't spin. Guards against anything unexpected so a request can't run
// forever.
const MAX_TURNS = 7;
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
    "Check whether named places (landmarks, neighbourhoods, markets, museums, restaurants) actually exist, using a free geographic database. Batch every place from your draft into a single call. Returns, for each, whether it was found. Use the results to drop or replace places that don't check out before finalizing.",
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
    "Sanity-check the geography of a multi-city route. List your cities IN THE ORDER you plan to visit them. Returns the great-circle (straight-line) distance of each leg and the total, flags hops that are very long, and — if a clearly better ordering exists — suggests one. Use it to reorder cities, merge stops that sit right next to each other, or drop an extreme outlier before you finalize. Straight-line distance underestimates real travel time but reliably catches zig-zags and impractical jumps. Only useful for trips with two or more cities.",
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
    "Ground the TIMING of your plan in real climate data. Pass your cities (with country), and — if the brief implies WHEN they travel ('in August', 'next spring', specific dates) — the targetMonth (1-12) of the trip. Returns, per city, a 'best months to go' window and a peak/shoulder/off-season weather label for each month, derived from Open-Meteo climate normals (real observed weather, no key); if you gave a targetMonth, it assesses that month at each city. Use it to: time a flexible trip to the best window, WARN the traveler when their chosen month is harsh (peak heat, monsoon, deep winter) and suggest a better one, and tailor day plans to the actual conditions (indoor/early-start in extreme heat, rain backups in a wet month). It grounds WEATHER comfort only — not tourist crowds or prices, which depend on holidays and festivals — so never claim crowd levels from it. Call this when timing matters: the brief gives or leaves open the dates, the destination has a strong season (Mediterranean summer, tropical monsoon, far-north winter), or shifting the month would clearly help.",
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
      phase: "drafting" | "verifying" | "routing" | "pricing" | "timing" | "finalizing";
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
      ...(cc ? { cost: { tier: cc.tier, dailyUsd: cc.dailyUsd, anchors: cc.anchors } } : {}),
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
    budget = {
      style: costEstimate.style,
      currency: costEstimate.currency,
      totalUsd,
      perDayUsd,
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
      note: season.note,
      caveat: season.caveat,
    };
  }

  return {
    ...itinerary,
    ...(budget ? { budget } : {}),
    ...(seasonOut ? { season: seasonOut } : {}),
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
      const instruction = typeof r.instruction === "string" ? r.instruction.trim() : "";
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
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: brief }];
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
        messages.push(
          {
            role: "assistant",
            content: `Here's the itinerary I built:\n${JSON.stringify(refine.itinerary)}`,
          },
          { role: "user", content: refine.instruction },
        );
      }
      const verifyCache = new Map<string, VerifyResult>();
      let verifiedOnce = false; // have we run a real place-verification round yet?
      let routedOnce = false; // has the model used its one check_route round?
      let costedOnce = false; // has the model used its one estimate_costs round?
      let seasonedOnce = false; // has the model used its one best_time_to_go round?
      // The grounded budget from the last estimate_costs call, attached to the final plan.
      let costEstimate: CostEstimate | null = null;
      // The grounded seasonality from the last best_time_to_go call, attached to the final plan.
      let seasonEstimate: SeasonSummary | null = null;
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
          let phase: "drafting" | "routing" | "pricing" | "timing" | "finalizing";
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
          } else {
            // Places are grounded. Offer the OPTIONAL grounding tools the agent hasn't spent
            // yet — check_route (multi-city only), estimate_costs and best_time_to_go —
            // alongside emit, and let the model choose (the prompt steers when each earns its
            // turn). Each is gated to a single use, so the loop can't spin: at most one route +
            // one cost + one timing turn before emit. disable_parallel_tool_use keeps it to
            // exactly one tool_use per response, the same invariant every other turn relies on.
            // When no optional tool is left, force the final emit. (verify_places stays the sole
            // forced tool on turn 0, so place grounding is still structural — route/cost/timing
            // are the agent's call.)
            const optional: Anthropic.Tool[] = [];
            if (multiCity && !routedOnce) optional.push(CHECK_ROUTE_TOOL);
            // Offer cost and timing only once the route is settled (or there's no route to
            // settle), so they're computed against the FINAL city set — not one check_route may
            // still reorder or drop. Enforces the prompt's "ground once the cities are settled"
            // at the loop level instead of trusting the model to sequence it.
            if (!costedOnce && (!multiCity || routedOnce)) optional.push(ESTIMATE_COSTS_TOOL);
            if (!seasonedOnce && (!multiCity || routedOnce)) optional.push(BEST_TIME_TOOL);
            if (optional.length > 0) {
              // Pre-decision label: name the work most likely to run next so the UI shows a
              // sensible phase before the model picks. Routing comes first on a multi-city trip;
              // otherwise cost, then timing. The precise per-tool status fires when the chosen
              // tool actually runs (or finalizing if it emits instead).
              phase = multiCity && !routedOnce ? "routing" : !costedOnce ? "pricing" : "timing";
              toolsForTurn = [...optional, EMIT_ITINERARY_TOOL];
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
                  system: SYSTEM_PROMPT,
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
              itinerary: annotateItinerary(itinerary, verifyCache, costEstimate, seasonEstimate),
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

            if (places.length === 0) {
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

            send({ type: "status", phase: "verifying", done: 0, total: places.length });
            const results = await verifyPlaces(places, verifyCache, (done, total, last) =>
              send({ type: "progress", done, total, name: last.name, found: last.found }),
            );
            messages.push({
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(results) },
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
            const route = await checkRoute(
              cities,
              (done, total, name) => send({ type: "status", phase: "routing", done, total, name }),
              req.signal,
            );
            messages.push({
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(route) },
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
            costEstimate = estimate; // attached to the final plan as the grounded budget
            messages.push({
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(estimate) },
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
