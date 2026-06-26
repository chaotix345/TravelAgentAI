"use client";

import { useEffect, useState } from "react";
import type {
  VerifiedItinerary,
  VerifiedDay,
  VerifiedActivity,
  VerifiedCity,
  BudgetSummary,
  FlightSummary,
  FlightConditions,
  SliceBaggage,
  SeasonSummary,
  CitySeasonSummary,
  SeasonLabel,
} from "@/lib/schema";
import { SAMPLE_BRIEFS } from "@/lib/sampleBriefs";

const MAX_BRIEF_CHARS = 4000;
// The route streams progress events as it works. We don't cap total time (a 4-week plan
// is legitimately slow); instead we abort only if the stream goes silent — the server's
// heartbeat keeps this from tripping during a long drafting/routing/finalizing turn.
const IDLE_TIMEOUT_MS = 45_000;
const DEPTH_OPTIONS = ["Go deep", "Go broad", "You decide"];
// One-tap refine presets. Each sends its own label as the change instruction; the planner
// applies it and streams back a single re-grounded plan.
const BASE_REFINE_CHIPS = ["Make it broader", "Make days lighter", "More food", "More nightlife"];
// Offered only once a flight has actually been priced. It re-runs the whole find_flights path
// (refine re-grounds everything) — the decisive alternative to a "pick a different flight" menu on
// the card itself.
const FLIGHT_REFINE_CHIP = "Different flight option";

// Mirror of the server's PlanEvent (app/api/plan/route.ts). Kept local so the client
// bundle doesn't pull in server-only code.
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
        | "flights"
        | "finalizing";
      done?: number;
      total?: number;
      name?: string;
    }
  | { type: "progress"; done: number; total: number; name: string; found: boolean }
  | { type: "itinerary"; itinerary: VerifiedItinerary }
  | { type: "error"; message: string };

type ClarifyQuestion = { id: "depth" | "constraints"; prompt: string };
type Clarification = { prompt: string; answer: string };

type Progress =
  | { phase: "drafting" | "finalizing" }
  | { phase: "verifying"; done: number; total: number }
  | {
      phase: "routing" | "pricing" | "timing" | "regrounding";
      done: number;
      total: number;
      name?: string;
    }
  | { phase: "flights"; name?: string };

// What runPlan needs: the brief + clarifications context, and — for a concierge tweak — the
// latest plan plus the change to apply. A refine reuses the ORIGINAL brief/clarifications so
// it stays anchored to the trip's full context even if the textarea was edited afterwards.
type RunPlanOpts = {
  brief: string;
  clarifications: Clarification[];
  origin?: string;
  refine?: { itinerary: VerifiedItinerary; instruction: string };
};

