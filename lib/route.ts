import { geocodeCity, type GeoPoint } from "./verify";
import type { RouteLeg, RouteSummary } from "./schema";

// check_route grounds the multi-city ROUTE the way verify_places grounds the PLACES. The model
// drafts an ordered list of cities; we geocode each centroid (free Nominatim, reused from
// lib/verify.ts) and then ground the legs between consecutive cities in REAL road travel times and
// distances from the keyless public OSRM road-routing service. Road time is what the model can't see
// by eyeballing a map: two cities that look close can be an 8-hour drive, and two that look far can
// be a quick hop — and a pair separated by water has NO road route at all (you fly or ferry it). We
// feed the numbers back so the agent can reorder, merge, drop, or switch a leg to a flight before it
// emits, and we attach a server-owned RouteSummary to the plan so the traveler sees the same grounding.
//
// Shape mirrors the other grounding tools:
//   1. Geocode each city centroid (reusing geocodeCity — the same free Nominatim layer verify uses).
//   2. ONE call to OSRM's table service returns the full city-by-city driving duration+distance
//      matrix (seconds + metres). One request, not N-1, so the per-leg times AND the 2-opt reorder
//      both run on real road durations while staying well inside OSRM's fair-use policy.
//   3. Derive ordered legs + long-hop flags + a reorder suggestion server-side, exactly the way
//      assessSeason derives its verdict — and recompute the legs against the FINAL emitted order at
//      annotate time (buildRouteSummary), the same "trust the server's recompute, not a stale tool
//      result" discipline the budget and season verdict use.
//
// HONESTY + GRACEFUL DEGRADATION (the same free-data-first, honest-about-limits stance as season/cost):
//   - Road times are NOT a recommendation to drive: a train or flight is often faster, so the model is
//     told not to cite them as generic travel time, and the UI labels them "by road".
//   - A pair with no road route is flagged "fly or ferry", never a fabricated distance across water.
//     OSRM is unreliable about returning a literal null for this, so we ALSO treat any OSRM distance
//     shorter than the great-circle distance as "no road route" — a real road can never be shorter
//     than a straight line, so that's a bogus/disconnected route (verified live: London→New York came
//     back ~2149 km vs ~5570 km straight-line).
//   - If the OSRM call fails entirely (timeout / non-200 / "excessive use" block / a non-Ok code /
//     fewer than 2 geocoded cities), we fall back to today's straight-line haversine behaviour and
//     LABEL it as such (source:"haversine") — never dressed up as a real driving time. The tool never
//     regresses below where it was before OSRM, and check_route never throws.

export type RouteCity = { name: string; country?: string };

// The model-facing view serialized into the tool_result. Lean — ordered legs + flags + an optional
// reorder suggestion + a note — so the model can reorder/drop/switch-to-flight, the same way
// seasonModelView trims the climate payload. The full matrix stays server-side (StoredRouteMatrix).
export type RouteModelView = {
  source: "osrm" | "haversine";
  cities: Array<{ name: string; country?: string; geocoded: boolean }>;
  legs: Array<{
    from: string;
    to: string;
    roadHours: number | null;
    roadKm: number | null;
    noRoadRoute: boolean;
  }>;
  flags: string[];
  suggestion?: { order: string[]; savingPct: number };
  note: string;
};

// Server-only: the full pairwise grids + the city→index map, stored on the loop's routeEstimate var
// and reused by buildRouteSummary at annotate time. NEVER serialized to the model, NEVER in the
// client bundle (it holds a Map and is import-free from the client side). Mirrors how seasonEstimate
// holds the full SeasonSummary while the model only sees seasonModelView.
export type StoredRouteMatrix = {
  source: "osrm" | "haversine";
  // fold(name) → row/column index. Built from the cities passed to checkRoute; buildRouteSummary
  // looks the FINAL emitted city names up in it (a city the model added post-route just misses).
  cityIndex: Map<string, number>;
  // [i][j] straight-line km; null when either endpoint failed to geocode. Always present.
  haversineGrid: Array<Array<number | null>>;
  // [i][j] road hours / km. A null CELL = no road route for that pair (OSRM null or shorter-than-
  // straight-line). A null GRID = the whole OSRM call failed (source:"haversine"). The two are
  // distinguished by `source`.
  roadHoursGrid: Array<Array<number | null>> | null;
  roadKmGrid: Array<Array<number | null>> | null;
};

