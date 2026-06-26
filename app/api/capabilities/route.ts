import { NextResponse } from "next/server";
import { homeCurrency } from "@/lib/currency";

export const runtime = "nodejs";

// Advertises which optional capabilities THIS deployment has configured, so the client can render
// capability-gated affordances (the "Flying from?" origin input) without leaving a dead control
// when the underlying key is absent. It mirrors the server-side gate in app/api/plan/route.ts
// (flights are offered only when DUFFEL_API_KEY is set), so the UI and the agent loop agree on what
// the app can do.
//
// What it reveals is deliberately minimal: a BOOLEAN that a Duffel key exists (never the key
// itself) plus the home/display currency — the same facts already inferable from whether a plan
// shows a flight block and which currency its figures use. So there's nothing here that the app's
// own output doesn't already disclose.
export async function GET() {
  return NextResponse.json(
    { flights: !!process.env.DUFFEL_API_KEY, homeCurrency: homeCurrency() },
    {
      headers: {
        // The value is per-instance and env-derived, so keep a CDN/edge from caching one
        // deployment's answer and serving a stale "flights:false" to users after a key is
        // added (or vice-versa). Private + a short max-age is plenty for a capability ping.
        "Cache-Control": "private, max-age=60",
      },
    },
  );
}
