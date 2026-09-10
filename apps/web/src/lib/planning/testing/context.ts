import { buildCanonicalTripBuildInput, compositionTimingBriefOf } from '../canonical-input';
import { travelerBriefFor, defaultProfileFor } from '../production-plan';
import type { BoardSignals, CompositionContext, DestinationEnvelope } from '../composition';
import type { TravelerProfile, Trip, TripComposerAnswers } from '@sidequest/core';

/**
 * ONE COMPOSITION CONTEXT FOR TESTS, BUILT THE WAY PRODUCTION BUILDS IT.
 *
 * PRODUCTION LOCK V5. Before this, each test assembled a context by hand from a
 * `BenchmarkTripRequest` — which meant a dozen tests asserted things about a
 * shape the product no longer uses, and none of them would have noticed the
 * production assembler changing underneath them. This helper calls exactly the
 * two functions `generateSidequestPlanForTrip` calls, so a test that passes here
 * is a test about the real path.
 */
export function testCompositionContext(input: {
  trip: Trip;
  profile?: TravelerProfile;
  composer?: TripComposerAnswers | null;
  envelope: DestinationEnvelope;
  boardSignals?: BoardSignals;
  bookedFacts?: readonly string[];
  mode?: 'full' | 'quick';
  now?: Date;
}): CompositionContext {
  const now = input.now ?? new Date('2026-08-01T00:00:00.000Z');
  const composer = input.composer ?? null;
  const profile = input.profile ?? defaultProfileFor(input.trip, composer);
  const canonical = buildCanonicalTripBuildInput({ trip: input.trip, composer, profile, ...(input.bookedFacts ? { bookedFacts: input.bookedFacts } : {}), now });
  const brief = travelerBriefFor({ input: canonical, envelope: input.envelope, ...(input.boardSignals ? { boardSignals: input.boardSignals } : {}) });
  return {
    brief,
    envelope: input.envelope,
    mode: input.mode ?? 'full',
    ...(input.boardSignals ? { boardSignals: input.boardSignals } : {}),
    ...(input.bookedFacts && input.bookedFacts.length > 0 ? { bookedFacts: input.bookedFacts } : {}),
    timing: compositionTimingBriefOf(canonical.timing, now),
    planningFacts: { carAvailable: canonical.movement.carAvailable, desiredBaseCount: canonical.movement.desiredBaseCount.value ?? 1, budgetBand: profile.budgetStyle },
  };
}
