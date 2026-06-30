import type { JetlagSummary } from "./schema";

// Jet-lag / circadian-adjustment grounding — the THIRTEENTH grounded signal, and the FIRST that is
// ORIGIN-RELATIVE. Every signal before it (weather, daylight, heat, air, altitude, UV, pollen,
// holidays, cost, route, flights) is a fact about WHERE you're going. Jet-lag is a fact about the
// RELATIONSHIP between where you start and where you land: the UTC-offset delta between the origin
// city's timezone and the first destination's, the direction of travel (east = phase advance =
// harder; west = phase delay = easier), and the consequent adjustment time + light-exposure cue.
//
// Mechanism (resolved by a live probe + a 4-lens design panel before coding):
//   1. Geocode the origin and the first destination city to IANA TIMEZONE NAMES via the keyless
//      Open-Meteo Geocoding API (it returns a top-level `timezone` string for essentially every
//      city, even tiny ones). Its no-match shape is a 200 with NO `results` key — a VALUE check, not
//      an HTTP 4xx — so we test for `results` presence, not just res.ok.
//   2. Turn each IANA name into a DST-CORRECT UTC offset (in MINUTES) via Intl.DateTimeFormat with
//      timeZoneName:"longOffset", evaluated on a representative date in the TRAVEL MONTH — because
//      the inter-zone delta itself swings with DST (Sydney↔London is 9h in July, 11h in January).
//      Minutes, never whole hours, because of the half-hour (+5:30) and 45-minute (+5:45, +13:45)
//      zones that integer hours would mangle.
//   3. Canonicalize the delta to the SHORTER arc [-720, 720] before reading its sign or magnitude —
//      without this, New York→Tokyo reads "+780 min / 13h east" when the body actually adapts the
//      short way (10h west). This is the panel's #1 must-fix.
//
// Like daylight/altitude/pollen, the threshold + wording all live SERVER-SIDE and the UI prints the
// computed strings verbatim. Like FX / booking-enrich, it needs NO model turn — it's a deterministic
// server fact derived after the plan emits, attached to the itinerary the same way. Graceful
// degradation is a `null` return (geocode miss / failure / below the floor), never a throw — and the
// UI shows NOTHING in that case (absence means "unremarkable crossing", never a false "no jet lag").
//
// HONEST ABOUT LIMITS: this is GENERAL behavioural travel guidance, not medical advice; the
// east-harder-than-west adjustment rate is a population rule of thumb (individual response varies a
// lot), so the estimate is shown as a RANGE; and there are NO drug names / no melatonin / no dosing
// (the same discipline pollen and altitude follow). Sources for the science: CDC Yellow Book
// (jet-lag disorder), Choy & Salbu 2019 (PMC6684967), Sack 2010 (PMC3630947).

// Below this absolute offset delta, a time-zone crossing isn't a meaningful planning signal — the
// disruption is typically indistinguishable from ordinary travel fatigue (CDC: "at least two time
// zones"; the clinical reviews tighten to three). 180 min = 3 hours = the conservative floor; below
// it computeJetlag returns null and NO block renders (Sydney→Singapore ~2h stays silent).
const JETLAG_FLOOR_MIN = 180;
// Eastward shifts beyond ~8 hours can re-entrain "antidromically" — the body drifts further LATER
// (a delay) rather than advancing, so the seek-morning-light routine becomes less reliable. We don't
// flip the light advice (added complexity + user confusion for v1); we append an honest caveat
// instead (Sack 2010, PMC3630947). 480 min = 8 hours.
const ANTIDROMIC_MIN = 480;
// Cap the adjustment estimate. Empirically a ~9h shift resolves in ~7 days (PMC6684967); past that
// the linear rule of thumb is imprecise anyway (and the antidromic caveat has already fired), so 7 is
// an honest display ceiling rather than surfacing an absurd "12 days".
const MAX_ADJUST_DAYS = 7;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Fold case + accents so a cache key / country match is robust to "São Paulo" vs "Sao Paulo". Same
// normalization shape the season cache and verify layer use.
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

// Parse an Intl "longOffset" timezone-name string to SIGNED MINUTES. The format is "GMT+09:00" /
// "GMT-04:00" / "GMT+05:45", and exactly "GMT" (or "UTC") for a zero offset (London in winter). A
// 1-digit hour and a missing-colon variant are tolerated defensively. Returns null on an
// unrecognized shape so the caller degrades rather than computing a bogus delta.
function offsetStringToMinutes(s: string): number | null {
  if (s === "GMT" || s === "UTC") return 0;
  const m = s.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const h = parseInt(m[2], 10);
  const min = m[3] ? parseInt(m[3], 10) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return sign * (h * 60 + min);
}

