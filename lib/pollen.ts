// Pollen / allergy-season grounding — the TWELFTH grounded signal, folded into the best_time_to_go
// season pass like daylight, "feels-like" heat, air quality, altitude and UV. When a European city-month
// typically runs high in a pollen an allergy-sufferer reacts to, the plan flags it ("Birch pollen runs
// high this month — if you're prone to hay fever, bring whatever you normally take for it"). Like the other
// folded signals it needs NO new model tool and NO new model turn. Unlike UV (which rides the existing CAMS
// air-quality fetch for free), pollen costs ONE extra keyless fetch: the pollen variables are populated only
// under the Copernicus CAMS *European* model (domains=cams_europe), while the app's existing air-quality fetch
// uses cams_global (which returns the pollen columns ALL-NULL) and carries the UV the European model lacks — so
// the two can't be merged. That separate fetch lives in lib/season.ts; it is EUROPE-ONLY (a non-European
// coordinate returns an explicit "no data" 400), degrading honestly to no signal everywhere else.
//
// What's a planning DECISION (warn a hay-fever traveler, steer to a quieter month, build indoor backups) stays
// the model's job; what's a FACT about a city-month (which pollens typically run high) is computed here, server-side.
//
// This module is PURE (zero imports, no network) so it compiles and unit-tests standalone, exactly like
// lib/uv.ts, lib/airheat.ts and lib/altitude.ts. The thresholds and advisory wording — the whole judgment about
// when pollen is worth a line — live here, server-side, so the model view and the UI render one source of truth
// (the app has no precedent for client-side threshold logic). The advisory names the physical fact + the
// consequent action, is hemisphere-neutral, and frames the figure as a typical monthly NORMAL, never a live
// count. It is general allergy travel information, not personal medical advice: it makes NO drug-name claims
// (the altitude module banned acetazolamide; "bring whatever you normally take for it" is behavioral, like UV's
// "cover up", not pharmaceutical) and it is framed as opt-in ("if you're prone to hay fever") so a traveler with
// no allergies isn't alarmed by a signal that doesn't apply to them.

// The six pollen species the CAMS European model serves. Kept in a fixed canonical order so a multi-species
// advisory string is deterministic across server restarts (the firing list is value-sorted, ties broken here).
export type PollenSpecies = "alder" | "birch" | "grass" | "mugwort" | "olive" | "ragweed";
export const POLLEN_SPECIES: readonly PollenSpecies[] = [
  "alder", "birch", "grass", "mugwort", "olive", "ragweed",
];

// One city-month's typical pollen, per species, in grains/m³ (the monthly mean of each day's 24-hour MEAN
// concentration — NOT a daily peak: published European severity scales are all defined on the daily mean, and
// pollen, unlike UV, does not fall to zero at night, so a 24h mean is the correct aggregation). null per species
// when CAMS had no data for it that month. The whole object is null for a non-European city (no coverage).
export type PollenReadings = Record<PollenSpecies, number | null>;

// Advisory FIRE thresholds (monthly mean of daily-mean grains/m³). Each is calibrated PER SPECIES — a single
// universal cutoff would be wrong, because the species differ by an order of magnitude in both abundance and
// potency: ragweed provokes symptoms at counts where olive is still trivial. These fire a notch into the
// "Moderate" band of the published daily-mean scales (so a monthly mean at the threshold implies the month has
// frequent genuinely-high-pollen DAYS), matching the "only warn when it changes the plan" calibration the heat
// (37°C, not 30), UV (index 9, not the band floor 8) and air (USG, not Moderate) signals use. Sources, per species:
//   birch/alder  25  — Rantio-Lehtimäki/SILAM (FMI) tree scale (Low 1-9, Moderate 10-99, High 100+); 25 = upper-Moderate
//   grass        20  — EAACI "high pollen day" = 50/m³ daily; a 20 monthly mean implies repeated ≥50 days
//   olive        25  — OPDEC (Cartagena) olive scale (Moderate 11-50, High 51-100); 25 = meaningful mid-Moderate
//   mugwort      15  — CAMS herbaceous grouping; catches Vienna's ~18 August mugwort season
//   ragweed      10  — Milan study (medium-high symptoms ~14.5/m³); the most potent species, so the lowest floor
// Validated against probed 2023-24 monthly normals across Berlin/Vienna/Madrid/Athens/London with zero false
// positives (Berlin Apr birch 86 fires; Berlin May birch 5 silent; Madrid May olive 43 fires; Madrid Apr olive 10 silent).
const ADVISORY_FLOOR: Record<PollenSpecies, number> = {
  alder: 25,
  birch: 25,
  grass: 20,
  olive: 25,
  mugwort: 15,
  ragweed: 10,
};