const OSRM_TABLE = "https://router.project-osrm.org/table/v1/driving";
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";

const EARTH_RADIUS_KM = 6371;
// Road-time thresholds (OSRM mode). Beyond LONG a leg is a long travel day; beyond VERY_LONG it
// usually wants a flight or train. Tuned to flag only genuinely awkward hops, not to nag.
const LONG_LEG_HOURS = 5;
const VERY_LONG_LEG_HOURS = 10;
// Straight-line thresholds (haversine fallback mode), unchanged from before OSRM existed.
const LONG_LEG_KM = 500;
const VERY_LONG_LEG_KM = 1200;
// A genuine road route is never shorter than the great-circle distance. When OSRM returns a distance
// below this fraction of the straight line, it has stitched together a bogus/disconnected route
// (typically across water) — treat it as "no road route", same as an explicit null cell. The slack
// (0.85, not 1.0) tolerates centroid-snapping imprecision on short legs; transoceanic garbage comes
// back at ~0.4× the straight line, far under this.
const NO_ROAD_HAVERSINE_RATIO = 0.85;
// Only surface a reordering when it meaningfully beats the model's order — a near-tie usually means
// the model chose its order for a real reason (where flights land, must-includes), so we don't nag.
const SUGGEST_MIN_SAVING_PCT = 20;
const GEO_THROTTLE_MS = 1100; // match Nominatim's ~1 req/sec courtesy limit
// Bound the OSRM table call so a slow/hung demo server can't eat the request's time budget; on any
// failure we degrade to haversine. One table request is light, so this is generous.
const OSRM_TIMEOUT_MS = 6000;
// Skip OSRM (degrade to haversine) above this many geocoded cities — guards the demo table-size limit
// and URL length. Far above any realistic trip; the upstream caps keep city counts small anyway.
const OSRM_MAX_CITIES = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const toRad = (deg: number) => (deg * Math.PI) / 180;
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Format a duration in hours as "4h 40m" / "45m" / "11h". Shared shape with the UI's formatter so a
// flag string and the rendered leg agree.
export function fmtRoadTime(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Decide one road-matrix cell from OSRM's raw duration (seconds) + distance (metres) and the
// straight-line distance (km). Returns null — "no road route" — when OSRM gave no usable value, OR
// when the road distance is shorter than the great-circle distance, which is geometrically impossible
// for a real road (it means OSRM stitched a bogus/disconnected route across water; verified live:
// London→New York came back ~2149 km vs ~5570 km straight-line). Otherwise the rounded {hours, km}.
// Exported so the sanity-check is unit-testable without mocking the network. Pure.
export function roadCell(
  durSeconds: number | null | undefined,
  distMeters: number | null | undefined,
  haversineKm: number | null,
): { hours: number; km: number } | null {
  if (durSeconds == null || distMeters == null) return null;
  if (!Number.isFinite(durSeconds) || !Number.isFinite(distMeters)) return null;
  if (haversineKm != null && distMeters / 1000 < haversineKm * NO_ROAD_HAVERSINE_RATIO) return null;
  return { hours: Math.round((durSeconds / 3600) * 100) / 100, km: Math.round(distMeters / 1000) };
}

// One leg's SHORT qualitative advisory for the UI ("a long travel day …"), or null when the leg is
// unremarkable. No city names and no figure — the UI row already shows both. Road-mode uses the hour
// thresholds; fallback uses the km thresholds. A no-road leg has no advisory string — the noRoadRoute
// flag itself is the signal ("fly or ferry"). The model gets a fuller sentence built in checkRoute.
function legAdvisory(leg: RouteLeg, source: "osrm" | "haversine"): string | null {
  if (leg.noRoadRoute) return null;
  if (source === "osrm" && leg.roadHours != null) {
    if (leg.roadHours >= VERY_LONG_LEG_HOURS) {
      return "Too far to drive comfortably — fly or take the train.";
    }
    if (leg.roadHours >= LONG_LEG_HOURS) {
      return "A long travel day by road — a train or flight may be faster.";
    }
    return null;
  }
  if (source === "haversine" && leg.haversineKm != null) {
    if (leg.haversineKm >= VERY_LONG_LEG_KM) {
      return "Very long — consider flying, or adding a stop between.";
    }
    if (leg.haversineKm >= LONG_LEG_KM) {
      return "A long travel day.";
    }
  }
  return null;
}

// --- 2-opt route ordering (model-facing only; the suggestion is input for the MODEL, not shown in
// the UI — re-surfacing a reorder the model already adopted would contradict the emitted plan) -----

// Total length of visiting `order` (indices) using `metric` between consecutive stops. null if any
// hop is unmeasurable (ungeocoded endpoint, or a no-road gap) — we can't compare orders we can't
// fully measure, so 2-opt won't suggest a reorder across a sea or a missing city.
function pathLength(order: number[], metric: Array<Array<number | null>>): number | null {
  let total = 0;
  for (let i = 1; i < order.length; i++) {
    const v = metric[order[i - 1]]?.[order[i]];
    if (v == null) return null;
    total += v;
  }
  return total;
}

// 2-opt local search for a shorter open path (both endpoints free). Cheap at real-trip city counts
// and good enough to expose an obvious zig-zag — an advisory hint, not a routing engine.
function twoOptOrder(start: number[], metric: Array<Array<number | null>>): number[] {
  let best = start.slice();
  let bestLen = pathLength(best, metric);
  if (bestLen === null) return best;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const len = pathLength(candidate, metric);
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

// --- OSRM table service ----------------------------------------------------------------------

// Fetch the full pairwise driving duration (s) + distance (m) matrix for `coords` in ONE request.
// Returns null on ANY failure (network, timeout, non-200, a non-"Ok" OSRM code, malformed body) so
// the caller degrades cleanly to haversine. OSRM wants coordinates as lon,lat (the opposite of our
// GeoPoint), so we swap. Throttling isn't needed — it's a single call per plan.
async function fetchOsrmMatrix(
  coords: GeoPoint[],
  signal?: AbortSignal,
): Promise<{ durations: Array<Array<number | null>>; distances: Array<Array<number | null>> } | null> {
  const path = coords.map((c) => `${c.lon},${c.lat}`).join(";");
  const url = `${OSRM_TABLE}/${path}?annotations=duration,distance`;
  const timeout = AbortSignal.timeout(OSRM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      // 429/403 would be the "excessive use" block; any non-2xx → degrade to haversine.
      console.warn(`OSRM HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      code?: string;
      durations?: Array<Array<number | null>>;
      distances?: Array<Array<number | null>>;
    };
    if (data?.code !== "Ok" || !Array.isArray(data.durations) || !Array.isArray(data.distances)) {
      return null;
    }
    return { durations: data.durations, distances: data.distances };
  } catch {
    // Timeout / abort / network error — not evidence of anything, just no road data this time.
    return null;
  }
}

// --- leg derivation (shared by the model view and the annotate-time recompute) ---------------

// Derive the ordered legs for a given city order from the stored grids. This is the one place that
// knows how a grid cell becomes a leg, so the model view (built from the model's order) and the
// attached RouteSummary (built from the FINAL emitted order) can never diverge in how they read the
// matrix. Pure — no network. A city missing from the index (name drift, or added after check_route)
// degrades to an unmeasured leg, never a throw — exactly how seasonByCity.get misses degrade.
function deriveLegs(orderedNames: string[], stored: StoredRouteMatrix): RouteLeg[] {
  const legs: RouteLeg[] = [];
  for (let i = 1; i < orderedNames.length; i++) {
    const from = orderedNames[i - 1];
    const to = orderedNames[i];
    const a = stored.cityIndex.get(fold(from));
    const b = stored.cityIndex.get(fold(to));
    let leg: RouteLeg;
    if (a == null || b == null) {
      // A city not in the matrix — can't measure this leg.
      leg = { from, to, roadKm: null, roadHours: null, haversineKm: null, noRoadRoute: false, flag: null };
    } else {
      const hav = stored.haversineGrid[a]?.[b] ?? null;
      if (stored.source === "haversine" || stored.roadKmGrid == null || stored.roadHoursGrid == null) {
        // Straight-line fallback: only the haversine distance is honest to show.
        leg = { from, to, roadKm: null, roadHours: null, haversineKm: hav, noRoadRoute: false, flag: null };
      } else if (hav == null) {
        // OSRM mode but an endpoint failed to geocode — no road, no straight-line, nothing to show.
        leg = { from, to, roadKm: null, roadHours: null, haversineKm: null, noRoadRoute: false, flag: null };
      } else {
        const rKm = stored.roadKmGrid[a]?.[b] ?? null;
        const rH = stored.roadHoursGrid[a]?.[b] ?? null;
        if (rKm == null || rH == null) {
          // Both geocoded, but no usable road route → fly or ferry. Don't surface the straight-line
          // distance (it would imply a driveable distance across open water).
          leg = { from, to, roadKm: null, roadHours: null, haversineKm: null, noRoadRoute: true, flag: null };
        } else {
          leg = { from, to, roadKm: rKm, roadHours: rH, haversineKm: hav, noRoadRoute: false, flag: null };
        }
      }
    }
    leg.flag = legAdvisory(leg, stored.source);
    legs.push(leg);
  }
  return legs;
}

// Does a set of legs carry anything worth showing the traveler? A no-road leg or a long-haul flag is
// signal; a clean route (or one whose only "issue" is an ungeocoded city) is noise we suppress.
function legsHaveSignal(legs: RouteLeg[]): boolean {
  return legs.some((l) => l.noRoadRoute || l.flag != null);
}

// The model-facing sentence for one flagged leg — fuller than the UI advisory (it names the cities
// and the figure so the model can act and cite it correctly).
function modelLegSentence(leg: RouteLeg, source: "osrm" | "haversine"): string | null {
  if (leg.noRoadRoute) {
    return `${leg.from} → ${leg.to} has no road route — the traveler flies or ferries this leg.`;
  }
  if (!leg.flag) return null;
  const figure =
    source === "osrm" && leg.roadHours != null
      ? `~${fmtRoadTime(leg.roadHours)} by road`
      : leg.haversineKm != null
        ? `~${leg.haversineKm} km straight-line`
        : null;
  return figure ? `${leg.from} → ${leg.to} is ${figure} — ${leg.flag}` : `${leg.from} → ${leg.to}: ${leg.flag}`;
}

const ROUTE_NOTE_OSRM =
  "Road travel times via OSRM (OpenStreetMap contributors, ODbL). These are road-network times for " +
  "comparing legs and may include ferry crossings — not a recommendation to drive; a train or flight " +
  "is often faster.";
const ROUTE_NOTE_OSRM_NOROAD =
  " Legs with no road route need a flight or ferry; those intercity fares aren't included in the budget.";
const ROUTE_NOTE_HAVERSINE =
  "Straight-line distances (real road times were unavailable) — these underestimate actual travel time.";

function noteFor(source: "osrm" | "haversine", legs: RouteLeg[]): string {
  return source === "osrm"
    ? ROUTE_NOTE_OSRM + (legs.some((l) => l.noRoadRoute) ? ROUTE_NOTE_OSRM_NOROAD : "")
    : ROUTE_NOTE_HAVERSINE;
}

// --- public: execute the check_route tool ----------------------------------------------------

export async function checkRoute(
  rawCities: RouteCity[],
  // Optional: called as each city geocodes, so the route can stream live "routing 3/8" progress.
  onProgress?: (done: number, total: number, name: string) => void,
  // Optional: the request signal, so geocoding stops promptly if the client navigates away.
  signal?: AbortSignal,
): Promise<{ model: RouteModelView; stored: StoredRouteMatrix }> {
  const cities = rawCities.filter(
    (c) => c && typeof c.name === "string" && c.name.trim().length > 0,
  );

  // Geocode each centroid, paced to respect Nominatim's free-use policy. (Runs after the verify
  // round and a slow model turn, so there's no request-rate overlap with verifyPlaces.)
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
  // Pad coords to the city length if we broke early on abort, so the grids stay square.
  while (coords.length < cities.length) coords.push(null);

  const n = cities.length;
  const cityIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) cityIndex.set(fold(cities[i].name), i);

  // Straight-line grid — always computable, and the sanity-check the OSRM distances are measured
  // against. null when either endpoint failed to geocode.
  const haversineGrid: Array<Array<number | null>> = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => null as number | null),
  );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = coords[i];
      const b = coords[j];
      haversineGrid[i][j] = a && b ? Math.round(haversineKm(a, b)) : null;
    }
  }

  // Try OSRM for the geocoded cities. We index the matrix by the ORIGINAL city positions so the
  // grids line up with cityIndex; cells touching an ungeocoded city stay null.
  const geocodedIdx = coords.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  let roadHoursGrid: Array<Array<number | null>> | null = null;
  let roadKmGrid: Array<Array<number | null>> | null = null;
  let source: "osrm" | "haversine" = "haversine";

  if (geocodedIdx.length >= 2 && geocodedIdx.length <= OSRM_MAX_CITIES && !signal?.aborted) {
    const subset = geocodedIdx.map((i) => coords[i] as GeoPoint);
    const osrm = await fetchOsrmMatrix(subset, signal);
    if (osrm) {
      source = "osrm";
      roadHoursGrid = Array.from({ length: n }, () => Array.from({ length: n }, () => null as number | null));
      roadKmGrid = Array.from({ length: n }, () => Array.from({ length: n }, () => null as number | null));
      for (let si = 0; si < geocodedIdx.length; si++) {
        for (let sj = 0; sj < geocodedIdx.length; sj++) {
          const i = geocodedIdx[si];
          const j = geocodedIdx[sj];
          // roadCell bakes in the no-road sanity-check (null cell, or a road shorter than the
          // straight line → no usable road route for this pair → fly or ferry).
          const cell = roadCell(osrm.durations[si]?.[sj], osrm.distances[si]?.[sj], haversineGrid[i][j]);
          roadHoursGrid[i][j] = cell ? cell.hours : null;
          roadKmGrid[i][j] = cell ? cell.km : null;
        }
      }
    }
  }

  const stored: StoredRouteMatrix = { source, cityIndex, haversineGrid, roadHoursGrid, roadKmGrid };

  // Build the model-facing view against the model's own order.
  const names = cities.map((c) => c.name);
  const legs = deriveLegs(names, stored);
  const flags: string[] = [];
  for (const leg of legs) {
    const sentence = modelLegSentence(leg, source);
    if (sentence) flags.push(sentence);
  }
  // Flag cities we couldn't locate at all (so the model knows a leg is unmeasured, not clean).
  const ungeocoded = cities.filter((_, i) => coords[i] === null).map((c) => c.name);
  if (ungeocoded.length > 0) {
    flags.push(
      `Couldn't locate ${ungeocoded.join(", ")} to measure the route around ${ungeocoded.length === 1 ? "it" : "them"}.`,
    );
  }

  // 2-opt reorder suggestion (model-facing only), on road durations when we have them, else haversine.
  let suggestion: RouteModelView["suggestion"] | undefined;
  const metric = source === "osrm" && roadHoursGrid ? roadHoursGrid : haversineGrid;
  if (n >= 3) {
    const current = cities.map((_, i) => i);
    const currentLen = pathLength(current, metric);
    if (currentLen != null && currentLen > 0) {
      const bestOrder = twoOptOrder(current, metric);
      const bestLen = pathLength(bestOrder, metric) ?? currentLen;
      const savingPct = Math.round(((currentLen - bestLen) / currentLen) * 100);
      if (savingPct >= SUGGEST_MIN_SAVING_PCT) {
        const order = bestOrder.map((i) => cities[i].name);
        suggestion = { order, savingPct };
        flags.push(
          `A different order cuts total ${source === "osrm" ? "road time" : "straight-line distance"} ~${savingPct}%: ${order.join(
            " → ",
          )}. Adopt it only if it doesn't fight your entry/exit flights or must-includes.`,
        );
      }
    }
  }

  const note =
    n === 0
      ? "No valid cities were provided — there's nothing to check."
      : n === 1
        ? `Only "${cities[0].name}" was provided — there's no multi-city route to check.`
        : noteFor(source, legs);

  const model: RouteModelView = {
    source,
    cities: cities.map((c, i) => ({ name: c.name, country: c.country, geocoded: coords[i] !== null })),
    legs: legs.map((l) => ({
      from: l.from,
      to: l.to,
      roadHours: l.roadHours,
      roadKm: l.roadKm,
      noRoadRoute: l.noRoadRoute,
    })),
    flags,
    suggestion,
    note,
  };

  return { model, stored };
}

// Recompute the route legs against the FINAL emitted city order and attach a RouteSummary — the same
// "trust the server's recompute against the final plan, not the stale tool result" discipline the
// budget and season verdict use, applied to edges. Returns null (no block attached) when there's no
// stored matrix, fewer than two emitted cities, or nothing worth showing (a clean route, or one whose
// only issue is an ungeocoded city). Pure — no network — so it's easy to unit-test.
export function buildRouteSummary(
  orderedCityNames: string[],
  stored: StoredRouteMatrix | null,
): RouteSummary | null {
  if (!stored || orderedCityNames.length < 2) return null;
  const legs = deriveLegs(orderedCityNames, stored);
  if (!legsHaveSignal(legs)) return null;
  return { source: stored.source, legs, note: noteFor(stored.source, legs) };
}
