import { COUNTRY_PRICE_LEVELS, type CountryPriceLevel } from "./costData";
import type { CostTier } from "./schema";

// estimate_costs grounds the BUDGET of a plan the way verify_places grounds its PLACES
// and check_route grounds its ROUTE. There is no reliable keyless source for live flight or
// hotel prices (Amadeus self-service is shutting down; everything else is key-walled), and
// inventing exact prices is exactly what the system prompt forbids. So we ground COST LEVEL
// instead, in two layers that mirror verify.ts's OSM-then-Wikipedia fallback:
//
//   1. A bundled, offline World Bank price-level table (lib/costData.ts) gives every country a
//      COMPARABLE cost tier and a per-style daily budget. This always works — no network, no key.
//   2. A live, keyless Wikivoyage lookup (the same public MediaWiki API verify.ts already uses
//      for Wikipedia) adds REAL, verbatim per-city price anchors ("budget hostel from €19"),
//      so the numbers are illustrated with sourced examples rather than asserted.
//
// The model uses the result to right-size nights, flag or swap pricey cities, and say where to
// save — then emits. Like verification, the budget the UI shows is OURS (server-attached from
// this tool), not a number the model claimed.

export type CostStyle = "budget" | "mid-range" | "luxury";
// CostTier is the single source of truth in lib/schema.ts (it's also the UI-facing type, kept
// import-free there for the client bundle). Re-export it so server callers can reach it here too.
export type { CostTier };

export type CostCityInput = { name: string; country?: string; nights: number };

export type CityCost = {
  name: string;
  country?: string;
  nights: number;
  tier: CostTier;
  // Per-person, per-day, all-in (lodging + food + local transport + activities) for the chosen
  // style. null when we have no price level for the country.
  dailyUsd: number | null;
  subtotalUsd: number | null; // dailyUsd * nights
  // Home-currency conversions of the two figures above. estimateCosts() leaves these undefined —
  // it stays a pure, offline, USD-only computation. The route fills them in afterwards via
  // lib/currency.ts (applyFxToCost) once it knows the live ECB rate, the same way verify verdicts
  // are attached after the fact. undefined/null → no conversion ran (degrade to native USD).
  dailyHome?: number | null;
  subtotalHome?: number | null;
  priceLevel: number | null; // World Bank ratio, US = 1.0
  anchors: string[]; // verbatim real price snippets pulled from Wikivoyage
  source: "worldbank" | "none"; // where the tier/daily figure came from
};

export type CostEstimate = {
  style: CostStyle;
  // The native currency the figures below are computed in. estimateCosts() always returns "USD"
  // (World Bank price levels are USD-denominated); the type is `string` so the route can carry a
  // converted estimate through the same shape. The home-currency fields live alongside.
  currency: string;
  cities: CityCost[];
  totalUsd: number | null; // sum of per-city subtotals (per person), null if nothing priced
  perDayUsd: number | null; // total / total nights, a headline daily figure
  flags: string[];
  note: string;
  // Filled by the route's FX pass (lib/currency.ts), not by estimateCosts. Absent → no conversion.
  homeCurrency?: string;
  totalHome?: number | null;
  perDayHome?: number | null;
  rate?: number;
  rateDate?: string;
};

// --- Heuristics (tunable, like route.ts's distance thresholds) -------------------------------
// US-baseline (priceLevel = 1.0) all-in daily spend per person for each style; a country's
// figure is this scaled by its World Bank price level. Floors stop a very cheap country from
// showing an implausible single-digit day. These are deliberate estimates, surfaced as "~$X"
// and clearly labelled — the GROUNDED part is the relative price level and the Wikivoyage
// anchors; these bands turn that into a usable number.
const STYLE_BASE_USD: Record<CostStyle, number> = { budget: 75, "mid-range": 160, luxury: 400 };
const STYLE_FLOOR_USD: Record<CostStyle, number> = { budget: 15, "mid-range": 35, luxury: 90 };

// Tier cutoffs on the price level (US = 1.0). Tuned so the US lands "pricey", typical Western
// Europe "moderate"–"pricey", Switzerland/Nordics "expensive", SE Asia "cheap".
function tierFor(priceLevel: number): CostTier {
  if (priceLevel < 0.5) return "cheap";
  if (priceLevel < 0.8) return "moderate";
  if (priceLevel < 1.1) return "pricey";
  return "expensive";
}

