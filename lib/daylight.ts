// Daylight-hours grounding — the SEVENTH grounded signal, and the FIRST that needs no network at
// all. Daylight DURATION (sunrise to sunset) is a deterministic function of just two things: a
// city's LATITUDE and the DATE (which fixes the sun's declination). best_time_to_go already
// geocodes every city to a lat/lon to fetch its climate, so the latitude is already in hand — which
// means daylight isn't a tool the model calls or an API we hit, it's a closed-form astronomical
// computation folded into the season pass. That mirrors the FX / booking-enrich / smart-selection
// decisions: a deterministic fact derivable from data a tool already gathered doesn't earn its own
// model turn. It also can't FAIL the way a network source can (no 429, no missing field, no NaN),
// which is exactly why this stayed a local formula instead of pulling Open-Meteo's daylight_duration
// field — an absent field there would silently slip a NaN past the climate fetch's null-guard.
//
// Same honest-about-limits stance as the rest of the app: this is the GEOMETRIC sunrise-to-sunset
// day length (with the standard refraction/disc correction), computed from latitude — NOT observed
// data and NOT usable-light. Civil twilight adds ~20-40 min of usable light at each end (more at
// high latitude), and local mountains can shorten it; the season note discloses both. Complements
// best_time_to_go's WEATHER comfort with the OTHER thing a season changes: how much daylight you get
// to spend it in.

// The NOAA sunrise equation gives the hour angle of sunrise/sunset; twice that, scaled to hours, is
// the day length. We evaluate it for a representative MID-MONTH day (the 15th) — near the solstices
// the within-month swing is under half an hour, and near the equinoxes the larger swing falls in the
// unremarkable 9-16h band that gets no advisory anyway, so a single mid-month value is honest at the
// precision we surface ("~Xh"). Day-of-year of the 15th of each month (non-leap; the ~1-day leap
// shift is far below the half-hour resolution).
const MID_MONTH_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

// The sun's centre is ~0.833° below the true horizon at the moment its upper limb appears to touch
// it (atmospheric refraction ~0.567° + the disc's angular radius ~0.267°). This is the same
// definition api.sunrise-sunset.org and almanacs use for "official" sunrise/sunset.
const SUN_ALTITUDE_DEG = -0.833;

// Below this absolute latitude, daylight sits within a couple of hours of 12h ALL year (Singapore,
// Nairobi, Bangkok) — the figure is noise, not a planning signal — so we suppress the advisory
// entirely (the raw hours still ride in the tooltip as low-stakes context).
const EQUATORIAL_LAT = 12;

// Advisory bands on the mid-month day length (hours). Outside [SHORT_MAX, LONG_MIN) there's no
// advisory — a mid-latitude shoulder/summer month where daylight neither constrains nor rewards the
// planner. LONG_MIN is 16h (not 15h): London in June (~16.7h, sunset ~9:15pm) is genuinely notable
// and fires; London in May (~15.4h, sunset ~8:45pm) is pleasant-but-normal and stays silent.
const POLAR_NIGHT_MAX = 4; // below this → very short / polar-night handling
const SHORT_MAX = 9; // [4,9) → front-load outdoor plans
const LONG_MIN = 16; // [16,21) → long light evenings
const MIDNIGHT_SUN_MIN = 21; // ≥ this → near-midnight-sun

