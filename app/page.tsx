"use client";

import { useState } from "react";
import type {
  VerifiedItinerary,
  VerifiedDay,
  VerifiedActivity,
  VerifiedCity,
  BudgetSummary,
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
const REFINE_CHIPS = ["Make it broader", "Make days lighter", "More food", "More nightlife"];

// Mirror of the server's PlanEvent (app/api/plan/route.ts). Kept local so the client
// bundle doesn't pull in server-only code.
type PlanEvent =
  | {
      type: "status";
      phase: "drafting" | "verifying" | "routing" | "pricing" | "finalizing";
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
  | { phase: "routing" | "pricing"; done: number; total: number; name?: string };

// What runPlan needs: the brief + clarifications context, and — for a concierge tweak — the
// latest plan plus the change to apply. A refine reuses the ORIGINAL brief/clarifications so
// it stays anchored to the trip's full context even if the textarea was edited afterwards.
type RunPlanOpts = {
  brief: string;
  clarifications: Clarification[];
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
    await runPlan({ brief, clarifications: [] });
  }

  function onAnswersSubmit() {
    if (loading) return;
    const qs = questions ?? [];
    const clarifications: Clarification[] = qs
      .map((q) => ({ prompt: q.prompt, answer: (answers[q.id] ?? "").trim() }))
      .filter((c) => c.answer.length > 0);
    setQuestions(null);
    setLoading(true);
    void runPlan({ brief, clarifications });
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
            } else if (evt.phase === "routing" || evt.phase === "pricing") {
              // Heartbeats during the route/cost turn carry no counts — don't let them blank an
              // active bar; keep the last counts for this phase until a real tick lands.
              const ph = evt.phase;
              setProgress((prev) =>
                evt.total && evt.total > 0
                  ? { phase: ph, done: evt.done ?? 0, total: evt.total, name: evt.name }
                  : prev && prev.phase === ph
                    ? prev
                    : { phase: ph, done: 0, total: 0 },
              );
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
            void runPlan({ brief, clarifications: [] });
          }}
        />
      )}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && <ProgressView progress={progress} />}

      {itinerary && <Plan itinerary={itinerary} />}

      {itinerary && (
        <RefineComposer
          log={refineLog}
          value={refineText}
          setValue={setRefineText}
          onRefine={onRefine}
          loading={loading}
        />
      )}
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
            : "Finalizing your itinerary…";

  const pct =
    (progress?.phase === "verifying" ||
      progress?.phase === "routing" ||
      progress?.phase === "pricing") &&
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

function Plan({ itinerary }: { itinerary: VerifiedItinerary }) {
  return (
    <section className="plan">
      <p className="summary">{itinerary.summary}</p>
      <p className="meta">
        {itinerary.cities.length} {itinerary.cities.length === 1 ? "city" : "cities"} · {itinerary.totalNights} nights
      </p>

      {itinerary.budget && <BudgetBlock budget={itinerary.budget} />}

      {itinerary.cities.map((city, i) => (
        <article className="city" key={`${city.name}-${i}`}>
          <div className="city-head">
            <h2>
              {city.name}
              {city.country ? `, ${city.country}` : ""} <span className="nights">· {city.nights} nights</span>
              <CityCostChip city={city} />
            </h2>
            {city.why && <p className="why">{city.why}</p>}
          </div>
          {city.days.map((day, j) => (
            <DayBlock key={`${city.name}-day-${j}`} day={day} />
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
  return (
    <div className="budget">
      <div className="budget-head">
        <span className="budget-amount">
          {budget.totalUsd != null ? `Est. ~$${budget.totalUsd.toLocaleString()}` : "Budget estimate"}
        </span>
        <span className="budget-sub">
          {styleLabel} · per person{budget.perDayUsd != null ? ` · ~$${budget.perDayUsd}/day` : ""}
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
    </div>
  );
}

function CityCostChip({ city }: { city: VerifiedCity }) {
  const cost = city.cost;
  if (!cost || cost.tier === "unknown") return null;
  const title =
    cost.anchors.length > 0
      ? `Example prices (Wikivoyage): ${cost.anchors.join(" · ")}`
      : "Cost level from World Bank price-level data";
  return (
    <span className={`cost-chip ${cost.tier}`} tabIndex={0} title={title}>
      {cost.tier}
      {cost.dailyUsd != null ? ` · ~$${cost.dailyUsd}/day` : ""}
    </span>
  );
}

function DayBlock({ day }: { day: VerifiedDay }) {
  return (
    <div className="day">
      <h3>{day.label}</h3>
      <Slot when="Morning" act={day.morning} />
      <Slot when="Afternoon" act={day.afternoon} />
      <Slot when="Evening" act={day.evening} />
    </div>
  );
}

function Slot({ when, act }: { when: string; act: VerifiedActivity }) {
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
          <span
            className="badge warn"
            title="Couldn't confirm this one in the free geo database — treat with caution"
          >
            unconfirmed
          </span>
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
}: {
  log: string[];
  value: string;
  setValue: (v: string) => void;
  onRefine: (instruction: string) => void;
  loading: boolean;
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
        {REFINE_CHIPS.map((c) => (
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
