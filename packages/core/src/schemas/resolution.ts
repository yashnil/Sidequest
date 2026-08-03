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

/**
 * AMBIGUITY THAT IS ACTUALLY A QUESTION, AND AMBIGUITY THAT IS NOT.
 *
 * `ambiguityReasons` carries two entirely different kinds of doubt, and
 * conflating them produced the defect this phase exists to fix. A traveller who
 * typed "Kyrgyzstan" was shown a screen headed **"Kyrgyzstan — which one?"** with
 * exactly one card on it, then asked to press "That is the one".
 *
 * The mechanism: a country always gets `administrative_area_needs_subset`
 * pushed, `isUnambiguous` requires the reason list to be *empty*, so a country
 * is by construction never unambiguous — and the flow read "not unambiguous" as
 * "ask which one".
 *
 * But "this is a whole country" is not a question about **which** place was
 * meant. It is a question about **how much of it** a trip covers, it has a
 * different screen, and it comes later. The set below is the line between the
 * two, and it is deliberately explicit rather than a negation, so that a new
 * reason has to be classified by whoever adds it.
 */
export const BREADTH_REASONS: readonly AmbiguityReason[] = [
  'administrative_area_needs_subset',
  'breadth_exceeds_trip_length',
  /*
   * A missing boundary is a *precision* problem, not an identity one. We know
   * which place they mean; we do not know where it stops. The scope screen says
   * so, and offering a which-one card for it asks a question with one answer.
   */
  'no_boundary_available',
];

/** Reasons that genuinely mean "we are not sure which place you meant". */
export function identityAmbiguityReasons(resolution: DestinationResolution): AmbiguityReason[] {
  return resolution.ambiguityReasons.filter((reason) => !BREADTH_REASONS.includes(reason));
}

export type InterpretationDecision =
  | { kind: 'not_a_place' }
  | { kind: 'no_match' }
  /** One credible reading. No screen, no click — the flow continues. */
  | { kind: 'single'; candidate: DestinationCandidate; breadthReasons: AmbiguityReason[] }
  /** Genuinely several. This is the only case that earns a disambiguation screen. */
  | { kind: 'choose'; candidates: DestinationCandidate[]; reasons: AmbiguityReason[] };

/**
 * What to do with a resolution, decided once.
 *
 * Deliberately more forgiving than `isUnambiguous`, which stays as it is because
 * other callers use it to mean "nothing at all is uncertain". This answers a
 * narrower question — *do we need to ask which place they meant* — and breadth
 * does not make that a yes.
 *
 * A leading candidate is adopted without a screen when it is the only one, or
 * when it is materially more confident than the alternatives. "Materially" is
 * the strict test: high confidence when nothing else reaches it. Two plausible
 * readings still go in front of a human, because the cost of asking is one
 * screen and the cost of guessing is a compiled region on the wrong continent.
 */
export function decideInterpretation(resolution: DestinationResolution): InterpretationDecision {
  if (resolution.ambiguityReasons.includes('query_is_not_a_place')) return { kind: 'not_a_place' };
  if (resolution.candidates.length === 0) return { kind: 'no_match' };

  const identity = identityAmbiguityReasons(resolution);
  const breadthReasons = resolution.ambiguityReasons.filter((reason) =>
    BREADTH_REASONS.includes(reason),
  );

  const leading = resolution.candidates[0];
  if (!leading) return { kind: 'no_match' };

  if (resolution.candidates.length === 1 && identity.length === 0) {
    return { kind: 'single', candidate: leading, breadthReasons };
  }

  const others = resolution.candidates.slice(1);
  const clearlyLeading =
    leading.confidence.level === 'high' &&
    others.every((candidate) => candidate.confidence.level === 'low');
  if (clearlyLeading && !identity.includes('providers_disagree')) {
    return { kind: 'single', candidate: leading, breadthReasons };
  }

  return { kind: 'choose', candidates: [...resolution.candidates], reasons: identity };
}

/**
 * Why a reading is uncertain, as a sentence somebody can act on.
 *
 * Replaces a bare `Not sure` badge, which told a traveller that we were unsure
 * and gave them nothing to do about it. Confidence is still shown; what changes
 * is that the *reason* leads and the label follows.
 */
export function confidenceExplanation(candidate: DestinationCandidate): string {
  if (candidate.confidence.note) return candidate.confidence.note;
  switch (candidate.confidence.level) {
    case 'high':
      return 'More than one source agrees on where this is.';
    case 'medium':
      return 'One source found this, and nothing contradicted it.';
    default:
      return 'Only one source found this, and it did not publish much about it.';
  }
}
