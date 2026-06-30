import { geocodeCity } from "./verify";
import { computeDaylightHours, daylightAdvisory, daylightSwing } from "./daylight";
import { computeHeatAdvisory, aqiBandFor, aqiAdvisory, truncTenth } from "./airheat";
import { computeAltitudeAdvisory, altitudeTier } from "./altitude";
import { uvBandFor, uvAdvisory } from "./uv";
import { pollenAdvisory, pollenTag, POLLEN_SPECIES, type PollenReadings, type PollenSpecies } from "./pollen";
import type {
  MonthSeason,
  SeasonLabel,
  CitySeasonSummary,
  SeasonSummary,
} from "./schema";

// best_time_to_go grounds the TIMING of a plan the way verify_places grounds its PLACES,
// check_route grounds its ROUTE, and estimate_costs grounds its BUDGET. The model has rough
// intuitions about seasons but confidently gets specifics wrong (which month is actually
// pleasant, how brutal a summer is, that a tropical city's "season" is wet-vs-dry not
// hot-vs-cold). So we ground it in REAL observed climate, keyless, in the same shape as the
// other tools:
//
//   1. Geocode each city to a lat/lon (reusing geocodeCity from lib/verify.ts — the same
//      free Nominatim layer check_route uses).
//   2. Fetch 5 years of daily weather from Open-Meteo's free Historical/ERA5 archive (no key,
//      non-commercial use, CC-BY 4.0), and aggregate it server-side into 12 monthly normals.
//   3. Score each month for traveler comfort (temperature + dryness), label it peak / shoulder
//      / off, and derive a "best months to go" window plus a verdict on the trip's target month.
//
// On top of the weather comfort, classify() folds in FOUR derived signals computed from data the
// same geocode/fetch already produced — daylight hours (pure astronomy from the latitude, lib/
// daylight.ts), the "feels like" heat advisory (from an apparent-temperature field on the SAME ERA5
// fetch), and an air-quality advisory PLUS a UV / sun-safety advisory (both from ONE keyless CAMS fetch
// on the same coordinates — lib/airheat.ts and lib/uv.ts). None is a model tool: a fact derivable from
// data a tool already gathered doesn't earn its own model turn (the FX / booking-enrich / daylight precedent).
//
// Like the verify verdict and the budget, what the UI shows is OURS (server-computed here),
// never a claim the model made. The model reads a trimmed view (seasonModelView) to time the
// trip and warn about a bad month, then emits.
//
// HONESTY NOTE: there is no keyless source for tourist CROWDS or peak-booking seasons, so our
// labels are weather-derived only. We say so in the caveat and never pretend otherwise — a
// month that's "shoulder" by weather can still be the busiest by crowds (festivals, school
// holidays). Same free-data-first, honest-about-limits stance as the cost tool.

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";
// Geocoding (Nominatim) is the binding courtesy limit at ~1 req/sec; the Open-Meteo archive
// allows 600/min so it's never the bottleneck. We pace per city, like verify/cost.
const THROTTLE_MS = 1100;
// The archive fetch can take ~7s on a cold server cache for an uncommon coordinate (measured),
// so it gets a more generous timeout than the 5s geocode — but still bounded, so one slow
// request can't eat the whole plan's time budget. A timeout just degrades that city to "no
// data", never a failed plan.
const CLIMATE_TIMEOUT_MS = 8000;
// Cap how many cities we fetch climate for, matching cost.ts's anchor cap: each city is a
// throttled geocode + a (cached) climate fetch, so an unbounded many-city trip could blow the
// function's wall-clock. Cities past the cap still appear, just without season data.
const SEASON_CITY_CAP = 8;
// Five recent complete years: ~150 days per calendar month — plenty for a stable monthly
// normal — at ~50KB/city, versus ~130KB for ten years. Recent years also reflect current
// climate. Fixed window so the cache key (city) stays stable across requests.
const START_DATE = "2020-01-01";
const END_DATE = "2024-12-31";
// Air-quality normals come from a SEPARATE Open-Meteo endpoint (the Copernicus CAMS global model),
// whose history only begins in ~Aug 2022 — so it gets its OWN window (never reuse START_DATE, which
// would request 2+ years of empty rows before coverage starts). Two clean full years is the practical
// max and keeps a stable cache key. The hourly PM2.5 payload is ~20× the daily climate one, so it
// runs in parallel with the climate fetch. Its timeout is capped at the climate timeout (8s), NOT
// higher: Promise.allSettled waits for BOTH fetches, so a longer CAMS timeout would just make a slow
// CAMS response the binding per-city wall-clock. A CAMS timeout degrades air quality to null at no cost.
const AQ_ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const AQ_START_DATE = "2023-01-01";
const AQ_END_DATE = "2024-12-31";
const AQ_TIMEOUT_MS = 8000;
// Pollen rides a SEPARATE keyless fetch to the SAME air-quality endpoint but under the Copernicus CAMS *European*
// model (domains=cams_europe): the cams_global model the PM2.5/UV fetch uses returns the pollen columns ALL-NULL,
// and the European model in turn carries no UV — so the two genuinely can't be folded into one request (probed).
// The pollen history shares CAMS's ~2022/2023-onward coverage, so we reuse the 2023-24 window. EUROPE-ONLY: a
// non-European coordinate returns an explicit "no data" 400, which fetchPollenNormals reports as a definitive
// "outside coverage" result distinct from a transient error (see its discriminated return type). Timeout matches
// the others (Promise.allSettled waits for all three, so a longer pollen timeout would be the binding wall-clock).
const POLLEN_START_DATE = "2023-01-01";
const POLLEN_END_DATE = "2024-12-31";
const POLLEN_TIMEOUT_MS = 8000;

// --- Comfort model (tunable heuristics, like cost.ts's tier cutoffs / route.ts's distances) ---
// The whole verdict turns on these. They were calibrated against known cases (Seville is brutal
// in August / lovely in April & October; Reykjavik's peak is a cool short summer; Dubai is
// unbearable in July; Bangkok's season is rain, not heat) and are gathered here so they're easy
// to retune. A comfort score runs 0–10: a temperature score minus a wetness penalty.

// Temperature score breakpoints on the MEAN DAILY HIGH in °C (tourists feel the afternoon high,
// not the 24h mean). Piecewise-linear between these [temp, score] points; below the first temp
// the score floors at 1, above the last it drops to 1 (extreme heat).
const TEMP_IDEAL_LOW = 20; // 20–26°C is the ideal band (score 10)
const TEMP_IDEAL_HIGH = 26;
const TEMP_HOT_ONSET = 30; // heat starts to bite
const TEMP_VHOT_ONSET = 34; // restrict midday outdoor time
const TEMP_HOT_CEILING = 38; // above → score 1

// Wetness penalty on RAIN DAYS per month (days with ≥1mm — the conventional "rain day", a
// better traveler signal than total mm: 180mm in 4 storms feels drier than 60mm drizzled over
// 20 days). Subtracted from the temperature score.
const PRECIP_PENALTY: Array<{ maxDays: number; penalty: number }> = [
  { maxDays: 4, penalty: 0 }, // very dry
  { maxDays: 8, penalty: 0.5 }, // mostly dry
  { maxDays: 13, penalty: 1.0 }, // some rainfall
  { maxDays: 18, penalty: 1.5 }, // wet
  { maxDays: 23, penalty: 2.0 }, // very wet
  { maxDays: Infinity, penalty: 2.5 }, // relentless
];

const PEAK_THRESHOLD = 7.5; // comfort ≥ this → peak weather
const SHOULDER_THRESHOLD = 5.0; // ≥ this → shoulder; below → off-season

