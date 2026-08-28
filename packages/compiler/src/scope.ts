import {
  assessConfidence,
  breadthRank,
  DAY_REACH_KM,
  TRANSFER_SPEED_KMH,
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
   * THE PART THE PREFLIGHT STRUCTURE CHOSE, FOR WHEN THE TRAVELLER NARROWS.
   *
   * "One area, in depth" replaces a container with a part, and a part has to be
   * *somewhere*. This input is the answer to which somewhere: the first base of
   * the preflight portfolio's route — the settlement the structure already
   * chose, showed the traveller, and wrote a reason for.
   *
   * A live car-free country trip found what its absence costs. The traveller
   * accepted "one area, in depth"; the preflight had chosen the capital as the
   * one base, seven nights, "the densest part of the region"; and `deriveScope`,
   * with no parameter to receive any of that, centred the narrowed radius on
   * `candidate.center` — the country's geometric centroid, two hundred
   * kilometres away in uninhabited highland. The compiled board held seven
   * glacial streams and no food, and the readiness system could only say so
   * after the compile was spent.
   *
   * Absent when no preflight ran or its portfolio found nowhere to base a trip
   * from. A narrowed *container* without this cannot say which part it means,
   * and `scopeFitsTrip` refuses it before any money is spent rather than
   * compiling a circle around a centroid.
   */
  preflightAnchor?: { id: string; name: string; center: { lat: number; lng: number } };
  /**
   * Whether anything configured can measure a public-transport journey.
   *
   * Defaults to false. Passed in rather than read here because the compiler
   * package has no business knowing which adapters a deployment configured —
   * that is what the capability registry is for, and it lives one layer up.
   */
  transitMeasurable?: boolean;
  /**
   * Every catalogue identifier the destination is published under.
   *
   * The candidate carries the one identifier the traveller's own selection was
   * minted from, and `divisionIdentityFor` below reads it without being told.
   * This exists for the case that identifier alone cannot express: a catalogue
   * that publishes the same place **twice**, at two administrative levels, where
   * the reading the index happened to pick is not the reading every other record
   * in the destination refers to.
   *
   * Resolved by the caller because resolving it needs the destination index, and
   * this package has no database. Unioned rather than preferred — the candidate's
   * own identifier is a fact about what the traveller chose and is never dropped.
   */
  divisionIds?: readonly string[];
}

/**
 * THE IDENTITY OF THE DIVISION THE DESTINATION **IS**, THREADED NOT REDERIVED.
 *
 * This used to be a hardcoded empty array, and the cost was measured on a stored
 * Tokyo pack: the scope reached the compiler knowing its country and its ISO
 * 3166-2 code and nothing that could be compared against a record's *parent
 * chain*, so the trip-scope overlay had to rediscover the destination by looking
 * its centre back up in a divisions layer that a retention budget had already
 * capped to 320 leaf neighbourhoods. It failed. 3,767 of 3,787 records came back
 * `membership_unknown`, all 56 attractions were demoted out of the anchor slot,
 * and a board for a world city said "64 things to do, 0 of which could hold a
 * morning".
 *
 * The answer was never missing. The traveller picked a row out of a place index,
 * that row *is* a catalogue division record, and its identifier travelled all the
 * way here on `providerRefs` while this line wrote `[]`.
 *
 * Which reference counts as the destination's own catalogue record is not
 * guessed and not hardcoded to a catalogue name: it is the one that reconstructs
 * the candidate's own id, since a candidate minted from an index row is
 * identified as `<catalog>:<sourceId>` by construction. A candidate that came
 * from a geocoder instead reconstructs nothing, contributes nothing, and is left
 * exactly as it was — an OSM element id compared against a chain of catalogue
 * identifiers would be an identity claim that can never be true.
 */
