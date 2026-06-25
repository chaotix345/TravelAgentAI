import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import {
  itineraryJsonSchema,
  itinerarySchema,
  type Itinerary,
  type VerifiedItinerary,
  type VerifyStatus,
} from "@/lib/schema";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { verifyPlaces, type VerifyResult } from "@/lib/verify";
import { checkRoute } from "@/lib/route";

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
// Backstop on agent-loop iterations. Happy path: 2 model turns for a single city
// (verify, then a forced emit) and 3 for a multi-city trip (verify, an optional
// check_route, then a forced emit). We allow the model ONE retry if it calls
// verify with no usable places (capped below by EMPTY_VERIFY_RETRIES), so the
// worst legitimate path is verify-retry -> verify -> check_route -> emit = 4
// turns and still fits. Guards against anything unexpected so a request can't
// spin forever.
const MAX_TURNS = 4;
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

// The tools the planner can use. verify_places and check_route are OURS to execute
// (they call free geo databases); emit_itinerary is the structured "I'm done"
// signal. Which tools are offered — and which one is forced — varies per turn (see
// the loop), so verify-then-emit stays structural: a plan can't be emitted before
// its places are grounded.
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

const EMIT_ITINERARY_TOOL: Anthropic.Tool = {
  name: "emit_itinerary",
  description:
    "Return the final, complete travel itinerary. Call this exactly once, after your named places have checked out.",
  input_schema: itineraryJsonSchema as Anthropic.Tool.InputSchema,
};

// The progress events we stream to the browser, one JSON object per line (NDJSON).
// The client switches on `type`. Phases mirror the agent loop: draft -> verify ->
// (route) -> finalize. On routing/verifying events, `done`/`total` drive the
// progress bar and `name` (routing) names the city being located.
type PlanEvent =
  | {
      type: "status";
      phase: "drafting" | "verifying" | "routing" | "finalizing";
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
  return {
    ...itinerary,
    cities: itinerary.cities.map((city) => ({
      ...city,
      days: city.days.map((day) => ({
        label: day.label,
        morning: { ...day.morning, ...verdict(day.morning.name) },
        afternoon: { ...day.afternoon, ...verdict(day.afternoon.name) },
        evening: { ...day.evening, ...verdict(day.evening.name) },
      })),
    })),
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
          let phase: "drafting" | "routing" | "finalizing";
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
          } else if (multiCity && !routedOnce) {
            // Offer {check_route, emit}; disable_parallel_tool_use makes the model pick
            // exactly ONE per response. The prompt steers a multi-city trip to call
            // check_route here, but the model MAY emit directly if it judges the route
            // already clean — check_route is the agent's choice, not forced. (verify_places
            // stays the forced, sole tool on turn 0, so place-grounding is still structural.)
            phase = "routing";
            toolsForTurn = [CHECK_ROUTE_TOOL, EMIT_ITINERARY_TOOL];
            toolChoice = { type: "any", disable_parallel_tool_use: true };
          } else {
            phase = "finalizing";
            toolsForTurn = [EMIT_ITINERARY_TOOL];
            // Same single-tool-per-turn invariant: force exactly one emit_itinerary.
            toolChoice = { type: "tool", name: "emit_itinerary", disable_parallel_tool_use: true };
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
            send({ type: "itinerary", itinerary: annotateItinerary(itinerary, verifyCache) });
            return;
          }

          if (toolUse.name === "verify_places") {
            const input = toolUse.input as { places?: unknown };
            // Tool inputs aren't strictly validated, so the model can return `places` as
            // something other than an array (the larger refine context makes this more
            // likely). Guard the type — a non-array falls into the empty-verify retry below
            // instead of throwing. (`?? []` alone only guards null/undefined.)
            if (input.places != null && !Array.isArray(input.places)) {
              console.warn(
                "verify_places: non-array places:",
                JSON.stringify(input.places).slice(0, 300),
              );
            }
            const rawPlaces = Array.isArray(input.places)
              ? (input.places as Array<{ name?: unknown; city?: unknown }>)
              : [];
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
            // Same guard as verify_places: a non-array `cities` shouldn't throw. An empty
            // result just means checkRoute reports nothing to check and we move to emit.
            const rawCities = Array.isArray(input.cities)
              ? (input.cities as Array<{ name?: unknown; country?: unknown }>)
              : [];
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
            continue; // back to the top — next turn we force the final itinerary
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
