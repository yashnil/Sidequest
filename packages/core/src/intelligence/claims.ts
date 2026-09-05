import { z } from 'zod';

/**
 * EVIDENCE CLAIMS: WHAT IS ASSERTED, BY WHOM, HOW RECENTLY, AND WITH WHAT RIGHT.
 *
 * Every material fact the trip hub shows a traveller passes through this
 * shape so that five questions always have an answer: what is the claim,
 * where did it come from, when was it checked, how authoritative is it, and
 * is it current enough. The states are words, not decimals, because "0.73"
 * tells nobody whether they need a visa.
 *
 * The five doctrine rules live here as code:
 *   unknown ≠ false · missing ≠ contradicted · stale ≠ current ·
 *   model knowledge ≠ current legal fact · provider failure ≠ impossibility.
 */

export const AUTHORITY_CLASSES = [
  /** Government, border authority, official park, official operator, official venue. */
  'official_current',
  /** A licensed, structured provider: routing, places, weather. */
  'authoritative_structured',
  /** OpenStreetMap, Overture, open government datasets. */
  'open_structured',
  /** Tourism board, reputable guide, an existing licensed reference. */
  'trusted_reference',
  /** A fact the traveller typed themselves: a booking, a passport month. */
  'traveller_stated',
  /** Travel judgment from the composing model. Useful, never authoritative. */
  'model_proposal',
] as const;
export const authorityClassSchema = z.enum(AUTHORITY_CLASSES);
export type AuthorityClass = z.infer<typeof authorityClassSchema>;

export const AUTHORITY_LABELS: Record<AuthorityClass, string> = {
  official_current: 'Official source',
  authoritative_structured: 'Licensed data provider',
  open_structured: 'Open dataset',
  trusted_reference: 'Trusted reference',
  traveller_stated: 'Entered by you',
  model_proposal: 'Sidequest’s suggestion',
};

export const CLAIM_STATES = ['confirmed', 'unverified', 'contradicted', 'stale', 'not_applicable', 'needs_input'] as const;
export const claimStateSchema = z.enum(CLAIM_STATES);
export type ClaimState = z.infer<typeof claimStateSchema>;

export const CLAIM_STATE_LABELS: Record<ClaimState, string> = {
  confirmed: 'Confirmed',
  unverified: 'Not independently verified',
  contradicted: 'Contradicted by evidence',
  stale: 'Checked, but may be out of date',
  not_applicable: 'Does not apply',
  needs_input: 'Needs one detail from you',
};

export const FRESHNESS_CLASSES = ['very_volatile', 'date_bound', 'regulatory_volatile', 'stable_reference'] as const;
export const freshnessClassSchema = z.enum(FRESHNESS_CLASSES);
export type FreshnessClass = z.infer<typeof freshnessClassSchema>;

export const FRESHNESS_LABELS: Record<FreshnessClass, string> = {
  very_volatile: 'Changes hourly to daily',
  date_bound: 'Tied to a date or season',
  regulatory_volatile: 'Rules can change without notice',
  stable_reference: 'Stable',
};

export const CLAIM_KINDS = [
  'entry_visa',
  'passport_validity',
  'transit_requirement',
  'health_document',
  'travel_advisory',
  'local_law',
  'driving_document',
  'routing_duration',
  'transport_schedule',
  'current_traffic',
  'opening_hours',
  'seasonal_access',
  'permit',
  'weather_forecast',
  'climate',
  'daylight',
  'hotel_availability',
  'live_price',
  'place_identity',
  'cost_estimate',
  'booked_fact',
  'meal_intent',
  'packing_suggestion',
  'safety_hazard',
  'general',
] as const;
export const claimKindSchema = z.enum(CLAIM_KINDS);
export type ClaimKind = z.infer<typeof claimKindSchema>;

/**
 * WHICH SOURCES MAY ESTABLISH WHICH KINDS OF TRUTH.
 *
 * A claim of a kind may only be `confirmed` by an authority in its row. A
 * model may say "check whether you need a visa"; it may not say "you do not
 * need a visa". Static road routing may confirm a duration; it may not confirm
 * live traffic. Climate may not confirm a forecast.
 */
export const CONFIRMING_AUTHORITY: Record<ClaimKind, readonly AuthorityClass[]> = {
  entry_visa: ['official_current'],
  passport_validity: ['official_current', 'traveller_stated'],
  transit_requirement: ['official_current'],
  health_document: ['official_current'],
  travel_advisory: ['official_current'],
  local_law: ['official_current'],
  driving_document: ['official_current'],
  routing_duration: ['authoritative_structured', 'open_structured', 'official_current'],
  transport_schedule: ['official_current', 'authoritative_structured'],
  current_traffic: ['authoritative_structured'],
  opening_hours: ['official_current', 'authoritative_structured'],
  seasonal_access: ['official_current', 'authoritative_structured'],
  permit: ['official_current'],
  weather_forecast: ['authoritative_structured', 'official_current'],
  climate: ['authoritative_structured', 'open_structured', 'official_current'],
  daylight: ['authoritative_structured', 'open_structured'],
  hotel_availability: ['authoritative_structured'],
  live_price: ['authoritative_structured'],
  place_identity: ['authoritative_structured', 'open_structured', 'official_current'],
  cost_estimate: ['traveller_stated', 'authoritative_structured', 'official_current'],
  booked_fact: ['traveller_stated'],
  meal_intent: [],
  packing_suggestion: [],
  safety_hazard: ['official_current', 'authoritative_structured'],
  general: ['official_current', 'authoritative_structured', 'open_structured', 'trusted_reference'],
};