// DST-correct UTC offset (minutes) for an IANA timezone name at a given INSTANT. Pure: no network,
// just the V8/ICU timezone database via Intl. The instant matters — the same zone has different
// offsets across a DST boundary — so the caller passes a date in the travel month. Returns null for
// an invalid/unknown IANA name (Intl throws a RangeError, which we swallow into graceful degradation).
export function offsetMinutes(timeZone: string, date: Date): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    const part = dtf.formatToParts(date).find((p) => p.type === "timeZoneName");
    return part ? offsetStringToMinutes(part.value) : null;
  } catch {
    return null;
  }
}

// A representative INSTANT for DST evaluation: noon UTC on the 15th of the travel month. Noon-UTC
// (not local midnight) keeps it independent of the server's own timezone, and the 15th sits clear of
// any month-edge DST transition. When no travel month is known we use the current month; the year
// rolls forward to the next occurrence of that month (mirroring the flights/holidays year inference)
// so a "past" month resolves to next year — though for DST only the MONTH actually matters.
export function representativeDate(
  travelMonth: number | null,
  now: Date,
): { date: Date; month: number; year: number; monthName: string } {
  const curMonth = now.getUTCMonth() + 1;
  const curYear = now.getUTCFullYear();
  const month = travelMonth && travelMonth >= 1 && travelMonth <= 12 ? travelMonth : curMonth;
  const year = month >= curMonth ? curYear : curYear + 1;
  return {
    date: new Date(Date.UTC(year, month - 1, 15, 12)),
    month,
    year,
    monthName: MONTH_NAMES[month - 1],
  };
}

// "9 hours" / "5 hours 30 minutes" / "5 hours 45 minutes" — plain words for the headline. The
// magnitude is always >= JETLAG_FLOOR_MIN (180), so the hour count is >= 3 and "hours" is always
// plural; the minute tail only appears for the half-/45-minute zones.
function fmtOffsetWords(magnitudeMin: number): string {
  const h = Math.floor(magnitudeMin / 60);
  const m = magnitudeMin % 60;
  const hPart = `${h} hour${h === 1 ? "" : "s"}`;
  return m === 0 ? hPart : `${hPart} ${m} minutes`;
}

