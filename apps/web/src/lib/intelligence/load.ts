import 'server-only';
import { createHash } from 'node:crypto';
import { itineraryStructureFingerprint, type BookedPlanItem, type Itinerary, type TravelIntelligence, type TravelReadinessProfile, type Trip } from '@sidequest/core';
import { getProfile } from '@/lib/db/repository';
import { getIntent } from '@/lib/db/compiler-repository';
import { getDraftHints, getFxRate, getReadinessProfile, getTravelIntelligence, listBookedItems, listChecks, saveTravelIntelligence, type CheckList } from '@/lib/db/intelligence-repository';
import { defaultProfileFor } from '@/lib/planning/default-profile';
import { applyBookedFacts } from './booked-reconcile';
import { buildTravelIntelligence, INTELLIGENCE_RULES_VERSION } from './build';

/**
 * THE INTELLIGENCE FOR A TRIP, FROM WHAT IS ON DISK.
 *
 * Booked facts are applied to the canonical itinerary at load time — the
 * planner's own result stays pristine in `itineraries`, and the traveller's
 * bookings are a layer over it that can be added, edited and removed without
 * ever regenerating. The snapshot is reused while nothing it was built from
 * has changed, so `builtAt` keeps meaning "when these facts were read".
 */
export interface LoadedIntelligence {
  itinerary: Itinerary;
  intelligence: TravelIntelligence;
  booked: BookedPlanItem[];
  honored: string[];
  conflicts: string[];
  checks: Record<CheckList, string[]>;
  readinessProfile: TravelReadinessProfile | null;
}

export function loadTripIntelligence(input: {
  trip: Trip;
  itinerary: Itinerary;
  timeZone?: string;
  /** The compiled scope's country, used when no destination resolution was persisted for the trip. */
  countryCode?: string;
  sourcedAreas?: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[];
  worthSkipping?: readonly { name: string; reason: string }[];
  now?: Date;
  persist?: boolean;
}): LoadedIntelligence {
  const now = input.now ?? new Date();
  const trip = input.trip;
  const booked = listBookedItems(trip.id);
  const applied = applyBookedFacts(input.itinerary, booked);
  const intent = getIntent(trip.id);
  const composer = intent?.composer ?? null;
  const profile = getProfile(trip.id) ?? defaultProfileFor(trip, composer);
  const readinessProfile = getReadinessProfile(trip.id);
  const draft = getDraftHints(trip.id);
  const candidate = intent?.resolution?.candidates.find((c) => c.id === (intent.selectedCandidateId ?? intent.resolution?.unambiguousCandidateId)) ?? intent?.resolution?.candidates[0] ?? null;
  const userPlaces = [...(composer?.mustDo ? composer.mustDo.split(/\n|,|;/).map((s) => s.trim()).filter((s) => s.length > 1) : []), ...profile.interview.mustInclude];

  const inputsHash = createHash('sha256')
    /*
     * The rules that will read these inputs are part of the key. A fix to a
     * derivation is not an input and does not move the itinerary, so without
     * this a corrected rule never reaches a trip that was already built.
     */
    .update(INTELLIGENCE_RULES_VERSION)
    .update(itineraryStructureFingerprint(applied.itinerary))
    .update(JSON.stringify(booked))
    .update(JSON.stringify(readinessProfile ?? null))
    .update(JSON.stringify(profile.interview))
    .update(profile.budgetStyle)
    .update(userPlaces.join('|'))
    .update(JSON.stringify(getFxRate(trip.id)))
    .digest('hex')
    .slice(0, 32);

  const stored = getTravelIntelligence(trip.id);
  let intelligence: TravelIntelligence;
  if (stored && stored.itineraryFingerprint === inputsHash) {
    intelligence = stored;
  } else {
    intelligence = buildTravelIntelligence({
      tripId: trip.id,
      itinerary: applied.itinerary,
      draft,
      profile,
      basics: trip.basics,
      destination: {
        name: candidate?.displayName ?? trip.basics.destinationInput,
        ...(candidate?.countryCode ?? input.countryCode ? { countryCode: candidate?.countryCode ?? input.countryCode } : {}),
        ...(input.timeZone ?? candidate?.timeZones?.[0] ? { timeZone: input.timeZone ?? candidate?.timeZones?.[0] } : {}),
      },
      composer,
      booked,
      readinessProfile,
      sourcedAreas: input.sourcedAreas ?? [],
      worthSkipping: input.worthSkipping ?? [],
      userPlaces,
      bookedHonored: applied.honored,
      bookedConflicts: applied.conflicts,
      now,
      fx: getFxRate(trip.id),
    });
    /*
     * The fingerprint stored is the inputs hash, not the bare itinerary
     * fingerprint, so a new booking or a readiness profile invalidates the
     * snapshot exactly as a regenerated plan does.
     */
    intelligence = { ...intelligence, itineraryFingerprint: inputsHash };
    if (input.persist !== false) saveTravelIntelligence(intelligence);
  }
  return { itinerary: applied.itinerary, intelligence, booked, honored: applied.honored, conflicts: applied.conflicts, checks: listChecks(trip.id), readinessProfile };
}
