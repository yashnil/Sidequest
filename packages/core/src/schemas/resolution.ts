import { z } from 'zod';
import { coordinatesSchema } from './common';
import {
  confidenceAssessmentSchema,
  destinationEntityTypeSchema,
  geoBoundsSchema,
  providerRefSchema,
  scopeBreadthSchema,
} from './geography';

/**
 * What a free-form destination string might mean.
 *
 * The rule this file exists to enforce: **ambiguity is preserved, never
 * resolved silently.** "Springfield" is thirty places, "Georgia" is a country
 * and a state, and "Bali" is an island whose traveller almost certainly means
 * three specific parts of it. A resolver that picks one and moves on will be
 * right most of the time and catastrophically wrong the rest, with no signal
 * that anything happened.
 */

export const AMBIGUITY_REASONS = [
  /** Several materially different places share this name. */
  'multiple_matching_places',
  /** The name matched, but at a breadth that cannot be planned as one trip. */
  'breadth_exceeds_trip_length',
  /** A country or state: almost always needs a subset chosen. */
  'administrative_area_needs_subset',
  /** The query described a vibe rather than a place. */
  'query_is_not_a_place',
  /** Providers returned different countries or centres for the same string. */
  'providers_disagree',
  /** Nothing was found at all. */
  'no_match',
  /** Found, but with no boundary, so scope has to be assumed rather than read. */
  'no_boundary_available',
] as const;
export const ambiguityReasonSchema = z.enum(AMBIGUITY_REASONS);
export type AmbiguityReason = z.infer<typeof ambiguityReasonSchema>;

export const AMBIGUITY_REASON_COPY: Record<AmbiguityReason, string> = {
  multiple_matching_places: 'More than one place goes by this name.',
  breadth_exceeds_trip_length: 'This covers more ground than the trip has days for.',
  administrative_area_needs_subset: 'This is a whole country or state — a trip needs a part of it.',
  query_is_not_a_place: 'This reads more like a kind of trip than a place.',
  providers_disagree: 'Our sources do not agree on where this is.',
  no_match: 'We could not find anywhere by that name.',
  no_boundary_available: 'We found it, but nobody publishes its edges.',
};

export const destinationCandidateSchema = z.object({
  /** Stable within one resolution. Referenced by scope and by clarification answers. */
  id: z.string().min(1),
  /** What to call it on screen. */
  displayName: z.string().min(1),
  /** The fuller form, with country: "Bali, Indonesia". */
  qualifiedName: z.string().min(1),
  entityType: destinationEntityTypeSchema,
  breadth: scopeBreadthSchema,
  center: coordinatesSchema,
  /** Absent is meaningful: it means nobody published one, and scope must be assumed. */
  bounds: geoBoundsSchema.optional(),
  countryCode: z.string().length(2).optional(),
  countryName: z.string().min(1).optional(),
  /** Coarse-to-fine: ["Indonesia", "Bali"]. Used to detect hierarchy agreement. */
  administrativeAreas: z.array(z.string().min(1)).default([]),
  /**
   * Candidate IANA zones. Plural on purpose — a country can span several, and a
   * single guessed zone is how a shuttle timetable moves by an hour.
   */
  timeZones: z.array(z.string().min(1)).default([]),
  providerRefs: z.array(providerRefSchema).default([]),
  confidence: confidenceAssessmentSchema,
  /** One line on what this interpretation would mean for the trip. */
  note: z.string().min(1).optional(),
});
export type DestinationCandidate = z.infer<typeof destinationCandidateSchema>;

export const DESTINATION_RESOLUTION_VERSION = 1 as const;

export const destinationResolutionSchema = z.object({
  schemaVersion: z.literal(DESTINATION_RESOLUTION_VERSION),
  /** Exactly what the traveller typed. */
  query: z.string().min(1),
  /** Case-folded, whitespace-collapsed. The cache key, not a display value. */
  normalizedQuery: z.string().min(1),
  candidates: z.array(destinationCandidateSchema),
  ambiguityReasons: z.array(ambiguityReasonSchema).default([]),
  /**
   * Set only when exactly one candidate came back with high confidence and no
   * ambiguity reasons. Its presence is what lets the UI skip the disambiguation
   * step; it is never inferred by taking the first candidate.
   */
  unambiguousCandidateId: z.string().min(1).optional(),
  /** Which providers were asked, whether or not they answered. */
  providersConsulted: z.array(z.string().min(1)).default([]),
  resolvedAt: z.string().min(1),
});
export type DestinationResolution = z.infer<typeof destinationResolutionSchema>;

/**
 * Whether this resolution can proceed without asking the traveller anything.
 *
 * Deliberately strict, and deliberately deterministic: one candidate, high
 * confidence, no recorded ambiguity, and a breadth a trip can actually be built
 * at. Everything else goes in front of a human. The cost of asking is one screen;
 * the cost of guessing is a compiled region for the wrong continent.
 */
export function isUnambiguous(resolution: DestinationResolution): boolean {
  if (resolution.ambiguityReasons.length > 0) return false;
  if (resolution.candidates.length !== 1) return false;
  const only = resolution.candidates[0];
  if (!only) return false;
  return only.confidence.level === 'high' && resolution.unambiguousCandidateId === only.id;
}

export function candidateById(
  resolution: DestinationResolution,
  candidateId: string,
): DestinationCandidate | undefined {
  return resolution.candidates.find((candidate) => candidate.id === candidateId);
}

/** Case-folded, whitespace-collapsed. Used for cache keys and equality, never shown. */
export function normalizeDestinationQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}
