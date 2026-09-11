import { z } from 'zod';

/**
 * TRAVEL REALITY — WHAT IS OPERATIONALLY TRUE ABOUT TRAVELLING HERE, BEFORE
 * SIDEQUEST RECOMMENDS ANYTHING.
 *
 * V7 §3. The interview told an American traveller "Sidequest recommends rent a
 * car" for a Chinese municipality because nothing between the geocoder's
 * `state` and the word "recommends" knew that a foreign short-term visitor
 * cannot drive on an international permit there, that the metro is dense,
 * that high-speed rail is the regional mode, and that payment and maps need
 * setting up before landing. This is the object that knows.
 *
 * Every externally stated operational fact carries where it came from, how
 * authoritative that is, how fast it changes and when it was compiled. A
 * fact from the bundled reference is labelled a reference and never promoted
 * to "official current"; a legal or entry claim stays a proposal until an
 * official source confirms it (`claims.ts#CONFIRMING_AUTHORITY`). Nothing
 * here calls a model or a provider: it is a pure function of the intent, the
 * screening, the party and the jurisdiction data.
 */
export const TRAVEL_REALITY_VERSION = 1 as const;

/** Transport as concepts a traveller chooses between — never collapsed into "a car". */
export const MODE_CONCEPTS = [
  'self_drive',
  'rental_car',
  'private_driver',
  'taxi',
  'rideshare',
  'metro',
  'bus',
  'intercity_train',
  'high_speed_rail',
  'ferry',
  'cruise',
  'flight',
  'walking',
  'cycling',
  'shuttle',
  'guided_transfer',
] as const;
export const modeConceptSchema = z.enum(MODE_CONCEPTS);
export type ModeConcept = z.infer<typeof modeConceptSchema>;

export const MODE_CONCEPT_LABELS: Record<ModeConcept, string> = {
  self_drive: 'Driving yourselves',
  rental_car: 'A hire car',
  private_driver: 'A hired driver',
  taxi: 'Taxis',
  rideshare: 'Ride-hailing',
  metro: 'Metro',
  bus: 'Buses',
  intercity_train: 'Trains',
  high_speed_rail: 'High-speed rail',
  ferry: 'Ferries',
  cruise: 'A cruise',
  flight: 'Flights',
  walking: 'On foot',
  cycling: 'Cycling',
  shuttle: 'Shuttles',
  guided_transfer: 'Guided or arranged transfers',
};

/** Whether a mode is a good idea here — independent of whether Sidequest can measure it. */
export const MODE_STATUSES = ['recommended', 'viable', 'friction', 'discouraged', 'unknown', 'unavailable'] as const;
export const modeStatusSchema = z.enum(MODE_STATUSES);
export type ModeStatus = z.infer<typeof modeStatusSchema>;

export const MODE_STATUS_LABELS: Record<ModeStatus, string> = {
  recommended: 'Recommended',
  viable: 'Works well',
  friction: 'Possible, with friction',
  discouraged: 'Not advised',
  unknown: 'Unknown',
  unavailable: 'Not available',
};

export const MODE_SCOPES = ['urban', 'regional', 'all'] as const;
export type ModeScope = (typeof MODE_SCOPES)[number];

export const REALITY_TOPICS = [
  'driving',
  'transit',
  'rail',
  'ferry',
  'ride_hailing',
  'payment',
  'apps',
  'navigation',
  'connectivity',
  'language',
  'ticketing',
  'holidays',
  'booking_lead',
  'border',
  'permits',
  'gateways',
  'seasonal_access',
  'safety_context',
] as const;
export const realityTopicSchema = z.enum(REALITY_TOPICS);
export type RealityTopic = z.infer<typeof realityTopicSchema>;

/**
 * Who stands behind a fact. `reference` is the bundled, dated compilation
 * that ships with the app (the same class as the country facts); it is never
 * shown as an official current source, and a legal claim from it is a
 * proposal until an official source is linked.
 */
export const REALITY_AUTHORITIES = ['official_current', 'reference', 'sidequest_derived', 'model_proposal'] as const;
export const realityAuthoritySchema = z.enum(REALITY_AUTHORITIES);
export type RealityAuthority = z.infer<typeof realityAuthoritySchema>;

export const REALITY_AUTHORITY_LABELS: Record<RealityAuthority, string> = {
  official_current: 'Official source',
  reference: 'Reference, compiled by Sidequest',
  sidequest_derived: 'Derived from this trip',
  model_proposal: 'Sidequest’s suggestion',
};

export const REALITY_FRESHNESS = ['stable', 'medium', 'volatile', 'regulatory_volatile'] as const;
export type RealityFreshness = (typeof REALITY_FRESHNESS)[number];

