import {
  assessConfidence,
  breadthRank,
  GEOGRAPHIC_SCOPE_VERSION,
  singleAnswer,
  type ClarificationSet,
  type ConfidenceSignal,
  type DestinationCandidate,
  type GeographicScope,
  type ScopeShape,
  type TransportMode,
  type TravelerProfile,
} from '@sidequest/core';
import { QUESTION_IDS } from './clarify';

/**
 * Turning an interpretation plus a handful of answers into the ground a trip
 * covers.
 *
 * The output of this is the last cheap thing that happens. Everything after it
 * costs money, so it is shown to the traveller and confirmed before the
 * compiler runs — not because the derivation is likely to be wrong, but because
 * being wrong here is the one failure they cannot see afterwards.
 */

/**
 * How far a trip of this length can usefully reach, by how it gets around.
 *
 * Deliberately not one number. "Within 80 km" is a reasonable region for a car
 * and an absurd one for a city with a metro, where 15 km is a long day out and
 * where the interesting radius is measured in stops rather than kilometres.
 */
const RADIUS_KM_BY_MODE: Record<'drive' | 'transit' | 'walk', { perNight: number; cap: number }> = {
  drive: { perNight: 28, cap: 220 },
  transit: { perNight: 12, cap: 90 },
  walk: { perNight: 3, cap: 12 },
};

export interface ScopeInput {
  candidate: DestinationCandidate;
  clarifications: ClarificationSet;
  profile?: TravelerProfile;
  nights: number;
  /** Bumped by the caller whenever the traveller edits anything on this screen. */
  revision: number;
  /**
   * What the composer established before any of this ran.
   *
   * Read only where nothing stronger exists: a questionnaire profile always
   * wins, and a clarification answer wins over the composer, because both are
   * later and more specific. What this removes is the case where the traveller
   * said "I will drive" on the first screen and the scope was still built on
   * walking reach because nobody downstream had asked again.
   */
  composerTransport?: string;
  /**
   * The shape the traveller chose on the preflight screen.
   *
   * Read here rather than only through a clarification answer, because
   * suppressing a question the composer has already answered also removes the
   * answer — `rebuildClarificationSet` keeps answers only for questions that
   * survive, by design, so an answer whose question is gone is gone with it.
   *
   * A live run found this the hard way: choosing "two bases" produced a scope
   * with `maxBaseChanges: 0`, which then failed the country-from-one-base check
   * and left "Build the region" disabled with no explanation the traveller could
   * act on. The composer is the durable record; the clarification answer is a
   * refinement of it.
   */
  composerShape?: 'one_base' | 'two_bases' | 'circuit' | 'undecided';
}

/**
 * The shape of the ground, chosen from what we actually have.
 *
 * Bounds when the geocoder published them, because a real boundary beats an
 * assumed circle every time. A radius only when nobody published edges — and
 * when that happens the scope says so through its confidence signals rather
 * than presenting the circle as if it were a border.
 */
function deriveShape(
  candidate: DestinationCandidate,
  radiusKm: number,
  narrowed: boolean,
): ScopeShape {
  if (candidate.bounds && !narrowed) {
    /**
     * A published boundary, clipped to what the trip can actually reach.
     *
     * The boundary alone was the shape, and a live New York evaluation showed
     * what that costs: a four-night walking trip took the city's full
     * fifty-kilometre administrative boundary, the router refused two hundred
     * and seventy-two of three hundred and eighty walking legs across the
     * harbour, and the plan came out as whichever borough the base landed in.
     *
     * A city boundary is a fact about governance. What a traveller covers is a
     * fact about their transport and their nights. Where the two disagree by a
     * lot, the smaller one is the honest scope — and the intersection is still a
     * real boundary rather than a circle drawn over one.
     */
     const clipped = clipToReach(candidate.bounds, candidate.center, radiusKm);
     return { kind: 'bounds', bounds: clipped };
  }
  return { kind: 'radius', center: candidate.center, radiusKm };
}

/** Latitude degrees per kilometre. Longitude is scaled by the cosine. */
const KM_PER_DEGREE_LAT = 111;

function clipToReach(
  bounds: NonNullable<DestinationCandidate['bounds']>,
  center: { lat: number; lng: number },
  radiusKm: number,
): NonNullable<DestinationCandidate['bounds']> {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  const lngDelta =
    radiusKm / (KM_PER_DEGREE_LAT * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));

  return {
    southWest: {
      lat: Math.max(bounds.southWest.lat, center.lat - latDelta),
      lng: Math.max(bounds.southWest.lng, center.lng - lngDelta),
    },
    northEast: {
      lat: Math.min(bounds.northEast.lat, center.lat + latDelta),
      lng: Math.min(bounds.northEast.lng, center.lng + lngDelta),
    },
  };
}

