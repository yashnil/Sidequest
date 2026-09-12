import 'server-only';
import { createHash } from 'node:crypto';
import { itineraryStructureFingerprint, type BookedPlanItem, type BookingResolution, type Itinerary, type TravelIntelligence, type TravelReadinessProfile, type TravelerProfile, type Trip } from '@sidequest/core';
import { getProfile } from '@/lib/db/repository';
import { profileWithPartyDiet } from '@/lib/db/party-repository';
import { getIntent } from '@/lib/db/compiler-repository';
import { getDraftHints, getFxRate, getReadinessProfile, getTravelIntelligence, listBookedItems, listChecks, saveTravelIntelligence, type CheckList } from '@/lib/db/intelligence-repository';
import { defaultProfileFor } from '@/lib/planning/default-profile';
import { applyBookedFacts, type BookedAffectedScope } from './booked-reconcile';
import { listBookingResolutions } from '@/lib/db/execution-repository';
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
  /** V9 §5 — which days and bases the booked facts reached, and what was not re-measured. */
  affected: BookedAffectedScope;
  resolutions: BookingResolution[];
  checks: Record<CheckList, string[]>;
  readinessProfile: TravelReadinessProfile | null;
}

/**
 * V9.1 §2 — WHAT "PUBLIC" MEANS, STATED ONCE.
 *
 * Three projections, applied before `buildTravelIntelligence` sees anything,
 * so the personal sentence is never composed rather than composed and then
 * hunted for.
 */

/** A booked fact keeps only what shapes the plan: its kind, title, place and dates. */
function publicBookedFact(fact: BookedPlanItem): BookedPlanItem {
  const { confirmationRef: _ref, notes: _notes, cost: _cost, url: _url, paid: _paid, refundable: _refundable, bookingItemId: _need, replaces: _replaces, source: _source, ...rest } = fact;
  void _ref;
  void _notes;
  void _cost;
  void _url;
  void _paid;
  void _refundable;
  void _need;
  void _replaces;
  void _source;
  return rest as BookedPlanItem;
}

/**
 * A profile keeps the trip's shape and loses the people.
 *
 * Pace, budget style, interests and detour tolerance describe the trip and are
 * why the shared plan reads as a plan rather than a list. Dietary needs and
 * the traveller's own words about food, mobility limits and accessibility
 * notes describe a person, and each of them is a source of a sentence naming
 * that person's body or beliefs. `dietaryStrict` goes with them: a hard rule
 * is the loudest of those sentences.
 */
function publicProfile<P extends TravelerProfile>(profile: P): P {
  return {
    ...profile,
    food: { ...profile.food, dietaryNeeds: [], dietaryStrict: false, notes: undefined },
    accessibility: { mobilityLimited: false, notes: undefined },
  };
}

/** A share carries no tick list: every one of them is the owner's own record of what they have done. */
function emptyChecks(): Record<CheckList, string[]> {
  return { packing: [], checklist: [], preflight: [] };
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
  /**
   * V9.1 §2 — WHO THIS SNAPSHOT IS BEING BUILT FOR.
   *
   * `'owner'` (the default, and every product surface) builds from everything
   * the traveller has told Sidequest. `'public'` builds the same trip without
   * the inputs that can *generate* personal advisory prose, and is what a
   * read-only share gets.
   *
   * This is a boundary, not a filter. Entry, visa, health and advisory
   * sentences are composed at build time from the readiness profile and the
   * party — "Sidequest has not independently verified whether a NZ passport
   * holder needs a visa" is written once and then copied into the readiness
   * packet, the checklist, the regret list, the source registry and, through
   * them, the state graph and Preflight. No strip run afterwards can take a
   * nationality back out of a sentence, and one that tried by matching words
   * would be a sanitiser with a bypass waiting in it. Withholding the inputs
   * means the sentence is never written, which is the only version of this
   * that is actually true.
   *
   * What stays: the itinerary, the route, the days, the stays, the food and
   * lodging reasoning, the weather, the budget bands, and the preparation that
   * follows from the destination rather than from the traveller.
   */
  audience?: 'owner' | 'public';
}): LoadedIntelligence {
  const now = input.now ?? new Date();
  const trip = input.trip;
  const isPublic = input.audience === 'public';
  const ownerBooked = listBookedItems(trip.id);
  /* A booked fact's existence shapes the plan; its reference, cost, notes and link are the owner's. */
  const booked = isPublic ? ownerBooked.map(publicBookedFact) : ownerBooked;
  const resolutions = isPublic ? [] : listBookingResolutions(trip.id);
  const applied = applyBookedFacts(input.itinerary, booked);
  const intent = getIntent(trip.id);
  const composer = intent?.composer ?? null;
  const ownerProfile = profileWithPartyDiet(getProfile(trip.id) ?? defaultProfileFor(trip, composer), trip.id);
  const profile = isPublic ? publicProfile(ownerProfile) : ownerProfile;
  const readinessProfile = isPublic ? null : getReadinessProfile(trip.id);
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
    .update(JSON.stringify(resolutions))
    .update(JSON.stringify(readinessProfile ?? null))
    .update(JSON.stringify(profile.interview))
    .update(profile.budgetStyle)
    .update(userPlaces.join('|'))
    .update(JSON.stringify(getFxRate(trip.id)))
    .digest('hex')
    .slice(0, 32);

  /*
   * A public build never reads or writes the owner's snapshot: that row was
   * built from the private inputs, and the whole point here is not to have
   * them. It is rebuilt per view, which the measurements put at about five
   * milliseconds.
   */
  const stored = isPublic ? null : getTravelIntelligence(trip.id);
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
      resolutions,
    });
    /*
     * The fingerprint stored is the inputs hash, not the bare itinerary
     * fingerprint, so a new booking or a readiness profile invalidates the
     * snapshot exactly as a regenerated plan does.
     */
    intelligence = { ...intelligence, itineraryFingerprint: inputsHash };
    if (input.persist !== false && !isPublic) saveTravelIntelligence(intelligence);
  }
  return { itinerary: applied.itinerary, intelligence, booked, honored: applied.honored, conflicts: applied.conflicts, affected: applied.affected, resolutions, checks: isPublic ? emptyChecks() : listChecks(trip.id), readinessProfile };
}
