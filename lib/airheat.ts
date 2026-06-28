// Air-quality + heat-index grounding — the EIGHTH and NINTH grounded signals, folded into the
// best_time_to_go season pass the same way daylight was. Neither is a model tool: best_time_to_go
// already geocodes every city and fetches its climate, so the "feels like" high rides the SAME
// ERA5 fetch (one more daily field) and the air-quality normal is a second server-side fetch on the
// coordinates already in hand (see lib/season.ts). What's a planning DECISION (front-load mornings,
// pack an N95, shift the dates) stays the model's job; what's a FACT about a city-month (how hot it
// feels, how dirty the air typically is) is computed here, server-side, and attached to the plan —
// the same "deterministic fact ≠ model turn" call the FX / booking-enrich / daylight passes made.
//
// This module is PURE (zero imports, no network) so it compiles and unit-tests standalone, exactly
// like lib/daylight.ts. The network fetches live in lib/season.ts; the thresholds and advisory
// wording — the whole judgment about when a signal is worth a line — live here, server-side, so the
// model view and the UI render one source of truth (the app has no precedent for client-side
// threshold logic). All advisories name the physical fact + the consequent action, are
// hemisphere-neutral, and frame the figure as a monthly NORMAL, never a live forecast.

// --- Heat / "feels like" ---------------------------------------------------------------------
//
// Signal: the monthly mean of ERA5 daily apparent_temperature_max (°C). Open-Meteo's apparent
// temperature folds humidity, wind and shortwave radiation into the dry-bulb temperature, so it is a
// genuine "feels like" — NOT the NWS shade-only heat index (the advisory wording says "feels-like",
// never "heat index", for that reason). Thresholds were CALIBRATED against the real 5-year (2020-24)
// monthly normals the season tool fetches, across the full hot-city spectrum:
//   Gulf/Phoenix 42-44.5 · Indian-subcontinent/Cairo 40-41 · hot-humid SE-Asia/Seville/US-South
//   37-40 · pleasant Mediterranean (Rome 35.5, Madrid 33.6) and temperate (Sydney 28.6, London 21.6).
// CAUTION ≥ 37°C cleanly catches the genuinely taxing humid-heat windows (Bangkok, Singapore, Houston,
// Seville-in-August — which season.ts itself calls "brutal") while leaving pleasant warm summers
// silent; DANGER ≥ 42°C isolates the Gulf/desert extreme. The bands are on the ROUNDED feels-like so
// the advisory's cited figure can never contradict the displayed "~X°C" (the daylight raw-vs-rounded
// lesson). It is ADVISORY-ONLY — it never touches the comfort score (the dry-bulb temperature already
// penalises raw heat; this exists to catch the humidity amplification the dry-bulb misses).
const HEAT_CAUTION_C = 37; // rounded feels-like >= this → pace midday / front-load mornings
const HEAT_DANGER_C = 42; // rounded feels-like >= this → extreme heat, avoid midday exposure

export function computeHeatAdvisory(meanApparentMaxC: number | null): string | null {
  if (meanApparentMaxC == null || !Number.isFinite(meanApparentMaxC)) return null;
  const r = Math.round(meanApparentMaxC); // band on the rounded value, like daylight
  if (r >= HEAT_DANGER_C) {
    return `Feels-like afternoon highs average around ${r}°C — dangerous heat. Avoid midday outdoor exposure, plan sightseeing for early morning, lean on air-conditioned options in the afternoon, and hydrate constantly.`;
  }
  if (r >= HEAT_CAUTION_C) {
    return `Feels-like afternoon highs average around ${r}°C — strenuous outdoor activity is taxing midday. Front-load sightseeing into the morning, take indoor breaks through the afternoon heat, and hydrate well.`;
  }
  return null;
}

// --- Air quality (PM2.5 → US AQI band) -------------------------------------------------------
//
// Signal: the typical monthly-mean PM2.5 concentration (µg/m³) from CAMS (see season.ts). We compute
// the US EPA AQI CATEGORY ourselves from the raw concentration rather than trust a provider index
// field — a pre-computed field can be absent for some coordinates (silent nulls) and may still use the
// pre-2024 breakpoints (old "Good" upper bound 12.0; the 2024 revision lowered it to 9.0). Computing
// it here guarantees the band exists whenever the concentration does, and uses the current breakpoints.
export type AqiBand =
  | "Good"
  | "Moderate"
  | "Unhealthy for Sensitive Groups"
  | "Unhealthy"
  | "Very Unhealthy"
  | "Hazardous";

// EPA Technical Assistance Document: the AQI is computed on the concentration TRUNCATED to 0.1 µg/m³,
// not rounded — so 9.05 is treated as 9.0 (Good), not 9.1 (Moderate). Caller guarantees x >= 0, so
// floor == truncate-toward-zero here. The +1e-9 nudge absorbs IEEE-754 representation error: 9.1 is
// stored as 9.0999999996, so a bare floor(9.1 * 10) gives 90 → 9.0, mis-banding a value that sits
// exactly on a 0.1 breakpoint DOWNWARD. The epsilon is far below any real 0.1 step, so it only
// corrects float noise, never a genuine value.
function truncTenth(x: number): number {
  return Math.floor(x * 10 + 1e-9) / 10;
}

// US EPA (2024) 24-hour PM2.5 breakpoints → AQI category. Applied to a monthly mean (a smoother,
// more conservative input than any single 24h average), so this reads as "typical air for the month".
export function aqiBandFor(pm25: number | null): AqiBand | null {
  if (pm25 == null || !Number.isFinite(pm25) || pm25 < 0) return null;
  const c = truncTenth(pm25);
  if (c <= 9.0) return "Good";
  if (c <= 35.4) return "Moderate";
  if (c <= 55.4) return "Unhealthy for Sensitive Groups";
  if (c <= 125.4) return "Unhealthy";
  if (c <= 225.4) return "Very Unhealthy";
  return "Hazardous";
}

// The advisory fires at "Unhealthy for Sensitive Groups" and worse; Good/Moderate get no line (a
// Moderate monthly normal doesn't warrant warning a traveler). Takes the BAND (not the raw figure) so
// the advisory and the displayed band can never disagree. Every string frames the figure as a typical
// monthly normal, names the action, and is hemisphere-neutral.
export function aqiAdvisory(band: AqiBand | null): string | null {
  switch (band) {
    case "Unhealthy for Sensitive Groups":
      return "Air quality is typically in the unhealthy-for-sensitive-groups range this month — travelers with asthma or heart/lung conditions should limit long or strenuous time outdoors.";
    case "Unhealthy":
      return "Air quality is typically unhealthy this month — consider an N95 mask for long stretches outdoors, and sensitive travelers should keep outdoor exertion short.";
    case "Very Unhealthy":
      return "Air quality is typically very unhealthy this month — wear an N95 mask outdoors, keep outdoor time short, favor indoor plans, and reconsider the dates if anyone in the party is vulnerable.";
    case "Hazardous":
      return "Air quality is typically hazardous this month — avoid outdoor exertion, mask up (N95) when out, and seriously reconsider these dates, especially for children, older travelers, or anyone with respiratory issues.";
    default:
      return null; // Good, Moderate, or no data → no advisory
  }
}
