import { countryIso2 } from "./cost";
import type { HolidayItem, CountryHolidays, HolidaySummary } from "./schema";

// check_holidays grounds the PUBLIC-HOLIDAY closures of a plan the way best_time_to_go grounds
// its WEATHER. The season tool deliberately disclaims crowds and holidays ("Actual crowds and
// prices also depend on school holidays, festivals and flight schedules"); this tool fills that
// acknowledged gap with the one piece of it that has a free, authoritative, keyless source:
// statutory public holidays, from the Nager.Date API.
//
// Shape mirrors the other grounding tools:
//   1. Resolve each city's COUNTRY name to an ISO 3166-1 alpha-2 code (reusing countryIso2 from
//      lib/cost.ts, which folds + aliases + reads the bundled World Bank table — no second table).
//   2. For each DISTINCT country (holidays are national, so a 3-city France trip is ONE fetch),
//      GET /api/v3/PublicHolidays/{year}/{ISO2} from Nager.Date (keyless, free for non-profit use).
//   3. Keep the NATIONWIDE statutory closures (types Public/Bank, global=true) that fall in the
//      trip's target month, derive day-of-week + long-weekend server-side, and label each.
//
// Like the verify verdict, the budget and the season, what the UI shows is OURS (server-computed
// here), never a claim the model made. The model reads a compact view (holidayModelView) to warn
// about closures, suggest shifting a museum day, or note a long-weekend travel surge, then emits.
//
// HONESTY NOTES (the same free-data-first, honest-about-limits stance as cost.ts/season.ts):
//   - Public holidays are a reliable proxy for CLOSURES (government, banks, many attractions) and,
//     around long weekends, for heavier DOMESTIC travel — NOT for measured tourist crowd counts,
//     school-holiday timing, or festival attendance. We never claim "crowds" from this data.
//   - Nager.Date OMITS Islamic lunar-calendar holidays (Eid, Ramadan) even for countries it
//     otherwise covers (verified: Turkey returns only its secular civic holidays). For those
//     destinations we say so explicitly rather than imply a clean "no holidays" — a silent gap
//     would be worse than no data.
//   - Nager covers ~150 countries; major destinations (India, Thailand, UAE, Nepal, Jordan, ...)
//     are absent. An uncovered country degrades to source:"none" so the UI shows "no data", never
//     a misleading "no holidays".