const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Hours of daylight (sunrise to sunset) for a city at `lat` in `month` (1-12), on the 15th. Pure,
// network-free, and — by construction — incapable of returning NaN: the cosH ratio is clamped to
// [-1,1] before acos, so an over-water-of-the-poles or |lat|=90 input degrades to 0h or 24h rather
// than poisoning the season summary, the cache, the model view and the UI with a silent NaN.
export function computeDaylightHours(lat: number, month: number): number {
  // A non-finite latitude should never reach here (geocodeCity guarantees a finite lat), but guard
  // it so the "cannot produce NaN" property holds unconditionally: fall back to the equatorial ~12h.
  if (!Number.isFinite(lat)) return 12;
  const n = MID_MONTH_DOY[month - 1] ?? 182;
  // Cooper's declination approximation (degrees): accurate to a fraction of a degree, which is far
  // tighter than the half-hour resolution we surface.
  const decl = 23.45 * Math.sin(DEG * ((360 * (284 + n)) / 365));
  const cosH =
    (Math.sin(DEG * SUN_ALTITUDE_DEG) - Math.sin(DEG * lat) * Math.sin(DEG * decl)) /
    (Math.cos(DEG * lat) * Math.cos(DEG * decl));
  // cosH < -1 ⇒ the sun never sets (midnight sun, 24h); cosH > 1 ⇒ it never rises (polar night, 0h).
  const halfDay = Math.acos(clamp(cosH, -1, 1)); // radians, sunrise→noon arc
  return (24 * halfDay) / Math.PI;
}

// Round to the nearest half hour and format as "~Xh" — the honest precision for a mid-month
// representative value (never decimal minutes, which would imply the formula models terrain and
// refraction variation it doesn't).
export function fmtDaylight(hours: number): string {
  return `~${Math.round(hours * 2) / 2}h`;
}

// The server-computed, hemisphere-NEUTRAL planning advisory for a city/month — or null when daylight
// isn't a signal worth a line (the 9-16h band, or an equatorial city). The whole threshold decision
// lives here, server-side, so the model view and the UI render the SAME verdict from one source of
// truth (the app has no precedent for client-side threshold logic — bestWindow, flags and the
// season caveat are all server strings the UI prints verbatim). Phrasing names the physical fact and
// the consequent action, never a season label, so a southern-hemisphere December (long days) is
// never mislabelled "winter".
export function daylightAdvisory(lat: number, month: number): string | null {
  if (Math.abs(lat) < EQUATORIAL_LAT) return null; // ~12h year-round — no signal
  const h = computeDaylightHours(lat, month);
  const hr = fmtDaylight(h);
  // True polar night (rounds to 0h): "schedule around midday" would overstate it, so say it plainly.
  if (Math.round(h * 2) / 2 <= 0) {
    return "Essentially no daylight at this time of year (polar night) — only faint twilight around midday; plan indoor activities.";
  }
  if (h < POLAR_NIGHT_MAX) {
    return `Only ${hr} of daylight — schedule any outdoor sightseeing tightly around midday; it's dark for most of the day.`;
  }
  if (h < SHORT_MAX) {
    return `${hr} of daylight — front-load outdoor sightseeing; expect dark by early afternoon.`;
  }
  if (h < LONG_MIN) return null; // unremarkable middle band — no advisory
  if (h < MIDNIGHT_SUN_MIN) {
    return `${hr} of daylight — evenings stay light well past dinner; outdoor dining and evening walks are viable.`;
  }
  return `${hr} of daylight (near midnight sun) — outdoor sightseeing works at any hour; the sky barely gets dark.`;
}

// The yearlong daylight swing for a high-latitude city, used in the MODEL VIEW only when the trip
// has no target month — there's no single value to advise on, but a 4h→21h swing IS itself the
// dominant reason to time the trip, so the model gets it when recommending a best window. Returns
// null when the swing is small enough that the best-window guidance already covers it. `monthly` is
// the 12-element daylight-hours array (index 0 = January).
const SWING_NOTABLE = 7; // hours of annual swing below which the season window already implies it
export function daylightSwing(monthly: number[]): string | null {
  if (monthly.length !== 12) return null;
  const swing = Math.max(...monthly) - Math.min(...monthly);
  if (swing < SWING_NOTABLE) return null;
  // December and June are the solstitial extremes for both hemispheres (the labels stay literal —
  // "Dec"/"Jun" — so the model reads the actual figures rather than a hemisphere-specific season).
  return `${fmtDaylight(monthly[11])} (Dec) to ${fmtDaylight(monthly[5])} (Jun) — daylight swings hard across the year, so timing matters a lot for outdoor plans`;
}
