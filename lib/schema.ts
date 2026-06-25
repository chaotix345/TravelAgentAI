import { z } from "zod";

// Narrative fields (`why`, `country`) are optional: the model usually fills them,
// but one omitted sentence shouldn't fail-validate an otherwise perfect plan.
// Structural fields (name, type, nights, label) stay required. The .max() bounds are
// generous — well above any real plan — so they never trip a legitimate emit, but they cap
// how much adversarial text a refine's client-supplied prior plan can smuggle into the
// model's context (that plan is user input and gets embedded verbatim before planning).
export const activitySchema = z.object({
  name: z.string().max(400).describe("A specific, real place or thing to do."),
  type: z.enum([
    "food",
    "sight",
    "activity",
    "nature",
    "nightlife",
    "shopping",
    "rest",
    "transit",
  ]),
  why: z
    .string()
    .max(1000)
    .optional()
    .describe("One sentence: why this is here for this traveler."),
});

export const daySchema = z.object({
  label: z.string().max(120).describe('e.g. "Day 1" or a real date.'),
  morning: activitySchema,
  afternoon: activitySchema,
  evening: activitySchema,
});

export const citySchema = z.object({
  name: z.string().max(120),
  country: z.string().max(120).optional(),
  // .min(1): a city you sleep in has at least one night; this also flows into the tool's
  // JSON Schema (below) so the model is told the bound, and Zod rejects "-3 nights".
  nights: z.number().int().min(1).describe("How many nights in this city."),
  why: z.string().max(1000).optional().describe("Why this city, and why this many nights."),
  // .min(1): never render a city header with no days under it.
  days: z.array(daySchema).min(1),
});

export const itinerarySchema = z.object({
  summary: z.string().max(600).describe("One line: what this trip is."),
  totalNights: z.number().int().min(1),
  cities: z.array(citySchema).min(1).describe("Ordered list — the route."),
});

export type Activity = z.infer<typeof activitySchema>;
export type Day = z.infer<typeof daySchema>;
export type City = z.infer<typeof citySchema>;
export type Itinerary = z.infer<typeof itinerarySchema>;

// JSON Schema for the Claude tool's input_schema, generated from the Zod schema
// above (single source of truth). Zod 4 ships this natively. The .min(1) bounds above
// become `minimum` / `minItems` here, so the model sees them too. Strip the top-level
// `$schema` key — it's valid JSON Schema but isn't expected in a tool input_schema.
const full = z.toJSONSchema(itinerarySchema, { target: "draft-7" }) as Record<string, unknown>;
const { $schema: _omit, ...rest } = full;
export const itineraryJsonSchema = rest;

// Approach B layer: the model emits the schema above unchanged. After it does, the route
// runs each named place through the verify tool and attaches a verdict. These enriched
// types describe that annotated shape — the verdict is OURS, not part of what the model
// returns, so the UI can trust the badge.
export type VerifyStatus = "confirmed" | "unconfirmed";
export type VerifiedActivity = Activity & { verified?: VerifyStatus; matched?: string };
export type VerifiedDay = {
  label: string;
  morning: VerifiedActivity;
  afternoon: VerifiedActivity;
  evening: VerifiedActivity;
};

// Same Approach-B idea applied to BUDGET: when the model calls estimate_costs, the route
// grounds each city's cost level (bundled World Bank price levels + live Wikivoyage anchors)
// and attaches the result here. Like the verify verdict, this is OURS — the displayed budget
// is the tool's output, not a number the model asserted. Self-contained (no import from the
// server-only cost module) so this file stays safe to pull types from in the client bundle.
export type CostTier = "cheap" | "moderate" | "pricey" | "expensive" | "unknown";
export type CityCostSummary = {
  tier: CostTier;
  dailyUsd: number | null; // per-person, per-day, all-in, for the chosen style
  anchors: string[]; // verbatim real price examples from Wikivoyage
};
export type BudgetSummary = {
  style: "budget" | "mid-range" | "luxury";
  currency: "USD";
  totalUsd: number | null; // per person, lodging+food+local; excludes flights/intercity
  perDayUsd: number | null;
  note: string;
  flags: string[];
};
export type VerifiedCity = Omit<City, "days"> & { days: VerifiedDay[]; cost?: CityCostSummary };
export type VerifiedItinerary = Omit<Itinerary, "cities"> & {
  cities: VerifiedCity[];
  budget?: BudgetSummary;
};
