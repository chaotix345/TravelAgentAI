import { geocodeCity, type GeoPoint } from "./verify";

// check_route grounds the multi-city ROUTE the way verify_places grounds the
// PLACES. The model drafts an ordered list of cities; we geocode each centroid
// (free Nominatim, reused from lib/verify.ts) and compute great-circle distances
// between consecutive cities. Straight-line distance isn't travel time, but it's
// enough to catch the failure the model can't see by eyeballing a map: a route
// that zig-zags, or a one-night stop hiding behind a brutal transfer. We feed the
// numbers back so the agent can reorder, merge, or drop before it emits.

export type RouteCity = { name: string; country?: string };

export type RouteLeg = { from: string; to: string; km: number | null };

export type RouteCheck = {
  cities: Array<{ name: string; country?: string; geocoded: boolean }>;
  legs: RouteLeg[];
  totalKm: number;
  longestLegKm: number;
  flags: string[];
  suggestion?: { order: string[]; totalKm: number; savingPct: number };
  note: string;
};

const EARTH_RADIUS_KM = 6371;
// A straight-line hop beyond LONG_LEG_KM is a long travel day on the ground;
// beyond VERY_LONG_LEG_KM it usually wants a flight, an intermediate stop, or
// dropping an endpoint. Tuned to flag only genuinely awkward hops, not to nag.
const LONG_LEG_KM = 500;
const VERY_LONG_LEG_KM = 1200;
// Only surface a reordering when it meaningfully beats the model's order — a
// near-tie usually means the model chose its order for a real reason (where the
// flights land, must-includes), so we don't nag about small wins.
const SUGGEST_MIN_SAVING_PCT = 20;
const GEO_THROTTLE_MS = 1100; // match Nominatim's ~1 req/sec courtesy limit

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const toRad = (deg: number) => (deg * Math.PI) / 180;

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Total straight-line length of visiting `order` (indices into coords) in
// sequence. null if any city on the path failed to geocode — we can't compare
// orderings we can't fully measure.
function pathLength(order: number[], coords: Array<GeoPoint | null>): number | null {
  let total = 0;
  for (let i = 1; i < order.length; i++) {
    const a = coords[order[i - 1]];
    const b = coords[order[i]];
    if (!a || !b) return null;
    total += haversineKm(a, b);
  }
  return total;
}

// 2-opt local search for a shorter open path (both endpoints free). Cheap at the
// city counts a real trip has, and good enough to expose an obvious zig-zag —
// this is an advisory hint, not a routing engine.
function twoOptOrder(start: number[], coords: Array<GeoPoint | null>): number[] {
  let best = start.slice();
  let bestLen = pathLength(best, coords);
  if (bestLen === null) return best;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const len = pathLength(candidate, coords);
        if (len !== null && len < bestLen - 1e-6) {
          best = candidate;
          bestLen = len;
          improved = true;
        }
      }
    }
  }
  return best;
}

export async function checkRoute(
  rawCities: RouteCity[],
  // Optional: called as each city geocodes, so the route can stream live
  // "routing 3/8" progress the way verification streams its per-place progress.
  onProgress?: (done: number, total: number, name: string) => void,
  // Optional: the request signal, so geocoding stops promptly if the client
  // navigates away instead of grinding through the remaining cities.
  signal?: AbortSignal,
): Promise<RouteCheck> {
  const cities = rawCities.filter(
    (c) => c && typeof c.name === "string" && c.name.trim().length > 0,
  );

  // Geocode each centroid, paced to respect Nominatim's free-use policy. (This
  // runs after the verify round and after a slow model turn, so there's no
  // request-rate overlap with verifyPlaces to worry about.)
  const coords: Array<GeoPoint | null> = [];
  for (let i = 0; i < cities.length; i++) {
    if (signal?.aborted) break; // client gone — don't keep geocoding
    if (i > 0) await sleep(GEO_THROTTLE_MS);
    let point: GeoPoint | null = null;
    try {
      point = await geocodeCity(cities[i].name, cities[i].country, signal);
    } catch {
      // A lookup failure isn't evidence the city is fake — just unmeasurable.
      point = null;
    }
    coords.push(point);
    onProgress?.(i + 1, cities.length, cities[i].name);
  }

  const legs: RouteLeg[] = [];
  const flags: string[] = [];
  let totalKm = 0;
  let longestLegKm = 0;

  for (let i = 1; i < cities.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const from = cities[i - 1].name;
    const to = cities[i].name;
    if (!a || !b) {
      legs.push({ from, to, km: null });
      flags.push(`Couldn't locate ${!a ? from : to} to measure the ${from} → ${to} leg.`);
      continue;
    }
    const km = Math.round(haversineKm(a, b));
    legs.push({ from, to, km });
    totalKm += km;
    longestLegKm = Math.max(longestLegKm, km);
    if (km >= VERY_LONG_LEG_KM) {
      flags.push(
        `${from} → ${to} is ~${km} km straight-line — very long; consider flying it, adding a stop between, or dropping one end.`,
      );
    } else if (km >= LONG_LEG_KM) {
      flags.push(`${from} → ${to} is ~${km} km straight-line — a long travel day.`);
    }
  }

  // Suggest a tighter order only when we could measure every city and a clearly
  // better arrangement exists.
  let suggestion: RouteCheck["suggestion"] | undefined;
  if (cities.length >= 3 && coords.every((c) => c !== null)) {
    const current = coords.map((_, i) => i);
    const currentLen = pathLength(current, coords) ?? 0;
    const bestOrder = twoOptOrder(current, coords);
    const bestLen = pathLength(bestOrder, coords) ?? currentLen;
    const savingPct =
      currentLen > 0 ? Math.round(((currentLen - bestLen) / currentLen) * 100) : 0;
    if (savingPct >= SUGGEST_MIN_SAVING_PCT) {
      const order = bestOrder.map((i) => cities[i].name);
      suggestion = { order, totalKm: Math.round(bestLen), savingPct };
      flags.push(
        `A different order cuts total straight-line distance ~${savingPct}% (${Math.round(
          currentLen,
        )}→${Math.round(bestLen)} km): ${order.join(
          " → ",
        )}. Adopt it only if it doesn't fight your entry/exit flights or must-includes.`,
      );
    }
  }

  const note =
    cities.length === 0
      ? "No valid cities were provided — there's nothing to check."
      : cities.length === 1
        ? `Only "${cities[0].name}" was provided — there's no multi-city route to check.`
        : `Planned order: ${cities.map((c) => c.name).join(" → ")}. Total straight-line ~${Math.round(
            totalKm,
          )} km over ${legs.length} leg${legs.length === 1 ? "" : "s"}; longest single hop ~${longestLegKm} km. Straight-line underestimates real travel time but reliably flags zig-zags and impractical jumps.${
            flags.length === 0 ? " This route looks geographically reasonable." : ""
          }`;

  return {
    cities: cities.map((c, i) => ({
      name: c.name,
      country: c.country,
      geocoded: coords[i] !== null,
    })),
    legs,
    totalKm: Math.round(totalKm),
    longestLegKm,
    flags,
    suggestion,
    note,
  };
}
