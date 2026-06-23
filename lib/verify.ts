export type VerifyResult = {
  name: string;
  city?: string;
  found: boolean;
  matched?: string;
  source?: "osm" | "wikipedia";
};

type VerifyInput = { name: string; city?: string };

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const WIKIPEDIA = "https://en.wikipedia.org/w/api.php";

// Nominatim's free-use policy: send a real User-Agent and stay under ~1 request/second.
// We're a learning-scale app, so we pace lookups to respect that. For production volume
// you'd self-host a geocoder or use a paid one — this is the "free option first" choice.
const USER_AGENT = "TravelAgentAI/0.1 (personal learning project)";
const THROTTLE_MS = 1100;
// Cap a single lookup so one slow/hung request can't eat the whole time budget (20+
// throttled lookups already push a long trip toward the function limit). An abort lands
// in the per-place catch below and becomes "unconfirmed", never a failed plan.
const FETCH_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fold case and accents so "Pastéis de Belém" and "pasteis de belem" compare equal.
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// Significant words of a name: tokens longer than 3 chars, so filler like "de", "la",
// "the", "and" doesn't count as a match. Unicode-aware split keeps non-Latin scripts.
const sigTokens = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 3);

// Does the geo hit actually share a meaningful word with the name we searched for? This
// is the guard against over-confirmation: a free geo search returns its single best
// candidate for ANY string, so a made-up "Restaurante Paradiso da Rua Verde" can latch
// onto a real node via the city/street tokens alone. Requiring a name-word overlap
// rejects those loose hits. If the name has no distinctive word (all short tokens, or a
// non-Latin script we can't tokenize), we don't block — there's nothing to check against.
function nameOverlaps(placeName: string, matched: string): boolean {
  const wanted = new Set(sigTokens(placeName));
  if (wanted.size === 0) return true;
  return sigTokens(matched).some((t) => wanted.has(t));
}

// One canonical key for a place, so route.ts can look up what we found here.
export function placeKey(name: string, city?: string): string {
  return `${name.trim().toLowerCase()}|${(city ?? "").trim().toLowerCase()}`;
}

// Returns the matched display name when the place checks out, or null for a genuine
// "not found" (HTTP 200 with no usable hit). THROWS on an infrastructure error (timeout,
// 4xx/5xx) so the caller can tell "this place isn't real" from "the lookup itself failed"
// — we don't want a Nominatim 429 to silently brand a famous real place as unconfirmed.
async function searchNominatim(query: string, placeName: string): Promise<string | null> {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn(`Nominatim HTTP ${res.status} for "${query}"`);
    throw new Error(`Nominatim HTTP ${res.status}`);
  }
  const data = (await res.json()) as Array<{ display_name?: string }>;
  if (data.length === 0) return null;
  const display = data[0].display_name ?? query;
  return nameOverlaps(placeName, display) ? display : null;
}

async function searchWikipedia(name: string): Promise<string | null> {
  const url = `${WIKIPEDIA}?action=opensearch&limit=1&namespace=0&format=json&search=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn(`Wikipedia HTTP ${res.status} for "${name}"`);
    throw new Error(`Wikipedia HTTP ${res.status}`);
  }
  const data = (await res.json()) as [string, string[], string[], string[]];
  const title = data?.[1]?.[0];
  if (!title) return null;
  // opensearch prefix-matches, so "Fontaine de la Lune" can return "Fontaine" (a real
  // commune). Same overlap guard rejects that.
  return nameOverlaps(name, title) ? title : null;
}

// Executes the verify_places tool: for each place, ask a free geo database whether it
// exists. OpenStreetMap (Nominatim) is the primary check; Wikipedia is a fallback for
// famous things OSM phrases differently. `cache` dedupes repeats within one plan and
// also lets the route annotate the final itinerary from what we actually found.
export async function verifyPlaces(
  places: VerifyInput[],
  cache: Map<string, VerifyResult>,
  // Optional: called as each place resolves, so the route can stream "12/15 checked"
  // progress to the browser. Verification is the slow part (~1 lookup/sec), so this is
  // the most useful live signal during a long plan.
  onProgress?: (done: number, total: number, last: VerifyResult) => void,
): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  let networked = false;
  const report = (r: VerifyResult) => onProgress?.(out.length, places.length, r);

  for (const place of places) {
    if (!place?.name) continue; // defensive: skip a malformed entry rather than crash
    const key = placeKey(place.name, place.city);
    const cached = cache.get(key);
    if (cached) {
      out.push(cached);
      report(cached);
      continue;
    }

    // Pace successive live lookups; cached hits above never sleep.
    if (networked) await sleep(THROTTLE_MS);
    networked = true;

    const query = place.city ? `${place.name}, ${place.city}` : place.name;
    try {
      const osm = await searchNominatim(query, place.name);
      let result: VerifyResult;
      if (osm) {
        result = { name: place.name, city: place.city, found: true, matched: osm, source: "osm" };
      } else {
        // OSM gave a clean "not found" (200, no usable hit). Try Wikipedia for famous
        // things OSM phrases differently. (If OSM had *errored*, we'd have thrown above
        // and skipped straight to the catch — we don't trust a degraded backend, and we
        // don't waste a second lookup on it.)
        const wiki = await searchWikipedia(place.name);
        result = wiki
          ? { name: place.name, city: place.city, found: true, matched: wiki, source: "wikipedia" }
          : { name: place.name, city: place.city, found: false };
      }
      cache.set(key, result);
      out.push(result);
      report(result);
    } catch {
      // A network/timeout/HTTP error is not evidence the place is fake. Mark it
      // unconfirmed for this response, but DON'T cache it — a transient outage shouldn't
      // poison a later repeat of the same place, and a fresh run should get to retry.
      const failed: VerifyResult = { name: place.name, city: place.city, found: false };
      out.push(failed);
      report(failed);
    }
  }

  return out;
}

// --- Route grounding support -------------------------------------------------
// A geocoded city centroid. check_route (lib/route.ts) uses these to compute
// real straight-line distances between consecutive cities, so the agent can
// sanity-check a multi-city route instead of eyeballing the map.
export type GeoPoint = { lat: number; lon: number; display: string };

// Geocode a city to a lat/lon centroid via the same free Nominatim layer the
// place verifier uses. Returns null for a clean "not found"; THROWS on an
// infrastructure error (timeout, non-2xx) so the caller can tell "couldn't find
// this city" from "the lookup itself failed" — a transient outage shouldn't read
// as a real geographic gap. Including the country in the query strongly
// disambiguates same-named cities; we take the top hit's coordinates (precision
// to the city centroid is plenty for catching zig-zags).
export async function geocodeCity(
  name: string,
  country?: string,
  signal?: AbortSignal,
): Promise<GeoPoint | null> {
  const query = country ? `${name}, ${country}` : name;
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  // Compose the request-abort signal (client navigated away) with the per-lookup
  // timeout, so a city geocode stops promptly on either — no point geocoding the
  // rest of a route after the browser has gone.
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    console.warn(`Nominatim HTTP ${res.status} for city "${query}"`);
    throw new Error(`Nominatim HTTP ${res.status}`);
  }
  const data = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
  if (data.length === 0) return null;
  const lat = Number.parseFloat(data[0].lat ?? "");
  const lon = Number.parseFloat(data[0].lon ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, display: data[0].display_name ?? query };
}