function primaryModeFor(
  profile: TravelerProfile | undefined,
  carAnswer: string | undefined,
  composerTransport: string | undefined,
): { mode: TransportMode; carAvailable: boolean | null; basis: 'profile' | 'clarification' | 'default' } {
  if (profile) {
    return {
      mode: profile.transport.willDrive ? 'drive' : 'walk',
      carAvailable: profile.transport.willDrive,
      basis: 'profile',
    };
  }
  if (carAnswer === 'yes') return { mode: 'drive', carAvailable: true, basis: 'clarification' };
  if (carAnswer === 'no') return { mode: 'walk', carAvailable: false, basis: 'clarification' };
  if (composerTransport === 'drive' || composerTransport === 'mixed') {
    return { mode: 'drive', carAvailable: true, basis: 'clarification' };
  }
  if (composerTransport === 'public_transport') {
    return { mode: 'walk', carAvailable: false, basis: 'clarification' };
  }
  /**
   * Nobody has said, and that is a third state.
   *
   * `carAvailable: null` rather than `false`, because "we have not established
   * this" and "no car" produce different plans and different sentences. Walking
   * is the conservative *primary* mode — it never invents reach the traveller
   * may not have — but the null is what stops a later screen claiming they said
   * no.
   */
  return { mode: 'walk', carAvailable: null, basis: 'default' };
}

export function deriveScope(input: ScopeInput): GeographicScope {
  const { candidate, clarifications, profile, nights, revision } = input;

  const carAnswer = singleAnswer(clarifications, QUESTION_IDS.carAvailable);
  const { mode, carAvailable, basis } = primaryModeFor(profile, carAnswer, input.composerTransport);

  const breadthAnswer = singleAnswer(clarifications, QUESTION_IDS.breadthStrategy);
  const chosenShape = input.composerShape;
  /*
   * Narrowing to one area, from whichever source said so. The clarification
   * answer wins when there is one, because it is the later and more specific
   * statement; the composer's shape is the fallback rather than the exception.
   */
  const narrowed =
    breadthAnswer === 'one_area' ||
    breadthAnswer === 'name_it' ||
    (breadthAnswer === undefined && chosenShape === 'one_base');

  const baseAnswer = singleAnswer(clarifications, QUESTION_IDS.baseStrategy);
  const maxBaseChanges = narrowed
    ? 0
    : baseAnswer !== undefined && /^\d+$/.test(baseAnswer)
      ? Number(baseAnswer)
      : chosenShape === 'two_bases'
        ? 1
        : chosenShape === 'circuit'
          ? 2
          : 0;

  const waterAnswer = singleAnswer(clarifications, QUESTION_IDS.waterOrAir);
  const acceptsWaterOrAir =
    waterAnswer === undefined
      ? candidate.entityType === 'island' || candidate.entityType === 'archipelago'
        ? null
        : true
      : waterAnswer !== 'no';

  const reach = RADIUS_KM_BY_MODE[mode === 'drive' ? 'drive' : mode === 'walk' ? 'walk' : 'transit'];
  /**
   * A radius that grows with the trip, not with the destination.
   *
   * Four days does not reach two hundred kilometres however big the country is,
   * and stretching the scope to match the name is how a compiler spends its
   * whole budget on ground the traveller will never see.
   */
  const radiusKm = Math.min(reach.cap, Math.max(reach.perNight, reach.perNight * (nights + 1)));

  const allowedModes: TransportMode[] = carAvailable
    ? ['drive', 'walk', 'shuttle', 'public_bus', 'rail']
    : ['walk', 'public_bus', 'rail', 'shuttle', 'rideshare'];
  if (acceptsWaterOrAir !== false) allowedModes.push('ferry');

  const signals: ConfidenceSignal[] = [...candidate.confidence.signals];
  if (!signals.includes('user_confirmed')) signals.push('user_confirmed');

  const shape = deriveShape(candidate, radiusKm, narrowed);

  return {
    schemaVersion: GEOGRAPHIC_SCOPE_VERSION,
    revision,
    destinationCandidateId: candidate.id,
    destinationName: candidate.displayName,
    destinationEntityType: candidate.entityType,
    breadth: narrowed && breadthRank(candidate.breadth) > breadthRank('subregion')
      ? 'subregion'
      : candidate.breadth,
    center: candidate.center,
    /*
     * WHAT KIND OF EDGE THIS IS, RECORDED RATHER THAN INFERRED.
     *
     * `measured_extent` when the source published one, `reach_circle` when it
     * did not — which is very nearly always, because every city, town, county
     * and district in the destination index carries a centre and no polygon. A
     * consumer that needs a *border* can now tell that it has been handed a
     * circle, instead of discovering it by admitting a county 166 km away.
     */
    boundaryEvidence: (candidate.bounds && !narrowed ? 'measured_extent' : 'reach_circle') as
      | 'published_boundary'
      | 'measured_extent'
      | 'reach_circle',
    /*
     * The unclipped extent, kept beside the clipped shape.
     *
     * `deriveShape` intersects a published boundary with the trip's reach. That
     * is right for choosing what to compile and wrong for judging what belongs:
     * the clipped box is a subset of the boundary, so it can confirm membership
     * and can never refute it.
     */
    ...(candidate.bounds ? { administrativeBoundary: candidate.bounds } : {}),
    /*
     * Reach as its own number, because the shape can no longer be asked for it.
     */
    reachRadiusKm: radiusKm,
    /*
     * What the destination is, administratively — the evidence containment
     * actually uses, since geometry is usually unavailable. It has been on the
     * candidate all along and was simply never carried through.
     */
    administrative: {
      ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
      /*
       * The typed half. A code on both sides of a comparison is the only thing
       * that survives a catalogue publishing one name in English and another in
       * the local script — and the destination index has published this all
       * along while the scope layer wrote only the country and the flat
       * hierarchy.
       */
      ...(candidate.regionCode ? { regionCode: candidate.regionCode } : {}),
      /* Other spellings of *this entity*, compared only at its own level. */
      aliases: [...candidate.aliases],
      hierarchy: [...candidate.administrativeAreas],
      divisionIds: [],
    },
    /**
     * The scope's own bounds, never the geocoder's unclipped ones.
     *
     * These two disagreed, and everything downstream that reads `scope.bounds`
     * — the partitioner, the extractor, the discovery box — read the wider
     * answer while the shape said something narrower. One of them has to be the
     * scope, and it is the shape.
     */
    ...(shape.kind === 'bounds' ? { bounds: shape.bounds } : {}),
    ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
    /**
     * Every zone the interpretation spans, never collapsed to one. A region
     * straddling a boundary that gets one side's clock applied to both is how a
     * timetable moves by an hour.
     */
    timeZones: candidate.timeZones.length > 0 ? [...candidate.timeZones] : ['UTC'],
    shape,
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: mode,
      allowedModes,
      carAvailable,
      acceptsWaterOrAirTransfers: acceptsWaterOrAir,
      basis,
      note: describeTransport(mode, carAvailable),
    },
    maxBaseChanges,
    nights,
    rationale: describeScope(candidate, radiusKm, narrowed, maxBaseChanges),
    confidence: assessConfidence(signals),
    decidedBy: clarifications.answers.map((answer) => ({
      questionId: answer.questionId,
      values: [...answer.values],
    })),
    confirmedByUser: false,
  };
}