export default function Home() {
  const [brief, setBrief] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itinerary, setItinerary] = useState<VerifiedItinerary | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [questions, setQuestions] = useState<ClarifyQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Concierge/refine state. lastBrief + lastClarifications are the context that produced the
  // current plan; refines replay them so each tweak builds on the original trip, not the
  // (possibly edited) textarea. refineLog is the running list of tweaks already applied.
  const [lastBrief, setLastBrief] = useState("");
  const [lastClarifications, setLastClarifications] = useState<Clarification[]>([]);
  const [refineLog, setRefineLog] = useState<string[]>([]);
  const [refineText, setRefineText] = useState("");
  // The explicit departure city (the "Flying from?" field) and whether this deployment can even
  // price flights. capabilities starts at the safe keyless default so the origin input is simply
  // absent until /api/capabilities confirms a Duffel key — no layout flash, and the keyless app
  // renders byte-for-byte as before. lastOrigin snapshots the origin that produced the current plan
  // so refines stay anchored to it (mirrors lastBrief/lastClarifications).
  const [origin, setOrigin] = useState("");
  const [lastOrigin, setLastOrigin] = useState("");
  const [capabilities, setCapabilities] = useState<{ flights: boolean; homeCurrency: string }>({
    flights: false,
    homeCurrency: "AUD",
  });

  // Discover capabilities once on mount. Best-effort, exactly like /api/clarify: any failure keeps
  // the safe keyless default, so a hiccup just hides the flights affordance rather than erroring.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setCapabilities({
          flights: !!d.flights,
          homeCurrency: typeof d.homeCurrency === "string" ? d.homeCurrency : "AUD",
        });
      })
      .catch(() => {
        /* best-effort — keep the keyless default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 1: ask the intake step whether it wants to clarify anything. If it does, show the
  // questions and wait; if not (or it errors), go straight to planning.
  async function onPlan() {
    if (!brief.trim() || loading) return;
    setError(null);
    setItinerary(null);
    setQuestions(null);
    setRefineLog([]);
    setRefineText("");
    setLoading(true);

    try {
      const res = await fetch("/api/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      const data = await res.json().catch(() => null);
      const qs: ClarifyQuestion[] = Array.isArray(data?.questions) ? data.questions : [];
      if (qs.length > 0) {
        setQuestions(qs);
        setAnswers({});
        setLoading(false);
        return; // wait for the traveler to answer
      }
    } catch {
      // Clarify is best-effort — fall through to planning.
    }
    await runPlan({ brief, clarifications: [], origin });
  }

  function onAnswersSubmit() {
    if (loading) return;
    const qs = questions ?? [];
    const clarifications: Clarification[] = qs
      .map((q) => ({ prompt: q.prompt, answer: (answers[q.id] ?? "").trim() }))
      .filter((c) => c.answer.length > 0);
    setQuestions(null);
    setLoading(true);
    void runPlan({ brief, clarifications, origin });
  }

  // Concierge step: apply a change to the current plan. Sends the LATEST itinerary (prior
  // tweaks are already baked in, so we don't replay the whole refine history) plus the new
  // instruction; the server strips our annotations, re-grounds, and streams a revised plan
  // in place. Empty/whitespace instructions are ignored here.
  function onRefine(instruction: string) {
    const text = instruction.trim();
    if (!text || loading || !itinerary) return;
    setRefineText("");
    setLoading(true);
    void runPlan({
      brief: lastBrief,
      clarifications: lastClarifications,
      origin: lastOrigin,
      refine: { itinerary, instruction: text },
    });
  }

  // Step 2: stream the plan (initial or refined). Reads the route's NDJSON events and drives
  // the progress UI. A refine keeps the existing plan on screen while the new one streams.
  async function runPlan(opts: RunPlanOpts) {
    setError(null);
    if (!opts.refine) setItinerary(null); // a refine re-streams in place — keep the old plan up
    setProgress({ phase: "drafting" });

    const controller = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };
    resetIdle();

    let gotItinerary = false;
    let gotError = false;

    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: opts.brief,
          clarifications: opts.clarifications,
          origin: opts.origin,
          refine: opts.refine,
        }),
        signal: controller.signal,
      });

      // Pre-stream failure: the server sent a normal JSON error, not the event stream.
      if (!res.ok || !res.body) {
        let message = "Something went wrong.";
        try {
          const data = await res.json();
          message = data?.error ?? message;
        } catch {
          message = `The server returned an unexpected response (status ${res.status}).`;
        }
        setError(message);
        gotError = true;
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;

          let evt: PlanEvent;
          try {
            evt = JSON.parse(line) as PlanEvent;
          } catch {
            continue; // ignore a malformed line rather than crash the whole read
          }

          if (evt.type === "status") {
            if (evt.phase === "verifying") {
              setProgress({ phase: "verifying", done: evt.done ?? 0, total: evt.total ?? 0 });
            } else if (
              evt.phase === "routing" ||
              evt.phase === "pricing" ||
              evt.phase === "timing" ||
              evt.phase === "regrounding"
            ) {
              // Heartbeats during the route/cost/timing/repair turn carry no counts — don't let them
              // blank an active bar; keep the last counts for this phase until a real tick lands.
              const ph = evt.phase;
              setProgress((prev) =>
                evt.total && evt.total > 0
                  ? { phase: ph, done: evt.done ?? 0, total: evt.total, name: evt.name }
                  : prev && prev.phase === ph
                    ? prev
                    : { phase: ph, done: 0, total: 0 },
              );
            } else if (evt.phase === "flights") {
              // Flights has no per-city counts — just a label. Keep the last label across the
              // heartbeats (which carry no name) so the line doesn't flicker back to bare.
              const nm = evt.name;
              setProgress((prev) => ({
                phase: "flights",
                name: nm ?? (prev && prev.phase === "flights" ? prev.name : undefined),
              }));
            } else {
              setProgress({ phase: evt.phase });
            }
          } else if (evt.type === "progress") {
            setProgress({ phase: "verifying", done: evt.done, total: evt.total });
          } else if (evt.type === "itinerary") {
            setItinerary(evt.itinerary);
            gotItinerary = true;
            // Remember the context that produced this plan so later refines stay anchored to
            // it. For a refine, record the tweak in the running log.
            setLastBrief(opts.brief);
            setLastClarifications(opts.clarifications);
            setLastOrigin(opts.origin ?? "");
            if (opts.refine) {
              const applied = opts.refine.instruction;
              setRefineLog((log) => [...log, applied]);
            }
          } else if (evt.type === "error") {
            setError(evt.message);
            gotError = true;
          }
        }
      }

      if (!gotItinerary && !gotError) {
        setError("The planner stopped early. Try again.");
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError("The planner went quiet for too long. Try again, or try a shorter trip.");
      } else {
        setError("Could not reach the planner. Is the dev server running?");
      }
    } finally {
      if (idle) clearTimeout(idle);
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <main className="wrap">
      <header>
        <h1>TravelAgentAI</h1>
        <p>Tell it what you want out of a trip. It hands you one plan, not a menu.</p>
      </header>

      <textarea
        id="brief"
        aria-label="Describe your trip"
        value={brief}
        maxLength={MAX_BRIEF_CHARS}
        onChange={(e) => {
          setBrief(e.target.value);
          if (questions) setQuestions(null); // editing the brief invalidates pending questions
        }}
        placeholder="e.g. Europe in December for 4 weeks, mid-budget, love food and history, hate early mornings…"
      />

      <div className="chips">
        {SAMPLE_BRIEFS.map((s) => (
          <button
            key={s}
            className="chip"
            onClick={() => {
              setBrief(s);
              setQuestions(null);
            }}
            type="button"
          >
            {s}
          </button>
        ))}
      </div>

      {capabilities.flights && (
        <div className="origin">
          <label htmlFor="origin" className="q-label">
            Flying from?
          </label>
          <input
            id="origin"
            type="text"
            className="q-input"
            value={origin}
            maxLength={120}
            disabled={loading}
            aria-describedby="origin-hint"
            placeholder="e.g. Sydney, London, New York — to price your flights"
            onChange={(e) => setOrigin(e.target.value)}
          />
          <p id="origin-hint" className="origin-hint">
            Optional. Add your departure city and I&apos;ll price round-trip flights
            {capabilities.homeCurrency !== "USD" ? ` in ${capabilities.homeCurrency}` : ""}.
          </p>
        </div>
      )}

      {!questions && (
        <div className="row">
          <button
            className="go"
            onClick={onPlan}
            disabled={loading || !brief.trim()}
            aria-busy={loading}
            type="button"
          >
            {loading ? "Planning…" : "Plan my trip"}
          </button>
        </div>
      )}

      {questions && (
        <ClarifyForm
          questions={questions}
          answers={answers}
          setAnswers={setAnswers}
          loading={loading}
          onSubmit={onAnswersSubmit}
          onSkip={() => {
            if (loading) return;
            setQuestions(null);
            setLoading(true);
            void runPlan({ brief, clarifications: [], origin });
          }}
        />
      )}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && <ProgressView progress={progress} />}

      {itinerary && <Plan itinerary={itinerary} onRefine={onRefine} loading={loading} />}

      {itinerary && (
        <RefineComposer
          log={refineLog}
          value={refineText}
          setValue={setRefineText}
          onRefine={onRefine}
          loading={loading}
          chips={itinerary.flights ? [...BASE_REFINE_CHIPS, FLIGHT_REFINE_CHIP] : BASE_REFINE_CHIPS}
        />
      )}

      <footer className="sources">
        Grounded with free, keyless data: place checks via OpenStreetMap &amp; Wikipedia, distances
        via OpenStreetMap, cost levels via World Bank &amp; Wikivoyage, and climate via{" "}
        <a href="https://open-meteo.com" target="_blank" rel="noreferrer noopener">
          Open-Meteo
        </a>{" "}
        (CC BY 4.0). Flight fares, when a{" "}
        <a href="https://duffel.com" target="_blank" rel="noreferrer noopener">
          Duffel
        </a>{" "}
        key is configured, come from its flight-search API — test-mode fares are illustrative, not
        real quotes. When a figure&apos;s currency differs from your home currency, it&apos;s
        converted at{" "}
        <a href="https://frankfurter.dev" target="_blank" rel="noreferrer noopener">
          European Central Bank reference rates
        </a>{" "}
        (when available). A planning aid, not a booking service.
      </footer>
    </main>
  );
}

function ClarifyForm({
  questions,
  answers,
  setAnswers,
  loading,
  onSubmit,
  onSkip,
}: {
  questions: ClarifyQuestion[];
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  loading: boolean;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="clarify">
      <p className="clarify-head">A couple of quick things, then I&apos;ll plan:</p>
      {questions.map((q) => (
        <div className="q" key={q.id}>
          <label className="q-label">{q.prompt}</label>
          {q.id === "depth" ? (
            <div className="opts">
              {DEPTH_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`opt ${answers[q.id] === opt ? "sel" : ""}`}
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : (
            <input
              type="text"
              className="q-input"
              placeholder="e.g. must include Porto; skip big cities — or leave blank"
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            />
          )}
        </div>
      ))}
      <div className="row">
        <button className="go" type="button" onClick={onSubmit} disabled={loading}>
          Plan my trip
        </button>
        <button className="link" type="button" onClick={onSkip} disabled={loading}>
          Skip, just plan it
        </button>
      </div>
    </div>
  );
}

function ProgressView({ progress }: { progress: Progress | null }) {
  const label =
    !progress || progress.phase === "drafting"
      ? "Building your route…"
      : progress.phase === "verifying"
        ? `Checking each place is real… ${progress.done}/${progress.total}`
        : progress.phase === "regrounding"
          ? progress.total > 0
            ? `Checking replacements… ${progress.done}/${progress.total}`
            : "Checking replacements…"
          : progress.phase === "routing"
            ? progress.total > 0
              ? `Sanity-checking the route… ${progress.done}/${progress.total} cities${
                  progress.name ? ` · ${progress.name}` : ""
                }`
              : "Sanity-checking the route…"
            : progress.phase === "pricing"
              ? progress.total > 0
                ? `Pricing the trip… ${progress.done}/${progress.total} cities${
                    progress.name ? ` · ${progress.name}` : ""
                  }`
                : "Pricing the trip…"
              : progress.phase === "timing"
                ? progress.total > 0
                  ? `Checking the best time to go… ${progress.done}/${progress.total} cities${
                      progress.name ? ` · ${progress.name}` : ""
                    }`
                  : "Checking the best time to go…"
                : progress.phase === "flights"
                  ? `Pricing flights…${progress.name ? ` · ${progress.name}` : ""}`
                  : "Finalizing your itinerary…";

  const pct =
    (progress?.phase === "verifying" ||
      progress?.phase === "routing" ||
      progress?.phase === "pricing" ||
      progress?.phase === "timing" ||
      progress?.phase === "regrounding") &&
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;

  return (
    <div className="loading" aria-live="polite">
      <p className="loading-line">
        <span className="spinner" aria-hidden="true" />
        {label}
      </p>
      {pct !== null && (
        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function Plan({
  itinerary,
  onRefine,
  loading,
}: {
  itinerary: VerifiedItinerary;
  onRefine: (instruction: string) => void;
  loading: boolean;
}) {
  return (
    <section className="plan">
      <p className="summary">{itinerary.summary}</p>
      <p className="meta">
        {itinerary.cities.length} {itinerary.cities.length === 1 ? "city" : "cities"} · {itinerary.totalNights} nights
      </p>

      {itinerary.budget && <BudgetBlock budget={itinerary.budget} />}
      {itinerary.flights && <FlightsBlock flights={itinerary.flights} />}
      {itinerary.season && <SeasonBlock season={itinerary.season} />}

      {itinerary.cities.map((city, i) => (
        <article className="city" key={`${city.name}-${i}`}>
          <div className="city-head">
            <h2>
              {city.name}
              {city.country ? `, ${city.country}` : ""} <span className="nights">· {city.nights} nights</span>
              <CityCostChip city={city} homeCurrency={itinerary.budget?.homeCurrency} />
            </h2>
            {city.why && <p className="why">{city.why}</p>}
          </div>
          {city.season && (
            <CitySeason season={city.season} targetMonth={itinerary.season?.targetMonth ?? null} />
          )}
          {city.days.map((day, j) => (
            <DayBlock
              key={`${city.name}-day-${j}`}
              day={day}
              cityName={city.name}
              onRefine={onRefine}
              loading={loading}
            />
          ))}
        </article>
      ))}
    </section>
  );
}

// The grounded budget, server-attached from the estimate_costs tool. Like the "✓ real" badge,
// these are the tool's numbers, not the model's — hence the "grounded" badge and the note on
// what's included. Shows only when the agent priced the trip.
function BudgetBlock({ budget }: { budget: BudgetSummary }) {
  const styleLabel = budget.style === "mid-range" ? "mid-range" : budget.style;
  // Show the home-currency figure as the headline and the native (USD) figure quietly beside it,
  // but only when a conversion actually ran (home differs from native and the rate landed). Falls
  // back to the native USD figure when FX was a no-op or failed — graceful degradation in the UI.
  const converted =
    budget.homeCurrency != null &&
    budget.totalHome != null &&
    budget.homeCurrency !== budget.currency;
  const totalText = converted
    ? `Est. ~${fmtMoney(budget.totalHome!, budget.homeCurrency!)}`
    : budget.totalUsd != null
      ? `Est. ~${fmtMoney(budget.totalUsd, budget.currency)}`
      : "Budget estimate";
  const nativeTotal =
    converted && budget.totalUsd != null ? `~${fmtMoney(budget.totalUsd, budget.currency)}` : null;
  const perDayText = converted
    ? budget.perDayHome != null
      ? `~${fmtMoney(budget.perDayHome, budget.homeCurrency!)}/day`
      : ""
    : budget.perDayUsd != null
      ? `~${fmtMoney(budget.perDayUsd, budget.currency)}/day`
      : "";
  return (
    <div className="budget">
      <div className="budget-head">
        <span className="budget-amount">{totalText}</span>
        {nativeTotal && <span className="budget-native">{nativeTotal}</span>}
        <span className="budget-sub">
          {styleLabel} · per person{perDayText ? ` · ${perDayText}` : ""}
        </span>
        <span
          className="badge ok"
          tabIndex={0}
          title="Grounded in World Bank price levels and Wikivoyage — a planning ballpark, not a live quote"
        >
          grounded
        </span>
      </div>
      {budget.flags.length > 0 && (
        <ul className="budget-flags">
          {budget.flags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <p className="budget-note">{budget.note}</p>
      {converted && budget.rate != null && (
        <FxNote native={budget.currency} home={budget.homeCurrency!} rate={budget.rate} date={budget.rateDate} />
      )}
    </div>
  );
}

// The exchange-rate provenance line, shown under a converted budget or fare. Like the climate
// CC-BY footer, it's honest about where the number came from — the ECB reference rate and its date
// — so a converted figure is never a mystery. Rendered only when a conversion actually happened.
function FxNote({
  native,
  home,
  rate,
  date,
}: {
  native: string;
  home: string;
  rate: number;
  date?: string;
}) {
  return (
    <p className="fx-note">
      Converted from {native} at the European Central Bank reference rate (1 {native} ={" "}
      {rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {home}
      {date ? `, ${date}` : ""}) via Frankfurter.
    </p>
  );
}

// Display symbols for the currencies Duffel quotes and the ECB set we convert into. Kept here
// (not imported from lib/currency.ts) so the client bundle pulls no server-only FX code — the same
// import-free discipline the schema types follow. Unknown codes fall back to the bare code.
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$", GBP: "£", EUR: "€", JPY: "¥", CAD: "C$", AUD: "A$", CHF: "CHF ", INR: "₹",
  NZD: "NZ$", SGD: "S$", HKD: "HK$", CNY: "¥", SEK: "kr ", NOK: "kr ", DKK: "kr ",
  PLN: "zł ", CZK: "Kč ", THB: "฿", ZAR: "R ", MXN: "MX$", BRL: "R$", KRW: "₩",
};
function fmtMoney(n: number, code: string): string {
  const sym = CURRENCY_SYMBOL[code] ?? (code ? `${code} ` : "$");
  return `${sym}${n.toLocaleString()}`;
}

// The grounded flights, server-attached from the find_flights (Duffel) tool — the FIRST keyed
// tool. Like the budget and season, the price shown is the tool's, not the model's. In Duffel TEST
// mode the fares are synthetic, so we show a loud "test data" badge and the disclaimer in the
// note; with a live key the same block reads "live fare". Renders only when the agent priced
// flights, which only happens when a Duffel key is configured (the graceful-degradation gate).
// Pull "HH:mm" out of an ISO 8601 datetime ("2026-06-15T09:45:00"). Duffel segment times are local
// to the airport, so we show them as-is — no timezone math, which would only mislead.
function fmtTime(iso: string | null): string {
  if (!iso) return "--:--";
  const t = iso.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(t) ? t : "--:--";
}

// One slice's checked-bag allowance, server-computed as the MIN across its segments. Distinguishes
// "0 = no checked bag" from "null = Duffel didn't report it" — never shows a misleading "0 bags".
function BaggageLine({ baggage }: { baggage: SliceBaggage }) {
  const n = baggage.checkedQuantity;
  const text =
    n == null
      ? "Checked-bag allowance not specified"
      : n === 0
        ? "No checked bag included"
        : `${n} checked bag${n === 1 ? "" : "s"} included`;
  return <p className="flights-baggage">{text}</p>;
}

// Offer-level fare rules from the enrich pass. Leads with the home-currency penalty when the FX pass
// converted it, else the native penalty; tells apart "allowed, fee not specified" from a real zero
// and an outright "not allowed", and falls back to "conditions unavailable" when nothing is known.
function ConditionsRow({ conditions }: { conditions: FlightConditions }) {
  const homeCur = conditions.penaltyHomeCurrency;
  const term = (
    allowed: boolean | null,
    amount: number | null,
    currency: string | null,
    home: number | null,
    label: string,
  ): string | null => {
    if (allowed === false) return `${label}: not allowed`;
    if (amount != null) {
      if (amount === 0) return `${label}: no fee`;
      const shown =
        home != null && homeCur != null
          ? fmtMoney(home, homeCur)
          : currency != null
            ? fmtMoney(amount, currency)
            : null;
      return shown ? `${label}: ${shown} fee` : `${label}: fee applies`;
    }
    if (allowed === true) return `${label}: allowed (fee not specified)`;
    return null;
  };
  const rows = [
    term(
      conditions.refundable,
      conditions.refundPenaltyAmount,
      conditions.refundPenaltyCurrency,
      conditions.refundPenaltyHome,
      "Refund",
    ),
    term(
      conditions.changeable,
      conditions.changePenaltyAmount,
      conditions.changePenaltyCurrency,
      conditions.changePenaltyHome,
      "Change",
    ),
  ].filter((r): r is string => r !== null);
  return (
    <p className="flights-conditions">{rows.length > 0 ? rows.join(" · ") : "Fare conditions unavailable"}</p>
  );
}

function FlightsBlock({ flights }: { flights: FlightSummary }) {
  const [detailOpen, setDetailOpen] = useState(false);
  // Offer expiry is computed CLIENT-SIDE on every render from the stored timestamp — no server
  // round-trip. A plan reopened hours later flips to the expired state on its own, and a refine's
  // fresh search overwrites expiresAt. testMode offers carry a synthetic expiry, so we gate all
  // expiry framing on a real (non-test) fare.
  const expiryMs = flights.expiresAt ? new Date(flights.expiresAt).getTime() : null;
  const isExpired = expiryMs != null && Date.now() > expiryMs;
  // Stops come from the outbound leg the tool counted; the card was silently dropping this.
  const outStops = flights.legs[0]?.stops ?? null;
  const stopsLabel =
    outStops === 0
      ? "nonstop"
      : outStops === 1
        ? "1 stop"
        : outStops != null
          ? `${outStops} stops`
          : null;
  const code = flights.currency ?? "";
  // Lead with the home-currency fare and keep Duffel's native quote beside it — this is what turns
  // a stray "A$126" sandbox fare into "≈ £66 (A$126)". Show native-only when no conversion ran.
  const converted =
    flights.homeCurrency != null &&
    flights.homeAmount != null &&
    flights.homeCurrency !== flights.currency;
  const nativeText = flights.totalAmount != null ? fmtMoney(flights.totalAmount, code) : null;
  const amount = converted
    ? fmtMoney(flights.homeAmount!, flights.homeCurrency!)
    : (nativeText ?? "Fare estimate");
  const nativeBeside = converted ? nativeText : null;

  const legs = flights.legs;
  // A symmetric there-and-back (same airports both ways) reads as "London ⇄ Lisbon"; an open-jaw
  // (fly into one city, home from another) lists each leg.
  const roundTrip =
    legs.length === 2 &&
    legs[0].fromCode === legs[1].toCode &&
    legs[0].toCode === legs[1].fromCode;
  const route =
    legs.length === 0
      ? ""
      : roundTrip
        ? `${legs[0].fromCity} ⇄ ${legs[0].toCity}`
        : legs.map((l) => `${l.fromCity} → ${l.toCity}`).join(" · ");

  return (
    <div className="flights">
      <div className="flights-head">
        <span className="flights-amount">{amount}</span>
        {nativeBeside && <span className="flights-native">{nativeBeside}</span>}
        <span className="flights-sub">
          round trip · per person{flights.airline ? ` · ${flights.airline}` : ""}
        </span>
        {!flights.testMode && isExpired ? (
          <span
            className="badge warn"
            tabIndex={0}
            title="This Duffel offer has expired and can no longer be booked. Re-plan to get a current fare."
          >
            expired
          </span>
        ) : flights.testMode ? (
          <span
            className="badge warn"
            tabIndex={0}
            title="Synthetic fares from Duffel's test environment — not a real, bookable price. Set a live Duffel key for real fares."
          >
            test data
          </span>
        ) : (
          <span
            className="badge ok"
            tabIndex={0}
            title="A live fare snapshot from Duffel — prices change, so treat it as a ballpark."
          >
            live fare
          </span>
        )}
      </div>
      {route && (
        <p className="flights-route">
          {route}
          {stopsLabel ? <span className="flights-stops"> · {stopsLabel}</span> : null}
        </p>
      )}
      <p className="flights-note">{flights.note}</p>
      {converted && flights.rate != null && (
        <FxNote
          native={flights.currency ?? ""}
          home={flights.homeCurrency!}
          rate={flights.rate}
          date={flights.rateDate}
        />
      )}
      {!flights.testMode && expiryMs != null && !isExpired && (
        <p className="flights-expiry">Fare valid for roughly 30 minutes from search — prices change.</p>
      )}
      {!flights.testMode && isExpired && (
        <p className="flights-expiry warn">This offer has expired — re-plan to get a current fare.</p>
      )}
      {flights.sliceSegments && flights.sliceSegments.length > 0 && !isExpired && (
        <>
          <button
            type="button"
            className="flights-detail-btn"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((o) => !o)}
          >
            {detailOpen ? "Hide flight details" : "Show flight details"}
          </button>
          {detailOpen && (
            <div className="flights-detail">
              {flights.testMode && (
                <p className="flights-detail-test">
                  Illustrative detail from Duffel&apos;s test environment — not a real flight.
                </p>
              )}
              {flights.sliceSegments.map((segs, si) => (
                <div className="flights-slice" key={si}>
                  <p className="flights-slice-label">{si === 0 ? "Outbound" : "Return"}</p>
                  {segs.map((seg, gi) => (
                    <div className="flights-segment" key={gi}>
                      {gi > 0 && segs[gi - 1].destinationCity && (
                        <p className="flights-connection">Connect in {segs[gi - 1].destinationCity}</p>
                      )}
                      <div className="flights-seg-line">
                        <span className="flights-seg-route">
                          {seg.origin ?? "?"} → {seg.destination ?? "?"}
                        </span>
                        {seg.departingAt && seg.arrivingAt && (
                          <span className="flights-seg-times">
                            {fmtTime(seg.departingAt)}–{fmtTime(seg.arrivingAt)}
                          </span>
                        )}
                        {seg.durationMinutes != null && (
                          <span className="flights-seg-dur">
                            {Math.floor(seg.durationMinutes / 60)}h {seg.durationMinutes % 60}m
                          </span>
                        )}
                      </div>
                      {(seg.carrierName || seg.flightDesignator) && (
                        <span className="flights-seg-flight">
                          {[seg.carrierName, seg.flightDesignator].filter(Boolean).join(" ")}
                        </span>
                      )}
                    </div>
                  ))}
                  {flights.sliceBaggage?.[si] && <BaggageLine baggage={flights.sliceBaggage[si]} />}
                </div>
              ))}
              {flights.conditions && <ConditionsRow conditions={flights.conditions} />}
              <p className="flights-booking-caveat">
                A planning reference — fares change and this is not a booking confirmation.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CityCostChip({ city, homeCurrency }: { city: VerifiedCity; homeCurrency?: string }) {
  const cost = city.cost;
  if (!cost || cost.tier === "unknown") return null;
  // Prefer the home-currency daily figure (when converted); fall back to the native USD one. The
  // Wikivoyage anchor prices in the tooltip stay in their own local currency — they're verbatim
  // real examples, not converted figures, so we leave them as sourced.
  const useHome = cost.dailyHome != null && homeCurrency != null;
  const daily = useHome ? cost.dailyHome! : cost.dailyUsd;
  const dailyCode = useHome ? homeCurrency! : "USD";
  const title =
    cost.anchors.length > 0
      ? `Example prices (Wikivoyage): ${cost.anchors.join(" · ")}`
      : "Cost level from World Bank price-level data";
  return (
    <span className={`cost-chip ${cost.tier}`} tabIndex={0} title={title}>
      {cost.tier}
      {daily != null ? ` · ~${fmtMoney(daily, dailyCode)}/day` : ""}
    </span>
  );
}

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const SEASON_WORD: Record<SeasonLabel, string> = {
  peak: "peak season",
  shoulder: "shoulder season",
  off: "off-season",
  "best-available": "the best available",
};

// The grounded seasonality, server-attached from the best_time_to_go tool. Trip-level block:
// the target-month verdict (the decisive "is your month any good" line), a legend for the
// per-city month strips below, and the honest weather-vs-crowds caveat. Like the budget, the
// labels are the tool's, not the model's.
function SeasonBlock({ season }: { season: SeasonSummary }) {
  const targetName = season.targetMonth ? MONTHS_FULL[season.targetMonth - 1] : null;
  return (
    <div className="season">
      <div className="season-head">
        <span className="season-title">When to go</span>
        <span
          className="badge ok"
          tabIndex={0}
          title="Grounded in Open-Meteo climate normals (ERA5) — real observed weather, not crowds"
        >
          grounded
        </span>
      </div>
      {season.targetAssessment && (
        <p className="season-target">
          {targetName ? <strong>{targetName}: </strong> : null}
          {season.targetAssessment.replace(/^[A-Z][a-z]+:\s*/, "")}
        </p>
      )}
      <div className="season-legend" aria-hidden="true">
        <span>
          <i className="mo peak" /> peak
        </span>
        <span>
          <i className="mo shoulder" /> shoulder
        </span>
        <span>
          <i className="mo off" /> off-season
        </span>
        {season.cities.some((c) => c.challenging) && (
          <span>
            <i className="mo best-available" /> best available
          </span>
        )}
      </div>
      <p className="season-note">
        {season.note} {season.caveat}
      </p>
    </div>
  );
}