const WIKIVOYAGE = "https://en.wikivoyage.org/w/api.php";
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";
const THROTTLE_MS = 1100; // match the courtesy pacing verify.ts uses for Wikimedia
const FETCH_TIMEOUT_MS = 5000;
// Cap how many cities we fetch Wikivoyage anchors for. Each fetch is throttled (~1.1s) plus up
// to a 5s timeout, so without a cap a many-city trip could push the request past the function's
// wall-clock limit. Cities past the cap still get their bundled price tier — just no anchors.
const WIKIVOYAGE_ANCHOR_CAP = 8;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

// Traveler-facing country names → the World Bank's folded key, for the cases where they differ
// (the model says "Vietnam"/"South Korea"; the dataset says "viet nam"/"korea, rep.").
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "united states",
  "u.s.": "united states",
  us: "united states",
  america: "united states",
  uk: "united kingdom",
  "u.k.": "united kingdom",
  britain: "united kingdom",
  "great britain": "united kingdom",
  england: "united kingdom",
  scotland: "united kingdom",
  wales: "united kingdom",
  vietnam: "viet nam",
  "south korea": "korea, rep.",
  korea: "korea, rep.",
  "north korea": "korea, dem. people's rep.",
  russia: "russian federation",
  turkey: "turkiye",
  "czech republic": "czechia",
  laos: "lao pdr",
  brunei: "brunei darussalam",
  slovakia: "slovak republic",
  kyrgyzstan: "kyrgyz republic",
  egypt: "egypt, arab rep.",
  iran: "iran, islamic rep.",
  syria: "syrian arab republic",
  venezuela: "venezuela, rb",
  bolivia: "bolivia",
  moldova: "moldova",
  macedonia: "north macedonia",
  "hong kong": "hong kong sar, china",
  macau: "macao sar, china",
  macao: "macao sar, china",
  "the bahamas": "bahamas, the",
  bahamas: "bahamas, the",
  "the gambia": "gambia, the",
  gambia: "gambia, the",
  "ivory coast": "cote d'ivoire",
  "cape verde": "cabo verde",
  "democratic republic of the congo": "congo, dem. rep.",
  "dr congo": "congo, dem. rep.",
  "republic of the congo": "congo, rep.",
  uae: "united arab emirates",
};

function lookupCountry(country?: string): CountryPriceLevel | null {
  if (!country) return null;
  const key = fold(country);
  // Guard priceLevel > 0 as insurance: the generator already drops implausible values, but a
  // stray non-positive ratio must never reach the daily-band math (it would floor-clamp to a
  // fake "grounded" number instead of falling through to an honest "no data").
  const direct = COUNTRY_PRICE_LEVELS[key];
  if (direct && direct.priceLevel > 0) return direct;
  const aliased = COUNTRY_ALIASES[key];
  const viaAlias = aliased ? COUNTRY_PRICE_LEVELS[aliased] : undefined;
  if (viaAlias && viaAlias.priceLevel > 0) return viaAlias;
  return null;
}

// --- Wikivoyage price anchors ---------------------------------------------------------------
// Best-effort extraction of a few REAL, verbatim price snippets from a city's Wikivoyage
// article. These illustrate the tier with sourced examples; they're not cross-compared or used
// to compute the tier (the bundled price level does that), so noisy parsing degrades gracefully
// to "no anchors" rather than a wrong number.

// Wikivoyage writes currency as {{EUR|10-20}} etc. Expand those to a symbol+number BEFORE any
// template-stripping, or the price would be deleted with the template.
const convertCurrency = (s: string) =>
  s.replace(/\{\{\s*(EUR|USD|GBP|JPY|INR|THB|AUD|CAD|CHF)\s*\|\s*([^}]*)\}\}/gi, (_m, cur, val) => {
    const sym: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };
    return `${sym[cur.toUpperCase()] ?? cur.toUpperCase() + " "}${val}`;
  });

