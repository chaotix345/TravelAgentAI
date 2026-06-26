import type { CostEstimate } from "./cost";
import type { FlightSummary } from "./schema";

// Cross-currency display grounds the MONEY in a plan the way verify_places grounds its PLACES and
// estimate_costs grounds its BUDGET — but it is the first grounding that is NOT a tool the model
// calls. An exchange rate is a deterministic live fact, not a planning decision (unlike "which
// cities" or "is August too hot"), so converting figures into the traveler's home currency is a
// pure SERVER-SIDE transform run after a tool returns, never a model turn. The model is merely
// TOLD the converted figures (via the tool results) so its prose can't say "$2,420" next to a
// "£1,840" block.
//
//   • The budget is always native USD (World Bank price levels are USD-denominated).
//   • A flight fare is whatever Duffel quoted (a test fare can come back as the synthetic "A$126").
//   • Both get converted to the home currency (default AUD) at a live European Central Bank
//     reference rate, fetched keyless from Frankfurter — the same free-data-first, authoritative-
//     source discipline as World Bank price levels and Open-Meteo climate normals.
//
// Graceful degradation is first-class, exactly like the flights/season tools: if the FX fetch
// fails, the currency is unsupported, or the home currency already equals the native one, we attach
// NO home figures and the UI shows the native amount only. A missing rate never throws and never
// breaks a plan — it just means no "≈ £" line.

// Frankfurter's v1 path is pure ECB reference rates (30 major currencies) with a simple object
// response — the cleanest "authoritative source" story for our footer, and it covers every currency
// Duffel realistically quotes plus USD. (v2 exists with 201 currencies from 84 sources and an array
// response, if v1 is ever retired — but v1 is the live 301 target of the deprecated frankfurter.app
// host, so it's the stable, well-attributed choice here.) Response shape, confirmed live:
//   GET /v1/latest?base=USD&symbols=GBP  ->  {"amount":1.0,"base":"USD","date":"2026-06-25","rates":{"GBP":0.75986}}
const FRANKFURTER = "https://api.frankfurter.dev/v1/latest";
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";
// FX is a quick single read; keep the ceiling tight so a hung request can't stall the plan. A
// timeout just degrades to native-only, like every other grounding source here.
const FETCH_TIMEOUT_MS = 4000;

const ISO4217 = /^[A-Z]{3}$/;

export type FxRate = {
  rate: number; // multiply a native amount by this to get the home amount
  date: string; // the ECB publish date of the rate (YYYY-MM-DD), for honest disclosure
  source: "frankfurter" | "identity"; // identity = same currency, no fetch
};

