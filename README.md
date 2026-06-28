# TravelAgentAI

A decisive AI travel planner. You type a free-text brief — *"Europe in December for 4
weeks, mid-budget, love food and history"* — and it hands you **one** complete plan:
the route (which cities, in what order, nights in each) and a day-by-day list of
things to do. No wall of options. It has an opinion.

This is **v1.5+ (Approach B + C)** from `DESIGN.md`: a grounded, streaming agent. It may
ask one or two quick questions first (only when they'd change the plan), then drafts a
route and **grounds it in real data with five keyless tools** — it verifies the named places
against a free geo database (OpenStreetMap + Wikipedia), for a multi-city trip checks the real
distances along the route, grounds the **budget** in real cost data (World Bank price levels +
Wikivoyage), grounds the **timing** in real climate normals, **daylight hours**, a **"feels-like" heat** read, **air quality** and **altitude / acclimatization** (Open-Meteo ERA5 + Copernicus CAMS + terrain elevation + latitude-based astronomy), and flags the **public holidays** that close attractions or spike domestic travel in your dates (Nager.Date) — all in a single
agent loop, streaming live progress and marking each activity confirmed-real in the UI. With an
optional **Duffel** API key it also prices the **flights** — the first tool that needs a key, and
one that degrades gracefully to nothing when no key is set. Every money figure — the budget and the
flight fare — is then shown in **your home currency** (default AUD, set `HOME_CURRENCY` to change),
converted at a live **European Central Bank** reference rate (keyless, via Frankfurter), so a budget
computed in USD and a fare Duffel happens to quote in another currency both land in the currency you
actually think in.

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
4. **(Optional) Enable flight search.** Add a free Duffel **test** token to `.env.local` to turn on
   the `find_flights` tool; without it everything else works unchanged (there's just no flight
   block):
   ```
   DUFFEL_API_KEY=duffel_test_...
   ```
   Get one with no credit card at https://app.duffel.com/join → Developers → Access tokens.
   Heads-up: **test-mode fares are synthetic** (a sandbox airline) and shown with a "test data"
   badge — they prove the integration, not real prices. A live token returns real fares.

## How it works

- **`app/page.tsx`** — the UI: one textarea, an optional clarifying-questions card, a
  live progress indicator (drafting → verifying *N/M* → routing *N/M cities* → pricing *N/M
  cities* → timing *N/M cities* → flights → finalizing), and the rendered itinerary with a **✓ real** badge
  on each verified place, a **grounded budget block** (trip total + per-day + where-to-save
  flags, shown in your home currency with the native USD figure beside it), a per-city **cost chip**
  (cheap/moderate/pricey/expensive · ~home-currency/day, with real Wikivoyage
  example prices on hover), and a **"When to go" block** with a per-city **12-month weather strip**
  (each month coloured peak/shoulder/off-season, the trip's target month ringed, hover for that
  month's detail) plus a target-month verdict, and — when a Duffel key is configured — a **flights
  block** with the cheapest round-trip fare (badged "test data" for synthetic test-mode fares, shown
  in your home currency with Duffel's native quote beside it). Each converted figure carries a small
  ECB-rate provenance line. It
  reads the plan route's streamed events with a
  `fetch` + `ReadableStream` reader. Below a finished plan, a **refine composer** (quick chips + a
  free-text box) sends a change back through the same stream and repaints the revised plan in
  place. A footer credits the keyless data sources (incl. Open-Meteo, CC BY 4.0).
- **`app/api/clarify/route.ts`** — `POST /api/clarify` takes `{ brief }` and, on a fast
  cheap model (`claude-haiku-4-5`), decides whether to ask the traveler up to two quick
  questions (trip *depth*, *must-includes / hard no's*). Returns `{ questions: [...] }` —
  empty when the brief already settles things, so the common case plans instantly.
- **`app/api/capabilities/route.ts`** — `GET /api/capabilities` returns `{ flights, homeCurrency }`
  so the client knows whether a Duffel key is configured (and which currency to name) **before** the
  user types — that's what gates the optional **"Flying from?"** origin input. It exposes only a
  boolean that a key exists (never the key) plus the home currency, both already inferable from a
  plan's output, so a keyless deploy stays byte-for-byte unchanged (the input simply never renders).
- **`app/api/plan/route.ts`** — `POST /api/plan` takes `{ brief, clarifications?, origin?, refine? }`
  and runs the agent loop, **streaming** newline-delimited JSON progress events. Claude is
  *forced* to verify its named places first (`verify_places`); then it's offered the optional
  grounding tools it hasn't spent yet — `check_route` (multi-city only), `estimate_costs`,
  `best_time_to_go`, `check_holidays`, and (only when a Duffel key is set) `find_flights` — alongside `emit`, picking
  one per turn until none remain; finally it is *forced* to emit the itinerary. The verification
  verdict, the grounded budget, the grounded seasonality, the grounded public holidays **and** the grounded flights are attached
  on the server before it streams back. A sanitized `origin` (from the **"Flying from?"** field) is
  appended to the brief as a user-turn line and makes flight pricing a **required** step — the loop
  withholds `emit` until `find_flights` has run — so naming where you fly from reliably lights up the
  fare instead of leaving it to the model to infer from the brief. When `refine` is present
  it carries the latest plan plus a change; the route strips its own annotations off that plan,
  seeds it (and the change) into the conversation, and runs the **same loop** — so the revision is
  re-verified, re-routed if its cities changed, and re-priced / re-timed if its cities or nights
  changed. Every turn forces exactly one tool (`disable_parallel_tool_use`), so a large plan can't
  split a tool into parallel calls and orphan a tool result; a small `coerceArray` helper also
  recovers a tool-input array the model occasionally returns as a JSON *string*, so that quirk
  can't sink a plan.
- **`lib/verify.ts`** — executes the `verify_places` tool: checks each place against
  OpenStreetMap (Nominatim) with a Wikipedia fallback. Free, no API key, throttled to ~1
  request/second per OSM's usage policy. A **token-overlap guard** rejects loose matches
  (a free geo search returns *some* best hit for any string, so a made-up name can latch
  onto a real node — we require a real name-word in the match), and each lookup has a
  5s timeout. Reports per-place progress so the route can stream it. Also exports
  `geocodeCity`, which turns a city name into a lat/lon centroid using the same layer —
  reused by both `check_route` and `best_time_to_go`.
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
- **`lib/season.ts`** — executes the `best_time_to_go` tool, grounding the **timing**. It reuses
  `geocodeCity` to turn each city into a lat/lon, then fetches **5 years of daily weather from the
  keyless, free Open-Meteo ERA5 archive** (real *observed* climate, non-commercial use, CC BY 4.0)
  and aggregates it server-side into 12 monthly normals. A tunable **comfort model** (a temperature
  score on the mean daily *high*, minus a dryness penalty from rain days) labels each month
  peak/shoulder/off-season and derives a "best months to go" window — handling the wrap-around
  (a Nov–Feb peak) and the Mediterranean split (a brutal summer between a spring and an autumn
  window). Two overrides keep it honest worldwide: a **tropical override** ranks by rain instead of
  heat (so Bangkok's dry season Nov–Mar reads as peak, not "always too hot"), and a
  **challenging-climate override** labels the least-bad months "best available" where no month is
  genuinely comfortable (Reykjavik). Hemisphere needs no special-casing — labels come from the real
  numbers, so Sydney is correctly warm in January. Keyless and throttled like the geo tools, with a
  process-lifetime cache (normals barely change) and graceful degradation to "no data" on any
  error. The thresholds are documented, tunable heuristics. Alongside the weather it grounds four more
  signals (the pure functions live in `lib/daylight.ts`, `lib/airheat.ts` and `lib/altitude.ts`):
  **daylight hours** — day length is a deterministic function of latitude and date, computed locally
  (pure astronomy via the NOAA sunrise equation — no network, no failure mode) from the lat the
  geocode already returned, with a per-city advisory ("~4h of daylight in December — front-load
  outdoor sightseeing"); a **"feels-like" heat advisory** — the same ERA5 fetch also returns the
  apparent-temperature high (humidity + wind + sun), so a humid 34°C Bangkok April reads as "feels
  ~39°C — move sightseeing out of the midday heat"; and an **air-quality advisory** — a second
  keyless fetch pulls ~2 years of Copernicus CAMS PM2.5 normals on the coordinates already in hand,
  turned into a US-EPA AQI band server-side, so Delhi in November warns "typically unhealthy — bring
  an N95"; and an **altitude / acclimatization advisory** — the same ERA5 response already carries the
  city's terrain elevation, so a base at ~3,400m (Cusco) warns "take day 1 easy, hydrate, watch for
  altitude sickness" and the model paces a gentle arrival day (the first *city-level*,
  month-independent signal, so it attaches to the city, not each month). All four fold into the season
  pass with no new model turn (a fact a tool already has the
  data for doesn't earn its own turn) and each degrades independently to nothing. It grounds
  **weather, daylight, heat, air quality and altitude** only — there's no keyless source for tourist crowds —
  and says so in a caveat.
- **`lib/airheat.ts`** — the pure (zero-import, network-free) functions behind two of those signals:
  the "feels-like" **heat advisory** (CAUTION ≥ 37°C / DANGER ≥ 42°C on the ERA5 apparent-temperature
  high, thresholds calibrated against real 2020–24 normals across the hot-city spectrum) and the
  **air-quality** band + advisory (US-EPA 2024 PM2.5 breakpoints, advisory at "unhealthy for sensitive
  groups" or worse). Like `lib/daylight.ts`, the thresholds live server-side so the model view and UI
  render one verdict; the network fetches stay in `lib/season.ts`.
- **`lib/altitude.ts`** — the pure (zero-import, network-free) functions behind the **altitude /
  acclimatization advisory**: it bands a city's base elevation into tiers (mild ~2,000m, acclimatize
  ~2,500m, very high / serious risk ~3,500m) and writes a decisive, honest advisory (general travel
  information, not medical advice; no drug names; HACE/HAPE glossed in plain language). The elevation is
  the Copernicus GLO-90 figure that rides the **same** ERA5 archive response `lib/season.ts` already
  fetches — so altitude costs no new request, the way daylight costs no network. It's the first
  city-level (month-independent) signal, so it attaches to `CitySeasonSummary`, not `MonthSeason`.
- **`lib/holidays.ts`** — executes the `check_holidays` tool, grounding the **public holidays**.
  The season tool deliberately disclaims crowds and holidays; this fills that gap. For each
  *distinct country* in the trip (holidays are national, so a three-city France trip is one fetch)
  it calls the keyless **Nager.Date** calendar, keeps the nationwide statutory closures
  (Public/Bank, in the target month), and derives day-of-week + long-weekend server-side (with the
  Friday–Saturday weekend handled for the countries that use it). The model uses it to move a visit
  off a day a holiday closes it, flag a long-weekend travel surge, or call out a holiday worth being
  there for. Honest about its limits: it grounds **closures**, not measured crowds; an uncovered
  country (Nager has ~150) reads as "no data", never a false "no holidays"; and it flags that Islamic
  holidays (Eid/Ramadan) are absent even for countries it otherwise covers. Reuses `costData.ts`'s
  `iso2` (no new country table), and is server-attached and recomputed against the final cities, like
  the budget and season.
- **`lib/flights.ts`** — executes the `find_flights` tool, the **first tool that needs an API key**
  (Duffel). It resolves each city name to an IATA code via Duffel's own Places endpoint (no
  hardcoded map), then makes ONE round-trip offer request (two slices: out + return) with raw
  `fetch` and reads back the cheapest economy fare. The whole tool branches on one env check: with
  **no `DUFFEL_API_KEY`** it's never offered and returns a typed "unavailable" result (degradation
  is a value, not a thrown error); with a **Duffel TEST key** it makes real API calls but returns
  *synthetic* fares, flagged `testMode` so the UI shows a "test data" disclaimer; with a **live
  key** the same flow returns real fares. Origin is required (inferred from the brief — no default
  departure city), the date is a representative mid-month proxy, and like every other tool the price
  shown is server-attached, never the model's claim.
- **`lib/currency.ts`** — the cross-currency layer, and the **first grounding that isn't a tool the
  model calls**. An exchange rate is a deterministic live fact, not a planning decision, so instead
  of a model turn it's a pure server-side transform run *after* a tool returns: it fetches the
  native→home rate from the keyless **Frankfurter** API (pure **ECB reference rates**), then
  `applyFxToCost` / `applyFxToFlights` augment the budget and fare with home-currency figures
  (rewriting the `$`-baked cost flags too). The home currency is a user setting (`HOME_CURRENCY`,
  default AUD). Same discipline as the other sources: a same-currency identity short-circuit (no
  fetch), a best-effort per-day rate cache, and graceful degradation — any FX failure or unsupported
  currency just shows the native figure, never a broken plan. The converted figures are fed back
  into the model's tool_result so its prose cites the home-currency amount too.
- **`lib/schema.ts`** — the itinerary shape, defined once as a Zod schema. It's the
  contract between the model and the UI. The same Zod schema is converted to JSON Schema
  (Zod 4's native `z.toJSONSchema`) and handed to Claude as the **forced** `emit_itinerary`
  tool — the reliable way to get structured JSON back. The response is validated with the
  same Zod schema before it reaches the UI. Enriched `Verified*` types add the per-activity
  verdict, and self-contained `BudgetSummary` / `CityCostSummary` / `SeasonSummary` / `MonthSeason`
  / `FlightSummary` / `HolidaySummary` types carry the server-attached, grounded budget, seasonality, holidays and flights (kept
  import-free so the client bundle never pulls in the cost data, climate fetch, scoring logic, or
  Duffel client).
- **`lib/prompt.ts`** — two system prompts: the decisive-travel-agent personality for the
  planner (describing the five keyless grounding tools and when to spend the optional ones), plus a
  `FLIGHTS_CLAUSE` appended to it **only when a Duffel key is configured** (capability-conditional
  prompting — the planner hears about `find_flights` exactly when it can use it); and a tight
  "ask only if it matters" prompt for the clarify step.

## The agent loop (the concept worth understanding)

`route.ts` keeps a growing `messages` array across model calls in one request. It's a small
state machine: **which tools are offered, and which one is forced, changes per turn**, so
the loop stays bounded while the agent becomes genuinely multi-tool.

```
messages = [user brief, (optional: clarifying Q&A)]
turn 1:  Claude -> tool_use: verify_places([...])     # FORCED — it can't skip grounding
         run OpenStreetMap/Wikipedia, push tool_result onto messages
turn 2…: Claude is offered the optional tools it hasn't spent + emit, picks ONE:
           check_route([cities])      # multi-city only — geocode + leg distances + flags
           estimate_costs([cities])   # cost tier + daily budget + Wikivoyage price anchors
           best_time_to_go([cities])  # 12-month climate normals -> peak/shoulder/off + best window
           check_holidays([cities])   # public-holiday closures + long weekends in the trip month
           find_flights([...])        # ONLY if a Duffel key is set — cheapest round-trip fare
           emit_itinerary({...})      # done
         (route/cost/timing/holidays/flights each gated to one use; cost, timing, holidays & flights wait until the
          route is settled, so they see the final city set)
turn N:  Claude -> tool_use: emit_itinerary({...})    # FORCED once nothing optional remains
         attach our verdicts + grounded budget + seasonality + holidays + flights -> render badges
```

Three things make this sturdy:

- **Forced verify-then-emit.** `tool_choice` forces `verify_places` as the *sole* tool on
  the first turn, and forces `emit_itinerary` at the end. The model can't hand back a plan
  it never grounded — grounding is **structural**, not a polite request in the prompt.
- **The optional tools are the agent's choice, gated to where they matter.** After
  verification, the model is offered the optional grounding tools it hasn't used yet —
  `check_route` (multi-city only), `estimate_costs`, `best_time_to_go`, and `find_flights` (only
  when a Duffel key is configured) — alongside `emit`, and must pick exactly one
  (`tool_choice: {type:"any", disable_parallel_tool_use:true}`). Each is gated to a single use, so
  the loop can't spin: at most one route + one cost + one timing + one flights turn before emit.
  Cost, timing and flights are only offered once the route is settled, so they compute against the
  final city set. A single-city trip is never offered `check_route`; a trip with no budget or timing
  angle just won't be steered to those tools; and with no Duffel key `find_flights` simply never
  appears. This adds the new tools **without** weakening the place-grounding guarantee:
  `verify_places` stays the lone forced tool on turn 1 regardless.
- **Streaming.** Each model call uses `client.messages.stream(...).finalMessage()` (no
  HTTP timeout on the large emit turn, room for `max_tokens` up to 64k on long trips), and
  the route streams phase + per-place + per-city progress events the whole way. A heartbeat
  keeps the connection visibly alive during the silent model turns.

The loop is bounded (`MAX_TURNS = 8`, worst legitimate path verify-retry → verify → route →
cost → timing → flights → emit) on purpose: every turn is a full, slow model call, and a free-form
loop ballooned to ~100s in testing.

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
they exclude flights and intercity transport (no free price source for those).

## Grounding the timing (the second deals step)

Knowing *when* to go is the other big free lever on a trip — shoulder season is cheaper and
quieter, and a brutal month can ruin a good route. The model has rough intuitions about seasons
but confidently gets the specifics wrong (which month is actually pleasant, how brutal a summer
is, that a tropical city's "season" is wet-vs-dry not hot-vs-cold). So `best_time_to_go` grounds
the timing the same way `verify_places` grounds places — in real, keyless data:

- **5 years of Open-Meteo ERA5 climate normals** (free, no key, real *observed* weather), fetched
  per city via the geocoder we already had and aggregated server-side into 12 monthly normals.
- **A comfort model** scores each month from the mean daily high (a temperature curve with a
  comfortable 20–26 °C band) minus a dryness penalty from rain days, then labels it
  peak/shoulder/off-season and derives the best months to go. A **tropical override** switches to
  ranking by rain where temperature is flat year-round; a **challenging-climate override** is
  honest about places no month makes truly comfortable. Hemisphere falls out of the real numbers —
  no "summer = July" assumption to get backwards.

When the brief implies a month, the tool assesses it ("August: off-season in Seville — extreme
heat, 37 °C") so the agent can warn the traveler and suggest a better window, or adapt the plan
(early starts, shaded afternoons, rain backups). Like the budget, the **displayed seasonality is
server-attached** (`annotateItinerary`, with the target-month verdict recomputed from the final
cities), never the model's claim. It now also grounds **daylight hours, a "feels-like" heat read,
and air quality** per month (computed from the same geocode/fetch, server-side, with no extra model
turn) — but still no tourist crowds (no keyless source), so a caveat says a weather-mild month can
still be the busiest, and the air-quality figure is flagged as a monthly normal, not a live reading.

## Grounding the flights (the first keyed tool)

Every tool so far is keyless. Real flight prices aren't: there's no reliable free, keyless source
(the budget tool says as much and excludes flights on purpose). So `find_flights` is the project's
**first tool that needs an API key** — and the point is as much the *pattern* as the prices:
**graceful degradation around an optional capability.**

- **No key → the app is unchanged.** When `DUFFEL_API_KEY` is unset, the loop never offers the
  tool and the flights clause is dropped from the system prompt, so the model can't even try. The
  five keyless tools carry the whole plan exactly as before — no error, no empty block. Degradation
  is a *first-class return value* (`{ source: "unavailable", reason }`), never a thrown exception.
- **A free Duffel TEST key → the integration lights up, honestly labelled.** Duffel's test mode is
  free (no card), but its fares are **synthetic** — a sandbox airline, not real prices (the docs say
  so outright). The tool flags this `testMode`, and the UI shows a loud "test data" badge and a
  disclaimer. That's the same honest-about-limits stance the season tool takes on crowds: show the
  real thing the tool *can* ground, and be blunt about what it can't.
- **A live key → real fares, same code.** A production token returns real fares with no disclaimer;
  nothing else changes.

Mechanically (raw `fetch`, no SDK, so the HTTP stays visible): resolve each city to an IATA code via
Duffel's own Places endpoint, then one round-trip offer request (two slices, out + return) sorted to
the cheapest economy offer. Two wrinkles that earlier tools never had: a flight needs an **origin**
(inferred from the brief — if you don't say where you're leaving from, it skips flights rather than
guess), and an exact **date** (we use a representative mid-month proxy from the travel month, so the
fare is a *sample for that month*, not a quote for your trip). Like every other tool, the displayed
fare is **server-attached** (`annotateItinerary`), never the model's claim.

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
   schema (`itinerarySchema.safeParse` drops the `verified`/`matched`/`budget`/`season` keys),
   leaving a clean `Itinerary` to embed. If the change is empty/oversized or the plan doesn't
   parse, it ignores the refine and plans fresh.
2. **Seeds the conversation** as `[user: brief] (+ clarify replay) + [assistant: the prior
   plan] + [user: the change]`, then runs the **same** forced-verify → optional grounding →
   forced-emit loop. No second loop, no new endpoint.

Because the loop is reused unchanged, a refine is **re-grounded** (every place re-verified) and
**re-routed / re-priced / re-timed** whenever the relevant part changes — `multiCity` is
re-detected from the revised plan. This is the next concept past the within-request agent loop:
**conversation state carried across requests**, held client-side (like the clarifications) so it
stays stateless-serverless friendly. Each refine re-verifies the whole plan, so it costs about as
much as the first plan — correct, just heavier; fine for v1 (and the season cache makes a
same-cities re-timing near-free).

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
  pricey capital from a cheap town in the same country. Treat the total as a planning ballpark.
- **The season is weather, not crowds.** `best_time_to_go` grounds the *weather* per month from
  real climate normals (temperature + rain). It has **no** data on tourist crowds, prices, school
  holidays, or festivals — a month that's mild by weather can still be the busiest of the year. The
  comfort labels are tunable heuristics for a general traveler, and the normals are a 5-year recent
  average, not a guarantee for any one trip. Treat the labels as a strong steer, not a forecast.
- **Flights are off by default, and test fares are synthetic.** `find_flights` only runs when a
  Duffel API key is set; otherwise there's simply no flight block. With a free Duffel *test* key the
  fares are **synthetic sandbox data** (a fake airline), shown with a "test data" badge — they prove
  the integration, not real prices. Real fares need a live Duffel token. Either way it prices a
  single representative mid-month round-trip (one origin, economy, 1 adult) — a planning ballpark,
  not your actual itinerary's fares.
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
7. ✅ **Deals, part 2 — timing grounding — done.** A fourth grounding tool, `best_time_to_go`,
   grounds *when* to go in real Open-Meteo climate normals (keyless, free) — peak/shoulder/off
   season per month, a best-window recommendation, and a verdict on the traveler's chosen month.
   Shoulder season is the biggest free lever on price and crowds, so it's the natural next deals
   signal after budget.
8. ✅ **Flight search — done.** `find_flights` (Duffel) is the first **keyed** tool — optional, and
   degrading gracefully to nothing when no key is set. Free Duffel test fares are synthetic (badged
   "test data"); a live key returns real fares. The pattern it teaches is the keyed-tool +
   graceful-degradation shape the all-in-one vision needs.
9. ✅ **Cross-currency display — done.** Budgets (USD) and Duffel fares (any currency) are converted
   to your home currency (default AUD) at live **ECB** reference rates (keyless, via Frankfurter).
   The lesson it teaches: the first grounding that *isn't* a model tool — an exchange rate is a fact,
   not a decision, so it's a pure server-side transform run after the tool returns, fed back into the
   model's prose so nothing shows `$` next to `£`.
10. ✅ **More grounding since — done.** Further milestones followed the same server-attached pattern:
    a bounded auto-repair verify round, booking-ready flight detail + smart flight selection, **public
    holidays** (Nager.Date), real **road travel times** between cities (OSRM), **daylight hours**, and a
    **"feels-like" heat + air-quality** pass — all folded into `best_time_to_go` as deterministic
    enrichments (no new tool, no extra model turn), so a December plan in Reykjavik front-loads outdoor
    sightseeing around ~4h of light, Dubai in August warns of ~45°C feels-like heat, and Delhi in
    November flags typically unhealthy air with an N95 nudge.
11. Then the rest of the vision: deeper deals and eventually booking — each a new tool on the same
    agent.
