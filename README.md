# TravelAgentAI

A decisive AI travel planner. You type a free-text brief — *"Europe in December for 4
weeks, mid-budget, love food and history"* — and it hands you **one** complete plan:
the route (which cities, in what order, nights in each) and a day-by-day list of
things to do. No wall of options. It has an opinion.

This is **v1.5+ (Approach B + C)** from `DESIGN.md`: a grounded, streaming agent. It may
ask one or two quick questions first (only when they'd change the plan), then drafts a
route, **grounds it in real data with three tools** — it verifies the named places against
a free geo database (OpenStreetMap + Wikipedia), for a multi-city trip checks the real
distances along the route, and grounds the **budget** in real cost data (World Bank price
levels + Wikivoyage) — all in a single agent loop, streaming live progress and marking
each activity confirmed-real in the UI.

After the plan lands you can **refine it in plain language** — *"swap Coimbra for Braga",
"make day 2 lighter", "add a city"* — and get back one revised, fully re-grounded plan
(never a menu). That's the start of the **concierge** step in the product vision.

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
  live progress indicator (drafting → verifying *N/M* → routing *N/M cities* → pricing *N/M
  cities* → finalizing), and the rendered itinerary with a **✓ real** badge on each verified
  place, a **grounded budget block** (trip total + per-day + where-to-save flags), and a
  per-city **cost chip** (cheap/moderate/pricey/expensive · ~$/day, with real Wikivoyage
  example prices on hover). It reads the plan route's streamed events with a `fetch` +
  `ReadableStream` reader. Below a finished plan, a **refine composer** (quick chips + a
  free-text box) sends a change back through the same stream and repaints the revised plan
  in place.
- **`app/api/clarify/route.ts`** — `POST /api/clarify` takes `{ brief }` and, on a fast
  cheap model (`claude-haiku-4-5`), decides whether to ask the traveler up to two quick
  questions (trip *depth*, *must-includes / hard no's*). Returns `{ questions: [...] }` —
  empty when the brief already settles things, so the common case plans instantly.
- **`app/api/plan/route.ts`** — `POST /api/plan` takes `{ brief, clarifications?, refine? }`
  and runs the agent loop, **streaming** newline-delimited JSON progress events. Claude is
  *forced* to verify its named places first (`verify_places`); then it's offered the optional
  grounding tools it hasn't spent yet — `check_route` (multi-city only) and `estimate_costs` —
  alongside `emit`, picking one per turn until none remain; finally it is *forced* to emit the
  itinerary. The verification verdict **and** the grounded budget are attached on the server
  before it streams back. When `refine` is present it carries the latest plan plus a change;
  the route strips its own annotations off that plan, seeds it (and the change) into the
  conversation, and runs the **same loop** — so the revision is re-verified, re-routed if its
  cities changed, and re-priced if its cities/nights changed. Every turn forces exactly one
  tool (`disable_parallel_tool_use`), so a large plan can't split a tool into parallel calls
  and orphan a tool result.
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
- **`lib/cost.ts`** — executes the `estimate_costs` tool, grounding the **budget** in two
  layers that mirror `verify.ts`'s OSM-then-Wikipedia fallback. (1) A **bundled, offline
  World Bank price-level table** (`lib/costData.ts`) gives every country a comparable cost
  tier and a per-person daily budget for the chosen style (budget/mid-range/luxury) — this
  always works, no network, no key. (2) A **live, keyless Wikivoyage lookup** (the same public
  MediaWiki API `verify.ts` already uses for Wikipedia) adds *real, verbatim per-city price
  anchors* ("budget hostel from €19"), so the numbers are illustrated with sourced examples
  rather than asserted. There is no reliable keyless source for live flight/hotel prices, and
  inventing exact prices is exactly what the prompt forbids — so this grounds cost **level**,
  not live quotes. The tier cutoffs and daily-budget bands are documented, tunable heuristics
  (like `route.ts`'s distance thresholds); the sourced facts live in `costData.ts`.
- **`lib/costData.ts`** — *generated* (by `scripts/genCostData.mjs`) bundled price levels for
  ~200 countries: `priceLevel = consumer-PPP-factor / market-exchange-rate` (US = 1.0), from
  World Bank Open Data (CC BY 4.0). A static constant — no runtime call. Rerun the script to
  refresh the year.
- **`lib/schema.ts`** — the itinerary shape, defined once as a Zod schema. It's the
  contract between the model and the UI. The same Zod schema is converted to JSON Schema
  (Zod 4's native `z.toJSONSchema`) and handed to Claude as the **forced** `emit_itinerary`
  tool — the reliable way to get structured JSON back. The response is validated with the
  same Zod schema before it reaches the UI. Enriched `Verified*` types add the per-activity
  verdict, and self-contained `BudgetSummary` / `CityCostSummary` types carry the server-
  attached, grounded budget (kept import-free so the client bundle never pulls in the cost
  data or fetch logic).
- **`lib/prompt.ts`** — two system prompts: the decisive-travel-agent personality for the
  planner (now describing all three grounding tools and when to spend the optional ones), and
  a tight "ask only if it matters" prompt for the clarify step.

## The agent loop (the concept worth understanding)

`route.ts` keeps a growing `messages` array across model calls in one request. It's a small
state machine: **which tools are offered, and which one is forced, changes per turn**, so
the loop stays bounded while the agent becomes genuinely multi-tool.

```
messages = [user brief, (optional: clarifying Q&A)]
turn 1:  Claude -> tool_use: verify_places([...])    # FORCED — it can't skip grounding
         run OpenStreetMap/Wikipedia, push tool_result onto messages
turn 2…: Claude is offered the optional tools it hasn't spent + emit, picks ONE:
           check_route([cities])    # multi-city only — geocode + leg distances + flags
           estimate_costs([cities]) # cost tier + daily budget + Wikivoyage price anchors
           emit_itinerary({...})    # done
         (it loops here at most twice — route + cost are each gated to one use)
turn N:  Claude -> tool_use: emit_itinerary({...})   # FORCED once nothing optional remains
         attach our verdicts + grounded budget -> render badges
```

Three things make this sturdy:

- **Forced verify-then-emit.** `tool_choice` forces `verify_places` as the *sole* tool on
  the first turn, and forces `emit_itinerary` at the end. The model can't hand back a plan
  it never grounded — grounding is **structural**, not a polite request in the prompt.
- **The optional tools are the agent's choice, gated to where they matter.** After
  verification, the model is offered the optional grounding tools it hasn't used yet —
  `check_route` (multi-city only) and `estimate_costs` — alongside `emit`, and must pick
  exactly one (`tool_choice: {type:"any", disable_parallel_tool_use:true}`). Each is gated to
  a single use, so the loop can't spin: at most one route turn + one cost turn before emit. A
  single-city trip is never offered `check_route`; a trip with no budget angle just won't be
  steered to `estimate_costs`. This adds the new tools **without** weakening the place-grounding
  guarantee: `verify_places` stays the lone forced tool on turn 1 regardless.
- **Streaming.** Each model call uses `client.messages.stream(...).finalMessage()` (no
  HTTP timeout on the large emit turn, room for `max_tokens` up to 64k on long trips), and
  the route streams phase + per-place + per-city progress events the whole way. A heartbeat
  keeps the connection visibly alive during the silent model turns.

The loop is bounded (`MAX_TURNS = 6`, worst legitimate path verify-retry → verify → route →
cost → emit) on purpose: every turn is a full, slow model call, and a free-form loop
ballooned to ~100s in testing.

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

## Grounding the budget (the first deals step)

The product vision is plan → **deals** → concierge → booking. The honest v1 of "deals",
given the constraints, is **grounding the budget** — the same `verify_places` philosophy
applied to money. The scouting result was decisive: there is **no reliable keyless source
for live flight or hotel prices** (Amadeus's free self-service tier is shutting down,
Kiwi/Tequila went invitation-only, the rest are key-walled or ToS-violating scrapers) — and
inventing exact prices is precisely what the system prompt already bans. So `estimate_costs`
grounds cost **level**, not live quotes, in two layers:

- **A bundled World Bank price-level table** (offline, no key) gives every country a
  comparable cost tier and a per-person daily budget for the traveler's style. This is the
  robust, always-on signal — `priceLevel = consumer-PPP / market-exchange-rate`, US = 1.0, so
  e.g. Japan lands "moderate" (the weak yen makes it genuinely cheap right now) and
  Switzerland "expensive".
- **A live, keyless Wikivoyage lookup** adds *real, verbatim per-city price anchors* pulled
  from the article ("budget hostel from €19", "€5–8 mains") — the same public MediaWiki API
  the place-verifier already uses. Anchors illustrate; they're never cross-compared or used to
  compute the tier, so a thin or prose-only article degrades gracefully to "no anchors" rather
  than a wrong number.

The agent uses the result to right-size nights to the budget, flag or swap an expensive base,
and point out where to save — then emits. Like the verify verdict, the **displayed budget is
the tool's output, server-attached** in `annotateItinerary`, never a number the model
asserted. Figures are per person and cover lodging, food, local transport and activities;
they exclude flights and intercity transport (no free price source for those). Seasonality
(Open-Meteo) and live flight search (Duffel sandbox) are clean next tools, deliberately
deferred.

## Clarifying questions (Approach C)

When the brief leaves something open that would change the plan, the intake step asks at
most two questions before planning — *deep (fewer cities, more nights) vs broad?* and
*any must-include cities or hard no's?* — and skips them otherwise (a single-city brief
gets nothing, and plans immediately). The answers are replayed into the plan request as
prior conversation turns, so the planner conditions on them (that's the multi-turn state).

## Refining a plan (the concierge step)

Once a plan is on screen, you can ask for a change in plain language and get back **one**
revised plan — decisive, never a menu. The client sends `POST /api/plan` with
`refine: { itinerary, instruction }`, where `itinerary` is the **latest** plan it's holding
(prior tweaks already baked in, so there's no refine history to replay). The server:

1. **Strips its own annotations** off the incoming plan by re-parsing it through the Zod
   schema (`itinerarySchema.safeParse` drops the `verified`/`matched` keys), leaving a clean
   `Itinerary` to embed. If the change is empty/oversized or the plan doesn't parse, it
   ignores the refine and plans fresh.
2. **Seeds the conversation** as `[user: brief] (+ clarify replay) + [assistant: the prior
   plan] + [user: the change]`, then runs the **same** forced-verify → optional-check_route →
   forced-emit loop. No second loop, no new endpoint.

Because the loop is reused unchanged, a refine is **re-grounded** (every place re-verified)
and **re-routed** whenever the cities change — `multiCity` is re-detected from the revised
plan. This is the next concept past the within-request agent loop: **conversation state
carried across requests**, held client-side (like the clarifications) so it stays
stateless-serverless friendly. Each refine re-verifies the whole plan, so it costs about as
much as the first plan — correct, just heavier; fine for v1.

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
- **The budget is a grounded ballpark, not a quote.** `estimate_costs` grounds the cost
  *level* per country (World Bank price levels) and illustrates it with real Wikivoyage price
  anchors — it does **not** fetch today's flight or hotel prices (no reliable free source
  exists). The daily figure is per person, covers lodging/food/local costs, and excludes
  flights and intercity transport. Cost tiers are country-level, so it won't distinguish a
  pricey capital from a cheap town in the same country (the per-city Wikivoyage anchors hint
  at that). Treat the total as a planning ballpark.
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
5. ✅ **Concierge / refine loop — done.** After a plan is shown, tweak it in plain language
   ("swap a city", "lighter days", "add a city") and get back one revised, re-grounded plan.
   Reuses the whole loop; teaches conversation state carried *across* requests.
6. ✅ **Deals, part 1 — budget grounding — done.** A third grounding tool, `estimate_costs`,
   attaches a real, server-grounded budget (World Bank price levels + Wikivoyage anchors) to
   the plan — the first piece of the deals step. Keyless and free, like the geo tools; grounds
   cost *level*, not live quotes (no reliable free price source exists).
7. Then the rest of the all-in-one vision: seasonality/best-time-to-go (Open-Meteo, keyless),
   optional live flight search (Duffel sandbox, keyed), and eventually booking — each a new
   tool on the same agent.