// The traveler's home/display currency. It's a property of the USER, not the trip ("From London"
// is a departure airport, not a bank account), so it's a single configured value rather than
// something inferred per-brief — set HOME_CURRENCY=USD (or GBP, EUR, …) to switch. Defaults to AUD.
// Validated to a 3-letter ISO code so a typo can't poison the Frankfurter query; an invalid value
// falls back to the default rather than erroring the plan.
const DEFAULT_HOME_CURRENCY = "AUD";
export function homeCurrency(): string {
  const raw = (process.env.HOME_CURRENCY ?? "").trim().toUpperCase();
  return ISO4217.test(raw) ? raw : DEFAULT_HOME_CURRENCY;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

// Best-effort, per-instance cache of the day's rate. ECB publishes once per working day (~16:00
// CET) and a planning ballpark doesn't move on sub-1%/day drift, so a rate is reused for the rest
// of the calendar day it was fetched. Same honesty as the route's rate limiter: this lives per
// server instance, so on serverless it isn't global — but it spares repeated plans/refines a
// redundant fetch, and a miss just re-fetches (the call is free and keyless). For production scale
// you'd back it with a shared store; here it's a courtesy, not a correctness dependency.
type CacheEntry = FxRate & { day: string };
const rateCache = new Map<string, CacheEntry>();

// Fetch the native→home rate, or null on any failure (caller degrades to native-only). Short-
// circuits to an identity rate when the two currencies match, so HOME_CURRENCY=GBP + a Duffel fare
// already in GBP (or HOME=USD + the USD budget) costs no network call and shows no redundant "≈".
export async function getRate(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<FxRate | null> {
  const f = (from ?? "").trim().toUpperCase();
  const t = (to ?? "").trim().toUpperCase();
  if (!ISO4217.test(f) || !ISO4217.test(t)) return null;
  // Stamp "today" once so the cache-lookup and the cache-write agree even if the fetch straddles
  // UTC midnight — otherwise an entry could be filed under tomorrow's key.
  const day = todayUtc();
  if (f === t) return { rate: 1, date: day, source: "identity" };

  const key = `${f}|${t}`;
  const cached = rateCache.get(key);
  if (cached && cached.day === day) {
    return { rate: cached.rate, date: cached.date, source: cached.source };
  }

  try {
    const url = `${FRANKFURTER}?base=${encodeURIComponent(f)}&symbols=${encodeURIComponent(t)}`;
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      console.warn(`Frankfurter HTTP ${res.status} for ${f}->${t}`);
      return null;
    }
    const data = (await res.json()) as { date?: string; rates?: Record<string, number> };
    const rate = data?.rates?.[t];
    // A currency outside the ECB set (or any malformed response) has no usable rate → degrade.
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    const result: FxRate = { rate, date: data.date ?? day, source: "frankfurter" };
    rateCache.set(key, { ...result, day });
    return result;
  } catch {
    // Timeout / network / abort → no rate. Never fatal: the plan just shows native figures.
    return null;
  }
}

// --- Pure conversion helpers (no network — fully testable against a fixed FxRate) ---------------

const round = (n: number) => Math.round(n);

const SYMBOLS: Record<string, string> = {
  USD: "$", GBP: "£", EUR: "€", JPY: "¥", CAD: "C$", AUD: "A$", CHF: "CHF ", INR: "₹",
  NZD: "NZ$", SGD: "S$", HKD: "HK$", CNY: "¥", SEK: "kr ", NOK: "kr ", DKK: "kr ",
  PLN: "zł ", CZK: "Kč ", THB: "฿", ZAR: "R ", MXN: "MX$", BRL: "R$", KRW: "₩",
};
export const currencySymbol = (code: string): string =>
  SYMBOLS[code] ?? (code ? `${code} ` : "");

// Rewrite the "$160/day" amounts the cost tool bakes into its flag strings (lib/cost.ts) into the
// home currency, so a "Paris runs ~$160/day vs Lisbon ~$75/day" flag doesn't sit under a "£"
// headline (and the model, which reads these flags in the tool result, cites home figures too). We
// own the flag format, so the "$<number>" match is reliable. No-op when the rate is identity.
function rewriteUsdAmounts(text: string, rate: number, homeSymbol: string): string {
  return text.replace(/\$(\d[\d,]*)/g, (_m, digits: string) => {
    const value = Number.parseInt(digits.replace(/,/g, ""), 10);
    if (!Number.isFinite(value)) return _m;
    return `${homeSymbol}${round(value * rate).toLocaleString()}`;
  });
}

// Augment a (USD) cost estimate with home-currency figures + converted flag text. Returns the
// estimate unchanged when there's nothing to convert (no rate, or home already equals native), so
// the caller can apply it unconditionally. Pure given the FxRate.
export function applyFxToCost(
  estimate: CostEstimate,
  home: string,
  fx: FxRate | null,
): CostEstimate {
  if (!fx || home === estimate.currency) return estimate;
  const conv = (n: number | null) => (n == null ? null : round(n * fx.rate));
  const symbol = currencySymbol(home);
  return {
    ...estimate,
    cities: estimate.cities.map((c) => ({
      ...c,
      dailyHome: conv(c.dailyUsd),
      subtotalHome: conv(c.subtotalUsd),
    })),
    flags: estimate.flags.map((f) => rewriteUsdAmounts(f, fx.rate, symbol)),
    homeCurrency: home,
    totalHome: conv(estimate.totalUsd),
    perDayHome: conv(estimate.perDayUsd),
    rate: fx.rate,
    rateDate: fx.date,
  };
}

// Augment a Duffel flight summary with the home-currency fare. Returns it unchanged when there's
// nothing to convert (no rate, no fare, or Duffel already quoted in the home currency). Pure.
export function applyFxToFlights(
  flight: FlightSummary,
  home: string,
  fx: FxRate | null,
): FlightSummary {
  if (!fx || !flight.currency || home === flight.currency || flight.totalAmount == null) {
    return flight;
  }
  return {
    ...flight,
    homeCurrency: home,
    homeAmount: round(flight.totalAmount * fx.rate),
    rate: fx.rate,
    rateDate: fx.date,
  };
}

// A compact, single-currency view of the cost estimate for the MODEL's tool_result — parallel to
// flightModelView/seasonModelView. The full CostEstimate carries BOTH the native USD figures and
// the converted home ones; handing the model both invites it to cite "$2,420" next to a "£1,840"
// block. So we collapse to ONE currency (home when converted, else USD), drop the raw *Usd numeric
// fields and the Wikivoyage anchors (which are in assorted LOCAL currencies — another mismatch
// risk in prose, and they're shown UI-side only). The flags are already rewritten to the home
// currency by applyFxToCost. The FULL estimate still flows to annotateItinerary for the attached
// budget; this only shapes what the model reads.
export function costModelView(estimate: CostEstimate): unknown {
  const converted = estimate.homeCurrency != null;
  return {
    style: estimate.style,
    currency: converted ? estimate.homeCurrency : estimate.currency,
    total: converted ? estimate.totalHome : estimate.totalUsd,
    perDay: converted ? estimate.perDayHome : estimate.perDayUsd,
    cities: estimate.cities.map((c) => ({
      name: c.name,
      tier: c.tier,
      daily: converted ? (c.dailyHome ?? null) : c.dailyUsd,
    })),
    flags: estimate.flags,
    note: estimate.note,
  };
}