function divisionIdentityFor(
  candidate: DestinationCandidate,
  supplied: readonly string[] | undefined,
): string[] {
  const catalogue = candidate.providerRefs.find(
    (ref) => `${ref.provider}:${ref.externalId}` === candidate.id,
  )?.provider;
  const own = catalogue
    ? candidate.providerRefs
        .filter((ref) => ref.provider === catalogue)
        .map((ref) => ref.externalId)
    : [];
  return [...new Set([...own, ...(supplied ?? [])])];
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

/**
 * A destination that is a set of parts rather than one place, on this trip.
 *
 * `narrowed` is half the test and not a detail: a traveller who has said "just
 * one area of this" has replaced the container with a part, and a part is a
 * place — reach may size it exactly as it sizes a city.
 */
function isContainer(candidate: DestinationCandidate, narrowed: boolean): boolean {
  return !narrowed && MULTI_PART_BREADTHS.includes(candidate.breadth);
}

/**
 * Whether a published extent is larger than a trip could cover at all.
 *
 * Half the diagonal against the reach, so the comparison is "could one base sit
 * inside this and touch its edges" rather than "is the box wide". Degrees to
 * kilometres is enough for a size question — nothing here is a travel time, and
 * a boundary this far out of scale is not a borderline call.
 */
function exceedsAnyReach(
  bounds: DestinationCandidate['bounds'],
  unconstrainedRadiusKm: number,
): boolean {
  if (!bounds) return false;
  const latKm = (bounds.northEast.lat - bounds.southWest.lat) * KM_PER_DEGREE_LAT;
  const midLat = (bounds.northEast.lat + bounds.southWest.lat) / 2;
  const lngKm =
    (bounds.northEast.lng - bounds.southWest.lng) *
    KM_PER_DEGREE_LAT *
    Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
  const halfDiagonalKm = Math.sqrt(latKm * latKm + lngKm * lngKm) / 2;
  return halfDiagonalKm > unconstrainedRadiusKm;
}

function deriveShape(
  candidate: DestinationCandidate,
  radiusKm: number,
  /**
   * The ground this trip could cover if getting about were not the constraint.
   *
   * Read only for a container with no published edges. See the note below the
   * bounds branch for why a walking speed may not decide what a destination is.
   */
  unconstrainedRadiusKm: number,
  narrowed: boolean,
  /** The named part a narrowing resolves to. See `ScopeInput.preflightAnchor`. */
  part: { id: string; name: string; center: { lat: number; lng: number } } | undefined,
): ScopeShape {
  if (narrowed) {
    /**
     * NARROWING IS AN ANSWER TO "WHICH PART", NOT ONLY TO "HOW MUCH".
     *
     * This branch used to be one line at the bottom — the traveller's reach as
     * a radius around `candidate.center` — and for a container that centre is
     * the geometric centroid, which is a fact about a bounding box and not a
     * place anybody chose. A car-free country trip compiled twelve kilometres
     * of uninhabited highland that way while the preflight's chosen capital sat
     * unread in the stored portfolio. §12.1 bans the result in as many words:
     * a country may not be clipped to a city-sized walk radius.
     *
     * So the part leads, when one is resolved. The area is centred on it, and —
     * the same defect with a car, from the same line — the ground is kept
     * inside the destination's own published edges: a six-night drive radius
     * turned "a single part" of a city into 168 km of neighbouring prefectures
     * because nothing intersected the narrowed radius with anything.
     */
    if (part) {
      if (candidate.bounds) {
        return { kind: 'bounds', bounds: clipToReach(candidate.bounds, part.center, radiusKm) };
      }
      return { kind: 'radius', center: part.center, radiusKm };
    }
    /**
     * Narrowed, and nothing resolved which part.
     *
     * For a container that is an unanswerable state rather than a small trip:
     * the only centre on offer is the centroid, and a circle there is the
     * banned shape. The container's own ground stands — exactly what the
     * un-narrowed branches below derive — and the breadth stays undemoted, so
     * `scopeFitsTrip` refuses the confirm before a compile is bought instead
     * of a readiness deficit arriving after one.
     */
    if (MULTI_PART_BREADTHS.includes(candidate.breadth)) {
      if (candidate.bounds) {
        return { kind: 'bounds', bounds: candidate.bounds };
      }
      return {
        kind: 'radius',
        center: candidate.center,
        radiusKm: Math.max(radiusKm, unconstrainedRadiusKm),
      };
    }
    /**
     * A narrowed settlement is one place either way: reach narrows it around
     * its own centre, inside its own edges when anybody published them.
     */
    if (candidate.bounds) {
      return { kind: 'bounds', bounds: clipToReach(candidate.bounds, candidate.center, radiusKm) };
    }
    return { kind: 'radius', center: candidate.center, radiusKm };
  }
  if (candidate.bounds) {
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
    if (isContainer(candidate, narrowed)) {
      return { kind: 'bounds', bounds: candidate.bounds };
    }
    const clipped = clipToReach(candidate.bounds, candidate.center, radiusKm);
    return { kind: 'bounds', bounds: clipped };
  }
  /**
   * THE SAME RULE WHERE NOBODY PUBLISHED EDGES, WHICH IS VERY NEARLY ALWAYS.
   *
   * The guard above shipped inside the bounds branch, and measured against the
   * live destination index it could not run for the destinations it was written
   * for. **38,909 of 38,909 counties carry no bounds**, as do 53,542 of 53,542
   * towns, 12,080 of 12,080 cities and every district; and `county`, `island`,
   * `national_park` and `protected_area` all resolve to breadth `subregion` —
   * the first entry in `MULTI_PART_BREADTHS`. So a traveller who picked an
   * island group or a national park out of the suggestion list reached this
   * line, not the one above it, and their destination became a circle whose
   * radius is a *walking* speed multiplied by their nights: twelve kilometres.
   *
   * That is the archipelago failure the guard was written to stop, arriving
   * through the other branch. The second island is outside the compiled ground
   * before a record is read, nothing says so, and §12.1 forbids it in as many
   * words — "an island group losing an island before research starts", "a
   * transit destination being treated as a walking-only circle".
   *
   * So the container rule is stated once and applies to both shapes: a
   * traveller's reach narrows a *place* and never decides what a *set of places*
   * is. With edges, the edges stand unclipped. Without them, the circle is sized
   * by the trip — the same nights-times-reach arithmetic, taken at the widest
   * reach class rather than at this traveller's — so a car-free archipelago
   * compiles the same ground a driven one does.
   *
   * `Math.max` rather than a replacement, because a preflight structure or an
   * accepted "make room for it" may already have asked for more, and this exists
   * to stop reach *shrinking* a container, never to cap it.
   *
   * What does not change is the traveller: `reachRadiusKm` still carries their
   * real reach, base selection still reads it, the daily travel caps are
   * untouched, and `boundaryEvidence` still says `reach_circle` so no consumer
   * can mistake this for a border. A container a walker cannot cross stays a
   * transport problem, stated — not a smaller container, unstated.
   */
  return {
    kind: 'radius',
    center: candidate.center,
    radiusKm: isContainer(candidate, narrowed)
      ? Math.max(radiusKm, unconstrainedRadiusKm)
      : radiusKm,
  };
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
  const radiusForTrip = (band: { perNight: number; cap: number }): number =>
    Math.min(band.cap, Math.max(band.perNight, band.perNight * (nights + 1)));
  const derivedRadiusKm = radiusForTrip(reach);
  /**
   * The same arithmetic with the mode taken out of it.
   *
   * Used only by `deriveShape`, and only for a destination that is a set of
   * parts. It is still "a radius that grows with the trip, not with the
   * destination" — the same nights, the same table — asked at the widest reach
   * class, which is the honest answer to "how much of this could a trip of this
   * length be about" once how the traveller gets around is no longer allowed to
   * answer what the destination is.
   */
  const unconstrainedRadiusKm = radiusForTrip(RADIUS_KM_BY_MODE.drive);

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
   * NARROWING ALSO CHANGES WHAT THE RADIUS *MEANS*.
   *
   * The nights-times-reach table above answers "how much ground can a trip of
   * this length cover moving across parts". A traveller who chose one area from
   * one base is not moving across parts: their trip is day trips out and back,
   * and a day's ground is the day reach — the same figure the preflight's own
   * clustering uses. Without this, six driven nights made "a single part" of a
   * city 168 km across, which is not a part of anything.
   *
   * `Math.min`, because a short trip's own arithmetic may already be smaller
   * and narrowing must never widen anything.
   */
  /**
   * A DAY'S GROUND IS THE TRAVELLER'S OWN, WHERE THEY STATED IT.
   *
   * `DAY_REACH_KM` is the table's generic day — and for a driving traveller
   * narrowing a *container* destination to one base, the generic day quietly
   * overruled their own answer: a seven-night car trip anchored on a country's
   * capital was clipped to the 70 km constant while the standard day-trip
   * circuit for exactly that shape of trip sits beyond it, so the compiled
   * pack excluded half the destination's canonical ground and the recall
   * instrument's denominator shrank with it. Their questionnaire already
   * says how long they will drive in a day: half of it outbound at the
   * transfer speed the region model itself uses is the radius their own
   * answer implies. Clamped by the mode's cap so a generous answer cannot buy
   * an unbounded compilation, floored at the table's constant so a cautious
   * answer keeps today's ground, and applied only where the destination is a
   * container of parts — a traveller narrowing a *city* is not asking for its
   * hinterland, however far they would drive.
   */
  const statedDayReachKm =
    reachClass === 'drive' &&
    MULTI_PART_BREADTHS.includes(candidate.breadth) &&
    input.profile !== undefined
      ? Math.min(
          reach.cap,
          Math.max(
            DAY_REACH_KM[reachClass],
            Math.round(
              ((input.profile.transport.maxDailyDriveMinutes / 2) / 60) *
                TRANSFER_SPEED_KMH[reachClass],
            ),
          ),
        )
      : DAY_REACH_KM[reachClass];
  const narrowedFromPreflight = narrowed
    ? Math.min(fromPreflight, statedDayReachKm)
    : fromPreflight;

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
      ? Math.min(reach.cap, Math.round(narrowedFromPreflight * 1.5))
      : narrowedFromPreflight;

  const allowedModes: TransportMode[] = carAvailable
    ? ['drive', 'walk', 'shuttle', 'public_bus', 'rail']
    : ['walk', 'public_bus', 'rail', 'shuttle', 'rideshare'];
  if (acceptsWaterOrAir !== false) allowedModes.push('ferry');

  const signals: ConfidenceSignal[] = [...candidate.confidence.signals];
  if (!signals.includes('user_confirmed')) signals.push('user_confirmed');

  /**
   * The part a narrowing resolves to — read only when narrowing, because the
   * preflight's first base is a fact about the structure the traveller was
   * shown, and an un-narrowed trip is built on the whole of it.
   */
  const part = narrowed ? input.preflightAnchor : undefined;

  const shape = deriveShape(candidate, radiusKm, unconstrainedRadiusKm, narrowed, part);
  /*
   * The one branch of `deriveShape` that keeps ground the trip cannot reach:
   * narrowed, container-sized, nothing resolved which part — **and the ground
   * it kept is bigger than this trip could cover even unconstrained**.
   *
   * That last clause is not a hedge, it is the whole discriminator. Narrowing
   * with no part is only a *problem* when the container is far larger than the
   * area it was supposed to be narrowed to: for a metropolis that administers
   * islands a thousand kilometres out, "one area" is a promise the derivation
   * could not keep. For an ordinary subregion whose whole extent is already
   * inside a day's reach, the container *is* the one area and there is nothing
   * to narrow — refusing there would turn a working trip into a dead end over a
   * distinction the traveller cannot see. Measured: the first version of this
   * rule refused a small fixture subregion and disabled "Build the region" on
   * it, which is precisely the trap it was written to prevent.
   *
   * `unconstrainedRadiusKm` is the right ceiling because it is already "the
   * ground this trip could cover if getting about were not the constraint" —
   * so this asks whether the shape is beyond *any* reading of this trip's
   * reach, rather than beyond the mode the traveller happened to choose.
   */
  const narrowedWithoutPart =
    narrowed &&
    !part &&
    MULTI_PART_BREADTHS.includes(candidate.breadth) &&
    exceedsAnyReach(candidate.bounds, unconstrainedRadiusKm);
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
    /*
     * Demoted only when the narrowing actually *resolved* to a part. A country
     * narrowed to a named settlement is a subregion trip; a country narrowed to
     * nothing in particular is still a country, and leaving it one is what lets
     * `scopeFitsTrip`'s country-from-one-base rule refuse the confirm — the
     * demotion used to defeat that guard, and the centroid circle it waved
     * through cost a real compile before anything said a word.
     */
    breadth: narrowed && part !== undefined && breadthRank(candidate.breadth) > breadthRank('subregion')
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
    /*
     * Read off the shape rather than re-deriving the branch: a narrowed area
     * clipped inside a published extent is the same operation as a city clipped
     * to reach, and calling it a circle would make containment throw away the
     * one boundary it could have used.
     */
    boundaryEvidence: (shape.kind === 'bounds' ? 'measured_extent' : 'reach_circle') as
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
    ...(narrowedWithoutPart ? { narrowedWithoutPart: true } : {}),
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
      /*
       * The identifiers, which are the only half of this that a record's parent
       * chain can be compared against. See `divisionIdentityFor`.
       */
      divisionIds: divisionIdentityFor(candidate, input.divisionIds),
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
    /**
     * The resolved part, kept on the scope by name.
     *
     * This is what stops "one area" being anonymous downstream: the confirm
     * screen can name it, and it sits in the fingerprint's `in:` segment, so a
     * different chosen part can never silently reuse this part's artifact.
     */
    includedAreas: part
      ? [
          {
            id: part.id,
            name: part.name,
            center: part.center,
            note: `The part of ${candidate.displayName} this trip settles into.`,
          },
        ]
      : [],
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
    rationale: describeScope(candidate, radiusKm, narrowed, maxBaseChanges, part?.name),
    derivedFromProfile: input.profile !== undefined,
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
  partName?: string,
): string {
  const reach = `about ${Math.round(radiusKm)} km out`;
  const bases =
    maxBaseChanges === 0
      ? 'from one base'
      : `across up to ${maxBaseChanges + 1} bases`;
  if (narrowed) {
    /*
     * Named, never anonymous. "A single part of" a country told a traveller
     * nothing they could check; "the capital and around" is a sentence they
     * can refuse. The anonymous wording survives only for the unresolved case,
     * which `scopeFitsTrip` refuses to confirm anyway.
     */
    if (partName) {
      return `${partName} and around — one part of ${candidate.displayName}, ${reach}, ${bases}.`;
    }
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
  /**
   * "One area" over a destination whose parts we could not name.
   *
   * First, because it is the refusal that stops the widest ground from being
   * confirmed as the narrowest. The traveller asked for one part; the shape is
   * the whole container, and the rationale beside it says twelve kilometres.
   * Confirming that buys a compilation of everything the container administers
   * — for Tokyo, four Pacific island groups up to 1,225 km from the base the
   * same screen proposed, none of which routes against anything.
   *
   * The sentence names the two ways out, both of which work: naming the part
   * gives the narrowing something to centre on, and allowing a hotel change
   * makes the wider ground an honest circuit rather than a mislabelled day trip.
   */
  if (scope.narrowedWithoutPart) {
    return {
      fits: false,
      reason:
        'We could not work out which part of this you meant, so "one area" would end up covering the whole of it. Either name the part you have in mind, or allow a hotel change and we will build a route across it.',
    };
  }
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