// One city's 12-month weather strip: a cell per calendar month coloured by its season label,
// the trip's target month ringed. Hover a cell for that month's detail. Below it, the headline
// "best months" plus — when the trip has a target month — that month's verdict for this city.
function CitySeason({
  season,
  targetMonth,
}: {
  season: CitySeasonSummary;
  targetMonth: number | null;
}) {
  if (season.source !== "open-meteo" || season.months.length !== 12) return null;
  const tm = targetMonth ? season.months[targetMonth - 1] : null;
  return (
    <div className="city-season">
      <div className="months" role="img" aria-label={`Monthly weather for ${season.name}`}>
        {season.months.map((m) => (
          <span
            key={m.month}
            className={`mo ${m.label}${targetMonth === m.month ? " target" : ""}`}
            tabIndex={0}
            title={`${MONTHS_FULL[m.month - 1]}: ${m.temp}, ${m.meanMaxC}°C highs, ${m.rain}${
              m.flags.length ? ` — ${m.flags.join("; ")}` : ""
            } · ${SEASON_WORD[m.label] ?? m.label}`}
          >
            {MONTH_INITIALS[m.month - 1]}
          </span>
        ))}
      </div>
      <p className="city-season-cap">
        {season.bestWindow}
        {tm && (
          <>
            {" · "}
            <span className={`season-tag ${tm.label}`}>
              {MONTHS_FULL[tm.month - 1]}: {SEASON_WORD[tm.label] ?? tm.label}, {tm.meanMaxC}°C
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function DayBlock({
  day,
  cityName,
  onRefine,
  loading,
}: {
  day: VerifiedDay;
  cityName: string;
  onRefine: (instruction: string) => void;
  loading: boolean;
}) {
  const slotProps = { cityName, dayLabel: day.label, onRefine, loading };
  return (
    <div className="day">
      <h3>{day.label}</h3>
      <Slot when="Morning" act={day.morning} {...slotProps} />
      <Slot when="Afternoon" act={day.afternoon} {...slotProps} />
      <Slot when="Evening" act={day.evening} {...slotProps} />
    </div>
  );
}

function Slot({
  when,
  act,
  cityName,
  dayLabel,
  onRefine,
  loading,
}: {
  when: string;
  act: VerifiedActivity;
  cityName: string;
  dayLabel: string;
  onRefine: (instruction: string) => void;
  loading: boolean;
}) {
  // One-tap repair for a place the free geo database couldn't confirm. We build a tightly-scoped
  // refine instruction keyed on city + day + time-of-day + name, so the planner swaps exactly this
  // activity and nothing else, then re-grounds the whole plan through the same loop. The activity
  // name is sanitized (control + Unicode-format chars stripped) before it goes into the string —
  // defense in depth; the server sanitizes the instruction again at the trust boundary.
  const swap = () => {
    const slot = when.toLowerCase();
    // Strip control/format chars, and neutralize double-quotes in the city/day labels since they sit
    // inside quotes in the instruction (a stray quote would break the scoping). The server sanitizes
    // the whole instruction again at the trust boundary — this is defense in depth.
    const clean = (s: string) =>
      s.replace(/[\x00-\x1f\x7f-\x9f\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
    const safeName = clean(act.name).replace(/"/g, "'");
    const safeCity = clean(cityName).replace(/"/g, "'");
    const safeDay = clean(dayLabel).replace(/"/g, "'");
    onRefine(
      `In ${safeCity}, on "${safeDay}", swap only the ${slot} activity — "${safeName}" couldn't be verified in the geo database. Replace it with a different real place in ${safeCity} that fits the ${slot} and the trip's mood, and keep every other activity, city, and day exactly as they are.`,
    );
  };
  return (
    <div className="slot">
      <div className="when">{when}</div>
      <div>
        <span className="name">{act.name}</span>
        {act.verified === "confirmed" && (
          <span
            className="badge ok"
            title={act.matched ? `Found in OpenStreetMap/Wikipedia: ${act.matched}` : "Verified as a real place"}
          >
            ✓ real
          </span>
        )}
        {act.verified === "unconfirmed" && (
          <>
            <span
              className="badge warn"
              title="Not in our free geo database — may still be real, just not listed there"
            >
              unconfirmed
            </span>
            <button
              type="button"
              className="swap-btn"
              onClick={swap}
              disabled={loading}
              aria-label={`Find alternative for ${act.name}`}
              title="Have the planner replace this with a place it can verify, and re-check the plan"
            >
              find alternative
            </button>
          </>
        )}
        {act.why && <div className="act-why">{act.why}</div>}
      </div>
    </div>
  );
}

// The concierge composer: ask for a change and get back one re-grounded plan. Chips are
// one-tap presets; the input takes anything ("swap Coimbra for Braga", "drop a city"). Both
// route through onRefine, which re-runs the whole verify → route → emit loop server-side.
function RefineComposer({
  log,
  value,
  setValue,
  onRefine,
  loading,
  chips,
}: {
  log: string[];
  value: string;
  setValue: (v: string) => void;
  onRefine: (instruction: string) => void;
  loading: boolean;
  chips: string[];
}) {
  return (
    <section className="refine">
      <h3 className="refine-head">Want to tweak it?</h3>
      <p className="refine-sub">
        Ask for a change and I&apos;ll hand back one revised plan, re-checked and re-routed.
      </p>

      {log.length > 0 && (
        <ul className="refine-log">
          {log.map((t, i) => (
            <li key={`${i}-${t}`}>{t}</li>
          ))}
        </ul>
      )}

      <div className="chips">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            className="chip"
            disabled={loading}
            onClick={() => onRefine(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="row">
        <input
          type="text"
          className="refine-input"
          aria-label="Describe a change to your plan"
          value={value}
          disabled={loading}
          placeholder="e.g. swap Coimbra for Braga, make day 2 lighter, add a city…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRefine(value);
            }
          }}
        />
        <button
          className="go"
          type="button"
          disabled={loading || !value.trim()}
          onClick={() => onRefine(value)}
        >
          {loading ? "Refining…" : "Refine"}
        </button>
      </div>
    </section>
  );
}
