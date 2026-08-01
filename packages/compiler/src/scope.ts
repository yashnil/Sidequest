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
    return { kind: 'bounds', bounds: candidate.bounds };
  }
  return { kind: 'radius', center: candidate.center, radiusKm };
}

function primaryModeFor(
  profile: TravelerProfile | undefined,
  carAnswer: string | undefined,
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
  const { mode, carAvailable, basis } = primaryModeFor(profile, carAnswer);

  const breadthAnswer = singleAnswer(clarifications, QUESTION_IDS.breadthStrategy);
  const narrowed = breadthAnswer === 'one_area' || breadthAnswer === 'name_it';

  const baseAnswer = singleAnswer(clarifications, QUESTION_IDS.baseStrategy);
  const maxBaseChanges =
    breadthAnswer === 'one_area'
      ? 0
      : baseAnswer !== undefined && /^\d+$/.test(baseAnswer)
        ? Number(baseAnswer)
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
    ...(candidate.bounds && !narrowed ? { bounds: candidate.bounds } : {}),
    ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
    /**
     * Every zone the interpretation spans, never collapsed to one. A region
     * straddling a boundary that gets one side's clock applied to both is how a
     * timetable moves by an hour.
     */
    timeZones: candidate.timeZones.length > 0 ? [...candidate.timeZones] : ['UTC'],
    shape: deriveShape(candidate, radiusKm, narrowed),
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