const NAGER_API = "https://date.nager.at/api/v3";
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";
// Nager.Date documents NO rate limits, but we still pace per distinct country as a courtesy and to
// bound a many-country trip's wall-clock — far below verify/season's 1100ms (that's Nominatim's
// courtesy floor; Nager has none).
const THROTTLE_MS = 300;
const FETCH_TIMEOUT_MS = 6000;
// Cap distinct countries fetched, matching season.ts's city cap. A realistic trip visits a handful
// of countries; past the cap a country is listed with no data rather than blowing the wall-clock.
const COUNTRY_CAP = 8;

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Countries where major statutory holidays follow the Islamic lunar calendar (Eid al-Fitr, Eid
// al-Adha, etc.) that Nager.Date does NOT return, but which Nager otherwise covers with their
// secular civic holidays. The caveat only renders when we actually got Nager data for the country
// (source:"nager"), so an over-inclusive entry here is harmless — it just never fires. Heuristic
// set, ISO 3166-1 alpha-2.
const ISLAMIC_OMISSION = new Set<string>([
  "TR", "EG", "MA", "ID", "BD", "DZ", "TN", "AL", "BA", "NG", "AZ", "KZ", "KG",
]);

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type HolidayCityInput = { name: string; country?: string };

// The raw shape from GET /api/v3/PublicHolidays/{year}/{code} (verified against the live v3 API).
// `fixed` and `launchYear` are vestigial/deprecated and unused; we read date/name/localName/global/
// types and ignore the rest.
type NagerHoliday = {
  date?: string;
  localName?: string;
  name?: string;
  countryCode?: string;
  global?: boolean;
  types?: string[];
};

// --- pure helpers (no network — easy to reason about and unit-test) ---------------------------

// Nager needs a YEAR; the loop usually knows only a target month (1-12) inferred from the brief.
// Roll forward to the next occurrence of that month: a month >= the current month is this year, an
// earlier month is next year. (A trip in the current month is treated as this year — the common
// case; a trip planned for the same month a year out is the rare exception the month-only signal
// can't distinguish, and the caveat notes the single-month limitation.) Pure.
export function inferHolidayYear(targetMonth: number, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return targetMonth >= m ? y : y + 1;
}

const monthOf = (dateISO: string): number => Number.parseInt(dateISO.slice(5, 7), 10);

// A nationwide statutory closure: a Public or Bank holiday that applies to the whole country
// (global=true). Regional/subdivision-only holidays (global=false — e.g. a single German Land or
// Scottish bank holiday) are dropped as low-signal for a city-level traveler; the caveat flags
// that gap for the UK. School/Optional/Observance types are excluded as noise.
export function isClosureHoliday(h: NagerHoliday): boolean {
  return (
    h.global === true &&
    typeof h.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(h.date) &&
    Array.isArray(h.types) &&
    h.types.some((t) => t === "Public" || t === "Bank")
  );
}

// Countries whose official weekend is Friday–Saturday, so the weekend/long-weekend flags must shift:
// a Fri or Sat holiday already falls on a day off, and THURSDAY is the bridge day into the weekend.
// Several of these (Egypt, Algeria, Bangladesh) are in ISLAMIC_OMISSION and DO return Nager data, so
// the default Mon–Fri assumption would mis-flag them. Listing a country Nager doesn't cover is
// harmless — only source:"nager" rows reach toHolidayItem. ISO 3166-1 alpha-2.
const FRI_SAT_WEEKEND = new Set<string>([
  "EG", "DZ", "BD", "IL", "BH", "KW", "OM", "QA", "SA", "AE", "JO", "IQ", "LY", "SD", "YE",
]);

// Turn one Nager holiday into our labelled HolidayItem: day-of-week + weekend/long-weekend flags
// derived server-side from the date. A holiday that bridges into the weekend (Mon/Fri in a Sat–Sun
// country, Thursday in a Fri–Sat one) likely means a domestic-travel surge; one already on a weekend
// day is less disruptive. iso2 selects the weekend convention. Pure.
export function toHolidayItem(h: NagerHoliday, iso2?: string | null): HolidayItem {
  const date = h.date as string;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const friSat = iso2 != null && FRI_SAT_WEEKEND.has(iso2);
  return {
    date,
    name: (h.name ?? h.localName ?? "Public holiday").trim(),
    localName: (h.localName ?? h.name ?? "").trim(),
    dayOfWeek: DAY_NAMES[dow] ?? "",
    weekend: friSat ? dow === 5 || dow === 6 : dow === 0 || dow === 6,
    longWeekend: friSat ? dow === 4 : dow === 1 || dow === 5,
    closure: true,
  };
}

const noCountryData = (country: string, iso2: string | null): CountryHolidays => ({
  country,
  iso2,
  source: "none",
  holidays: [],
  islamicCaveat: false,
});

const CAVEAT =
  "Public holidays mean government offices, banks and some attractions close on these dates; long " +
  "weekends around them can mean heavier domestic travel. School-holiday and festival dates, which " +
  "also drive crowds, are not included.";

function emptySummary(targetMonth: number | null, year: number): HolidaySummary {
  return {
    targetMonth: targetMonth ?? 0,
    year,
    countries: [],
    note: "No public-holiday data for these dates.",
    caveat: CAVEAT,
  };
}

// --- Nager HTTP -------------------------------------------------------------------------------

// Process-lifetime cache of the raw per-(country, year) holiday list. Nager data is static within a
// year, so this is safe to keep for the server instance's life (like season.ts's seasonCache) and
// means a refine — or a second city in the same country — skips the fetch. Keyed by iso2|year so a
// long-lived instance crossing a new-year boundary still keys correctly. We cache successful
// fetches only; a transient failure must not poison a later retry.
const holidayCache = new Map<string, NagerHoliday[]>();

async function fetchCountryHolidays(
  iso2: string,
  year: number,
  signal?: AbortSignal,
): Promise<NagerHoliday[] | null> {
  const key = `${iso2.toLowerCase()}|${year}`;
  const cached = holidayCache.get(key);
  if (cached) return cached;

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(`${NAGER_API}/PublicHolidays/${year}/${encodeURIComponent(iso2)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  // 404 = Nager doesn't cover this country; any non-2xx = no data. Both degrade to null (the caller
  // shows "no data"), never a throw that would break the plan.
  if (!res.ok) {
    if (res.status !== 404) console.warn(`Nager.Date HTTP ${res.status} for ${iso2}/${year}`);
    return null;
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return null;
  const list = data as NagerHoliday[];
  holidayCache.set(key, list);
  return list;
}

// --- public entry point — executes the check_holidays tool ------------------------------------

// Mirrors assessSeason: filter inputs, dedup to distinct COUNTRIES (holidays are national), loop
// (throttled, abortable, capped), degrade gracefully to "no data", stream progress, attach a
// trip-level note + caveat. Returns the full HolidaySummary the server attaches to the plan.
export async function assessHolidays(
  rawCities: HolidayCityInput[],
  targetMonth: number | null,
  now: Date,
  onProgress?: (done: number, total: number, name: string) => void,
  signal?: AbortSignal,
): Promise<HolidaySummary> {
  // No travel month -> no meaningful window or year. Return empty; the route won't attach it.
  if (targetMonth == null) return emptySummary(targetMonth, 0);
  const year = inferHolidayYear(targetMonth, now);

  const cities = rawCities.filter(
    (c) => c && typeof c.name === "string" && c.name.trim().length > 0,
  );

  // Distinct countries only — dedup by resolved iso2 (so two French cities make ONE Nager call),
  // falling back to the folded name for an unresolved country so it still shows as "no data".
  const seen = new Set<string>();
  const distinct: Array<{ country: string; iso2: string | null }> = [];
  for (const c of cities) {
    const country = c.country?.trim();
    if (!country) continue; // no country named -> nothing to resolve
    const iso2 = countryIso2(country);
    const key = iso2 ? `iso:${iso2}` : `name:${fold(country)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ country, iso2 });
  }

  const out: CountryHolidays[] = [];
  let networked = false;
  for (let i = 0; i < distinct.length; i++) {
    if (signal?.aborted) break;
    const { country, iso2 } = distinct[i];

    // Past the cap, or a country we couldn't resolve to an ISO code: list it with no data so the UI
    // is honest about the gap rather than silently dropping it.
    if (i >= COUNTRY_CAP || !iso2) {
      out.push(noCountryData(country, iso2));
      onProgress?.(i + 1, distinct.length, country);
      continue;
    }

    let entry: CountryHolidays;
    try {
      if (networked) await sleep(THROTTLE_MS);
      networked = true;
      const raw = await fetchCountryHolidays(iso2, year, signal);
      if (raw == null) {
        entry = noCountryData(country, iso2);
      } else {
        const holidays = raw
          .filter(isClosureHoliday)
          .filter((h) => monthOf(h.date as string) === targetMonth)
          .map((h) => toHolidayItem(h, iso2))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        entry = { country, iso2, source: "nager", holidays, islamicCaveat: ISLAMIC_OMISSION.has(iso2) };
      }
    } catch {
      // Geocode/fetch/timeout failure isn't evidence of anything — just no data for this country.
      entry = noCountryData(country, iso2);
      out.push(entry);
      onProgress?.(i + 1, distinct.length, country);
      if (signal?.aborted) break;
      continue;
    }

    out.push(entry);
    onProgress?.(i + 1, distinct.length, country);
    if (signal?.aborted) break;
  }

  const haveData = out.some((c) => c.source === "nager");
  const note = haveData
    ? `Public holidays for ${year} from Nager.Date — nationwide statutory holidays in the trip month.`
    : "No public-holiday data available for these countries.";

  return { targetMonth, year, countries: out, note, caveat: CAVEAT };
}