// Tropical detection: when temperature barely moves all year AND it's always warm, temperature
// is a useless ranking signal (every month scores ~the same) and precipitation IS the season.
// We switch to a dryness-only score so the dry season reads as "peak", not a temp artifact.
const TROPICAL_MIN_MEAN_TEMP = 18; // every month's mean temp above this …
const TROPICAL_MAX_RANGE = 8; // … and <8°C spread in monthly highs → tropical

// Challenging climate: if even the best month can't clear this, the place has no genuinely
// comfortable month (Reykjavik, Tromsø). We then rank the least-bad months as "best available"
// rather than overselling them as "peak".
const CHALLENGING_MAX_SCORE = 6.5;

// Big day–night swing (clear-sky high-altitude/desert): a pleasant afternoon high can hide a
// freezing night. Flagged so the verdict doesn't read as unambiguously ideal.
const DIURNAL_SWING_THRESHOLD = 10;

const RAIN_DAY_MM = 1; // a day counts as a "rain day" at ≥1mm

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export type SeasonCityInput = { name: string; country?: string };

// Process-lifetime cache of computed per-city season summaries, keyed by folded name|country.
// Climate normals barely change, so this is safe to keep for the life of the server instance
// (the spec's advice) and means a refine — or a second user planning the same city — skips the
// geocode + fetch + scoring entirely. Mirrors verify.ts's cache, but module-scoped because the
// data is request-independent (unlike the per-request verify cache).
// NOTE: a long-running dev server caches each city ONCE per process lifetime, so after changing any
// signal computed in classify() (daylight, heat, air quality, uv) OR assembled in assessSeason() on the
// CitySeasonSummary (elevationM, altitudeAdvisory — the altitude signal) you must RESTART the server to
// flush cities cached without the new fields — there is deliberately no programmatic invalidation
// (the cache-read guard below force-refetches a pre-altitude entry as defense in depth, but a changed
// THRESHOLD still needs a restart).
const seasonCache = new Map<string, CitySeasonSummary>();
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
const cacheKey = (name: string, country?: string) => `${fold(name)}|${fold(country ?? "")}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (x: number, x0: number, x1: number, y0: number, y1: number) =>
  y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
// Round a raw value to a whole number, or null when it's absent/non-finite — used to round each pollen species'
// monthly mean ONCE (so the stored tag and the advisory cite the same integer; the raw-vs-rounded discipline).
const roundOrNull = (x: number | null | undefined) =>
  x != null && Number.isFinite(x) ? Math.round(x) : null;

// Temperature comfort from the mean daily high. Piecewise-linear; see the constants above.
function tempScore(meanMaxC: number): number {
  const t = meanMaxC;
  if (t < 5) return 1;
  if (t < 10) return lerp(t, 5, 10, 1, 4);
  if (t < 15) return lerp(t, 10, 15, 4, 7);
  if (t < TEMP_IDEAL_LOW) return lerp(t, 15, TEMP_IDEAL_LOW, 7, 10);
  if (t <= TEMP_IDEAL_HIGH) return 10;
  if (t < TEMP_HOT_ONSET) return lerp(t, TEMP_IDEAL_HIGH, TEMP_HOT_ONSET, 10, 8);
  if (t < TEMP_VHOT_ONSET) return lerp(t, TEMP_HOT_ONSET, TEMP_VHOT_ONSET, 8, 5);
  if (t <= TEMP_HOT_CEILING) return lerp(t, TEMP_VHOT_ONSET, TEMP_HOT_CEILING, 5, 2);
  return 1;
}

function precipPenalty(rainDays: number): number {
  for (const band of PRECIP_PENALTY) if (rainDays <= band.maxDays) return band.penalty;
  return 2.5;
}

// In tropical mode temperature is flat and useless for ranking, so comfort is dryness only:
// scale the same wetness penalty up to dominate the 0–10 range. A dry month (≤4 rain days)
// scores ~10 (peak dry season); a 25-rain-day monsoon month floors near 1.
function tropicalComfort(rainDays: number): number {
  return clamp(10 - precipPenalty(rainDays) * 3.5, 0, 10);
}

function tempDescriptor(meanMaxC: number): string {
  const t = meanMaxC;
  if (t < 5) return "very cold";
  if (t < 12) return "cold";
  if (t < 17) return "cool";
  if (t < 22) return "mild";
  if (t < 27) return "warm";
  if (t < 32) return "hot";
  if (t < 37) return "very hot";
  return "extreme heat";
}

function precipDescriptor(rainDays: number): string {
  if (rainDays <= 4) return "very dry";
  if (rainDays <= 8) return "mostly dry";
  if (rainDays <= 13) return "some rain";
  if (rainDays <= 18) return "wet"; // boundary aligned with the PRECIP_PENALTY "wet" band (≤18)
  return "very wet";
}

// One geocoded city's daily ERA5 series, folded into 12 monthly normals. null on any failure.
type MonthlyNormals = {
  meanTempC: number;
  meanMaxC: number;
  precipMm: number; // average monthly total
  rainDays: number; // average days/month with ≥1mm
  // Monthly mean of the daily APPARENT-temperature high (°C) — "feels like", folding humidity, wind
  // and sun into the dry-bulb max. Rides the same ERA5 fetch. null when the field is absent for a
  // month (it degrades independently and never nulls out the whole city — see the null-guard below).
  meanApparentMaxC: number | null;
}[];

// 12 monthly CAMS normals for one city: the mean PM2.5 (µg/m³) AND the UV index (the typical midday
// peak — the monthly mean of each day's MAXIMUM hourly UV), each null per month when CAMS had no data.
// Both signals ride the SAME keyless air-quality fetch, so they're folded and returned together.
// (Renamed from AqiMonthlyNormals now that it carries a WHO UV field beside the EPA-AQI PM2.5 one — the
// name reflects the SOURCE, the Copernicus CAMS global model, not one of the two standards it feeds.)
type CamsMonthlyNormals = Array<{ meanPm25: number | null; uvIndex: number | null }>;

// Raw monthly per-species pollen normals for one city (grains/m³), the monthly mean of each day's 24-hour MEAN.
// 12 elements; each species null when CAMS had no data that month. RAW from the fetch — classify() rounds once.
type PollenMonthlyNormals = Array<Record<PollenSpecies, number | null>>;
// fetchPollenNormals's discriminated result. "ok" with the 12 monthly normals; "eu_unavailable" when the endpoint
// DEFINITIVELY reported the coordinate outside the European model's coverage (a parsed "no data" 400) — a STABLE
// fact worth caching as pollenFetched:false; "error" for any transient/ambiguous failure (timeout, network, a
// non-geographic 400, a parse miss), which must NOT be cached as a coverage verdict, so the city re-fetches. This
// three-way split is the load-bearing fix for the cache-poison trap: a Berlin timeout must never read as "non-EU".
type PollenFetchResult =
  | { status: "ok"; months: PollenMonthlyNormals }
  | { status: "eu_unavailable" }
  | { status: "error" };

async function fetchNormals(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<{ normals: MonthlyNormals; elevationM: number | null } | null> {
  const url =
    `${ARCHIVE}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${START_DATE}&end_date=${END_DATE}` +
    `&daily=temperature_2m_mean,temperature_2m_max,precipitation_sum,apparent_temperature_max&timezone=UTC`;
  const timeout = AbortSignal.timeout(CLIMATE_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    // 401/403 would mean Open-Meteo started gating the free archive — log so the operator sees
    // it, but still degrade to "no data" rather than break the plan.
    console.warn(`Open-Meteo HTTP ${res.status} for ${lat},${lon}`);
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    daily?: {
      time?: string[];
      temperature_2m_mean?: Array<number | null>;
      temperature_2m_max?: Array<number | null>;
      precipitation_sum?: Array<number | null>;
      apparent_temperature_max?: Array<number | null>;
    };
  };
  const day = data?.daily;
  if (!day?.time || !Array.isArray(day.time)) return null;
  const mean = day.temperature_2m_mean ?? [];
  const max = day.temperature_2m_max ?? [];
  const precip = day.precipitation_sum ?? [];
  // Apparent temperature is OPTIONAL: if the archive ever drops the field, atMax is [] and every
  // atMax[i] is undefined → atMaxN stays 0 → meanApparentMaxC becomes null for that month, with NO
  // effect on the load-bearing temp/precip guard below. (The daylight lesson: an absent field must
  // never slip a NaN past the null-guard — here a missing apparent temp simply yields null.)
  const atMax = day.apparent_temperature_max ?? [];

  // Accumulate per calendar month. timezone=UTC means a day belongs cleanly to the month in its
  // ISO date with no DST boundary ambiguity. We count years per month to turn summed precip into
  // an average MONTHLY total, and skip nulls so an occasional ERA5 gap can't poison a mean.
  const acc = Array.from({ length: 12 }, () => ({
    tempSum: 0, tempN: 0, maxSum: 0, maxN: 0, precipSum: 0, precipN: 0, rainDayCount: 0, atMaxSum: 0, atMaxN: 0, years: new Set<string>(),
  }));
  for (let i = 0; i < day.time.length; i++) {
    const iso = day.time[i];
    const mo = Number.parseInt(iso.slice(5, 7), 10) - 1;
    // A malformed date parses to NaN, which slips past a bare `< 0 || > 11` range check and
    // would index acc[NaN] === undefined and throw — guard it explicitly.
    if (!Number.isFinite(mo) || mo < 0 || mo > 11) continue;
    const a = acc[mo];
    a.years.add(iso.slice(0, 4));
    if (mean[i] != null) { a.tempSum += mean[i] as number; a.tempN++; }
    if (max[i] != null) { a.maxSum += max[i] as number; a.maxN++; }
    if (atMax[i] != null) { a.atMaxSum += atMax[i] as number; a.atMaxN++; }
    if (precip[i] != null) {
      a.precipSum += precip[i] as number;
      a.precipN++;
      if ((precip[i] as number) >= RAIN_DAY_MM) a.rainDayCount++;
    }
  }
  // A month missing temperature OR precipitation data means a broken/partial response — bail to
  // "no data" rather than score it. The precip guard matters: without it, a response that dropped
  // precipitation_sum would compute 0 rain days for every month and confidently mislabel a
  // rainforest as "very dry" while still claiming source: "open-meteo". Dryness is half the verdict.
  // Apparent temperature is deliberately NOT in this guard — it's an advisory-only signal that
  // degrades to null per month, so its absence must never fail the whole city.
  if (acc.some((a) => a.tempN === 0 || a.maxN === 0 || a.precipN === 0)) return null;
  // Elevation is a TOP-LEVEL scalar in the ERA5 response (the Copernicus GLO-90 terrain model),
  // independent of the daily arrays — so we read it AFTER the load-bearing climate null-guard above has
  // already passed, and it never gates the climate data: an absent / non-finite / negative elevation
  // degrades to null only (the apparent-temperature lesson — an optional field must stay out of the
  // guard). Round to the nearest 10m HERE, once, so the stored figure and the advisory tier band on the
  // same value (the daylight/heat raw-vs-rounded lesson). A negative value (an ocean grid cell, or a DEM
  // no-data sentinel like -9999) is never a real city elevation → null.
  const rawElev = (data as { elevation?: unknown }).elevation;
  const elevationM =
    typeof rawElev === "number" && Number.isFinite(rawElev) && rawElev >= 0
      ? Math.round(rawElev / 10) * 10
      : null;
  const normals = acc.map((a) => {
    const years = Math.max(1, a.years.size);
    return {
      meanTempC: a.tempSum / a.tempN,
      meanMaxC: a.maxSum / a.maxN,
      precipMm: a.precipSum / years,
      rainDays: a.rainDayCount / years,
      meanApparentMaxC: a.atMaxN > 0 ? a.atMaxSum / a.atMaxN : null,
    };
  });
  return { normals, elevationM };
}

// One geocoded city's typical monthly PM2.5 (µg/m³) AND UV index from the CAMS global model via
// Open-Meteo's keyless air-quality endpoint. SEPARATE from the climate fetch (different host, different
// history window) and ENTIRELY wrapped so it can only ever return a 12-element array or null — it NEVER
// throws, so a CAMS outage degrades both air quality AND UV to "no data" without touching the climate
// season (assessSeason runs the two fetches with Promise.allSettled). The endpoint serves both as hourly
// series in ONE request (adding uv_index to the existing hourly list costs no extra round-trip — measured
// at ~0.5s, identical to PM2.5 alone, so AQ_TIMEOUT_MS is unchanged), so we fold hourly → per-day
// aggregate → monthly mean in two passes — with the crucial twist that PM2.5 uses a daily MEAN while UV
// uses a daily MAX (see Pass 1).
async function fetchAirQualityNormals(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<CamsMonthlyNormals | null> {
  try {
    const url =
      `${AQ_ENDPOINT}?latitude=${lat}&longitude=${lon}` +
      `&hourly=pm2_5,uv_index&start_date=${AQ_START_DATE}&end_date=${AQ_END_DATE}` +
      `&domains=cams_global&timezone=UTC`;
    const timeout = AbortSignal.timeout(AQ_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      console.warn(`CAMS air-quality HTTP ${res.status} for ${lat},${lon}`);
      return null;
    }
    const data = (await res.json()) as {
      hourly?: { time?: string[]; pm2_5?: Array<number | null>; uv_index?: Array<number | null> };
    };
    const h = data?.hourly;
    if (!h?.time || !Array.isArray(h.time)) return null;
    const pm = h.pm2_5 ?? [];
    const uv = h.uv_index ?? [];

    // Pass 1: hourly → per-day aggregate (key on the YYYY-MM-DD prefix). The two CAMS signals fold
    // DIFFERENTLY: PM2.5 → a daily MEAN (the 24h average concentration a traveler breathes); UV → a daily
    // MAX (the midday PEAK). A 24h average of UV is meaningless — the ~16 night hours read UV=0 and would
    // drag the figure to roughly half the real midday value (Cusco's true year-round-Extreme ~10 would
    // read as a mild Moderate ~5, silently suppressing every advisory). They're tracked in INDEPENDENT
    // accumulators in one loop so a null in one signal never drops the other's sample for that hour. Skip
    // nulls so a gap can't poison either aggregate; timezone=UTC means each timestamp is one calendar day.
    const daily = new Map<string, { sum: number; n: number }>();
    const dailyUvMax = new Map<string, number>();
    for (let i = 0; i < h.time.length; i++) {
      const dayKey = h.time[i].slice(0, 10);
      const v = pm[i];
      if (v != null && Number.isFinite(v)) {
        const b = daily.get(dayKey) ?? { sum: 0, n: 0 };
        b.sum += v as number;
        b.n++;
        daily.set(dayKey, b);
      }
      const uvV = uv[i];
      if (uvV != null && Number.isFinite(uvV)) {
        const prev = dailyUvMax.get(dayKey) ?? -Infinity;
        if ((uvV as number) > prev) dailyUvMax.set(dayKey, uvV as number);
      }
    }

    // Pass 2: per-day aggregate → monthly mean (each day weighted equally, so a data-dense day doesn't
    // dominate). PM2.5 averages the daily means; UV averages the daily maxima. Guard a malformed month
    // index, mirroring fetchNormals; a month with zero valid days stays null (never 0/0 = NaN). Both stay
    // RAW here — the single display-rounding (truncTenth for PM2.5, Math.round for UV) happens once in
    // classify(), so the stored figure and the banded value can't diverge (the raw-vs-rounded discipline).
    const acc = Array.from({ length: 12 }, () => ({ sum: 0, n: 0 }));
    for (const [dayKey, b] of daily) {
      const mo = Number.parseInt(dayKey.slice(5, 7), 10) - 1;
      if (!Number.isFinite(mo) || mo < 0 || mo > 11) continue;
      acc[mo].sum += b.sum / b.n;
      acc[mo].n++;
    }
    const uvAcc = Array.from({ length: 12 }, () => ({ sum: 0, n: 0 }));
    for (const [dayKey, mx] of dailyUvMax) {
      const mo = Number.parseInt(dayKey.slice(5, 7), 10) - 1;
      if (!Number.isFinite(mo) || mo < 0 || mo > 11) continue;
      uvAcc[mo].sum += mx;
      uvAcc[mo].n++;
    }
    return acc.map((a, i) => ({
      meanPm25: a.n > 0 ? a.sum / a.n : null,
      uvIndex: uvAcc[i].n > 0 ? uvAcc[i].sum / uvAcc[i].n : null,
    }));
  } catch {
    // Timeout / abort / network / parse — never evidence of anything, just no air-quality data.
    return null;
  }
}

// One geocoded city's typical monthly pollen, per species, from the Copernicus CAMS EUROPEAN model via Open-Meteo's
// keyless air-quality endpoint. A THIRD fetch, separate from the climate and the cams_global air-quality ones, run
// in parallel (Promise.allSettled in assessSeason) so it degrades independently. It NEVER throws: every failure maps
// to a discriminated result so a transient timeout can't be mistaken for "this city has no pollen" (the cache-poison
// trap). The hourly→daily→monthly fold mirrors PM2.5's daily-MEAN path (NOT UV's daily-MAX): published pollen
// severity scales are all defined on the daily mean and pollen does not zero at night, so a 24h mean is correct
// (a daily MAX would inflate every figure ~2-3× and over-alert). Each species accumulates independently, so a null
// in one never drops another.
async function fetchPollenNormals(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<PollenFetchResult> {
  try {
    const fields = POLLEN_SPECIES.map((s) => `${s}_pollen`).join(",");
    const url =
      `${AQ_ENDPOINT}?latitude=${lat}&longitude=${lon}` +
      `&hourly=${fields}&start_date=${POLLEN_START_DATE}&end_date=${POLLEN_END_DATE}` +
      `&domains=cams_europe&timezone=UTC`;
    const timeout = AbortSignal.timeout(POLLEN_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      // A 400 is AMBIGUOUS: the European model returns it BOTH for a coordinate outside its coverage (a stable
      // "outside Europe" fact) AND for a malformed request (a bug). Distinguish by the body's reason string — only
      // the geographic case becomes a cached coverage verdict; anything else stays a transient "error" so a URL
      // bug can't permanently brand a real European city as non-European.
      if (res.status === 400) {
        let reason = "";
        try {
          const body = (await res.json()) as { reason?: unknown };
          reason = typeof body?.reason === "string" ? body.reason : "";
        } catch {
          /* non-JSON body — treat as a transient error, not a coverage verdict */
        }
        if (/no data is available for this location/i.test(reason)) {
          return { status: "eu_unavailable" };
        }
      }
      console.warn(`CAMS pollen HTTP ${res.status} for ${lat},${lon}`);
      return { status: "error" };
    }
    const data = (await res.json()) as {
      hourly?: { time?: string[] } & Partial<Record<`${PollenSpecies}_pollen`, Array<number | null>>>;
    };
    const h = data?.hourly;
    if (!h?.time || !Array.isArray(h.time)) return { status: "error" };

    // Pass 1: hourly → per-day MEAN, per species (independent accumulators keyed on the YYYY-MM-DD prefix). Skip
    // null / non-finite / negative samples so a gap or a sentinel can't poison a day's mean. timezone=UTC means each
    // timestamp belongs cleanly to one calendar day.
    const dailyBySpecies: Record<PollenSpecies, Map<string, { sum: number; n: number }>> = {
      alder: new Map(), birch: new Map(), grass: new Map(),
      mugwort: new Map(), olive: new Map(), ragweed: new Map(),
    };
    for (const species of POLLEN_SPECIES) {
      const arr = h[`${species}_pollen`] ?? [];
      const daily = dailyBySpecies[species];
      for (let i = 0; i < h.time.length; i++) {
        const v = arr[i];
        if (v == null || !Number.isFinite(v) || (v as number) < 0) continue;
        const dayKey = h.time[i].slice(0, 10);
        const b = daily.get(dayKey) ?? { sum: 0, n: 0 };
        b.sum += v as number;
        b.n++;
        daily.set(dayKey, b);
      }
    }

    // Pass 2: per-day mean → monthly mean (each day weighted equally). Guard a malformed month index, mirroring
    // fetchNormals/fetchAirQualityNormals; a month with zero valid days stays null (never 0/0 = NaN). RAW here —
    // classify() rounds each species ONCE, so the stored figure and the banded value can't diverge.
    const months: PollenMonthlyNormals = Array.from({ length: 12 }, () => ({
      alder: null, birch: null, grass: null, mugwort: null, olive: null, ragweed: null,
    }));
    for (const species of POLLEN_SPECIES) {
      const acc = Array.from({ length: 12 }, () => ({ sum: 0, n: 0 }));
      for (const [dayKey, b] of dailyBySpecies[species]) {
        const mo = Number.parseInt(dayKey.slice(5, 7), 10) - 1;
        if (!Number.isFinite(mo) || mo < 0 || mo > 11) continue;
        acc[mo].sum += b.sum / b.n;
        acc[mo].n++;
      }
      for (let m = 0; m < 12; m++) months[m][species] = acc[m].n > 0 ? acc[m].sum / acc[m].n : null;
    }
    return { status: "ok", months };
  } catch {
    // Timeout / abort / network / parse — never evidence of anything, just no pollen data this time.
    return { status: "error" };
  }
}

// Turn 12 monthly normals into 12 scored, labelled MonthSeason records plus the tropical/
// challenging flags and a best-window string. Takes the city's latitude so it can attach each
// month's daylight hours + advisory (pure astronomy, no network), and the optional air-quality
// normals so it can attach the air-quality AND UV advisories — all in the SAME place every other
// MonthSeason field is built, which guarantees daylight, heat, air-quality AND UV ride into the
// seasonCache with the rest of the summary, never as a later mutation a cache hit would skip. Pure
// apart from its inputs — so it's easy to test. NOTE altitude is NOT built here: it is a per-CITY
// (month-invariant) signal, so it's assembled in assessSeason() on the CitySeasonSummary, not in these
// per-month records (see lib/altitude.ts) — do not move it into classify() to "match the pattern".
function classify(
  normals: MonthlyNormals,
  lat: number,
  camsNormals?: CamsMonthlyNormals | null,
  pollenNormals?: PollenMonthlyNormals | null,
): {
  months: MonthSeason[];
  tropical: boolean;
  challenging: boolean;
  bestWindow: string;
} {
  const maxes = normals.map((n) => n.meanMaxC);
  const range = Math.max(...maxes) - Math.min(...maxes);
  const tropical =
    normals.every((n) => n.meanTempC > TROPICAL_MIN_MEAN_TEMP) && range < TROPICAL_MAX_RANGE;

  const comfort = normals.map((n) =>
    tropical ? tropicalComfort(n.rainDays) : clamp(tempScore(n.meanMaxC) - precipPenalty(n.rainDays), 0, 10),
  );
  const bestScore = Math.max(...comfort);
  const challenging = bestScore < CHALLENGING_MAX_SCORE;

  // In a challenging climate, the top three months are "best available", not "peak".
  const topThree = new Set(
    comfort
      .map((c, i) => [c, i] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map(([, i]) => i),
  );

  const labelFor = (i: number): SeasonLabel => {
    if (challenging) return topThree.has(i) ? "best-available" : "off";
    if (comfort[i] >= PEAK_THRESHOLD) return "peak";
    if (comfort[i] >= SHOULDER_THRESHOLD) return "shoulder";
    return "off";
  };

  const months: MonthSeason[] = normals.map((n, i) => {
    const flags: string[] = [];
    if (n.meanMaxC - n.meanTempC > DIURNAL_SWING_THRESHOLD) {
      flags.push("big day–night temperature swing — pack layers");
    }
    if (tropical && n.rainDays >= 14) flags.push("rainy season — expect downpours");
    // Heat + air quality fold in here, alongside daylight, so they ride into the seasonCache with the
    // rest of the summary. Both degrade independently: a missing apparent-temp field leaves the heat
    // signal null, and absent CAMS data leaves the air signal null — neither affects the comfort
    // label. The heat advisory is advisory-only (it never adjusts the comfort score, which already
    // penalises raw heat from the dry-bulb high). The feels-like is rounded so its advisory's cited
    // figure matches the displayed value (the daylight raw-vs-rounded lesson).
    const apparentMax = n.meanApparentMaxC != null ? Math.round(n.meanApparentMaxC) : null;
    // Truncate PM2.5 to 0.1 µg/m³ ONCE and use that single value for BOTH the band and the stored
    // display figure, so the tooltip's "~X µg/m³" can never disagree with its band (the heat path's
    // round-once discipline, applied to air). aqiBandFor re-truncates idempotently.
    const meanPm25Raw = camsNormals?.[i]?.meanPm25 ?? null;
    const meanPm25 = meanPm25Raw != null ? truncTenth(meanPm25Raw) : null;
    const band = aqiBandFor(meanPm25);
    // UV rides the SAME CAMS fetch. Round the raw monthly mean-of-daily-max to a whole UV index ONCE,
    // then band + advise + display from that single integer (WHO UV index is conventionally an integer,
    // so a fractional 9.2 would never match the "UV ~9" the advisory cites — the raw-vs-rounded lesson).
    const uvIndexRaw = camsNormals?.[i]?.uvIndex ?? null;
    const uvIndex = uvIndexRaw != null ? Math.round(uvIndexRaw) : null;
    // Pollen rides a SEPARATE CAMS European fetch (null for a non-European city, or when that fetch failed). Round
    // each species' raw monthly mean ONCE here, then derive the tooltip tag + the advisory from that same rounded
    // reading, so they cite the same integer (the raw-vs-rounded discipline). Advisory-only — pollen is never read
    // into the comfort[] array or labelFor() above, so it can't move the comfort score or season label.
    const pollenRaw = pollenNormals?.[i] ?? null;
    const pollen: PollenReadings | null = pollenRaw
      ? {
          alder: roundOrNull(pollenRaw.alder),
          birch: roundOrNull(pollenRaw.birch),
          grass: roundOrNull(pollenRaw.grass),
          mugwort: roundOrNull(pollenRaw.mugwort),
          olive: roundOrNull(pollenRaw.olive),
          ragweed: roundOrNull(pollenRaw.ragweed),
        }
      : null;
    return {
      month: i + 1,
      label: labelFor(i),
      comfort: Math.round(comfort[i] * 10) / 10,
      meanMaxC: Math.round(n.meanMaxC),
      meanTempC: Math.round(n.meanTempC),
      precipMm: Math.round(n.precipMm),
      rainDays: Math.round(n.rainDays),
      temp: tempDescriptor(n.meanMaxC),
      rain: precipDescriptor(n.rainDays),
      flags,
      daylightHours: computeDaylightHours(lat, i + 1),
      daylightAdvisory: daylightAdvisory(lat, i + 1),
      meanApparentMaxC: apparentMax,
      heatAdvisory: computeHeatAdvisory(apparentMax),
      meanPm25,
      aqiBand: band,
      aqiAdvisory: aqiAdvisory(band),
      uvIndex,
      uvBand: uvBandFor(uvIndex),
      uvAdvisory: uvAdvisory(uvIndex),
      pollenTag: pollenTag(pollen),
      pollenAdvisory: pollenAdvisory(pollen),
    };
  });

  return { months, tropical, challenging, bestWindow: bestWindow(comfort, months, challenging) };
}

// Format a contiguous (possibly year-wrapping) run of month indices as "Apr–Jun" / "Dec–Feb".
function formatRun(run: number[]): string {
  if (run.length === 1) return MONTHS_SHORT[run[0]];
  return `${MONTHS_SHORT[run[0]]}–${MONTHS_SHORT[run[run.length - 1]]}`;
}

// Derive the headline "best months to go" string. Two passes:
//  - If there are peak months, group them into circular contiguous runs and name them. Two
//    disconnected runs is the classic Mediterranean split (spring + autumn, brutal summer
//    between) — we report both so we don't paper over the summer.
//  - Otherwise (challenging climate, or all-shoulder), name the three least-bad months.
function bestWindow(comfort: number[], months: MonthSeason[], challenging: boolean): string {
  if (!challenging) {
    const isPeak = months.map((m) => m.label === "peak");
    if (isPeak.some(Boolean)) {
      // Build circular runs of consecutive peak months.
      const runs: number[][] = [];
      const seen = new Array(12).fill(false);
      for (let s = 0; s < 12; s++) {
        if (!isPeak[s] || seen[s]) continue;
        // Only start a run at a left edge (previous month not peak) so we don't split a run.
        if (isPeak[(s + 11) % 12]) continue;
        const run: number[] = [];
        let i = s;
        while (isPeak[i] && !seen[i]) { seen[i] = true; run.push(i); i = (i + 1) % 12; }
        runs.push(run);
      }
      // All 12 months peak (no left edge found): just say so.
      if (runs.length === 0) return "Good weather year-round";
      if (runs.length === 1 && runs[0].length >= 6) {
        // One long peak run — name the strongest 3-month stretch inside it so the advice stays
        // decisive instead of "Feb–Nov".
        return `Best around ${slidingBest(comfort, 3)}; good ${formatRun(runs[0])}`;
      }
      return `Best: ${runs.map(formatRun).join(" & ")}`;
    }
  }
  // No peak months: name the top three (challenging climates, or a flat all-shoulder place).
  const top = comfort
    .map((c, i) => [c, i] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3)
    .map(([, i]) => i)
    .sort((a, b) => a - b)
    .map((i) => MONTHS_SHORT[i]);
  return `${challenging ? "Best available: " : "Best: "}${top.join(", ")}`;
}

// Highest-scoring circular window of `size` months whose every month clears off-season quality
// (≥4.5), returned as "Apr–Jun". Used to pin the sweet spot inside one long peak run.
function slidingBest(comfort: number[], size: number): string {
  let best = -1;
  let bestStart = 0;
  for (let s = 0; s < 12; s++) {
    let sum = 0;
    let ok = true;
    for (let k = 0; k < size; k++) {
      const c = comfort[(s + k) % 12];
      if (c < 4.5) { ok = false; break; }
      sum += c;
    }
    if (ok && sum / size > best) { best = sum / size; bestStart = s; }
  }
  if (best < 0) return MONTHS_SHORT[comfort.indexOf(Math.max(...comfort))];
  return `${MONTHS_SHORT[bestStart]}–${MONTHS_SHORT[(bestStart + size - 1) % 12]}`;
}

const LABEL_WORD: Record<SeasonLabel, string> = {
  peak: "peak season",
  shoulder: "shoulder season",
  off: "off-season",
  "best-available": "the best available",
};

const CAVEAT =
  "Season labels reflect weather comfort from climate normals only. Actual crowds and prices " +
  "also depend on school holidays, festivals and flight schedules — a month that's mild by " +
  "weather can still be the busiest.";

// Build the trip-level target-month verdict, e.g.
// "August: off-season in Seville (extreme heat, 36°C) but peak in Lisbon (warm, 29°C)."
function targetAssessment(cities: CitySeasonSummary[], targetMonth: number): string | null {
  const withData = cities.filter((c) => c.source === "open-meteo");
  if (withData.length === 0) return null;
  const parts = withData.map((c) => {
    const m = c.months[targetMonth - 1];
    return `${LABEL_WORD[m.label]} in ${c.name} (${m.temp}, ${m.meanMaxC}°C, ${m.rain})`;
  });
  return `${MONTHS[targetMonth - 1]}: ${parts.join("; ")}.`;
}

// Public entry point — executes the best_time_to_go tool. Mirrors estimateCosts: filter inputs,
// loop cities (throttled, abortable, capped), degrade gracefully, stream progress, attach a
// trip-level note + caveat. Returns the full SeasonSummary the server attaches to the plan.
// Build the data-source note from a city set. Exported and taken as a PARAMETER (not closed over the
// full assessed list) so the route can RECOMPUTE it against the FINAL emitted cities — the same
// recompute-against-the-plan discipline targetAssessment follows. Each source clause is gated on that
// signal actually landing in THIS set, so a plan that dropped its only high-altitude (or hot, or
// polluted) city after assessment doesn't credit a source nothing visible uses.
export function buildSeasonNote(cities: CitySeasonSummary[]): string {
  const haveData = cities.some((c) => c.source === "open-meteo");
  if (!haveData) return "Couldn't ground the season for these cities.";
  const haveHeat = cities.some(
    (c) => c.source === "open-meteo" && c.months.some((m) => m.meanApparentMaxC != null),
  );
  const haveAqi = cities.some(
    (c) => c.source === "open-meteo" && c.months.some((m) => m.meanPm25 != null),
  );
  const haveUv = cities.some(
    (c) => c.source === "open-meteo" && c.months.some((m) => m.uvIndex != null),
  );
  const haveAltitude = cities.some((c) => c.source === "open-meteo" && c.altitudeAdvisory != null);
  // Pollen data landed for at least one European city in THIS (final) set; gate the disclosure on it like the
  // others so a plan that dropped its only European city doesn't credit a source nothing shows. havePollenGap =
  // a city is DEFINITIVELY outside coverage (pollenFetched === false), which adds the honest "non-European cities
  // show none" caveat — only on a mixed trip, never when every city is European.
  const havePollen = cities.some((c) => c.source === "open-meteo" && c.pollenFetched === true);
  const havePollenGap = cities.some((c) => c.source === "open-meteo" && c.pollenFetched === false);
  return `Weather grounded in Open-Meteo ERA5 climate normals (${START_DATE.slice(0, 4)}–${END_DATE.slice(0, 4)}). Labels reflect weather comfort, not crowds. Daylight hours are computed from each city's latitude (sunrise to sunset, mid-month value) — civil twilight adds roughly 20–40 minutes of usable light at each end (dawn and dusk), and local mountains can trim them.${haveHeat ? ` "Feels-like" highs are ERA5 apparent temperature, which folds in humidity, wind and sun.` : ""}${
    haveAqi
      ? ` Air quality is the typical monthly PM2.5 from the Copernicus Atmosphere Monitoring Service (CAMS) via Open-Meteo (${AQ_START_DATE.slice(0, 4)}–${AQ_END_DATE.slice(0, 4)}) — a monthly average, not a live reading, and a coarse global model can understate short, local pollution spikes such as crop-burning season.`
      : ""
  }${
    haveUv
      ? ` UV index is the typical daily midday peak (the monthly mean of each day's maximum UV, averaged across the observed mix of cloudy and clear days in the Copernicus CAMS global model via Open-Meteo, ${AQ_START_DATE.slice(0, 4)}–${AQ_END_DATE.slice(0, 4)}) — a day with below-average cloud can run notably higher, and UV climbs with altitude, so a day trip from the city up to meaningfully higher terrain faces more than the city-base figure shown. It's modeled from CAMS ozone, aerosols and cloud, not a live reading.`
      : ""
  }${
    haveAltitude
      ? ` Elevation is from the Copernicus GLO-90 terrain model (via Open-Meteo), accurate to roughly ±100–150m for most cities — enough to gauge altitude, not a precise benchmark; acclimatization varies by person, fitness, and rate of ascent.`
      : ""
  }${
    havePollen
      ? ` Pollen levels are the typical monthly tree (birch, alder, olive), grass and weed (mugwort, ragweed) pollen from the Copernicus CAMS European air-quality model via Open-Meteo (${POLLEN_START_DATE.slice(0, 4)}–${POLLEN_END_DATE.slice(0, 4)}) — a monthly mean of daily average concentrations (not daily peaks), not a live count, and a coarse model can understate a local burst.${havePollenGap ? " CAMS pollen covers European cities only, so any non-European cities here show none." : ""}`
      : ""
  }`;
}

export async function assessSeason(
  rawCities: SeasonCityInput[],
  targetMonth: number | null,
  onProgress?: (done: number, total: number, name: string) => void,
  signal?: AbortSignal,
): Promise<SeasonSummary> {
  const cities = rawCities.filter(
    (c) => c && typeof c.name === "string" && c.name.trim().length > 0,
  );

  const out: CitySeasonSummary[] = [];
  let networked = false;
  for (let i = 0; i < cities.length; i++) {
    if (signal?.aborted) break;
    const c = cities[i];
    const name = c.name.trim();
    const country = c.country?.trim() || undefined;

    // Past the cap: list the city but with no data (so the UI can be honest about the gap).
    if (i >= SEASON_CITY_CAP) {
      out.push(noData(name, country));
      onProgress?.(i + 1, cities.length, name);
      continue;
    }

    const key = cacheKey(name, country);
    const cached = seasonCache.get(key);
    // Serve a cached city ONLY if it (a) was cached by altitude-AWARE code — the `"elevationM" in cached`
    // key-existence check (NOT a value check: a legitimately sea-level/ocean city has elevationM === null
    // but the KEY present) force-refetches an entry cached before the altitude fields existed, so a
    // long-lived dev server can't serve a stale pre-altitude summary; and (b) actually carries BOTH CAMS
    // signals (PM2.5 AND UV). A city cached after a transient CAMS failure has all-null PM2.5/UV (the
    // climate still succeeded, so source is "open-meteo" and it WAS cached) — skipping it here lets the
    // CAMS fetch retry on a later request instead of suppressing the air/UV advisories for the whole
    // process lifetime (the same "don't poison a retry" rule the catch below upholds). The `&& m.uvIndex
    // != null` clause does DOUBLE duty: it also force-refetches a city cached before UV existed — such an
    // entry has m.uvIndex === undefined, and `undefined != null` is false (JS loose equality), so some()
    // returns false and the city re-fetches; no separate `"uvIndex" in` key-existence check is needed the
    // way altitude's was. A genuinely CAMS-uncovered city re-fetches each time, which is rare but correct.
    if (
      cached &&
      "elevationM" in cached &&
      "pollenFetched" in cached &&
      cached.months.some((m) => m.meanPm25 != null && m.uvIndex != null)
    ) {
      out.push(cached);
      onProgress?.(i + 1, cities.length, name);
      continue;
    }

    let summary: CitySeasonSummary;
    try {
      if (networked) await sleep(THROTTLE_MS);
      networked = true;
      const geo = await geocodeCity(name, country, signal);
      if (!geo) {
        summary = noData(name, country);
      } else {
        // Run the climate and air-quality fetches in PARALLEL on the geocoded coordinates.
        // Promise.allSettled keeps them independent: an air-quality failure becomes camsNormals=null
        // (no air or UV data) and NEVER rejects the climate season, while a climate failure still degrades
        // the city to "no data" exactly as before. fetchAirQualityNormals never throws on its own, but
        // allSettled also stops the climate fetch's deliberate throw-on-error from taking it down.
        const [normalsRes, aqiRes, pollenRes] = await Promise.allSettled([
          fetchNormals(geo.lat, geo.lon, signal),
          fetchAirQualityNormals(geo.lat, geo.lon, signal),
          fetchPollenNormals(geo.lat, geo.lon, signal),
        ]);
        const normalsResult = normalsRes.status === "fulfilled" ? normalsRes.value : null;
        const camsNormals = aqiRes.status === "fulfilled" ? aqiRes.value : null;
        // Pollen degrades independently like air quality. fetchPollenNormals never throws, but a rejected settle
        // (defensive) maps to a transient error → pollenFetched stays absent → the city re-fetches next time.
        const pollenResult: PollenFetchResult =
          pollenRes.status === "fulfilled" ? pollenRes.value : { status: "error" };
        const pollenNormals = pollenResult.status === "ok" ? pollenResult.months : null;
        // Altitude is assembled HERE, on the CitySeasonSummary, not inside classify() (which stays
        // per-month-only): elevation is month-invariant, so it's a city-level field. The 10m-rounded
        // elevationM fetchNormals returned is BOTH stored and banded by computeAltitudeAdvisory, so the
        // displayed figure and the advisory tier can't disagree.
        const elevationM = normalsResult?.elevationM ?? null;
        summary = normalsResult
          ? {
              name,
              country,
              geocoded: true,
              source: "open-meteo",
              ...classify(normalsResult.normals, geo.lat, camsNormals, pollenNormals),
              elevationM,
              altitudeAdvisory: computeAltitudeAdvisory(elevationM),
              // pollenFetched is a TRI-STATE: set true (European, data present) or false (definitively outside
              // Europe) ONLY for a definitive result; on a transient error LEAVE THE KEY ABSENT (conditional
              // spread) so the cache-read guard re-fetches rather than caching the city as non-European.
              ...(pollenResult.status === "error" ? {} : { pollenFetched: pollenResult.status === "ok" }),
            }
          : noData(name, country, true);
      }
    } catch {
      // Geocode/fetch/timeout failure isn't evidence of anything — just no data for this city.
      // Don't cache a failure: a transient outage shouldn't poison a later retry. We can't tell
      // whether the geocode itself succeeded (the fetch may have thrown instead), so report
      // geocoded:false rather than overclaim it.
      summary = noData(name, country);
      out.push(summary);
      onProgress?.(i + 1, cities.length, name);
      // An abort that surfaced as a thrown error mid-fetch: stop cleanly.
      if (signal?.aborted) break;
      continue;
    }

    if (summary.source === "open-meteo") seasonCache.set(key, summary);
    out.push(summary);
    onProgress?.(i + 1, cities.length, name);
    if (signal?.aborted) break;
  }

  // Recomputed below against the FINAL emitted cities in the route, but built here over every assessed
  // city for the model's tool_result. The helper gates each source disclosure on that signal actually
  // landing, so an all-low-altitude (or all-cool, or clean-air) plan doesn't credit a source it didn't use.
  const note = buildSeasonNote(out);

  return {
    cities: out,
    targetMonth: targetMonth ?? null,
    targetAssessment: targetMonth ? targetAssessment(out, targetMonth) : null,
    note,
    caveat: CAVEAT,
  };
}