const stripWiki = (s: string) =>
  s
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1") // [[target|label]] -> label
    .replace(/\[\[([^\]]*)\]\]/g, "$1") // [[page]] -> page
    .replace(/'''?/g, "") // bold/italic
    .replace(/<ref[^>]*>.*?<\/ref>/gis, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\{[^}]*\}\}/g, "") // drop any remaining templates
    .replace(/\s+/g, " ")
    .trim();

// Pull the wikitext of one == Heading == section, up to the next level-2 (==…==) heading so its
// ===subsections=== (Budget/Mid-range/Splurge) are included. JS regex has no \Z, so we slice.
function section(wikitext: string, heading: string): string {
  const headingRe = new RegExp(`^==+\\s*${heading}\\s*==+\\s*$`, "im");
  const m = headingRe.exec(wikitext);
  if (!m) return "";
  const rest = wikitext.slice(m.index + m[0].length);
  const next = /^==[^=].*$/m.exec(rest); // next top-level section heading
  // .trim() so an empty section returns "" (falsy) — otherwise the leading "\n" is truthy and the
  // caller's `|| wikitext` fallback (which would scan the whole article) never fires.
  return (next ? rest.slice(0, next.index) : rest).trim();
}

// Turn a raw price= field or {{EUR|10-20}} into a short, clean string with a currency number.
function cleanPrice(raw: string): string | null {
  let s = convertCurrency(raw).trim();
  s = stripWiki(s);
  // Reject leftover template syntax (a malformed or nested {{...}} that didn't expand) rather than
  // surface a garbled anchor like "€{{convert|10|EUR".
  if (s.includes("{{") || s.includes("}}")) return null;
  // Must contain a currency symbol or an explicit currency word with a number to be useful.
  if (!/[€£$¥₹฿]|\b(eur|usd|gbp|yen|baht|rupee|kr|zł|czk)\b/i.test(s)) return null;
  if (!/\d/.test(s)) return null;
  return s.length > 90 ? s.slice(0, 87).trimEnd() + "…" : s;
}

// Parse a {{Sleeppricerange|Budget=..|Mid-range=..|Splurge=..}} / {{Eatpricerange|...}} call.
function priceRangeAnchor(wikitext: string, template: string, label: string): string | null {
  const re = new RegExp(`\\{\\{\\s*${template}\\s*\\|([^}]*)\\}\\}`, "i");
  const m = wikitext.match(re);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const part of m[1].split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) params[fold(part.slice(0, eq))] = part.slice(eq + 1).trim();
  }
  const budget = params["budget"];
  const splurge = params["splurge"] || params["expensive"];
  const parts: string[] = [];
  if (budget) parts.push(`budget ${stripWiki(convertCurrency(budget))}`);
  if (splurge) parts.push(`splurge ${stripWiki(convertCurrency(splurge))}`);
  if (parts.length === 0) return null;
  const out = `${label}: ${parts.join(", ")}`;
  return out.length > 90 ? out.slice(0, 87).trimEnd() + "…" : out;
}

// Collect up to `max` price= listing values from a section's wikitext.
function listingPrices(sectionText: string, max: number): string[] {
  const out: string[] = [];
  const re = /\|\s*price\s*=\s*([^|}\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sectionText)) && out.length < max) {
    const cleaned = cleanPrice(m[1]);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

async function wikivoyageAnchors(city: string, signal?: AbortSignal): Promise<string[]> {
  const url = `${WIKIVOYAGE}?action=parse&page=${encodeURIComponent(
    city,
  )}&prop=wikitext&format=json&redirects=1`;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`Wikivoyage HTTP ${res.status}`);
  const data = (await res.json()) as { parse?: { wikitext?: { "*"?: string } }; error?: unknown };
  const wikitext = data?.parse?.wikitext?.["*"];
  if (!wikitext) return [];

  const anchors: string[] = [];
  const sleepSec = section(wikitext, "Sleep");
  const eatSec = section(wikitext, "Eat");

  const sleepRange = priceRangeAnchor(sleepSec || wikitext, "Sleeppricerange", "Accommodation");
  if (sleepRange) anchors.push(sleepRange);
  const eatRange = priceRangeAnchor(eatSec || wikitext, "Eatpricerange", "Meals");
  if (eatRange) anchors.push(eatRange);

  // Top up with concrete listing prices from Sleep, then Eat, until we have a few.
  for (const sec of [sleepSec, eatSec]) {
    if (anchors.length >= 3) break;
    for (const p of listingPrices(sec, 3 - anchors.length)) {
      if (!anchors.includes(p)) anchors.push(p);
      if (anchors.length >= 3) break;
    }
  }
  return anchors.slice(0, 3);
}

export function parseStyle(raw: unknown): CostStyle {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "budget" || s.includes("budget") || s.includes("cheap") || s.includes("shoestring"))
    return "budget";
  if (s === "luxury" || s.includes("luxur") || s.includes("splurge") || s.includes("high-end"))
    return "luxury";
  return "mid-range";
}

export async function estimateCosts(
  rawCities: CostCityInput[],
  style: CostStyle,
  // Optional: called as each city resolves, so the route can stream "pricing 2/4" progress the
  // way verification streams per-place progress.
  onProgress?: (done: number, total: number, name: string) => void,
  signal?: AbortSignal,
): Promise<CostEstimate> {
  const cities = rawCities.filter(
    (c) => c && typeof c.name === "string" && c.name.trim().length > 0,
  );

  const base = STYLE_BASE_USD[style];
  const floor = STYLE_FLOOR_USD[style];
  const out: CityCost[] = [];
  let networked = false;
  let dataYear = 0;

  for (let i = 0; i < cities.length; i++) {
    if (signal?.aborted) break;
    const c = cities[i];
    const nights = Number.isFinite(c.nights) && c.nights > 0 ? Math.floor(c.nights) : 1;
    const level = lookupCountry(c.country);

    let dailyUsd: number | null = null;
    let subtotalUsd: number | null = null;
    let tier: CostTier = "unknown";
    if (level) {
      dataYear = Math.max(dataYear, level.year);
      tier = tierFor(level.priceLevel);
      dailyUsd = Math.max(floor, Math.round(base * level.priceLevel));
      subtotalUsd = dailyUsd * nights;
    }

    // Live, keyless Wikivoyage anchors — best effort, never fatal. Capped (see
    // WIKIVOYAGE_ANCHOR_CAP) so a many-city trip can't blow the wall-clock budget; capped cities
    // still get their bundled tier, just no illustrative anchors.
    let anchors: string[] = [];
    if (i < WIKIVOYAGE_ANCHOR_CAP) {
      try {
        if (networked) await sleep(THROTTLE_MS);
        networked = true;
        anchors = await wikivoyageAnchors(c.name.trim(), signal);
      } catch {
        anchors = []; // a thin article or a transient error just means no illustrative anchors
      }
      // An abort that landed mid-fetch surfaces here as a caught error; stop now instead of
      // pushing one more city and streaming a stray progress event after the client has gone.
      if (signal?.aborted) break;
    }

    out.push({
      name: c.name.trim(),
      country: c.country?.trim() || undefined,
      nights,
      tier,
      dailyUsd,
      subtotalUsd,
      priceLevel: level ? level.priceLevel : null,
      anchors,
      source: level ? "worldbank" : "none",
    });
    onProgress?.(i + 1, cities.length, c.name.trim());
  }

  const priced = out.filter((c) => c.subtotalUsd != null);
  const totalUsd = priced.length > 0 ? priced.reduce((s, c) => s + (c.subtotalUsd ?? 0), 0) : null;
  const totalNights = priced.reduce((s, c) => s + c.nights, 0);
  const perDayUsd = totalUsd != null && totalNights > 0 ? Math.round(totalUsd / totalNights) : null;

  // Flags: surface the cost outliers a traveler would want to act on.
  const flags: string[] = [];
  const expensive = out.filter((c) => c.tier === "expensive");
  if (expensive.length > 0) {
    flags.push(
      `${expensive
        .map((c) => c.name)
        .join(
          ", ",
        )} ${expensive.length === 1 ? "is an expensive base" : "are expensive bases"} — keep nights here lean or trim elsewhere to stay on budget.`,
    );
  }
  if (priced.length >= 2) {
    const cheapest = priced.reduce((a, b) => ((a.dailyUsd ?? 0) <= (b.dailyUsd ?? 0) ? a : b));
    const priciest = priced.reduce((a, b) => ((a.dailyUsd ?? 0) >= (b.dailyUsd ?? 0) ? a : b));
    if (cheapest !== priciest && (priciest.dailyUsd ?? 0) >= 1.5 * (cheapest.dailyUsd ?? 1)) {
      flags.push(
        `${priciest.name} runs ~$${priciest.dailyUsd}/day vs ${cheapest.name} ~$${cheapest.dailyUsd}/day — shift nights toward ${cheapest.name} to stretch the budget.`,
      );
    }
  }
  const unknown = out.filter((c) => c.source === "none");
  if (unknown.length > 0) {
    flags.push(
      `No price-level data for ${unknown.map((c) => c.name).join(", ")} — those are left out of the estimate.`,
    );
  }

  const styleLabel = style === "mid-range" ? "mid-range" : style;
  const note =
    cities.length === 0
      ? "No cities were provided to estimate."
      : `Per-person estimate for ${styleLabel} travel — lodging, food, local transport and activities. Excludes flights and intercity transport (no reliable free price source for those). Cost levels are grounded in World Bank price-level data${
          dataYear ? ` (${dataYear})` : ""
        }; example prices are pulled from Wikivoyage. Treat as a planning ballpark, not a quote.`;

  return { style, currency: "USD", cities: out, totalUsd, perDayUsd, flags, note };
}