// Display labels (title-case) for each species, used in the advisory prose and the compact tooltip tag.
const SPECIES_LABEL: Record<PollenSpecies, string> = {
  alder: "Alder",
  birch: "Birch",
  grass: "Grass",
  mugwort: "Mugwort",
  olive: "Olive",
  ragweed: "Ragweed",
};

// The species whose typical monthly level clears its advisory floor, with that (already-rounded) level. Sorted
// by level descending (the most prominent allergen reads first), ties broken by canonical species order so the
// output is deterministic. Guards null / non-finite / negative per species (pollen is physically ≥ 0; a negative
// is a sentinel, never a real value). Returns [] when nothing fires or there are no readings — the single source
// of the "does pollen warrant a line this month" decision, shared by pollenAdvisory and pollenTag so they can't
// disagree about which species fired.
export function firingPollens(
  readings: PollenReadings | null,
): Array<{ species: PollenSpecies; value: number }> {
  if (!readings) return [];
  const firing: Array<{ species: PollenSpecies; value: number }> = [];
  for (const species of POLLEN_SPECIES) {
    const v = readings[species];
    if (v == null || !Number.isFinite(v) || v < 0) continue;
    if (v >= ADVISORY_FLOOR[species]) firing.push({ species, value: v });
  }
  // Sort by value desc; ties by canonical order (already the push order, so a stable comparison on value alone
  // preserves it). JS Array.sort isn't guaranteed stable on all engines, so break ties explicitly.
  return firing.sort(
    (a, b) => b.value - a.value || POLLEN_SPECIES.indexOf(a.species) - POLLEN_SPECIES.indexOf(b.species),
  );
}

// The server-computed allergy advisory for a city-month at these typical pollen levels, or null when no species
// runs high enough to be worth a line. Names the firing species explicitly (never groups them as "tree pollen" —
// olive is a distinct allergen from birch even though both are trees) and embeds the actual figure, the round-once
// discipline: the caller rounds each species' monthly mean ONCE and passes that same integer here and to pollenTag,
// so the figure the traveler reads can never disagree with the displayed tag. Behavioral, drug-name-free, opt-in
// framing; frames the level as a typical monthly normal, never a live count.
export function pollenAdvisory(readings: PollenReadings | null): string | null {
  const firing = firingPollens(readings);
  if (firing.length === 0) return null;
  const tail =
    "if you're prone to hay fever, bring whatever you normally take for it and check a local daily pollen forecast on arrival.";
  if (firing.length === 1) {
    const f = firing[0];
    return `${SPECIES_LABEL[f.species]} pollen runs high this month (around ${f.value} grains/m³ on average) — ${tail}`;
  }
  // Two or more: "Grass and ragweed" / "Birch, grass and ragweed", with the per-species figures after. "both" for
  // a pair, "all" for three or more; figures use the same "around N grains/m³ on average" phrasing as the single case.
  const names = firing.map((f) => SPECIES_LABEL[f.species]);
  const joined =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const quantifier = firing.length === 2 ? "both" : "all";
  const figures = firing.map((f) => `${SPECIES_LABEL[f.species].toLowerCase()} around ${f.value}`).join(", ");
  return `${joined} pollen ${quantifier} run high this month (${figures} grains/m³ on average) — ${tail}`;
}

// A compact label for the month-strip tooltip, e.g. "birch 86" or "grass 22, ragweed 14", or null when nothing
// fires. Built from the SAME firing list as the advisory (so the tooltip and the caption agree on which species
// are high), letting the UI show the firing species + figure without re-deriving any threshold client-side.
export function pollenTag(readings: PollenReadings | null): string | null {
  const firing = firingPollens(readings);
  if (firing.length === 0) return null;
  return firing.map((f) => `${SPECIES_LABEL[f.species].toLowerCase()} ${f.value}`).join(", ");
}