function noData(name: string, country?: string, geocoded = false): CitySeasonSummary {
  return {
    name,
    country,
    geocoded,
    source: "none",
    tropical: false,
    challenging: false,
    months: [],
    bestWindow: "",
    // Required fields (CitySeasonSummary declares them non-optional), so a noData city initializes both
    // to null — which also makes a cache-hit on a pre-altitude entry a type error at the access site
    // rather than a silent undefined.
    elevationM: null,
    altitudeAdvisory: null,
  };
}

// A compact view of the season result for the MODEL's tool_result — the full 12-month×N-city
// payload would be token-heavy, so we send the headline window, the target-month verdict, and a
// few best/worst months per city. The full detail still goes to the UI via the server attach.
export function seasonModelView(summary: SeasonSummary): unknown {
  // best/worst months carry only SHORT tags for the heat/air signals (a full advisory on each would
  // be token noise); the target month carries the full advisories so the model can act on them.
  const monthBrief = (m: MonthSeason) => {
    const tags: string[] = [];
    if (m.heatAdvisory && m.meanApparentMaxC != null) tags.push(`feels ~${m.meanApparentMaxC}°C`);
    if (m.aqiAdvisory && m.aqiBand) tags.push(`air ${m.aqiBand}`);
    if (m.uvAdvisory && m.uvIndex != null) tags.push(`UV ${m.uvIndex}`);
    // Include the firing species + figure (like the heat/air/UV tags carry their value), so a date-flexible
    // best/worst summary distinguishes an April birch month from a July grass month — a ragweed-only sufferer
    // shouldn't be steered off a harmless-to-them birch month. pollenTag is non-null exactly when pollenAdvisory is.
    if (m.pollenTag) tags.push(`pollen: ${m.pollenTag}`);
    return `${MONTHS_SHORT[m.month - 1]} ${LABEL_WORD[m.label]} (${m.temp}, ${m.meanMaxC}°C, ${m.rain}${
      tags.length ? "; " + tags.join("; ") : ""
    })`;
  };
  // The target month additionally carries its daylight, heat and air-quality advisories INLINE, so
  // the model adapts the day structure (front-load on short days or in extreme heat, mask/indoors on
  // bad-air days) instead of inferring it from raw numbers.
  const targetBrief = (m: MonthSeason) => {
    const extras = [m.daylightAdvisory, m.heatAdvisory, m.aqiAdvisory, m.uvAdvisory, m.pollenAdvisory].filter(Boolean);
    return extras.length ? `${monthBrief(m)}; ${extras.join("; ")}` : monthBrief(m);
  };
  const tm = summary.targetMonth;
  const grounded = summary.cities.filter((c) => c.source === "open-meteo");
  // Trip-level headlines for the target month — for each signal, the advisories of the grounded
  // cities whose target month is notable, mirroring targetAssessment. Model-view ONLY (the UI keeps
  // these per-city in CitySeason, since a mixed trip can't share one line); each gives the model a
  // one-line cue to LEAD with.
  const targetCue = (pick: (m: MonthSeason | undefined) => string | null) =>
    tm != null
      ? grounded
          .map((c) => ({ name: c.name, v: pick(c.months[tm - 1]) }))
          .filter((x): x is { name: string; v: string } => !!x.v)
      : [];
  const targetDaylight = targetCue((m) => m?.daylightAdvisory ?? null);
  const targetHeat = targetCue((m) => m?.heatAdvisory ?? null);
  const targetAir = targetCue((m) => m?.aqiAdvisory ?? null);
  const targetUv = targetCue((m) => m?.uvAdvisory ?? null);
  const targetPollen = targetCue((m) => m?.pollenAdvisory ?? null);
  // Altitude heads-up is trip-level but city-NAMED (a vague "this trip is high" misattributes the day-1
  // advice to the wrong city — the adversarial lens's positional-encoding catch). Built from `grounded`
  // directly, NOT via targetCue, because altitude doesn't depend on a target month.
  const altitudeHeadsUp = grounded
    // Type-predicate filter narrows BOTH altitudeAdvisory and elevationM to non-null (the invariant
    // computeAltitudeAdvisory enforces: a non-null advisory implies a non-null elevation).
    .filter(
      (c): c is CitySeasonSummary & { elevationM: number; altitudeAdvisory: string } =>
        c.altitudeAdvisory != null,
    )
    // A COMPACT, city-NAMED cue (city + elevation + tier) — NOT a re-copy of the full advisory, which
    // the per-city block already carries; its only job is positional disambiguation (which city is high)
    // so a mixed-elevation trip can't misattribute the day-1 advice. Mirrors the other compact trip cues.
    .map((c) => ({ city: c.name, elevationM: c.elevationM, tier: altitudeTier(c.elevationM) }));
  return {
    cities: summary.cities.map((c) => {
      if (c.source !== "open-meteo") return { name: c.name, data: false };
      const ranked = [...c.months].sort((a, b) => b.comfort - a.comfort);
      // With no target month there's no single value to advise on, but a large yearlong daylight
      // swing (a high-latitude city) is itself the reason to time the trip — hand the model that
      // swing so it can steer the best window. Small-swing cities omit it (the best-window implies it).
      const swing = tm == null ? daylightSwing(c.months.map((m) => m.daylightHours)) : null;
      // Date-flexible: surface the single worst air / heat month so the model can steer AWAY from it
      // even with no target month (mirrors daylightSwing). Only when an advisory actually fires.
      const worstAir =
        tm == null
          ? [...c.months].filter((m) => m.aqiAdvisory).sort((a, b) => (b.meanPm25 ?? 0) - (a.meanPm25 ?? 0))[0]
          : undefined;
      const worstHeat =
        tm == null
          ? [...c.months]
              .filter((m) => m.heatAdvisory)
              .sort((a, b) => (b.meanApparentMaxC ?? 0) - (a.meanApparentMaxC ?? 0))[0]
          : undefined;
      // UV: surface the single worst UV month for a date-flexible trip (mirrors worstAir/worstHeat) so
      // the model can steer toward a lower-UV window. But for an equatorial city where EVERY month is at
      // least Very High (UV >= 8), a "worst month" framing falsely implies the others are gentle — so we
      // flag yearRoundUvHigh instead (there is no low-UV season to steer to) and omit the worst-month cue.
      const yearRoundUvHigh =
        tm == null && c.months.length === 12 && c.months.every((m) => m.uvIndex != null && m.uvIndex >= 8);
      const worstUv =
        tm == null && !yearRoundUvHigh
          ? [...c.months].filter((m) => m.uvAdvisory).sort((a, b) => (b.uvIndex ?? 0) - (a.uvIndex ?? 0))[0]
          : undefined;
      // Date-flexible pollen steer: name the months pollen runs high so the model can point an allergy-prone
      // traveler at a quieter window. A LIST (not a single worst month like UV) because pollen has several disjoint
      // seasons — tree in spring, grass in summer, weed in late summer — that one "worst month" would misrepresent.
      const highPollenMonths =
        tm == null
          ? c.months
              .filter((m) => m.pollenAdvisory)
              .map((m) => `${MONTHS_SHORT[m.month - 1]} (${m.pollenTag!})`)
          : [];
      return {
        name: c.name,
        tropical: c.tropical || undefined,
        challenging: c.challenging || undefined,
        bestWindow: c.bestWindow,
        best: ranked.slice(0, 3).map(monthBrief),
        worst: ranked.slice(-2).map(monthBrief),
        ...(tm ? { targetMonth: targetBrief(c.months[tm - 1]) } : {}),
        ...(swing ? { daylightSwing: swing } : {}),
        // Altitude rides OUTSIDE any tm-gated block — it's month-invariant, so the model must get it even
        // for a dateless trip (the daylight render-gate lesson). The full advisory carries the day-1
        // pacing instruction; elevationM lets the model cite the figure.
        ...(c.altitudeAdvisory ? { altitudeAdvisory: c.altitudeAdvisory, elevationM: c.elevationM } : {}),
        ...(worstAir ? { worstAirMonth: `${MONTHS_SHORT[worstAir.month - 1]} (${worstAir.aqiBand})` } : {}),
        ...(worstHeat
          ? { worstHeatMonth: `${MONTHS_SHORT[worstHeat.month - 1]} (feels ~${worstHeat.meanApparentMaxC}°C)` }
          : {}),
        ...(worstUv ? { worstUvMonth: `${MONTHS_SHORT[worstUv.month - 1]} (UV ~${worstUv.uvIndex})` } : {}),
        ...(yearRoundUvHigh ? { yearRoundUvHigh: true } : {}),
        ...(highPollenMonths.length > 0 ? { highPollenMonths: highPollenMonths.join(", ") } : {}),
        // Tell the model plainly when a city is OUTSIDE pollen coverage (the DEFINITIVE non-European verdict only,
        // never a transient error) so it won't invent pollen for it from training knowledge — paired with the
        // prompt's pollen invention-ban. A European city or a transient pollen error stays silent here.
        ...(c.pollenFetched === false ? { pollenDataUnavailable: true } : {}),
      };
    }),
    targetAssessment: summary.targetAssessment ?? undefined,
    ...(targetDaylight.length > 0
      ? {
          targetDaylightAdvisory: `${MONTHS[tm! - 1]} daylight — ${targetDaylight
            .map((x) => `${x.name}: ${x.v}`)
            .join(" ")}`,
        }
      : {}),
    ...(targetHeat.length > 0
      ? {
          targetHeatAdvisory: `${MONTHS[tm! - 1]} heat — ${targetHeat
            .map((x) => `${x.name}: ${x.v}`)
            .join(" ")}`,
        }
      : {}),
    ...(targetAir.length > 0
      ? {
          targetAirAdvisory: `${MONTHS[tm! - 1]} air quality — ${targetAir
            .map((x) => `${x.name}: ${x.v}`)
            .join(" ")}`,
        }
      : {}),
    ...(targetUv.length > 0
      ? {
          targetUvAdvisory: `${MONTHS[tm! - 1]} UV — ${targetUv
            .map((x) => `${x.name}: ${x.v}`)
            .join(" ")}`,
        }
      : {}),
    ...(targetPollen.length > 0
      ? {
          targetPollenAdvisory: `${MONTHS[tm! - 1]} pollen — ${targetPollen
            .map((x) => `${x.name}: ${x.v}`)
            .join(" ")}`,
        }
      : {}),
    ...(altitudeHeadsUp.length > 0 ? { altitudeHeadsUp } : {}),
    note: summary.note,
    caveat: summary.caveat,
  };
}

// Exposed so the route can recompute the target-month verdict against the FINAL city set (after
// the model may have dropped a city post-assessment) — the same "trust the server's recompute,
// not a stale tool result" discipline the budget uses. Internally it's targetAssessment().
export { targetAssessment as seasonTargetLine };

// Parse the model's targetMonth input defensively (it isn't strictly validated): accept an
// integer 1–12, else null (no target month → we just return the best-window guidance).
export function parseTargetMonth(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
