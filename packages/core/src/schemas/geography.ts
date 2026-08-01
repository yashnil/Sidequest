import { z } from 'zod';
import { coordinatesSchema, httpUrlSchema } from './common';

/**
 * The geographic vocabulary an open-world planner needs before it knows anything
 * about a particular part of the world.
 *
 * Everything here is deliberately shape-agnostic. The Eastern Sierra happens to
 * be a corridor hanging off one highway and the first version of `Region`
 * encoded that as a centre and a radius — which is a circle, and a circle is
 * wrong for the Florida Keys, wrong for a rail corridor, and wrong for Indonesia.
 * A scope is therefore one of several shapes, and code that consumes a scope has
 * to handle all of them rather than assuming the one that happened to ship first.
 */

/** A south-west / north-east box. The one shape every geocoder returns. */
export const geoBoundsSchema = z
  .object({
    southWest: coordinatesSchema,
    northEast: coordinatesSchema,
  })
  .refine((value) => value.northEast.lat >= value.southWest.lat, {
    message: 'North-east corner must be north of the south-west corner',
    path: ['northEast'],
  });
export type GeoBounds = z.infer<typeof geoBoundsSchema>;

/**
 * What kind of thing the traveller named.
 *
 * This drives breadth, clarification and how hard the compiler has to work: a
 * `country` almost always needs a subset chosen before anything can be planned,
 * a `point_of_interest` almost never does.
 */
export const DESTINATION_ENTITY_TYPES = [
  'point_of_interest',
  'neighbourhood',
  'city',
  'metro_area',
  'island',
  'archipelago',
  'protected_area',
  'subregion',
  'state_or_province',
  'country',
  'multi_country',
  'route_or_corridor',
  'unknown',
] as const;
export const destinationEntityTypeSchema = z.enum(DESTINATION_ENTITY_TYPES);
export type DestinationEntityType = z.infer<typeof destinationEntityTypeSchema>;

export const DESTINATION_ENTITY_TYPE_LABELS: Record<DestinationEntityType, string> = {
  point_of_interest: 'A specific place',
  neighbourhood: 'A neighbourhood',
  city: 'A city or town',
  metro_area: 'A city and its surroundings',
  island: 'An island',
  archipelago: 'A group of islands',
  protected_area: 'A park or protected area',
  subregion: 'A region',
  state_or_province: 'A state or province',
  country: 'A whole country',
  multi_country: 'Several countries',
  route_or_corridor: 'A route or corridor',
  unknown: 'Something we could not classify',
};

/**
 * How much ground the interpretation covers, independent of what it is called.
 *
 * "Bali" is an island and "Slovenia" is a country, and for trip-planning purposes
 * they are the same breadth. Breadth, not entity type, is what decides whether
 * the compiler must ask the traveller to narrow down.
 */
export const SCOPE_BREADTHS = ['local', 'city', 'subregion', 'region', 'country', 'multi_country'] as const;
export const scopeBreadthSchema = z.enum(SCOPE_BREADTHS);
export type ScopeBreadth = z.infer<typeof scopeBreadthSchema>;

const BREADTH_ORDER: Record<ScopeBreadth, number> = {
  local: 0,
  city: 1,
  subregion: 2,
  region: 3,
  country: 4,
  multi_country: 5,
};

export function breadthRank(breadth: ScopeBreadth): number {
  return BREADTH_ORDER[breadth];
}

/**
 * A reference to the same real-world thing in somebody else's database.
 *
 * Kept rather than flattened because deduplication depends on it: two search
 * results that carry the same provider id are one place, and no amount of name
 * or coordinate comparison is as reliable as that.
 */
export const providerRefSchema = z.object({
  provider: z.string().min(1),
  externalId: z.string().min(1),
  url: httpUrlSchema.optional(),
});
export type ProviderRef = z.infer<typeof providerRefSchema>;

/**
 * WHY CONFIDENCE IS A LIST OF SIGNALS AND NOT A NUMBER
 *
 * A model asked "how confident are you?" will answer 0.85 about everything,
 * including things it invented. That number then travels through the system and
 * is rendered next to a place name, where it reads as evidence.
 *
 * So confidence here is never authored. It is a set of *observable* signals —
 * did two independent providers agree, was the name an exact match, did the
 * administrative hierarchy line up, did the traveller confirm it — and a pure
 * function maps those signals to a level. The signals are shown to the user;
 * the level is derived.
 */
export const CONFIDENCE_SIGNALS = [
  'multiple_providers_agree',
  'exact_name_match',
  'administrative_hierarchy_match',
  'boundary_available',
  'user_confirmed',
  'single_provider_only',
  'name_match_partial',
  'no_boundary_available',
  'model_inference_only',
  'conflicting_providers',
] as const;
export const confidenceSignalSchema = z.enum(CONFIDENCE_SIGNALS);
export type ConfidenceSignal = z.infer<typeof confidenceSignalSchema>;

