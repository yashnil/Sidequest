import {
  assessConfidence,
  breadthRank,
  GEOGRAPHIC_SCOPE_VERSION,
  reachClassFor,
  resolveTimeZones,
  singleAnswer,
  type ClarificationSet,
  type ConfidenceSignal,
  type DestinationCandidate,
  type GeographicScope,
  type ScopeBreadth,
  type ScopeShape,
  type TransportMode,
  type TravelerProfile,
} from '@sidequest/core';
import { QUESTION_IDS } from './clarify';
import { ADAPTIVE_QUESTION_IDS } from './adaptive';

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
  /**
   * The reach the preflight structure implies, in kilometres.
   *
   * The hand-off that keeps the regional preview and the compilation describing
   * the same trip. See the note beside `radiusKm` below for why it wins, and
   * why it is still clamped.
   */
  preflightReachKm?: number;
  /**
   * Whether anything configured can measure a public-transport journey.
   *
   * Defaults to false. Passed in rather than read here because the compiler
   * package has no business knowing which adapters a deployment configured —
   * that is what the capability registry is for, and it lives one layer up.
   */
  transitMeasurable?: boolean;
}

/**
 * The shape of the ground, chosen from what we actually have.
 *
 * Bounds when the geocoder published them, because a real boundary beats an
 * assumed circle every time. A radius only when nobody published edges — and
 * when that happens the scope says so through its confidence signals rather
 * than presenting the circle as if it were a border.
 */
/**
 * Destination breadths that are a *container of parts* rather than one place.
 *
 * The distinction this list draws is the whole of the fix below. A city is one
 * settlement: clipping it to what a traveller can cross leaves you inside the
 * same place, which is what the New York evaluation wanted. A country, an island
 * group or a region is a set of constituent parts, and clipping *that* to a
 * traveller's reach does not narrow the destination — it deletes members of it.
 */
const MULTI_PART_BREADTHS: readonly ScopeBreadth[] = ['subregion', 'region', 'country', 'multi_country'];