function describeTransport(mode: TransportMode, carAvailable: boolean | null): string {
  if (carAvailable === true) return 'Planned around a car, with transit and walking where they are better.';
  if (carAvailable === false) return 'Planned without a car: walking, public transport and transfers.';
  return 'We have not established whether you will have a car, so nothing here assumes one.';
}

function describeScope(
  candidate: DestinationCandidate,
  radiusKm: number,
  narrowed: boolean,
  maxBaseChanges: number,
): string {
  const reach = `about ${Math.round(radiusKm)} km out`;
  const bases =
    maxBaseChanges === 0
      ? 'from one base'
      : `across up to ${maxBaseChanges + 1} bases`;
  if (narrowed) {
    return `A single part of ${candidate.displayName}, ${reach}, ${bases}.`;
  }
  return `${candidate.qualifiedName}, ${reach}, ${bases}.`;
}

/**
 * Whether the confirmed scope is something a trip of this length can hold.
 *
 * Run before any money is spent, and reported rather than silently corrected —
 * shrinking a traveller's destination without telling them is worse than saying
 * it does not fit.
 */
export function scopeFitsTrip(scope: GeographicScope): { fits: boolean; reason?: string } {
  if (breadthRank(scope.breadth) >= breadthRank('country') && scope.maxBaseChanges === 0) {
    return {
      fits: false,
      reason:
        'A whole country from a single base means most days are spent getting somewhere. Either name a part of it, or allow a hotel change.',
    };
  }
  if (scope.nights < 2 && scope.maxBaseChanges > 0) {
    return {
      fits: false,
      reason: 'There is not enough time to change hotel on a trip this short.',
    };
  }
  return { fits: true };
}
