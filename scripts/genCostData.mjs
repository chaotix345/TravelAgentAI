// Regenerates lib/costData.ts — the bundled, keyless cost-level dataset that grounds
// the estimate_costs tool's per-country price tier. Run with: node scripts/genCostData.mjs
//
// Source: World Bank Open Data (https://data.worldbank.org), CC BY 4.0. We derive a
// per-country PRICE LEVEL relative to the United States (US = 1.0) as:
//
//     priceLevel = consumerPPP / marketExchangeRate
//
//   consumerPPP        = PA.NUS.PRVT.PP  (PPP conversion factor, household consumption,
//                                         LCU per international $) — preferred because it
//                                         tracks CONSUMER prices, the closest proxy to what
//                                         a traveler actually pays. Falls back to:
//   GDP PPP            = PA.NUS.PPP       (PPP conversion factor, GDP) where consumer PPP
//                                         is missing.
//   marketExchangeRate = PA.NUS.FCRF     (official exchange rate, LCU per US$).
//
// A value < 1 means the country is cheaper than the US at market rates; > 1 means pricier.
// This is the same idea as The Economist's Big Mac index but per-country (no euro-area
// lumping) and with ~190-country coverage. We align each country to the most recent year
// where its chosen PPP factor and exchange rate are BOTH present, so the ratio is consistent.
//
// The output is a static constant — no network call at runtime. Regenerate occasionally to
// refresh the year. Heuristic tiers and daily-budget bands live in lib/cost.ts, not here:
// this file holds only sourced facts (price level + provenance).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WB = "https://api.worldbank.org/v2";
const MRV = 12; // pull the most recent ~12 years so we can find a common year per country

