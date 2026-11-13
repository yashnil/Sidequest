import { chooseJourneyArchetype, type DiscoveryCandidate, type JourneyChoice, type TravelerProfile, type TripComposerAnswers, type TripQualityContract } from '@sidequest/core';
import { qualityContractFor } from './quality-contract';

/**
 * The trip-quality contract and the journey archetype, from one set of inputs,
 * for both the scan (which chooses the beds) and the build (which writes the
 * plan) — so the structure the stays were chosen for is the structure the plan
 * is written in. Pure; no provider, no model.
 */
export interface JourneyContext {
  destinationPhrase: string;
  composer: TripComposerAnswers | null;
  profile: TravelerProfile;
  semanticType?: string | null;
  scale?: string | null;
  namedParts: readonly string[];
  tripDays: number;
  carAvailable: boolean;
  maxDailyTravelMinutes: number | null;
  mustDos: readonly string[];
  avoidances: readonly string[];
  board?: readonly DiscoveryCandidate[];
}

export function journeyFor(context: JourneyContext): { contract: TripQualityContract; journey: JourneyChoice } {
  const contract = qualityContractFor({ ...context, board: context.board ?? [] });
  const journey = chooseJourneyArchetype({ contract, semanticType: context.semanticType ?? null, scale: context.scale ?? null, tripDays: context.tripDays, carAvailable: context.carAvailable });
  return { contract, journey };
}

/**
 * The hotel-change cap the stays are chosen within: the archetype's range, with
 * the traveller's own explicit answer winning wherever it is lower.
 */
export function strategicBaseChanges(journey: JourneyChoice, traveller: { value: number | null; explicit: boolean }): number {
  const strategy = journey.strategy;
  if (traveller.explicit && traveller.value !== null) return Math.min(traveller.value, strategy.maxBaseChanges);
  return Math.max(strategy.minBaseChanges, Math.min(strategy.maxBaseChanges, Math.max(traveller.value ?? 1, strategy.minBaseChanges)));
}