/** The freshness class a kind of claim carries unless the source says otherwise. */
export const DEFAULT_FRESHNESS: Record<ClaimKind, FreshnessClass> = {
  entry_visa: 'regulatory_volatile',
  passport_validity: 'regulatory_volatile',
  transit_requirement: 'regulatory_volatile',
  health_document: 'regulatory_volatile',
  travel_advisory: 'regulatory_volatile',
  local_law: 'regulatory_volatile',
  driving_document: 'regulatory_volatile',
  routing_duration: 'stable_reference',
  transport_schedule: 'date_bound',
  current_traffic: 'very_volatile',
  opening_hours: 'date_bound',
  seasonal_access: 'date_bound',
  permit: 'date_bound',
  weather_forecast: 'very_volatile',
  climate: 'stable_reference',
  daylight: 'stable_reference',
  hotel_availability: 'very_volatile',
  live_price: 'very_volatile',
  place_identity: 'stable_reference',
  cost_estimate: 'date_bound',
  booked_fact: 'stable_reference',
  meal_intent: 'stable_reference',
  packing_suggestion: 'stable_reference',
  safety_hazard: 'date_bound',
  general: 'date_bound',
};

export const sourceClaimSchema = z.object({
  id: z.string().min(1),
  kind: claimKindSchema,
  /** What the claim is about: a place id, a day number, "trip", a country code. */
  subject: z.string().min(1),
  /** The assertion, in words a traveller can read. */
  claim: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  authority: authorityClassSchema,
  sourceName: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  state: claimStateSchema,
  checkedAt: z.string().datetime().optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
  freshness: freshnessClassSchema,
  /** True when the trip cannot sensibly proceed until this is resolved. */
  blocking: z.boolean().default(false),
  notes: z.array(z.string().min(1)).default([]),
});
export type SourceClaim = z.infer<typeof sourceClaimSchema>;

/**
 * THE POLICY, APPLIED.
 *
 * A `confirmed` claim from an authority its kind does not accept is downgraded
 * to `unverified`, and says so. Nothing else changes — the claim, the source
 * and the date are kept so the traveller can still follow the link.
 */
export function applySourcePolicy(claim: SourceClaim): SourceClaim {
  if (claim.state !== 'confirmed') return claim;
  const allowed = CONFIRMING_AUTHORITY[claim.kind];
  if (allowed.includes(claim.authority)) return claim;
  return {
    ...claim,
    state: 'unverified',
    notes: [
      ...claim.notes,
      `${AUTHORITY_LABELS[claim.authority]} cannot confirm ${claim.kind.replace(/_/g, ' ')}; an ${allowed.length > 0 ? allowed.map((a) => AUTHORITY_LABELS[a].toLowerCase()).join(' or ') : 'authoritative source'} is needed.`,
    ],
  };
}

export function mayConfirm(kind: ClaimKind, authority: AuthorityClass): boolean {
  return CONFIRMING_AUTHORITY[kind].includes(authority);
}

/** A small constructor that fills defaults and applies the policy in one place. */
export function claim(input: {
  id: string;
  kind: ClaimKind;
  subject: string;
  claim: string;
  authority: AuthorityClass;
  sourceName: string;
  state: ClaimState;
  sourceUrl?: string;
  value?: string | number | boolean;
  checkedAt?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  freshness?: FreshnessClass;
  blocking?: boolean;
  notes?: readonly string[];
}): SourceClaim {
  return applySourcePolicy(
    sourceClaimSchema.parse({
      ...input,
      freshness: input.freshness ?? DEFAULT_FRESHNESS[input.kind],
      blocking: input.blocking ?? false,
      notes: input.notes ? [...input.notes] : [],
    }),
  );
}

/**
 * IS THIS CLAIM STILL CURRENT ENOUGH?
 *
 * Semantic windows rather than a blanket TTL: a forecast is current for a day,
 * a timetable or opening schedule for a season, a regulation is current on the
 * day it was read and worth re-reading before departure, a stable reference
 * does not go stale.
 */
export const RECHECK_WINDOW_DAYS: Record<FreshnessClass, number | null> = {
  very_volatile: 1,
  date_bound: 60,
  regulatory_volatile: 30,
  stable_reference: null,
};

export function freshnessVerdict(claim: SourceClaim, now: Date): 'current' | 'recheck' | 'unknown_age' {
  const window = RECHECK_WINDOW_DAYS[claim.freshness];
  if (window === null) return 'current';
  if (!claim.checkedAt) return 'unknown_age';
  const ageDays = (now.getTime() - Date.parse(claim.checkedAt)) / 86_400_000;
  return ageDays > window ? 'recheck' : 'current';
}

/** Which claims a traveller should re-read close to departure, regardless of age. */
export function needsRecheckBeforeDeparture(claim: SourceClaim): boolean {
  return claim.freshness !== 'stable_reference' && claim.state !== 'not_applicable';
}

/**
 * THE UNKNOWN-IS-NOT-FALSE HELPER.
 *
 * Absence of evidence produces `unverified` — never `contradicted`, never a
 * closed door. Only affirmative evidence produces `contradicted`.
 */
export function stateFromEvidence(input: { found: boolean; contradicts?: boolean; providerFailed?: boolean }): ClaimState {
  if (input.providerFailed) return 'unverified';
  if (!input.found) return 'unverified';
  return input.contradicts ? 'contradicted' : 'confirmed';
}