// The heart of the milestone, PURE and fully unit-testable: given the two resolved IANA timezone
// names + the travel month, compute the canonicalized delta, suppress below the floor, and build
// every server-owned advisory string. Returns null when there's no signal to show (offset
// unresolved, or the crossing is below the 3-hour floor — which includes a same-timezone trip).
export function buildJetlag(p: {
  origin: string;
  originTz: string;
  destinationCity: string;
  destinationTz: string;
  travelMonth: number | null;
  now: Date;
  // Whether to add the return-leg note. Defaults to true: in this planner an origin implies a
  // round trip home. A caller can pass false for a one-way move.
  hasReturn?: boolean;
}): JetlagSummary | null {
  const rep = representativeDate(p.travelMonth, p.now);
  const originOffset = offsetMinutes(p.originTz, rep.date);
  const destOffset = offsetMinutes(p.destinationTz, rep.date);
  if (originOffset === null || destOffset === null) return null;

  // rawDelta is the LITERAL clock difference (can exceed ±12h — Tokyo is genuinely 14h ahead of New
  // York). The headline states that true clock fact. But for ADAPTATION we canonicalize to the
  // SHORTER arc (the dateline must-fix): a raw +840 (NYC→Tokyo) means the body resets the other way,
  // a 10h WEST shift, not a 14h east one — so direction, magnitude, days and light all derive from
  // the canonicalized delta, never the raw one.
  const rawDelta = destOffset - originOffset;
  let delta = rawDelta;
  if (delta > 720) delta -= 1440;
  if (delta < -720) delta += 1440;

  const mag = Math.abs(delta); // the EFFECTIVE shift the body adapts to
  if (mag < JETLAG_FLOOR_MIN) return null; // unremarkable crossing (or same timezone) → no block

  const direction: "east" | "west" = delta > 0 ? "east" : "west";
  const east = direction === "east";
  // East ~1 day per timezone (phase advance, harder); west ~1 day per 1.5 timezones (phase delay,
  // easier — the circadian period runs slightly long). Round (a population mean), cap at MAX_ADJUST_DAYS.
  // `capped` marks where the per-zone rule of thumb would imply MORE days than we cap/show, so the
  // adjustment wording drops the rule there (else a 9h-east shift shows "6–7 days" while the text
  // implies 9). The low===high range branch is a defensive fallback — unreachable at the current ±1
  // spread, since low=central-1 and high=central+1 never coincide once central>=1.
  const rawDays = Math.round(mag / (east ? 60 : 90));
  const central = Math.min(rawDays, MAX_ADJUST_DAYS);
  const capped = rawDays > MAX_ADJUST_DAYS;
  const low = Math.max(1, central - 1);
  const high = Math.min(MAX_ADJUST_DAYS, central + 1);
  const rangeStr =
    low === high ? `roughly ${low} day${low === 1 ? "" : "s"}` : `roughly ${low}–${high} days`;
  const offWords = fmtOffsetWords(mag);

  // The clock statement uses the RAW offset (the literally-true "ahead/behind N hours"). When the trip
  // crosses the dateline (raw magnitude > 12h, so it differs from the canonical short arc), the
  // headline says the true clock gap AND that the body adapts the shorter way — so the figure here can
  // never contradict the smaller adjustment number below. For an ordinary crossing raw === canonical
  // and the two collapse to one honest sentence.
  const rawMag = Math.abs(rawDelta);
  const crossesDateline = rawMag !== mag;
  const rawAhead = rawDelta > 0;
  const headline = crossesDateline
    ? `${p.destinationCity} is ${fmtOffsetWords(rawMag)} ${
        rawAhead ? "ahead of" : "behind"
      } ${p.origin} by the clock — but your body adjusts the short way: about ${offWords} ${direction} (a phase ${
        east ? "advance" : "delay"
      }).`
    : `${p.destinationCity} is ${offWords} ${
        rawAhead ? "ahead of" : "behind"
      } ${p.origin} — you're flying ${direction} across time zones.`;

  // The per-zone rule of thumb holds until the cap bites; past it the range understates what the rule
  // implies, so we drop the rule and say the body completes most of the adjustment within about a week.
  const tail = capped
    ? "for a shift this large the body typically completes most of the adjustment within about a week, regardless of the exact zone count"
    : east
      ? "figure on about a day for each time zone crossed"
      : "figure on about a day for every one and a half time zones";
  const adjustment = east
    ? `Allow ${rangeStr} for your body clock to catch up. Flying east (your clock has to shift earlier) is the harder direction — ${tail}.`
    : `Allow ${rangeStr} for your body clock to catch up. Flying west (your clock shifts later) usually settles a little faster — ${tail}.`;

  let light = east
    ? `On arrival, get bright morning light and avoid bright light in the evening — that nudges your body clock earlier.`
    : `On arrival, get bright light in the late afternoon and early evening and avoid bright morning light — that nudges your body clock later.`;
  if (east && mag > ANTIDROMIC_MIN) {
    light += ` For a shift this large your body may instead reset the other way (drifting later), so if the morning-light routine isn't clicking, don't force it — let your own sleepiness lead.`;
  }

  const dayOne = `Plan a gentle first day in ${p.destinationCity}: nothing strenuous or early, an easy afternoon, and an early night to start resetting.`;

  const hasReturn = p.hasReturn !== false;
  const returnNote = hasReturn
    ? east
      ? `Your return flies west — most travellers find the westward direction a little easier to adjust to, on average.`
      : `Your return flies east — most travellers find the eastward direction a bit harder, on average, so ease back into your home schedule.`
    : null;

  const disclosure = `General travel guidance, not medical advice — individual adjustment varies a lot, and the adjustment estimate above is a rule of thumb. Time-zone offsets are DST-correct for ${rep.monthName} travel; time-zone data via Open-Meteo (CC BY 4.0).`;

  return {
    source: "computed",
    origin: p.origin,
    originTz: p.originTz,
    destinationCity: p.destinationCity,
    destinationTz: p.destinationTz,
    deltaMinutes: delta,
    direction,
    adjustmentDays: central,
    headline,
    adjustment,
    light,
    dayOne,
    returnNote,
    disclosure,
  };
}

// --- network layer (the only impure part) -----------------------------------------------------

const OPEN_METEO_GEO = "https://geocoding-api.open-meteo.com/v1/search";
const GEO_TIMEOUT_MS = 4000; // Open-Meteo geocoding is sub-second; a tight bound keeps the post-emit
// jet-lag pass from leaving the NDJSON stream silent for long (the "finalizing" status precedes it).
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";

