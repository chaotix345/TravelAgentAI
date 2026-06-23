"use client";

import { useState } from "react";
import type { VerifiedItinerary, VerifiedDay, VerifiedActivity } from "@/lib/schema";
import { SAMPLE_BRIEFS } from "@/lib/sampleBriefs";

const MAX_BRIEF_CHARS = 4000;
// The route streams progress events as it works. We don't cap total time (a 4-week plan
// is legitimately slow); instead we abort only if the stream goes silent — the server's
// heartbeat keeps this from tripping during a long drafting/routing/finalizing turn.
const IDLE_TIMEOUT_MS = 45_000;
const DEPTH_OPTIONS = ["Go deep", "Go broad", "You decide"];

// Mirror of the server's PlanEvent (app/api/plan/route.ts). Kept local so the client
// bundle doesn't pull in server-only code.
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

type ClarifyQuestion = { id: "depth" | "constraints"; prompt: string };
type Clarification = { prompt: string; answer: string };

type Progress =
  | { phase: "drafting" | "finalizing" }
  | { phase: "verifying"; done: number; total: number }
  | { phase: "routing"; done: number; total: number; name?: string };

export default function Home() {
  const [brief, setBrief] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itinerary, setItinerary] = useState<VerifiedItinerary | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [questions, setQuestions] = useState<ClarifyQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // Step 1: ask the intake step whether it wants to clarify anything. If it does, show the
  // questions and wait; if not (or it errors), go straight to planning.
  async function onPlan() {
    if (!brief.trim() || loading) return;
    setError(null);
    setItinerary(null);
    setQuestions(null);
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
    await runPlan([]);
  }

  function onAnswersSubmit() {
    const qs = questions ?? [];
    const clarifications: Clarification[] = qs
      .map((q) => ({ prompt: q.prompt, answer: (answers[q.id] ?? "").trim() }))
      .filter((c) => c.answer.length > 0);
    setQuestions(null);
    setLoading(true);
    void runPlan(clarifications);
  }

  // Step 2: stream the plan. Reads the route's NDJSON events and drives the progress UI.
  async function runPlan(clarifications: Clarification[]) {
    setError(null);
    setItinerary(null);
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
        body: JSON.stringify({ brief, clarifications }),
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
            } else if (evt.phase === "routing") {
              // Heartbeats during the route turn carry no counts — don't let them blank an
              // active geocoding bar; keep the last routing counts until a real tick lands.
              setProgress((prev) =>
                evt.total && evt.total > 0
                  ? { phase: "routing", done: evt.done ?? 0, total: evt.total, name: evt.name }
                  : prev && prev.phase === "routing"
                    ? prev
                    : { phase: "routing", done: 0, total: 0 },
              );
            } else {
              setProgress({ phase: evt.phase });
            }
          } else if (evt.type === "progress") {
            setProgress({ phase: "verifying", done: evt.done, total: evt.total });
          } else if (evt.type === "itinerary") {
            setItinerary(evt.itinerary);
            gotItinerary = true;
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
          onSubmit={onAnswersSubmit}
          onSkip={() => {
            setQuestions(null);
            setLoading(true);
            void runPlan([]);
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
    </main>
  );
}

function ClarifyForm({
  questions,
  answers,
  setAnswers,
  onSubmit,
  onSkip,
}: {
  questions: ClarifyQuestion[];
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
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
        <button className="go" type="button" onClick={onSubmit}>
          Plan my trip
        </button>
        <button className="link" type="button" onClick={onSkip}>
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
          : "Finalizing your itinerary…";

  const pct =
    (progress?.phase === "verifying" || progress?.phase === "routing") && progress.total > 0
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

      {itinerary.cities.map((city, i) => (
        <article className="city" key={`${city.name}-${i}`}>
          <div className="city-head">
            <h2>
              {city.name}
              {city.country ? `, ${city.country}` : ""} <span className="nights">· {city.nights} nights</span>
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
