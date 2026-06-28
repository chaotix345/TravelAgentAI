// Altitude / acclimatization grounding — the TENTH grounded signal, folded into the best_time_to_go
// season pass like daylight, heat and air quality. When a city's BASE sits high enough that altitude
// sickness is a real risk, the plan warns the traveler and paces their first day ("Cusco is at
// ~3,400m — take day 1 easy, hydrate, watch for altitude sickness"). Like daylight, it needs NO new
// network call and NO new model turn: the Open-Meteo ERA5 archive response best_time_to_go already
// fetches carries the grid-cell elevation (metres, Copernicus GLO-90 terrain model) as a TOP-LEVEL
// scalar — so the number falls out of the fetch we already make. What's a planning DECISION (a gentle
// arrival day, an intermediate overnight, shifting the route) stays the model's job; what's a FACT
// about a city (how high it sits, what that means for acclimatization) is computed here, server-side.
//
// THIS IS THE FIRST CITY-LEVEL SIGNAL in the codebase, and that is deliberate: daylight varies with the
// Earth's tilt, heat with the season, air quality with seasonal sources (crop burning) — all are
// per-MONTH and live on MonthSeason (×12). Elevation is a fixed geographic property of the city (Cusco
// is ~3,400m in January and in July), so it lives ONE level up, on CitySeasonSummary, and is assembled
// in assessSeason() ALONGSIDE classify()'s 12 per-month records — never inside classify(). Do NOT move
// it into classify() to "match the pattern" of the other three signals; the placement reflects what the
// fact actually depends on. (lib/season.ts holds the fetch + assembly; this module is the pure
// thresholds + advisory wording, zero imports, unit-tested standalone, exactly like daylight.ts.)
//
// HONESTY: the elevation is a terrain-model figure (DEM), accurate to roughly ±100–150m for most
// cities — enough to choose an acclimatization tier, not a precise benchmark — so the wording says
// "around", never an exact figure, and the season note discloses the source + that acclimatization
// varies by person, fitness and rate of ascent. The advisories are general TRAVEL information, never
// personal medical advice, and never name a prescription medication (the server knows nothing about a
// traveler's history). Same free-data-first, honest-about-limits, decisive stance as the rest of the app.

// Acclimatization tiers on the city's SLEEPING elevation (metres). These follow mainstream
// travel-medicine practice (CDC / Wilderness Medical Society): AMS is uncommon in healthy travelers
// below ~2,000m (so Denver ~1,610m, Nairobi ~1,795m, Kathmandu's centre ~1,400m stay SILENT), becomes
// a real consideration from ~2,500m (the classic "take it easy on arrival" altitude — Cusco, Quito,
// Bogotá), and is serious from ~3,500m (La Paz, Lhasa, Potosí). Below MILD there's no advisory at all.
const ALTITUDE_MILD_M = 2000; // >= this → mild altitude (informational, not a warning)
const ALTITUDE_ACCLIMATIZE_M = 2500; // >= this → acclimatize: AMS common without easing in
const ALTITUDE_HIGH_M = 3500; // >= this → very high altitude: serious AMS risk

export type AltitudeTier = "mild" | "acclimatize" | "high";

// Which tier a (rounded) elevation falls in, or null when it's below the floor / unknown. Exported so
// the band logic has one home and tests can assert the boundaries directly. Guards null / non-finite /
// negative (an ocean grid cell or a DEM no-data sentinel like -9999) → null, defense in depth even
// though lib/season.ts already screens those out before storing elevationM.
export function altitudeTier(elevationM: number | null): AltitudeTier | null {
  if (elevationM == null || !Number.isFinite(elevationM) || elevationM < 0) return null;
  if (elevationM >= ALTITUDE_HIGH_M) return "high";
  if (elevationM >= ALTITUDE_ACCLIMATIZE_M) return "acclimatize";
  if (elevationM >= ALTITUDE_MILD_M) return "mild";
  return null;
}

// Format a metre figure with thousands separators WITHOUT toLocaleString — a German locale renders
// 3340 as "3.340", which reads as a decimal (the route.ts toLocaleString lesson). The regex grouping
// is locale-independent. Caller passes the already-rounded elevationM, so this only formats.
function fmtMeters(m: number): string {
  return String(m).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// The server-computed acclimatization advisory for a city at `elevationM` metres, or null when the
// elevation is below the floor / unknown. Takes the SAME 10m-rounded value lib/season.ts stores and
// displays, so the figure cited here can never disagree with the displayed elevation (the daylight/
// heat raw-vs-rounded lesson). Each tier names the physical fact + the consequent action; framing is
// general travel information, not personal medical advice; no drug names. Decisive — one clear steer,
// not a menu — matching the app's personality.
export function computeAltitudeAdvisory(elevationM: number | null): string | null {
  const tier = altitudeTier(elevationM);
  if (tier == null) return null;
  const m = `around ${fmtMeters(elevationM as number)} m`;
  if (tier === "high") {
    return (
      `At ${m}, this is very high altitude and serious altitude sickness is a real risk without proper ` +
      `acclimatization. Build in a gradual ascent — flying in directly from sea level is substantially ` +
      `riskier than arriving overland by train or road, so an intermediate overnight stop is strongly ` +
      `recommended where the route allows. Keep the first day very gentle, hydrate well, and avoid alcohol ` +
      `and hard exertion at first. Watch for severe headache, confusion, or breathlessness at rest ` +
      `(signs of HACE — swelling in the brain — or HAPE — fluid in the lungs) and descend immediately if ` +
      `symptoms worsen. A consultation with a travel-medicine doctor before the trip is worth considering ` +
      `at this elevation. This is general travel information, not personal medical advice.`
    );
  }
  if (tier === "acclimatize") {
    return (
      `At ${m}, altitude sickness (AMS) is common if you arrive without acclimatizing. Take your first day ` +
      `genuinely easy — a short, low-exertion arrival day — hydrate well, limit alcohol and hard exertion, ` +
      `and ascend gradually where you can. Watch for headache, nausea, or trouble sleeping, which usually ` +
      `ease over a day or two. Day trips to significantly higher elevations carry extra risk even once ` +
      `you've settled into your base. This is general travel information, not personal medical advice.`
    );
  }
  return (
    `At ${m}, this is mild altitude — some travelers notice a little breathlessness on exertion or sleep ` +
    `less soundly the first night or two. Ease into the first day, stay well hydrated, and go easy on ` +
    `alcohol at first; most healthy travelers adjust within a day.`
  );
}