export const CONFIDENCE_SIGNAL_LABELS: Record<ConfidenceSignal, string> = {
  multiple_providers_agree: 'More than one source agrees',
  exact_name_match: 'The name matched exactly',
  administrative_hierarchy_match: 'The country and region line up',
  boundary_available: 'We have a real boundary for it',
  user_confirmed: 'You confirmed this',
  single_provider_only: 'Only one source found it',
  name_match_partial: 'The name was only a partial match',
  no_boundary_available: 'No boundary was published for it',
  model_inference_only: 'Inferred, not looked up',
  conflicting_providers: 'Sources disagree about this',
};

/** Signals that argue for the interpretation, in the order they carry weight. */
const POSITIVE_SIGNALS: readonly ConfidenceSignal[] = [
  'user_confirmed',
  'multiple_providers_agree',
  'exact_name_match',
  'administrative_hierarchy_match',
  'boundary_available',
];

/** Signals that argue against it. */
const NEGATIVE_SIGNALS: readonly ConfidenceSignal[] = [
  'conflicting_providers',
  'model_inference_only',
  'name_match_partial',
  'single_provider_only',
  'no_boundary_available',
];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const confidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof confidenceLevelSchema>;

export const confidenceAssessmentSchema = z.object({
  level: confidenceLevelSchema,
  signals: z.array(confidenceSignalSchema),
  /** Plain-language account of what the signals amount to. */
  note: z.string().min(1),
});
export type ConfidenceAssessment = z.infer<typeof confidenceAssessmentSchema>;

/**
 * The one place a confidence level is decided, from signals alone.
 *
 * `user_confirmed` is absolute: once a traveller has looked at an interpretation
 * and said yes, no amount of provider disagreement makes it uncertain. Below
 * that, `conflicting_providers` and `model_inference_only` are disqualifying on
 * their own, because both mean the system does not actually know.
 */
export function assessConfidence(signals: readonly ConfidenceSignal[]): ConfidenceAssessment {
  const set = new Set(signals);
  const positives = POSITIVE_SIGNALS.filter((signal) => set.has(signal));
  const negatives = NEGATIVE_SIGNALS.filter((signal) => set.has(signal));

  let level: ConfidenceLevel;
  if (set.has('user_confirmed')) {
    level = 'high';
  } else if (set.has('conflicting_providers') || set.has('model_inference_only')) {
    level = 'low';
  } else if (positives.length >= 3 && negatives.length === 0) {
    level = 'high';
  } else if (positives.length >= 2 && negatives.length <= 1) {
    level = 'medium';
  } else {
    level = 'low';
  }

  return {
    level,
    signals: [...positives, ...negatives],
    note: describeSignals(level, positives, negatives),
  };
}

function describeSignals(
  level: ConfidenceLevel,
  positives: readonly ConfidenceSignal[],
  negatives: readonly ConfidenceSignal[],
): string {
  const forIt = positives.map((signal) => CONFIDENCE_SIGNAL_LABELS[signal].toLowerCase());
  const againstIt = negatives.map((signal) => CONFIDENCE_SIGNAL_LABELS[signal].toLowerCase());
  if (forIt.length === 0 && againstIt.length === 0) return 'Nothing corroborates this yet.';
  const parts: string[] = [];
  if (forIt.length > 0) parts.push(`for it: ${forIt.join(', ')}`);
  if (againstIt.length > 0) parts.push(`against it: ${againstIt.join(', ')}`);
  const prefix =
    level === 'high' ? 'Well corroborated' : level === 'medium' ? 'Reasonably sure' : 'Not sure';
  return `${prefix} — ${parts.join('; ')}.`;
}

/**
 * The shape of the ground a trip covers.
 *
 * Four shapes rather than one, because the real ones are genuinely different and
 * flattening them loses the thing that matters. A radius is right for a base
 * town. A box is right for a city or an island a geocoder gave us bounds for. A
 * corridor is right for a road trip or a rail line, where "within 80 km of the
 * centre" would include a great deal of ground nobody will ever go to and exclude
 * the far end of the route. A set of named areas is right for a country subset,
 * where the traveller has chosen three regions out of eleven.
 */
export const scopeShapeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('radius'),
    center: coordinatesSchema,
    radiusKm: z.number().positive().max(3000),
  }),
  z.object({
    kind: z.literal('bounds'),
    bounds: geoBoundsSchema,
  }),
  z.object({
    kind: z.literal('corridor'),
    /** In travel order. Two or more. */
    waypoints: z.array(coordinatesSchema).min(2),
    /** How far either side of the line counts as "on the way". */
    corridorWidthKm: z.number().positive().max(500),
  }),
  z.object({
    kind: z.literal('areas'),
    areas: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          center: coordinatesSchema,
          radiusKm: z.number().positive().max(1000),
        }),
      )
      .min(1),
  }),
]);
export type ScopeShape = z.infer<typeof scopeShapeSchema>;