export const realityFactSchema = z.object({
  id: z.string().min(1),
  topic: realityTopicSchema,
  /** One sentence a traveller can read. */
  statement: z.string().min(1),
  authority: realityAuthoritySchema,
  sourceName: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  /** YYYY-MM the fact was compiled or last checked. */
  asOf: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
  freshness: z.enum(REALITY_FRESHNESS),
  confidence: z.enum(['high', 'medium', 'low']),
  /** Countries this applies to; empty means the whole destination. */
  countries: z.array(z.string().length(2)).default([]),
  scope: z.enum(MODE_SCOPES).default('all'),
});
export type RealityFact = z.infer<typeof realityFactSchema>;

export const modeAssessmentSchema = z.object({
  mode: modeConceptSchema,
  status: modeStatusSchema,
  scope: z.enum(MODE_SCOPES),
  reason: z.string().min(1),
  factIds: z.array(z.string().min(1)).default([]),
  /** Whether Sidequest can time this mode with a configured provider — separate from whether it is a good idea. */
  measurable: z.boolean(),
});
export type ModeAssessment = z.infer<typeof modeAssessmentSchema>;

export const setupItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  why: z.string().min(1),
  /** `before_you_fly` needs a home connection or an account; `on_arrival` is done at the airport or first day. */
  when: z.enum(['before_you_fly', 'on_arrival']),
  relevance: z.enum(['essential', 'useful']),
  topic: realityTopicSchema,
  factIds: z.array(z.string().min(1)).default([]),
  authority: realityAuthoritySchema,
});
export type SetupItem = z.infer<typeof setupItemSchema>;

export const crowdPeriodSchema = z.object({
  name: z.string().min(1),
  /** Inclusive month-day ranges; a period crossing the year end lists two. */
  ranges: z.array(z.object({ from: z.string().regex(/^\d{2}-\d{2}$/), to: z.string().regex(/^\d{2}-\d{2}$/) })).min(1),
  effect: z.enum(['very_busy', 'busy', 'closures']),
  note: z.string().min(1),
  countries: z.array(z.string().length(2)).default([]),
  factId: z.string().min(1).optional(),
  /** Some holidays move with a lunar calendar; the ranges are the usual window and say so. */
  movable: z.boolean().default(false),
});
export type CrowdPeriod = z.infer<typeof crowdPeriodSchema>;

export const bookingLeadSchema = z.object({
  kind: z.enum(['rail', 'cruise', 'safari_lodge', 'permit', 'guide', 'internal_flight', 'lodging_peak', 'timed_entry', 'ferry']),
  /** Days before travel a booking of this kind usually needs to be made. */
  leadDays: z.number().int().min(0),
  note: z.string().min(1),
  factId: z.string().min(1).optional(),
});
export type BookingLead = z.infer<typeof bookingLeadSchema>;

export const travelRealitySchema = z.object({
  version: z.literal(TRAVEL_REALITY_VERSION),
  destination: z.object({
    label: z.string().min(1),
    countries: z.array(z.string().length(2)).default([]),
    crossBorder: z.boolean(),
    /** How the ground reads for getting around. */
    urbanity: z.enum(['dense_urban', 'urban_plus_region', 'regional', 'remote', 'mixed', 'unknown']),
    /** Which parts of the world's operational knowledge this reality could draw on. */
    coverage: z.enum(['full', 'partial', 'none']),
  }),
  modes: z.array(modeAssessmentSchema),
  /**
   * What Sidequest would say before it sees the route — or null, in which
   * case the interview says "Sidequest will choose after it sees the route"
   * rather than inventing a recommendation.
   */
  recommendation: z
    .object({
      urban: z.array(modeConceptSchema).default([]),
      regional: z.array(modeConceptSchema).default([]),
      sentence: z.string().min(1),
      confidence: z.enum(['high', 'medium']),
      basis: z.string().min(1),
    })
    .nullable(),
  setup: z.array(setupItemSchema),
  facts: z.array(realityFactSchema),
  crowdPeriods: z.array(crowdPeriodSchema).default([]),
  bookingLeads: z.array(bookingLeadSchema).default([]),
  /** Operational dimensions nobody could answer, named. */
  unknowns: z.array(z.string().min(1)).default([]),
});
export type TravelReality = z.infer<typeof travelRealitySchema>;

/** The draft's driving arrangement, as the reality layer judges it. */
export function modeStatusFor(reality: TravelReality | null | undefined, mode: ModeConcept, scope: ModeScope = 'all'): ModeStatus {
  if (!reality) return 'unknown';
  const exact = reality.modes.find((m) => m.mode === mode && (m.scope === scope || m.scope === 'all'));
  if (exact) return exact.status;
  const any = reality.modes.find((m) => m.mode === mode);
  return any?.status ?? 'unknown';
}