// A compact, model-facing view for the tool_result — the model needs the gist (which dates close
// things, which are long weekends) to weave one honest line into its plan, not the full payload.
// A covered country with no holidays sends holidays:[] so the model can say "no closures that
// month"; an uncovered one sends data:false so it won't claim there are none.
export function holidayModelView(summary: HolidaySummary): unknown {
  return {
    targetMonth: summary.targetMonth,
    year: summary.year,
    countries: summary.countries.map((c) =>
      c.source === "nager"
        ? {
            country: c.country,
            holidays: c.holidays.map(
              (h) =>
                `${h.date} (${h.dayOfWeek}) ${h.name}${
                  h.longWeekend ? " — long weekend" : h.weekend ? " — falls on a weekend" : ""
                }`,
            ),
            ...(c.islamicCaveat
              ? { note: "Islamic holidays (Eid, Ramadan) are NOT in this data source — flag that for this country." }
              : {}),
          }
        : { country: c.country, data: false },
    ),
    note: summary.note,
    caveat: summary.caveat,
  };
}

// Recompute the holiday summary against the FINAL city set (after the model may have dropped a city
// post-grounding) — the same "trust the server's recompute, not a stale tool result" discipline the
// budget and season verdict use. Keep only countries whose cities survived to emit; attach nothing
// unless at least one surviving country was actually covered (so an all-"no data" block isn't shown).
export function recomputeHolidays(
  summary: HolidaySummary | null,
  cities: Array<{ country?: string }>,
): HolidaySummary | null {
  if (!summary || summary.targetMonth < 1) return null;
  const finalKeys = new Set<string>();
  for (const c of cities) {
    const country = c.country?.trim();
    if (!country) continue;
    const iso2 = countryIso2(country);
    finalKeys.add(iso2 ? `iso:${iso2}` : `name:${fold(country)}`);
  }
  const kept = summary.countries.filter((c) => {
    const key = c.iso2 ? `iso:${c.iso2}` : `name:${fold(c.country)}`;
    return finalKeys.has(key);
  });
  if (!kept.some((c) => c.source === "nager")) return null;
  return { ...summary, countries: kept };
}