async function fetchIndicator(code) {
  const url = `${WB}/country/all/indicator/${code}?format=json&mrv=${MRV}&per_page=20000`;
  const res = await fetch(url, { headers: { "User-Agent": "TravelAgentAI/0.1 (data gen)" } });
  if (!res.ok) throw new Error(`${code}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[1])) {
    throw new Error(`${code}: unexpected shape ${JSON.stringify(data).slice(0, 200)}`);
  }
  // iso3 -> { name, iso2, years: { [year]: value } }
  const byCountry = new Map();
  for (const row of data[1]) {
    const iso3 = row.countryiso3code;
    if (!iso3 || row.value == null) continue;
    if (!byCountry.has(iso3)) {
      byCountry.set(iso3, { name: row.country.value, iso2: row.country.id, years: {} });
    }
    byCountry.get(iso3).years[row.date] = Number(row.value);
  }
  return byCountry;
}

async function fetchRealCountryIso3() {
  // The indicator endpoint mixes in aggregates (World, Euro area, income groups). The
  // country metadata endpoint tags those with region "Aggregates", so we keep the rest.
  const res = await fetch(`${WB}/country?format=json&per_page=400`, {
    headers: { "User-Agent": "TravelAgentAI/0.1 (data gen)" },
  });
  const data = await res.json();
  const real = new Set();
  for (const c of data[1]) {
    if (c.region?.value && c.region.value !== "Aggregates") real.add(c.id); // c.id is iso3
  }
  return real;
}

const fold = (s) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

function latestCommonYear(yearsA, yearsB) {
  const common = Object.keys(yearsA).filter((y) => y in yearsB);
  if (common.length === 0) return null;
  return common.sort((a, b) => Number(b) - Number(a))[0];
}

async function main() {
  console.log("Fetching World Bank indicators…");
  const [fcrf, prvt, gdpPpp, realIso3] = await Promise.all([
    fetchIndicator("PA.NUS.FCRF"),
    fetchIndicator("PA.NUS.PRVT.PP"),
    fetchIndicator("PA.NUS.PPP"),
    fetchRealCountryIso3(),
  ]);

  const out = {}; // normalized country name -> { iso3, iso2, priceLevel, year, pppSource }
  const dropped = []; // countries whose ratio was too distorted to trust
  // Plausible band for a consumer price level vs the US (= 1.0). The priciest real economies
  // (Switzerland ~1.26, Nordics ~1.3-1.5) sit under 1.8; the cheapest (Egypt ~0.15, Pakistan
  // ~0.18) sit above 0.08. Anything outside is a PPP-vs-market-rate distortion (sanctions,
  // hyperinflation, a collapsed/abandoned currency) — drop it so the tool says "no data" rather
  // than emitting a confidently-wrong number.
  const IMPLAUSIBLE_MIN = 0.08;
  const IMPLAUSIBLE_MAX = 1.8;
  let count = 0;
  for (const [iso3, fx] of fcrf) {
    if (!realIso3.has(iso3)) continue;
    // Prefer consumer PPP; fall back to GDP PPP.
    const consumer = prvt.get(iso3);
    const gdp = gdpPpp.get(iso3);
    let ppp = consumer;
    let pppSource = "consumer";
    let year = ppp ? latestCommonYear(ppp.years, fx.years) : null;
    if (!year && gdp) {
      ppp = gdp;
      pppSource = "gdp";
      year = latestCommonYear(gdp.years, fx.years);
    }
    if (!ppp || !year) continue;
    const rate = fx.years[year];
    const factor = ppp.years[year];
    if (!Number.isFinite(rate) || !Number.isFinite(factor) || rate <= 0) continue;
    const rawPriceLevel = factor / rate;
    if (!Number.isFinite(rawPriceLevel) || rawPriceLevel <= 0) continue;
    // Round to the stored precision first, then sanity-check the value we'll actually serve:
    // a near-zero ratio (a collapsed/abandoned currency like Zimbabwe's) rounds to 0.000 and
    // would otherwise be stored as a fake "free" country, and a sanctioned/hyperinflationary
    // economy (Iran's 2.1) reads as the priciest on Earth. Drop anything outside the plausible
    // band so the tool honestly reports "no price data" instead of a confidently-wrong number.
    const priceLevel = Math.round(rawPriceLevel * 1000) / 1000;
    if (priceLevel < IMPLAUSIBLE_MIN || priceLevel > IMPLAUSIBLE_MAX) {
      dropped.push(`${fx.name} (${priceLevel})`);
      continue;
    }
    out[fold(fx.name)] = {
      iso3,
      iso2: fx.iso2,
      priceLevel,
      year: Number(year),
      pppSource,
    };
    count++;
  }

  // Sort keys for a stable, reviewable diff.
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));

  const header = `// GENERATED by scripts/genCostData.mjs — do not edit by hand.
// Source: World Bank Open Data (https://data.worldbank.org), CC BY 4.0.
// priceLevel = consumer-PPP-or-GDP-PPP factor / market exchange rate, US = 1.0
// (< 1 cheaper than the US, > 1 pricier). Indicators: PA.NUS.PRVT.PP (preferred),
// PA.NUS.PPP (fallback), PA.NUS.FCRF. Each country uses its latest year where both
// inputs exist. ${count} countries.
`;

  const body =
    header +
    `
export type CountryPriceLevel = {
  iso3: string;
  iso2: string;
  /** Price level relative to the United States (US = 1.0). */
  priceLevel: number;
  /** The data year this ratio is computed from. */
  year: number;
  /** Which PPP factor was used: household-consumption ("consumer") or GDP ("gdp"). */
  pppSource: "consumer" | "gdp";
};

// Keyed by case/accent-folded country name (see fold() in lib/cost.ts).
export const COUNTRY_PRICE_LEVELS: Record<string, CountryPriceLevel> = ${JSON.stringify(
      sorted,
      null,
      2,
    )};
`;

  const target = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "costData.ts");
  writeFileSync(target, body);
  console.log(`Wrote ${count} countries to ${target}`);
  if (dropped.length > 0) {
    console.log(
      `Dropped ${dropped.length} distorted (outside ${IMPLAUSIBLE_MIN}-${IMPLAUSIBLE_MAX}): ${dropped.join(", ")}`,
    );
  }
  // Spot-check a few well-known cases.
  for (const name of ["portugal", "switzerland", "japan", "thailand", "united states", "france", "norway", "vietnam"]) {
    const r = sorted[name];
    console.log("  ", name.padEnd(16), r ? `PL=${r.priceLevel} (${r.year}, ${r.pppSource})` : "MISSING");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