function deriveShape(
  candidate: DestinationCandidate,
  radiusKm: number,
  narrowed: boolean,
): ScopeShape {
  if (candidate.bounds && !narrowed) {
    /**
     * A published boundary, clipped to what the trip can actually reach —
     * but only where clipping narrows a place rather than dismembering one.
     *
     * The boundary alone was the shape, and a live New York evaluation showed
     * what that costs: a four-night walking trip took the city's full
     * fifty-kilometre administrative boundary, the router refused two hundred
     * and seventy-two of three hundred and eighty walking legs across the
     * harbour, and the plan came out as whichever borough the base landed in.
     *
     * Then the opposite failure arrived, from the same line. A traveller who
     * simply did not want to drive asked for a two-island country. Not driving
     * selects the walking reach; the walking reach caps at twelve kilometres;
     * and twelve kilometres around the centroid of an archipelago is one island.
     * The second island was outside the compiled shape before a single record
     * was read, and nothing anywhere said so — the trip was quietly redefined
     * to the part of the destination the traveller could walk across.
     *
     * Those two are not the same operation wearing different numbers. Clipping a
     * *city* answers "which part of this place will you actually cover", and the
     * answer is a fact about transport and nights. Clipping a *country* answers
     * "which of these places still counts as your destination", and that is not
     * a question a walking speed is entitled to answer.
     *
     * So: settlements clip, containers do not. A traveller's reach still
     * constrains everything it legitimately constrains — `reachRadiusKm` travels
     * on the scope, base selection reads it, and the planner's per-day travel
     * caps are unchanged — but it no longer decides what the destination *is*.
     * A country whose parts a walker cannot cross becomes a readiness and
     * transport problem, stated, rather than a smaller country, unstated.
     */
    if (MULTI_PART_BREADTHS.includes(candidate.breadth)) {
      return { kind: 'bounds', bounds: candidate.bounds };
    }
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

/**
 * HOW FAR A TRAVELLER GOES IS NOT THE SAME QUESTION AS WHAT THEY TRAVEL BY.
 *
 * `TransportMode` is a vocabulary of things that move — `drive`, `walk`, `rail`,
 * `ferry`. A *reach class* is how much ground a day of that costs, and there are
 * only three of them. Collapsing the two is what produced the defect this split
 * exists to remove: a traveller who said "public transport" was assigned
 * `primaryMode: 'walk'`, which selected the walking radius, which capped their
 * destination at twelve kilometres — while the preview screen beside it had
 * already used a forty-kilometre transit reach for the same answer.
 *
 * `primaryMode` stays conservative and stays honest: we may not claim rail
 * service exists before anything has measured it, and `unmeasurableModesFor`
 * turns that gap into a named readiness deficit rather than a silent assumption.
 * What changes is that a stated intention to use public transport now decides
 * how far the trip reaches, because that is a fact about the traveller rather
 * than a claim about a network.
 */
type ReachClass = 'drive' | 'transit' | 'walk';

function primaryModeFor(
  profile: TravelerProfile | undefined,
  carAnswer: string | undefined,
  composerTransport: string | undefined,
  transitMeasurable: boolean,
): {
  mode: TransportMode;
  reachClass: ReachClass;
  carAvailable: boolean | null;
  basis: 'profile' | 'clarification' | 'default';
} {
  /*
   * TWO QUESTIONS, ANSWERED FROM DIFFERENT SOURCES.
   *
   * "Will you have a car" and "how will you get around without one" are not the
   * same question, and the precedence rules are not the same either. The car
   * question has a dedicated clarification and a profile field, and the later,
   * more specific one wins. The *reach* question is only ever answered by the
   * composer's transport choice or by the profile's shuttle tolerance — the car
   * clarification says nothing about it.
   *
   * Resolving both in one cascade is what broke: answering the car question
   * `no` short-circuited before the composer's explicit "on foot" was read, so
   * a walker and a metro traveller got the same ground.
   */
  const carAvailable: boolean | null = profile
    ? profile.transport.willDrive
    : carAnswer === 'yes'
      ? true
      : carAnswer === 'no'
        ? false
        : composerTransport === 'drive' || composerTransport === 'mixed'
          ? true
          : composerTransport === 'public_transport' || composerTransport === 'walk'
            ? false
            : null;

  const basis: 'profile' | 'clarification' | 'default' = profile
    ? 'profile'
    : carAnswer !== undefined || composerTransport !== undefined
      ? 'clarification'
      : 'default';

  if (carAvailable === true) {
    return { mode: 'drive', reachClass: 'drive', carAvailable, basis };
  }

  /*
   * Without a car, how far a day reaches depends on whether scheduled transport
   * is on the table. The profile states it outright; the composer's "on foot"
   * states the opposite outright; a bare "no car" is read as transit, because
   * `allowedModes` below has always granted rail, bus and shuttle to a car-free
   * traveller and a reach that contradicted that was the inconsistency.
   *
   * `primaryMode` stays `walk` throughout. We may not claim a rail network
   * exists before anything has measured one — `unmeasurableModesFor` turns that
   * gap into a named readiness deficit instead.
   */
  const reachClass: ReachClass = reachClassFor({
    carAvailable,
    acceptsScheduled: profile ? profile.transport.willUseShuttles : composerTransport === 'walk' ? false : null,
    transitMeasurable,
  });

  /**
   * `carAvailable: null` rather than `false` when nobody has said, because "we
   * have not established this" and "no car" produce different plans and
   * different sentences. Walking reach is the conservative default — it never
   * invents reach the traveller may not have — but the null is what stops a
   * later screen claiming they said no.
   */
  return { mode: 'walk', reachClass, carAvailable, basis };
}

export function deriveScope(input: ScopeInput): GeographicScope {
  const { candidate, clarifications, profile, nights, revision } = input;

  const carAnswer = singleAnswer(clarifications, QUESTION_IDS.carAvailable);
  const { mode, reachClass, carAvailable, basis } = primaryModeFor(
    profile,
    carAnswer,
    input.composerTransport,
    /*
     * False unless a caller says otherwise, and every caller today leaves it
     * so — no transit provider exists. See `reachClassFor` for why widening a
     * car-free traveller's reach without one made the plan *less* truthful.
     */
    input.transitMeasurable ?? false,
  );

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
  /**
   * WHAT AN ADAPTIVE ANSWER ACTUALLY CHANGES.
   *
   * The worst thing an adaptive question can be is one nothing reads. It costs
   * the traveller a decision, promises a consequence in `planChangeByAnswer`,
   * and then the plan comes out the same — which is worse than not asking,
   * because it teaches them their answers do not matter.
   *
   * `adaptive.hotel-switch-tolerance` is asked only when the region genuinely
   * offers two bases two hours or more apart and nobody has said which they
   * want. This is where the answer lands: `move` allows one hotel change,
   * `stay` forbids any, and `either` — the working "decide for me" — leaves the
   * derived answer alone so the structure decides on travel logic.
   */
  const moveAnswer = singleAnswer(clarifications, ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance);
  const maxBaseChanges = narrowed
    ? 0
    : moveAnswer === 'stay'
      ? 0
      : moveAnswer === 'move'
        ? Math.max(1, baseAnswer !== undefined && /^\d+$/.test(baseAnswer) ? Number(baseAnswer) : 1)
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

  const reach = RADIUS_KM_BY_MODE[reachClass];
  /**
   * A radius that grows with the trip, not with the destination.
   *
   * Four days does not reach two hundred kilometres however big the country is,
   * and stretching the scope to match the name is how a compiler spends its
   * whole budget on ground the traveller will never see.
   */
  const derivedRadiusKm = Math.min(
    reach.cap,
    Math.max(reach.perNight, reach.perNight * (nights + 1)),
  );

  /**
   * THE REACH THE TRAVELLER WAS ALREADY SHOWN WINS.
   *
   * The preflight screen draws a structure — these bases, those day trips, this
   * much left out — and publishes the reach that structure implies. Deriving a
   * *second* number from a table here is how one screen came to propose bases a
   * hundred kilometres apart while the next described the same build as a dozen
   * kilometres across.
   *
   * Clamped rather than trusted: a preflight is a cheap estimate over index
   * records, and a runaway one must not be able to buy an arbitrarily large
   * compilation. The ceiling is the reach class's own cap, which is the same
   * bound the derived figure obeys.
   *
   * Absent — an older trip, or a destination with no index coverage — falls
   * back to the derived radius exactly as before.
   */
  /*
   * NARROWING IGNORES THE PREVIEW ENTIRELY.
   *
   * The preview's reach describes the structure it drew. A traveller who has
   * since said "just one area of this" has replaced that structure, and
   * adopting its reach anyway produced the absurdity that **choosing narrow
   * made the compiled circle bigger** — because `narrowed` also switches
   * `deriveShape` to a radius, so a multi-base preview's 300 km became a 300 km
   * circle around one centre.
   */
  const fromPreflight =
    !narrowed && input.preflightReachKm !== undefined && input.preflightReachKm > 0
      ? Math.min(reach.cap, Math.max(derivedRadiusKm, Math.round(input.preflightReachKm)))
      : derivedRadiusKm;

  /**
   * The other adaptive answer that has to land somewhere.
   *
   * `adaptive.extend-reach` is asked only when the structure dropped an area
   * for reach — close enough that a change of mind would admit it. Saying
   * "make room for it" has to widen the ground, or the question was theatre.
   *
   * A single step rather than an open-ended widening, and still clamped by the
   * reach class's own cap: the traveller is agreeing to one longer travel day,
   * not to a different trip.
   */
  const reachAnswer = singleAnswer(clarifications, ADAPTIVE_QUESTION_IDS.extendReach);
  const radiusKm =
    reachAnswer === 'include'
      ? Math.min(reach.cap, Math.round(fromPreflight * 1.5))
      : fromPreflight;

  const allowedModes: TransportMode[] = carAvailable
    ? ['drive', 'walk', 'shuttle', 'public_bus', 'rail']
    : ['walk', 'public_bus', 'rail', 'shuttle', 'rideshare'];
  if (acceptsWaterOrAir !== false) allowedModes.push('ferry');

  const signals: ConfidenceSignal[] = [...candidate.confidence.signals];
  if (!signals.includes('user_confirmed')) signals.push('user_confirmed');

  const shape = deriveShape(candidate, radiusKm, narrowed);
  /*
   * A resolver-supplied source promotes the same zones from "published" to
   * "provider_resolved", which is the difference between a value that travelled
   * with a record and one a civil-timezone source answered for this coordinate.
   * Both are authoritative; only the second can be re-asked.
   */
  const zones = resolveTimeZones({
    published: candidate.timeZones,
    center: candidate.center,
    ...(candidate.timeZoneSource && candidate.timeZones.length > 0
      ? {
          resolved: {
            zones: candidate.timeZones,
            source: candidate.timeZoneSource,
            resolvedAt: candidate.timeZoneResolvedAt ?? '',
          },
        }
      : {}),
  });

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
    /**
     * NO FABRICATED ZONE.
     *
     * This used to fall back to `['UTC']` when the resolver published none, and
     * that is a claim rather than a default: every consumer downstream reads
     * `timeZones[0]` and formats hours, daylight and forecast day-boundaries
     * with it. A museum in a destination nine hours off UTC then opened at
     * midnight, and nothing anywhere said the zone had been invented.
     *
     * `resolveTimeZones` prefers what the resolver published and otherwise
     * derives one from the destination's own longitude — a deterministic
     * measurement rather than a guess, within half an hour of local solar noon
     * by construction — and reports which it did, so a consumer that needs a
     * *political* zone can tell it has been handed a solar one.
     */
    timeZones: zones.zones,
    timeZoneBasis: zones.basis,
    ...(zones.source ? { timeZoneSource: zones.source } : {}),
    ...(zones.resolvedAt ? { timeZoneResolvedAt: zones.resolvedAt } : {}),
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
