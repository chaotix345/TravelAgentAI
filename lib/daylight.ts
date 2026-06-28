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

// Day-of-year of the 15th of each month (non-leap; the ~1-day leap shift is far below the half-hour
// resolution we surface). We evaluate the geometry for this representative mid-month day — near the
// solstices the within-month swing is under half an hour, and near the equinoxes the larger swing
// falls in the unremarkable 9-16h band that gets no advisory anyway, so a single mid-month value is
// honest at the precision we surface ("~Xh").
const MID_MONTH_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

// The sun's centre is ~0.833° below the true horizon at the moment its upper limb appears to touch
// it: 34 arcmin of atmospheric refraction + 16 arcmin for the disc's angular radius = 50 arcmin,
// and 50/60 = 0.833°. Same definition api.sunrise-sunset.org and almanacs use for "official"
// sunrise/sunset.
const SUN_ALTITUDE_DEG = -0.833;

// Below this absolute latitude, daylight sits within a couple of hours of 12h ALL year (Singapore,
// Nairobi, Bangkok) — the figure is noise, not a planning signal — so we suppress the advisory
// entirely (the raw hours still ride in the tooltip as low-stakes context).
const EQUATORIAL_LAT = 12;

// Advisory bands on the ROUNDED mid-month day length (hours). We band on the rounded value (not the
// raw float) so the advisory can never contradict the "~Xh" the traveler sees — a city shown "~16h"
// always gets the long-evenings note, one shown "~9h" always gets the short-day note. Edges are
// generous toward giving guidance, so a borderline city gets the advisory rather than silence.
// Outside [SHORT_MAX, LONG_MIN) there's no advisory — a mid-latitude shoulder/summer month where
// daylight neither constrains nor rewards the planner. LONG_MIN is 16h (not 15h): London in June
// (~16.6h, sunset ~9:15pm) is genuinely notable and fires; London in May (~15.6h → shown "~15.5h",
// sunset ~8:45pm) is pleasant-but-normal and stays silent.
const VERY_SHORT_MAX = 4; // rounded < this → very short / polar-fringe handling
const SHORT_MAX = 9; // rounded <= this → front-load outdoor plans
const LONG_MIN = 16; // rounded >= this → long light evenings
const MIDNIGHT_SUN_MIN = 21; // rounded >= this → near-midnight-sun

// Civil twilight: the sun between 0° and -6° below the horizon. Above -6° at noon there's still
// real usable outdoor light even when the sun never clears the horizon — the difference between a
// Tromsø polar "day" (noon sun ~-3°, the aurora/dog-sled season runs in it) and Svalbard's deep
// polar night (noon sun ~-12°, a dim glow). Used to split the no-sunrise advisory honestly.
const CIVIL_TWILIGHT_DEG = -6;

const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Solar declination (degrees) for a representative mid-month day, via Cooper's approximation —
// accurate to a fraction of a degree, far tighter than the half-hour resolution we surface. Shared
// by the day-length and noon-altitude calculations.
function solarDeclination(month: number): number {
  const n = MID_MONTH_DOY[month - 1] ?? 182;
  return 23.45 * Math.sin(DEG * ((360 * (284 + n)) / 365));
}

// Hours of daylight (sunrise to sunset) for a city at `lat` in `month` (1-12), on the 15th. Pure,
// network-free, and — by construction — incapable of returning NaN. Two things guarantee that, and
// note the clamp is NOT one of them (Math.acos(clamp(NaN,-1,1)) is still NaN, since min/max
// propagate NaN): (1) the !Number.isFinite(lat) guard below catches a NaN/Infinity latitude; and
// (2) for any real geocoded latitude cos(lat)*cos(decl) is never exactly zero (cos(π/2) computes to
// ~6.1e-17, not 0), so cosH is always finite — the clamp's job is only to pull a large finite
// over-shoot (e.g. cosH≈-7e15 near the poles) back into acos's [-1,1] domain, i.e. midnight sun / polar night.
export function computeDaylightHours(lat: number, month: number): number {
  // A non-finite latitude should never reach here (geocodeCity guarantees a finite lat), but guard
  // it so the "cannot produce NaN" property holds unconditionally: fall back to the equatorial ~12h.
  if (!Number.isFinite(lat)) return 12;
  const decl = solarDeclination(month);
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
  // Band on the ROUNDED value so the advisory always agrees with the displayed "~Xh".
  const r = Math.round(h * 2) / 2;
  const hr = `~${r}h`;
  if (r <= 0) {
    // No sunrise — but "no daylight" isn't uniform. At the Arctic-Circle fringe (Tromsø, Murmansk,
    // Nordkapp) the noon sun sits in CIVIL twilight (above -6°), giving a few hours of real usable
    // midday light the winter aurora/dog-sled season runs in; only deep polar night (Svalbard) is a
    // dim glow. Branch on the noon solar altitude = 90 - |lat - declination|.
    const noonAlt = 90 - Math.abs(lat - solarDeclination(month));
    return noonAlt > CIVIL_TWILIGHT_DEG
      ? "No true sunrise at this time of year, but a few hours of civil twilight around midday still give usable outdoor light — plan the day tightly around noon."
      : "Essentially no daylight (deep polar night) — only a dim glow around midday; plan indoor activities.";
  }
  if (r < VERY_SHORT_MAX) {
    return `Only ${hr} of daylight — schedule any outdoor sightseeing tightly around midday; it's dark for most of the day.`;
  }
  if (r <= SHORT_MAX) {
    return `${hr} of daylight — front-load outdoor sightseeing; the usable daylight window is short.`;
  }
  if (r < LONG_MIN) return null; // unremarkable middle band — no advisory
  if (r < MIDNIGHT_SUN_MIN) {
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
  // The order is calendar-FIXED (December then June, the solstitial extremes for both hemispheres),
  // NOT min-to-max: the labels stay literal "Dec"/"Jun" so the model reads the actual figures rather
  // than a hemisphere-specific season. For a southern high-latitude city this reads high→low (Dec is
  // their long day), which is correct — the numbers carry the meaning, not the order.
  return `${fmtDaylight(monthly[11])} (Dec) to ${fmtDaylight(monthly[5])} (Jun) — daylight swings hard across the year, so timing matters a lot for outdoor plans`;
}
