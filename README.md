# TravelAgentAI

A decisive AI travel planner. You type a free-text brief — *"Europe in December for 4
weeks, mid-budget, love food and history"* — and it hands you **one** complete plan:
the route (which cities, in what order, nights in each) and a day-by-day list of
things to do. No wall of options. It has an opinion.

This is **v1.5 (Approach B + C)** from `DESIGN.md`: a grounded, streaming agent. It may
ask one or two quick questions first (only when they'd change the plan), then drafts a
route, **grounds it in real data with two tools** — it verifies the named places against
a free geo database (OpenStreetMap + Wikipedia) *and*, for a multi-city trip, checks the
real distances along the route — all in a single agent loop, streaming live progress and
marking each activity confirmed-real in the UI.

## Run it

1. Install deps:
   ```
   npm install
   ```
2. Add your Anthropic API key. Copy `.env.example` to `.env.local` and paste a key
   from https://console.anthropic.com/settings/keys :
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Start the dev server:
   ```
   npm run dev
   ```
   Open http://localhost:3000 , type a brief (or click a sample), hit **Plan my trip**.

## How it works

- **`app/page.tsx`** — the UI: one textarea, an optional clarifying-questions card, a
  live progress indicator (drafting → verifying *N/M* → routing *N/M cities* → finalizing),
  and the rendered itinerary with a **✓ real** badge on each verified place. It reads the
  plan route's streamed events with a `fetch` + `ReadableStream` reader.
- **`app/api/clarify/route.ts`** — `POST /api/clarify` takes `{ brief }` and, on a fast
  cheap model (`claude-haiku-4-5`), decides whether to ask the traveler up to two quick
  questions (trip *depth*, *must-includes / hard no's*). Returns `{ questions: [...] }` —
  empty when the brief already settles things, so the common case plans instantly.
- **`app/api/plan/route.ts`** — `POST /api/plan` takes `{ brief, clarifications? }` and
  runs the agent loop, **streaming** newline-delimited JSON progress events. Claude is
  *forced* to verify its named places first (`verify_places`); then, for a **multi-city**
  trip, it gets one turn to call `check_route` and react to the real distances; finally it
  is *forced* to emit the itinerary. A verification verdict is attached to each activity on
  the server before it streams back.
- **`lib/verify.ts`** — executes the `verify_places` tool: checks each place against
  OpenStreetMap (Nominatim) with a Wikipedia fallback. Free, no API key, throttled to ~1
  request/second per OSM's usage policy. A **token-overlap guard** rejects loose matches
  (a free geo search returns *some* best hit for any string, so a made-up name can latch
  onto a real node — we require a real name-word in the match), and each lookup has a
  5s timeout. Reports per-place progress so the route can stream it. Also exports
  `geocodeCity`, which turns a city name into a lat/lon centroid using the same layer.
- **`lib/route.ts`** — executes the `check_route` tool: geocodes each city centroid
  (`geocodeCity`) and computes **great-circle (haversine) distances** between consecutive
  cities. It flags long hops, and if a clearly tighter order exists (a 2-opt pass that beats
  the model's order by ≥20%) it suggests one. Straight-line distance isn't travel time, but
  it reliably catches the failure the model can't see by eyeballing a map: a zig-zagging
  route, or a one-night stop hiding behind a brutal transfer.
- **`lib/schema.ts`** — the itinerary shape, defined once as a Zod schema. It's the
  contract between the model and the UI. The same Zod schema is converted to JSON Schema
  (Zod 4's native `z.toJSONSchema`) and handed to Claude as the **forced** `emit_itinerary`
  tool — the reliable way to get structured JSON back. The response is validated with the
  same Zod schema before it reaches the UI. Enriched `Verified*` types add the per-activity
  verdict.
- **`lib/prompt.ts`** — two system prompts: the decisive-travel-agent personality for the
  planner (now describing both grounding tools), and a tight "ask only if it matters" prompt
  for the clarify step.

## The agent loop (the concept worth understanding)

`route.ts` keeps a growing `messages` array across model calls in one request. It's a small
state machine: **which tools are offered, and which one is forced, changes per turn**, so
the loop stays bounded while the agent becomes genuinely multi-tool.

```
messages = [user brief, (optional: clarifying Q&A)]
turn 1:  Claude -> tool_use: verify_places([...])    # FORCED — it can't skip grounding
         run OpenStreetMap/Wikipedia, push tool_result onto messages
turn 2:  (multi-city only) Claude -> tool_use: check_route([cities in order])
         geocode centroids, compute leg distances + flags, push tool_result
         (single-city trips skip this turn entirely — there's no route to check)
turn 3:  Claude -> tool_use: emit_itinerary({...})   # FORCED; uses what checked out
         attach our verdicts -> render badges
```

Three things make this sturdy:

- **Forced verify-then-emit.** `tool_choice` forces `verify_places` as the *sole* tool on
  the first turn, and forces `emit_itinerary` at the end. The model can't hand back a plan
  it never grounded — grounding is **structural**, not a polite request in the prompt.
- **The route turn is the agent's choice, gated to where it matters.** After verification,
  a multi-city trip is offered `{check_route, emit}` and must pick exactly one
  (`tool_choice: {type:"any", disable_parallel_tool_use:true}`) — so it either checks the
  route and then emits, or emits directly. A single-city trip (detected from the verified
  places carrying just one city) is never offered `check_route` at all, so it keeps the
  snappy two-turn path. This adds the second tool **without** weakening the place-grounding
  guarantee: `verify_places` stays the lone forced tool on turn 1 regardless.
- **Streaming.** Each model call uses `client.messages.stream(...).finalMessage()` (no
  HTTP timeout on the large emit turn, room for `max_tokens` up to 64k on long trips), and
  the route streams phase + per-place + per-city progress events the whole way. A heartbeat
  keeps the connection visibly alive during the silent model turns.

The loop is bounded to ~2–3 model turns on purpose: every turn is a full, slow model call,
and a free-form loop ballooned to ~100s in testing.

## Grounding the route (why a second tool)

Verifying places makes the *things to do* real, but nothing checked the *route* — yet the
killer demo is "broad input → full multi-city route." Left to eyeball it, the model can
zig-zag across the map or strand a one-night stop behind a 9-hour transfer. `check_route`
fixes that: it hands the model real, grounded distances so it can reorder, merge nearby
stops, or drop an extreme outlier before committing. It uses the **free Nominatim layer we
already had** (no new dependency, no key) — geocode each city centroid, then haversine
between consecutive cities. Straight-line ≠ travel time, but it's enough to catch the
geographic mistakes; a real driving-time API (e.g. OSRM) is a later quality upgrade, not a
v1 dependency.

## Clarifying questions (Approach C)

When the brief leaves something open that would change the plan, the intake step asks at
most two questions before planning — *deep (fewer cities, more nights) vs broad?* and
*any must-include cities or hard no's?* — and skips them otherwise (a single-city brief
gets nothing, and plans immediately). The answers are replayed into the plan request as
prior conversation turns, so the planner conditions on them (that's the multi-turn state).

## Model and cost

The planner model is one constant in `app/api/plan/route.ts`:

```ts
const MODEL = "claude-opus-4-8";
```

`claude-opus-4-8` is the highest-quality planner. Switch it to `claude-sonnet-4-6` to
cut cost roughly in half for a small quality trade — a good default if you're running
lots of test calls. The clarify step runs on `claude-haiku-4-5` (cheap, fast — it's a
small decision, not the planning).

## Known limits (v1, on purpose)

- **Grounded, but lightly.** Named places are verified against OpenStreetMap/Wikipedia and
  badged "real". Verification confirms the named *anchor* exists (a neighbourhood,
  landmark, market, museum) — not that one specific restaurant is open today. The
  token-overlap guard errs toward precision: it would rather show an ambiguous-but-real
  place as **unconfirmed** than badge a hallucinated specific as real. *Not found ≠ fake.*
- **The route check is straight-line, not travel time.** `check_route` measures
  great-circle distance between city centroids. It reliably catches zig-zags and impractical
  jumps, but it doesn't know about mountains, ferries, or that a flight is faster than the
  train. It's a sanity check the model reasons over, not a routing engine.
- **Long trips stream, but the function still has a wall-clock cap.** Streaming means the
  browser sees live progress instead of a blank spinner and never times out on its own.
  But the route still has to *finish* within the server's function cap — on Vercel's free
  tier that's ~60s (`maxDuration = 300` asks for more; Pro raises the ceiling). The free geo
  lookups are the floor here: OSM's ~1 req/sec policy means verifying ~40 places plus
  geocoding a handful of cities is tens of seconds. Locally (`npm run dev`) there's no cap,
  so the longest trips work end to end.

## What's next (from DESIGN.md)

1. ✅ **Grounding (Approach B) — done.** The single call is an agent loop with a free
   place-verify tool; confirmed places are badged in the UI.
2. ✅ **Streaming — done.** The plan streams phase + per-place progress as NDJSON; the
   browser shows live status and no longer hits the client/gateway timeout.
3. ✅ **Clarifying questions (Approach C) — done.** A cheap intake step asks "deep or
   broad?" and "any must-include cities?" only when useful, then plans with the answers.
4. ✅ **Ground the route — done.** A second tool, `check_route`, grounds the multi-city
   route in real geographic distances so the agent loop is genuinely multi-tool.
5. Then the rest of the all-in-one vision: deals, concierge chat, booking — each a new
   tool on the same agent.