// Module-level cache of resolved IANA timezone names, keyed by folded name|country. IANA assignments
// for a city are effectively permanent, so caching across requests in a server-instance lifetime
// avoids repeat geocoding. WRITE-ON-CONFIRMED-SUCCESS ONLY (a transient failure / no-results must
// leave the key ABSENT so the next request retries — never poison the cache with a "no tz" verdict).
const tzCache = new Map<string, string>();

type GeoResult = { timezone?: string; country?: string; country_code?: string; name?: string };

// Resolve a city name to its IANA timezone via Open-Meteo Geocoding. Returns null for a clean
// no-match (the API's 200-with-no-`results` shape) OR any network/HTTP/abort failure — both are
// "couldn't resolve", which the caller degrades to no jet-lag block (never a throw). When a country
// is given we prefer the result whose country (or ISO code) matches, so "Sydney"+"Australia" picks
// Australia/Sydney rather than America/Halifax (Nova Scotia).
export async function geocodeTimezone(
  name: string,
  country?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const q = name.trim();
  if (!q) return null;
  const key = `${fold(q)}|${fold(country ?? "")}`;
  const cached = tzCache.get(key);
  if (cached) return cached;

  try {
    const url = `${OPEN_METEO_GEO}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`;
    const timeout = AbortSignal.timeout(GEO_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: GeoResult[] };
    // Open-Meteo's no-match is HTTP 200 with NO `results` key — a VALUE check, not an HTTP error.
    // Accessing data.results[0] without this guard would throw a TypeError instead of degrading.
    if (!data.results || data.results.length === 0) return null;
    const want = country ? fold(country) : "";
    const pick = want
      ? (data.results.find(
          (r) => fold(r.country ?? "") === want || fold(r.country_code ?? "") === want,
        ) ?? data.results[0])
      : data.results[0];
    const tz = pick?.timezone;
    // Cache + return ONLY a confirmed non-empty timezone string. Anything else falls through to
    // null WITHOUT writing the cache, so a transient miss can be retried on a later request.
    if (typeof tz === "string" && tz.length > 0) {
      // Validate the zone is ICU-recognized BEFORE caching: Open-Meteo returns standard IANA names,
      // but caching a string Intl can't parse would suppress jet-lag for this city for the whole
      // process lifetime (offsetMinutes would return null on every later use). offsetMinutes returns
      // null on an unknown zone (Intl throws, we catch), so a bad value falls through to a retry.
      if (offsetMinutes(tz, new Date()) !== null) {
        tzCache.set(key, tz);
        return tz;
      }
    }
    return null;
  } catch {
    return null; // timeout / network / abort → unresolved → graceful no-block
  }
}

// Public entry point — executes the jet-lag grounding pass. Geocodes the origin and the first
// destination city to IANA timezones IN PARALLEL (Promise.allSettled so one failure can't block the
// other), then runs the pure buildJetlag. Returns null whenever there's nothing to show: no origin
// or destination, either timezone unresolved, or the crossing is below the floor. The origin field
// is free text ("Sydney" or "Sydney, Australia"), so we split a trailing ", Country" off as a hint.
export async function computeJetlag(
  origin: string,
  destinationCity: string | undefined,
  destinationCountry: string | undefined,
  travelMonth: number | null,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<JetlagSummary | null> {
  const o = origin.trim();
  const dest = destinationCity?.trim();
  if (!o || !dest) return null;

  const [oNameRaw, ...oRest] = o.split(",");
  const oName = oNameRaw.trim();
  // Use the LAST comma-segment as the country hint: "Sydney, Nova Scotia, Canada" → "Canada" (not
  // "Nova Scotia, Canada", which would match no country and silently fall back to the wrong Sydney).
  const oCountry = oRest.length > 0 ? oRest[oRest.length - 1].trim() || undefined : undefined;
  if (!oName) return null;

  const [originTzRes, destTzRes] = await Promise.allSettled([
    geocodeTimezone(oName, oCountry, signal),
    geocodeTimezone(dest, destinationCountry, signal),
  ]);
  const originTz = originTzRes.status === "fulfilled" ? originTzRes.value : null;
  const destinationTz = destTzRes.status === "fulfilled" ? destTzRes.value : null;
  if (!originTz || !destinationTz) return null;

  return buildJetlag({
    origin: oName,
    originTz,
    destinationCity: dest,
    destinationTz,
    travelMonth,
    now,
  });
}
