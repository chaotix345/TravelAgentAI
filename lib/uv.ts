// UV-index / sun-safety grounding — the ELEVENTH grounded signal, folded into the best_time_to_go
// season pass like daylight, "feels-like" heat, air quality and altitude. When a city-month's typical
// midday UV is strong enough to burn unprotected skin quickly, the plan warns the traveler and shapes
// the day around it ("UV is extreme around midday — SPF50+, cover up, and stay out of direct sun
// from late morning to mid-afternoon"). Like the other folded signals it needs NO new model turn and —
// because UV rides the SAME Copernicus CAMS air-quality fetch best_time_to_go already makes for PM2.5
// (one extra hourly field, no new request, verified) — NO new network either. What's a planning
// DECISION (front-load mornings, pick a lower-UV month, build in shade) stays the model's job; what's
// a FACT about a city-month (how intense the typical midday UV is) is computed here, server-side.
//
// This module is PURE (zero imports, no network) so it compiles and unit-tests standalone, exactly like
// lib/daylight.ts, lib/airheat.ts and lib/altitude.ts. The network fetch + the hourly→daily-max→monthly
// fold live in lib/season.ts; the thresholds and advisory wording — the whole judgment about when UV is
// worth a line — live here, server-side, so the model view and the UI render one source of truth (the
// app has no precedent for client-side threshold logic). The advisory names the physical fact + the
// consequent action, is hemisphere-neutral, and frames the figure as a typical monthly midday NORMAL,
// never a live forecast. It is general sun-safety travel information, not personal medical advice, and
// makes no skin-type-specific claims (the server knows nothing about a traveler's skin) — darker skin
// tolerates far more UV before erythema than fair skin, so a "burns in X minutes" figure would be false
// precision (see the Extreme wording, which says "rapid burning" without a number).

// The WHO Global Solar UV Index categories, banded on the ROUNDED index (UV index is conventionally an
// integer): Low 0-2, Moderate 3-5, High 6-7, Very High 8-10, Extreme 11+. Displayed as a stat in the
// tooltip when an advisory fires; never adjusts the comfort score or season label (advisory-only, like
// heat and air quality — a city can be cool and still have brutal UV: high-altitude tropics, spring snow).
export type UvBand = "Low" | "Moderate" | "High" | "Very High" | "Extreme";

const UV_VERY_HIGH_BAND = 8; // WHO "Very High" band floor
const UV_EXTREME = 11; // WHO "Extreme" band floor

// The ADVISORY (the planning steer) fires at a HIGHER floor than the Very High band: an ordinary
// Mediterranean-summer peak of UV ~8 (Rome/Barcelona in July) is real Very-High UV but doesn't change
// the day's structure (you still visit the Colosseum, just with sunscreen everyone already brings), so
// it stays silent — the same "only warn when it changes the plan" calibration heat (37°C, not 30) and
// air (USG, not Moderate) use. UV >= 9 genuinely reshapes a day (move strenuous plans off solar noon,
// build in shade): Dubai May-Oct, Cusco/Quito year-round, Singapore peak months, Sydney December.
const UV_ADVISORY_FLOOR = 9;

// Which WHO band a (rounded) UV index falls in, or null when it's unknown. Exported so the band logic
// has one home and tests can assert the boundaries directly. Guards null / non-finite / negative
// (UV index is physically >= 0; the !Number.isFinite guard catches a stray NaN as defense in depth,
// mirroring aqiBandFor in lib/airheat.ts).
export function uvBandFor(uvIndex: number | null): UvBand | null {
  if (uvIndex == null || !Number.isFinite(uvIndex) || uvIndex < 0) return null;
  if (uvIndex >= UV_EXTREME) return "Extreme";
  if (uvIndex >= UV_VERY_HIGH_BAND) return "Very High";
  if (uvIndex >= 6) return "High";
  if (uvIndex >= 3) return "Moderate";
  return "Low";
}

// The server-computed sun-safety advisory for a city-month at this typical midday UV index, or null when
// UV isn't a signal worth a line (below the advisory floor, or no data). Single-arg (the value, not a
// pre-computed band) so it both selects the tier AND interpolates the ACTUAL figure into the string —
// mirroring computeHeatAdvisory(meanApparentMaxC), which embeds ${r}°C, never a threshold floor. That's
// the round-once discipline: the caller rounds the raw monthly mean ONCE and passes that same integer to
// uvBandFor (for the stored band) and here (for the advisory), so the figure the traveler reads in the
// advisory can never disagree with the displayed UV (the daylight/heat raw-vs-rounded lesson). Math.round
// here is defensive/idempotent — the caller already passes a rounded value, exactly like computeHeatAdvisory.
export function uvAdvisory(uvIndex: number | null): string | null {
  if (uvIndex == null || !Number.isFinite(uvIndex)) return null;
  const u = Math.round(uvIndex);
  if (u >= UV_EXTREME) {
    return `UV is extreme around midday this month (UV ~${u}) — unprotected skin burns rapidly, so stay out of direct sun from late morning to mid-afternoon, use SPF50+ and reapply, cover up with light long sleeves and a wide-brim hat, and wear sunglasses.`;
  }
  if (u >= UV_ADVISORY_FLOOR) {
    return `UV is very high around midday this month (UV ~${u}) — wear SPF30+, a hat and sunglasses, and seek shade in the hours around noon.`;
  }
  return null;
}
