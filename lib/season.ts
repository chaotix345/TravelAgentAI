import { geocodeCity } from "./verify";
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
const seasonCache = new Map<string, CitySeasonSummary>();
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
const cacheKey = (name: string, country?: string) => `${fold(name)}|${fold(country ?? "")}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (x: number, x0: number, x1: number, y0: number, y1: number) =>
  y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);

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
}[];

async function fetchNormals(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<MonthlyNormals | null> {
  const url =
    `${ARCHIVE}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${START_DATE}&end_date=${END_DATE}` +
    `&daily=temperature_2m_mean,temperature_2m_max,precipitation_sum&timezone=UTC`;
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
    };
  };
  const day = data?.daily;
  if (!day?.time || !Array.isArray(day.time)) return null;
  const mean = day.temperature_2m_mean ?? [];
  const max = day.temperature_2m_max ?? [];
  const precip = day.precipitation_sum ?? [];

  // Accumulate per calendar month. timezone=UTC means a day belongs cleanly to the month in its
  // ISO date with no DST boundary ambiguity. We count years per month to turn summed precip into
  // an average MONTHLY total, and skip nulls so an occasional ERA5 gap can't poison a mean.
  const acc = Array.from({ length: 12 }, () => ({
    tempSum: 0, tempN: 0, maxSum: 0, maxN: 0, precipSum: 0, precipN: 0, rainDayCount: 0, years: new Set<string>(),
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
  if (acc.some((a) => a.tempN === 0 || a.maxN === 0 || a.precipN === 0)) return null;
  return acc.map((a) => {
    const years = Math.max(1, a.years.size);
    return {
      meanTempC: a.tempSum / a.tempN,
      meanMaxC: a.maxSum / a.maxN,
      precipMm: a.precipSum / years,
      rainDays: a.rainDayCount / years,
    };
  });
}

// Turn 12 monthly normals into 12 scored, labelled MonthSeason records plus the tropical/
// challenging flags and a best-window string. Pure function — no network — so it's easy to test.
function classify(normals: MonthlyNormals): {
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
    if (cached) {
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
        const normals = await fetchNormals(geo.lat, geo.lon, signal);
        summary = normals
          ? { name, country, geocoded: true, source: "open-meteo", ...classify(normals) }
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

  const haveData = out.some((c) => c.source === "open-meteo");
  const note = haveData
    ? `Weather grounded in Open-Meteo ERA5 climate normals (${START_DATE.slice(0, 4)}–${END_DATE.slice(0, 4)}). Labels reflect weather comfort, not crowds.`
    : "Couldn't ground the season for these cities.";

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
  };
}

// A compact view of the season result for the MODEL's tool_result — the full 12-month×N-city
// payload would be token-heavy, so we send the headline window, the target-month verdict, and a
// few best/worst months per city. The full detail still goes to the UI via the server attach.
export function seasonModelView(summary: SeasonSummary): unknown {
  const monthBrief = (m: MonthSeason) =>
    `${MONTHS_SHORT[m.month - 1]} ${LABEL_WORD[m.label]} (${m.temp}, ${m.meanMaxC}°C, ${m.rain})`;
  return {
    cities: summary.cities.map((c) => {
      if (c.source !== "open-meteo") return { name: c.name, data: false };
      const ranked = [...c.months].sort((a, b) => b.comfort - a.comfort);
      return {
        name: c.name,
        tropical: c.tropical || undefined,
        challenging: c.challenging || undefined,
        bestWindow: c.bestWindow,
        best: ranked.slice(0, 3).map(monthBrief),
        worst: ranked.slice(-2).map(monthBrief),
        ...(summary.targetMonth
          ? { targetMonth: monthBrief(c.months[summary.targetMonth - 1]) }
          : {}),
      };
    }),
    targetAssessment: summary.targetAssessment ?? undefined,
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
