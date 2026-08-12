import type { PlaceAccessAssessment } from '../access/feasibility';
import type { OperatingAssessment } from '../hours/availability';
import type { AccessDataset } from '../schemas/access';
import type { Interest, InterestLevel } from '../schemas/common';
import { INSIDE_RELATIONSHIPS } from '../schemas/containment';
import type { OperatingHoursDataset } from '../schemas/hours';
import type { WeatherDataset } from '../schemas/weather';
import { assessPlaceWeather, type PlaceWeatherAssessment } from '../weather/board';
import type { BoardGroup } from '../schemas/discovery';
import { BOARD_GROUPS } from '../schemas/discovery';
import type { Place } from '../schemas/place';
import type { TravelerProfile } from '../schemas/profile';
import type { Region, WorthDetourLabel } from '../schemas/region';
import type { TransportMode } from '../schemas/access';
import type { TravelTimeMatrix } from '@sidequest/geo';
import type { TransitEvidence } from '../schemas/compiled-region';
import {
  detourToleranceMinutesFor,
  travelKnowledgeFor,
  type ReachFromBase,
} from '../travel/reach';
import type { TravelerNeed } from '../schemas/trip';
import { isVisitableRole, PLANNING_ROLES, type PlanningRole } from '../schemas/region-pack';
import type { PlaceCategory } from '../schemas/common';
import {
  expandRegion,
  worthDetourLabel,
  type DetourClass,
  type RegionExpansion,
} from '../region/expansion';
import type { SeasonAssessment } from '../region/season';
import {
  calibrateBandDistribution,
  scorePlace,
  type BlockerCode,
  type FitAssessment,
} from '../scoring/fit';
import { assessCandidateQuality, type CandidateOutcome, type QualityAssessment } from '../quality/candidate';
import { evidenceFor, type PlaceEvidence, type RegionEvidence } from '../schemas/evidence';

export interface DiscoveryCandidate {
  place: Place;
  fit: FitAssessment;
  /**
   * What official sources said about this one, where anything was researched.
   *
   * Optional and frequently absent, which is the honest state for a region
   * compiled before the research funnel existed or for a candidate the funnel
   * could not afford. A card reads the absence as "we did not look", never as
   * "there is nothing to know".
   */
  evidence?: PlaceEvidence;
  /** Evidence-driven quality, and the sentence that explains the verdict. */
  quality: QualityAssessment;
  detourClass: DetourClass;
  /**
   * ONE-WAY TIME FROM THE BASE, IN THE MODE THAT WOULD ACTUALLY BE USED.
   *
   * `null` when nothing usable was measured — never a zero, which the board has
   * shipped before and which reads on a card as "no journey at all".
   *
   * This replaces `driveMinutes`, which was never a driving figure on a
   * car-free trip: it came off `place.travelFromBase.driveMinutes`, filled by
   * the compiler from whichever single mode the region's matrix happened to be.
   * The card labelled it with the matrix's mode, so the *word* was usually
   * right; the *journey* was a walk where the traveller would have taken a
   * train, and every scorer downstream treated the walk's length as the
   * distance to the place.
   */
  travelMinutesFromBase: number | null;
  /** The mode that figure is in. `null` alongside an unresolved journey. */
  travelModeFromBase: TransportMode | null;
  /**
   * The shared reach relationship, carried whole.
   *
   * The card, the scorer, the auto-selector and the planner all read this one
   * object, which is what makes "the board and the planner agree" a structural
   * property rather than a coincidence two modules maintain by hand.
   */
  reach: ReachFromBase;
  /** Road distance, where the journey puts kilometres on a vehicle. */
  distanceKm: number | null;
  season: SeasonAssessment;
  /** Date-aware transport feasibility, shown on the card and read by the planner. */
  access: PlaceAccessAssessment;
  /** Date-aware opening hours. A separate question from whether you can get there. */
  operating: OperatingAssessment;
  /**
   * What the weather over the trip's dates says about this place — a forecast
   * where there is one, the seasonal pattern where there is not, and plainly
   * nothing where neither could be had.
   */
  weather: PlaceWeatherAssessment;
  worthDetour: WorthDetourLabel;
  group: BoardGroup;
}

// ---------------------------------------------------------------------------
// What a card is allowed to be
// ---------------------------------------------------------------------------

/**
 * THE PLANNING ROLE, CARRIED ON THE PLACE ITSELF.
 *
 * A live compilation put an international airport, a driver-for-hire and two
 * tour operators on a discovery board. The classification was right at every
 * step — the taxonomy calls an airport a gateway and the pack schema already
 * says which roles a traveller chooses between — and the board had no way to
 * ask, because a `Place` records what *kind* of thing it is and not what part
 * it plays in a trip. An airport and a market town are both `town_and_food`.
 *
 * So the role travels as a tag, written once where the record becomes a place
 * and read wherever a card is built. A tag rather than a field because it is
 * the one channel that already survives every artifact boundary the place
 * crosses — serialisation, storage, the compiled region, the provisional board
 * — without a migration, and because a place that predates the convention
 * carries no tag and is therefore *unknown* rather than silently claimed.
 *
 * The prefixes use a colon; the source-category tag the inventory writes uses
 * `=`, and the quality layer's `classifyingTagValue` reads only `=`. The two
 * conventions are deliberately unable to collide.
 */
export const PLACE_ROLE_TAG_PREFIX = 'role:';

/** Why a place outside the destination is here at all. */
export const PLACE_INCLUSION_TAG_PREFIX = 'included:';

export function placeRoleTag(role: PlanningRole): string {
  return `${PLACE_ROLE_TAG_PREFIX}${role}`;
}

/**
 * THE PART A PLACE PLAYS, WORKED OUT FROM WHAT KIND OF THING IT IS.
 *
 * The pack path derives a role from the source record's own catalogue category
 * and stamps it (`backbone/inventory.ts`). Records that arrive by *acquisition*
 * never went through that, so they reached the board carrying no role at all —
 * and every count derived from roles was structurally unable to see them. The
 * funnel then reported a breakdown of three beside a total of eleven.
 *
 * This is the rule for those records, and it lives here — beside `placeRoleTag`,
 * in the package both the live provider and the fixture provider import — so
 * that the two paths cannot answer it differently. They did: the first attempt
 * at this fix was written into the fixture only, which made the test assert a
 * property of the fake while production shipped the inconsistency untouched.
 *
 * A category is weaker evidence than a catalogue classification, and the mapping
 * is deliberately conservative: everything a traveller goes somewhere *for* is
 * an attraction or an outdoor, and nothing here ever produces `support`,
 * `gateway` or `excluded`. A supply deficit only ever asks for the visitable
 * kinds, so a car park is not something this path can be handed.
 */
export function planningRoleForCategory(category: PlaceCategory): PlanningRole {
  switch (category) {
    case 'day_hike':
    case 'easy_walk':
    case 'lake':
    case 'wildlife_area':
    case 'hot_spring':
    case 'geothermal':
    case 'scenic_drive':
      return 'outdoor';
    default:
      return 'attraction';
  }
}

export function placeInclusionTag(reason: string): string {
  return `${PLACE_INCLUSION_TAG_PREFIX}${reason}`;
}

function taggedValue(tags: readonly string[], prefix: string): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      const value = tag.slice(prefix.length).trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * The planning role a place carries, or `undefined` when it carries none.
 *
 * The `undefined` is load-bearing and must never be defaulted to a role. "We do
 * not know what part this plays" and "this is an attraction" are different
 * claims, and collapsing them is the whole defect in miniature.
 */
export function planningRoleOfPlace(place: { tags: readonly string[] }): PlanningRole | undefined {
  const value = taggedValue(place.tags, PLACE_ROLE_TAG_PREFIX);
  return value && (PLANNING_ROLES as readonly string[]).includes(value)
    ? (value as PlanningRole)
    : undefined;
}

export function inclusionReasonOfPlace(place: { tags: readonly string[] }): string | undefined {
  return taggedValue(place.tags, PLACE_INCLUSION_TAG_PREFIX);
}

/** Why a place was kept off the board. Never a fit judgement — those are groups. */
export const BOARD_REFUSALS = [
  /** A gateway, a practical stop, a hotel: real, useful, not something to do. */
  'utility_role',
  /**
   * Outside the destination and admitted only as a way in or out.
   *
   * The board is what a traveller chooses between; a terminal one division over
   * is how they arrive. Its inclusion reason says so, and the board honours it.
   */
  'gateway_only',
] as const;
export type BoardRefusal = (typeof BOARD_REFUSALS)[number];

export interface BoardAdmission {
  place: Place;
  admitted: boolean;
  role?: PlanningRole;
  refusal?: BoardRefusal;
}

/**
 * Whether a place may be a card, from the role it carries.
 *
 * Deliberately permissive about *absence* and strict about *presence*: a place
 * with no role tag is admitted, because refusing them would empty the board for
 * every region authored or compiled before the convention and would be a
 * regression dressed as a fix. A place whose role is known and is not visitable
 * is refused, and that refusal is the invariant.
 */
export function admitToBoard(place: Place): BoardAdmission {
  const role = planningRoleOfPlace(place);
  if (inclusionReasonOfPlace(place) === 'adjacent_gateway') {
    return { place, admitted: false, ...(role ? { role } : {}), refusal: 'gateway_only' };
  }
  if (role && !isVisitableRole(role)) {
    return { place, admitted: false, role, refusal: 'utility_role' };
  }
  return { place, admitted: true, ...(role ? { role } : {}) };
}

/**
 * What the board refused, and what it could not check.
 *
 * Reported rather than silent for the same reason the balancer reports its cap:
 * a gate that costs something and says nothing is indistinguishable from a bug,
 * and this one is the difference between a short board and a dishonest one.
 */
export interface BoardIntegrity {
  /** Places offered to the board. */
  offered: number;
  /** Cards it produced. Never larger than `offered`. */
  admitted: number;
  /** Refused, by reason, in the declared order. */
  refused: { refusal: BoardRefusal; count: number }[];
  /** Admitted while carrying no role at all. The pre-convention population. */
  roleUnknown: number;
  /** Admitted from outside the destination, each with a stated reason. */
  external: { reason: string; count: number }[];
  /**
   * True when every admitted card carries a role and that role is visitable.
   *
   * The invariant, as a boolean, so a test and a diagnostic read the same rule.
   */
  everyCardHasEligibleRole: boolean;
}

export function partitionBoardPlaces(places: readonly Place[]): {
  admitted: Place[];
  integrity: BoardIntegrity;
} {
  const admissions = places.map(admitToBoard);
  const admitted = admissions.filter((entry) => entry.admitted).map((entry) => entry.place);

  const refusedCounts = new Map<BoardRefusal, number>();
  for (const entry of admissions) {
    if (entry.refusal) refusedCounts.set(entry.refusal, (refusedCounts.get(entry.refusal) ?? 0) + 1);
  }

  const externalCounts = new Map<string, number>();
  let roleUnknown = 0;
  for (const entry of admissions) {
    if (!entry.admitted) continue;
    if (!entry.role) roleUnknown += 1;
    const reason = inclusionReasonOfPlace(entry.place);
    /*
     * Every inside relationship, from the one contract that declares them.
     *
     * Two of the three used to be named here as literals, which meant
     * `inside_selected_region` — the relationship a *region* trip admits its own
     * ground under — was counted as an external inclusion and reported to a
     * traveller as somewhere outside their destination. A list that has to be
     * kept in step with an eight-value enum by hand is a list that will drift;
     * reading it is the only version that cannot.
     */
    if (reason && !(INSIDE_RELATIONSHIPS as readonly string[]).includes(reason)) {
      externalCounts.set(reason, (externalCounts.get(reason) ?? 0) + 1);
    }
  }

  return {
    admitted,
    integrity: {
      offered: places.length,
      admitted: admitted.length,
      refused: BOARD_REFUSALS.filter((refusal) => refusedCounts.has(refusal)).map((refusal) => ({
        refusal,
        count: refusedCounts.get(refusal)!,
      })),
      roleUnknown,
      external: [...externalCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      everyCardHasEligibleRole: admissions.every(
        (entry) => !entry.admitted || (entry.role !== undefined && isVisitableRole(entry.role)),
      ),
    },
  };
}

export interface DiscoveryBoard {
  expansion: RegionExpansion;
  candidates: DiscoveryCandidate[];
  groups: { group: BoardGroup; candidates: DiscoveryCandidate[] }[];
  /**
   * What the role gate did, so board size can be read as supply.
   *
   * A board of six that can say "and eleven were transport and services" is a
   * different product from a board of six.
   */
  integrity: BoardIntegrity;
}

export interface BuildBoardInput {
  region: Region;
  places: Place[];
  profile: TravelerProfile;
  months: number[];
  dates: string[];
  access: AccessDataset;
  hours: OperatingHoursDataset;
  /**
   * Optional, and the omission is meaningful rather than lazy: a board built
   * without it says nothing about weather anywhere, which is the honest result
   * when no forecast could be reached.
   */
  weather?: WeatherDataset;
  /** Resolved official evidence, where the region carries any. */
  evidence?: RegionEvidence;
  travelerNeeds: TravelerNeed[];
  /**
   * THE MEASURED TRAVEL THIS BOARD IS ALLOWED TO REASON FROM.
   *
   * Required. The board's whole failure mode was that this was *available* at
   * the call site and not passed: `apps/web/src/lib/region.ts` held the matrix,
   * the transit evidence and the base id in one scope and handed
   * `buildDiscoveryBoard` none of them, so the board fell back to a scalar with
   * no mode on it while the planner, two clicks later, used the real evidence.
   *
   * `transit` stays beside the matrix and is never folded into it: a matrix has
   * one mode, and a transit answer is a property of two points *and an instant*.
   * Absent transit is the ordinary case and means "no timetables were bought",
   * which is a different claim from "there is no public transport here".
   */
  travel: {
    matrix: TravelTimeMatrix;
    transit?: TransitEvidence | null;
    /** The primary base. Every candidate resolves from here on a one-base trip. */
    baseId: string;
    /** Every base the trip sleeps at, for a multi-base trip. See `ExpansionInput`. */
    baseIds?: readonly string[];
  };
}

export function buildDiscoveryBoard(input: BuildBoardInput): DiscoveryBoard {
  const {
    region,
    places,
    profile,
    months,
    dates,
    access,
    hours,
    weather,
    evidence,
    travelerNeeds,
    travel,
  } = input;

  /*
   * Built once, here, from the same constructor the planner uses. The board does
   * not decide which modes this traveller may board and does not read a
   * timetable; it asks, and everything below reads the answer.
   */
  const knowledge = travelKnowledgeFor(travel.matrix, profile, travel.transit);

  /*
   * The role gate runs before the expansion, not after.
   *
   * `expandRegion` produces the distances, the detour classes and the satellite
   * counts a traveller reads as "how much is here". Filtering afterwards would
   * leave every one of those numbers counting an airport, so the board would
   * describe a region it does not show.
   */
  const { admitted, integrity } = partitionBoardPlaces(places);
  const expansion = expandRegion({
    region,
    places: admitted,
    profile,
    months,
    dates,
    access,
    hours,
    travel: {
      knowledge,
      baseId: travel.baseId,
      ...(travel.baseIds ? { baseIds: travel.baseIds } : {}),
    },
  });

  /*
   * `unmeasured` sits in this list beside the rest. A journey nobody could
   * route is still a place a traveller may want, and hiding it would turn a gap
   * in our evidence into a gap in the destination — the same conflation
   * `DetourClass.unknown` exists to end. Its card says the journey is unverified
   * and its quality assessment stops short of a distance verdict.
   */
  const assessments = [
    ...expansion.base,
    ...expansion.satellites,
    ...expansion.beyondRadius,
    ...expansion.unmeasured,
  ]
    /*
     * Re-sorted by journey, not left in class order. The expansion sorted
     * nearest-first for a reason this concatenation was silently defeating:
     * category saturation is counted in iteration order, so with the classes
     * concatenated, five unreachable museums were counted *before* the one
     * eight minutes away — and an unroutable place was always counted last,
     * taking a full saturation penalty on top of its honest unknown.
     */
    .sort(
      (a, b) =>
        (a.travelMinutesFromBase ?? Number.POSITIVE_INFINITY) -
          (b.travelMinutesFromBase ?? Number.POSITIVE_INFINITY) ||
        a.place.id.localeCompare(b.place.id),
    );

  /**
   * Category saturation is counted over the whole board rather than per group,
   * so the tenth viewpoint is demoted whichever section it would have landed in.
   */
  const categoryCounts = new Map<string, number>();

  /*
   * Scored first, then *calibrated as a population*, then built into cards.
   *
   * The order matters: the label distribution guard (§9.1) demotes the
   * lowest-scoring members of an over-subscribed top band, and everything a
   * card derives from its band — its group, its detour label — has to read the
   * calibrated band, not the raw one. A board where every card says "Top pick"
   * is a board with no top picks.
   */
  const rawFits = assessments.map((assessment) => scorePlace(assessment, { profile, travelerNeeds }));
  const calibrated = calibrateBandDistribution(rawFits);

  const candidates: DiscoveryCandidate[] = assessments
    .map((assessment, index) => {
      const fit = calibrated[index]!;
      const placeEvidence = evidenceFor(evidence, assessment.place.id);
      const seen = categoryCounts.get(assessment.place.category) ?? 0;
      categoryCounts.set(assessment.place.category, seen + 1);
      const quality = assessCandidateQuality({
        place: assessment.place,
        ...(placeEvidence ? { evidence: placeEvidence } : {}),
        /*
         * `fit.score` is 0-100 and this parameter is documented 0-1. The two
         * have disagreed since the quality layer landed, which made every
         * `fitScore` branch inside `decideOutcome` a constant: `fitScore < 0.35`
         * could not fire and the two `>= 0.5`-style gates always did. Normalised
         * here, at the one call site, so the thresholds the quality layer states
         * are the thresholds it applies.
         */
        fitScore: fit.score / 100,
        /*
         * The journey in the mode the traveller would make it in, against the
         * tolerance for that mode. Both halves matter: passing a walk's length
         * against a driving radius is how a transit-reachable place became
         * `not_worth_detour`, which the board files under "weak fit" and
         * auto-pick refuses outright.
         *
         * An unresolved journey passes no minutes at all. The quality layer
         * treats that as "no distance verdict available" rather than as a zero,
         * because a zero would make every unroutable place look adjacent.
         */
        ...(assessment.travelMinutesFromBase === null
          ? {}
          : { detourMinutes: assessment.travelMinutesFromBase }),
        ...(assessment.travelModeFromBase === null
          ? {}
          : { detourMode: assessment.travelModeFromBase }),
        categoryCount: seen,
        supersededByParent: placeEvidence?.parentSubjectId !== undefined,
        duplicate: false,
        usableOnTripDates:
          assessment.season.status !== 'closed' && assessment.operating.status !== 'closed_throughout',
        openingUncertain: assessment.operating.badges.includes('hours_unknown'),
        detourToleranceMinutes: detourToleranceMinutesFor(
          profile,
          assessment.travelModeFromBase ?? 'drive',
        ),
      });
      return {
        place: assessment.place,
        fit,
        ...(placeEvidence ? { evidence: placeEvidence } : {}),
        quality,
        detourClass: assessment.detourClass,
        travelMinutesFromBase: assessment.travelMinutesFromBase,
        travelModeFromBase: assessment.travelModeFromBase,
        reach: assessment.reach,
        distanceKm: assessment.distanceKm,
        season: assessment.season,
        access: assessment.access,
        operating: assessment.operating,
        weather: assessPlaceWeather({
          place: assessment.place,
          dataset: weather,
          dates,
          avoidances: profile.avoidances,
          daylightOnly: assessment.operating.daylightOnly,
        }),
        worthDetour: worthDetourLabel(assessment.detourClass, fit.band),
        group: groupFor(assessment.place, fit.band, quality.outcome, assessment.detourClass),
      };
    })
    // Anything you cannot actually do sorts below everything you can, however
    // well it scored on paper. Then highest fit first, with id as a stable
    // tiebreak so the board never reshuffles between renders.
    .sort(
      (a, b) =>
        Number(a.fit.band === 'not_workable') - Number(b.fit.band === 'not_workable') ||
        b.fit.score - a.fit.score ||
        a.place.id.localeCompare(b.place.id),
    );

  const groups = BOARD_GROUPS.map((group) => ({
    group,
    candidates: candidates.filter((candidate) => candidate.group === group),
  })).filter((entry) => entry.candidates.length > 0);

  return { expansion, candidates, groups, integrity };
}

/**
 * Each candidate lands in exactly one group. The order of these checks is the
 * priority: a weak fit is called out as such no matter how famous it is, and a
 * genuine hidden gem is never buried under the classics.
 */
function groupFor(
  place: Place,
  band: FitAssessment['band'],
  outcome: CandidateOutcome,
  /**
   * How far out this is *for this traveller*, in the mode they would make the
   * journey in. Read by the two groups whose headings talk about distance.
   */
  detourClass: DetourClass,
): BoardGroup {
  if (band === 'not_workable' || band === 'weak') return 'weak_fit';
  /**
   * Evidence outcomes that override the fit-based grouping, and only these two.
   *
   * Everything else the quality layer decides is already expressible as fit or
   * as a badge; these two are not, because they are statements about *our*
   * knowledge rather than about the place, and a traveller acts on them
   * differently.
   */
  if (outcome === 'insufficient_evidence' || outcome === 'not_worth_detour') return 'weak_fit';
  if (outcome === 'low_confidence') return 'needs_verification';
  if (place.hiddenGemScore >= 0.6) return 'hidden_gems';
  if (place.popularityScore >= 0.7) return 'must_see_classics';
  if (
    place.weather.poorWeatherBackup &&
    (place.physicalIntensity === 'none' || place.physicalIntensity === 'easy')
  ) {
    return 'low_effort_backups';
  }
  /**
   * THE LAST TWO GROUPS ARE ABOUT DISTANCE, SO THEY ARE DECIDED BY DISTANCE.
   *
   * They were not. `scenic_detours` was assigned on category alone and
   * `nearby_side_quests` was the fallthrough — "matched none of the rules above"
   * — while both groups' headings, here and in `BOARD_GROUP_COPY`, talk about
   * how far things are. A reviewer found the predictable result on a real board:
   * "Easy wins near your base · short hops you can slot into any day" holding a
   * one-hour-nine-minute drive, and "Worth the detour · further out" led by a
   * thirteen-minute viewpoint. A heading that asserts a fact its contents
   * contradict is worse than no heading, because the traveller acts on it.
   *
   * `stretch` and `too_far` are the classifier's own words for "past what this
   * traveller said they would go, in the mode they would go in" — so they are
   * exactly the population the further-out heading describes. An unmeasured
   * journey is not evidence of distance in either direction and stays with the
   * near group, whose heading no longer claims one.
   */
  if (detourClass === 'stretch' || detourClass === 'too_far') return 'scenic_detours';
  return 'nearby_side_quests';
}

// ---------------------------------------------------------------------------
// Board integrity, as something a traveller reads
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS AT ALL.
 *
 * `BoardIntegrity` above has been computed on every build since the role gate
 * landed and rendered on no screen. So has `ProvisionalBoard.counts`. A board
 * that has just set eleven records aside as transport, withheld four nobody
 * could place and dropped six for being somewhere else looks — to the person
 * reading it — exactly like a destination with nine things in it. The whole
 * difference between "we found little" and "we found a lot and most of it is not
 * something you do" was being computed and thrown away.
 *
 * Three rules run through everything below, and each one is a defect that
 * actually reached somebody:
 *
 * 1. **Never a fabricated zero.** Every count here is `number | undefined`, and
 *    `undefined` means *this artifact does not record it* — not nought. A panel
 *    that renders "0 practical stops set aside" for ever, because the number it
 *    reads is structurally incapable of being anything else, is a broken panel
 *    wearing a fact's clothing.
 * 2. **A uniform unknown is silent.** `roleUnknown === admitted` is the ordinary
 *    state of every region authored before the role convention, so naming it
 *    would shout on the most-travelled path in the product. Only a *mixed*
 *    population — some placed, some not — is a fact about this board.
 * 3. **No raw identifiers.** Everything a traveller sees comes off a label map
 *    declared here, and an unmapped value renders nothing. This is the rule
 *    `stageLabel` was written to hold, and `replace(/_/g, ' ')` is the exact
 *    mechanism it refuses.
 */

/**
 * How much of a trip this board can carry.
 *
 * Five states rather than a number, because "17" answers nothing on its own —
 * seventeen is generous for a weekend and thin for a fortnight. The ladder is
 * measured against the days it has to fill, so the same board reads differently
 * for two different trips, which is the honest reading.
 */
export const BOARD_INTEGRITY_STATES = ['strong', 'usable', 'partial', 'thin', 'blocked'] as const;
export type BoardIntegrityState = (typeof BOARD_INTEGRITY_STATES)[number];

export const BOARD_INTEGRITY_STATE_LABELS: Record<BoardIntegrityState, string> = {
  strong: 'Plenty to choose from',
  usable: 'Enough to plan on',
  partial: 'Enough to start, with gaps',
  thin: 'Thin for a trip this long',
  blocked: 'Nothing here you can do',
};

/** What each state means for the decision in front of the traveller. */
export const BOARD_INTEGRITY_STATE_BLURBS: Record<BoardIntegrityState, string> = {
  strong: 'Pick what you like — there is more here than the days can hold.',
  usable: 'There is enough here to build the trip from without stretching.',
  partial: 'Workable, and there are things we looked for and did not find.',
  thin: 'You can carry on, but expect repeats or long days.',
  blocked: 'Nothing we found is something you could actually do on these dates.',
};

/**
 * The counts a traveller is entitled to see, named as claims rather than fields.
 *
 * Each one is a different sentence about the same board, and collapsing any two
 * of them loses the distinction that makes the panel worth rendering: a place
 * kept aside as a petrol station, a place nobody could locate, and a place
 * proven to be somewhere else are three unrelated facts with three unrelated
 * remedies.
 */
export const BOARD_INTEGRITY_FACTS = [
  'attractions',
  'categoryDiversity',
  'regionalDiversity',
  'supportKeptSeparately',
  'withheldUnplaceable',
  'removedOutOfScope',
  'removedUtilityRole',
  'gateways',
  'expansionMembers',
  'satellites',
  'roleUnclassified',
] as const;
export type BoardIntegrityFactId = (typeof BOARD_INTEGRITY_FACTS)[number];

export const BOARD_INTEGRITY_FACT_LABELS: Record<BoardIntegrityFactId, string> = {
  attractions: 'Things to choose between',
  categoryDiversity: 'Different kinds of thing',
  regionalDiversity: 'Separate areas',
  supportKeptSeparately: 'Practical stops kept aside',
  withheldUnplaceable: 'Held back until we can place them',
  removedOutOfScope: 'Dropped for being somewhere else',
  removedUtilityRole: 'Dropped as transport or services',
  gateways: 'Kept as ways in and out',
  expansionMembers: 'Added on purpose from further out',
  satellites: 'Offered as optional side trips',
  roleUnclassified: 'Kept without knowing what they are',
};

/**
 * THE FACTS A TRAVELLER IS SHOWN, AS OPPOSED TO THE ONES WE RECORD.
 *
 * Every count above is worth *computing* — they are how an operator tells a thin
 * destination from a broken pipeline. Most of them are not worth *rendering*: a
 * board that opens with "Practical stops kept aside 94 / Added on purpose from
 * further out 3033" has handed the traveller the compiler's own bookkeeping and
 * asked them to care about it, which is the §26 failure in its purest form. The
 * live Tokyo board put the first place card nine hundred pixels down a desktop
 * screen behind exactly that list.
 *
 * These three survive because each answers a question somebody planning a trip
 * actually asks: how much is there, how varied is it, and how spread out is it.
 * The rest stay in the reading — nothing is deleted, and a diagnostic surface may
 * still render them — but they do not belong in front of a person choosing where
 * to go on Tuesday.
 */
export const TRAVELLER_BOARD_FACTS: readonly BoardIntegrityFactId[] = [
  'attractions',
  'categoryDiversity',
  'regionalDiversity',
];

/** One line under a count, where the count needs one. */
export const BOARD_INTEGRITY_FACT_BLURBS: Partial<Record<BoardIntegrityFactId, string>> = {
  supportKeptSeparately:
    'Fuel, parking, terminals and the like. Real, useful, and not something to do — so they are kept for the plan rather than shown here.',
  withheldUnplaceable:
    'Nobody publishes enough about where these are for us to be sure they belong to this trip. They are not lost.',
  removedOutOfScope: 'Proven to sit outside the ground this trip covers.',
  removedUtilityRole: 'Transport and services that were offered to the board and refused by it.',
  gateways: 'How you get in and out. Never something you choose between.',
  satellites: 'Outside the destination, and only used once you say so.',
  roleUnclassified:
    'We know these are places and not what part they would play in a trip. They are shown, and they are not counted on.',
};

/**
 * Why a candidate is unusable, as a clause that finishes "…because …".
 *
 * The plural voice, and kept here rather than in the schema for the reason the
 * planner's own blocker labels are: a count wants "they are shut on every day of
 * your trip", and the per-card message wants the singular. Two audiences, two
 * registers, one set of codes.
 */
export const BOARD_BLOCKER_CLAUSES: Record<BlockerCode, string> = {
  needs_car: 'there is no way in without a vehicle this trip does not have',
  no_way_in: 'we could not establish any way in to them',
  service_unavailable: 'the service that reaches them does not run on your dates',
  mode_declined: 'reaching them needs transport you ruled out',
  closed_on_your_dates: 'they are shut on every day of your trip',
  no_open_hours: 'nobody opens them on any day of your trip',
  exceeds_daily_travel:
    'getting to them and back is further than you have said you will travel in a day',
  avoided_interest: 'they are the kind of thing you asked us to keep out',
  rough_road: 'the road in is rougher than you agreed to drive',
  no_services: 'there is nothing out there to support a visit',
  too_strenuous: 'they are harder going than you asked for',
  mobility: 'they do not meet the access this trip needs',
  too_expensive: 'they cost more than this trip has for them',
};

/**
 * Something the traveller can actually do about it.
 *
 * Deterministic in both directions: which of these is offered is decided by the
 * counts alone, and each is offered **only where it could change the answer**. A
 * board that lost nothing to scope is never told to widen its scope, and a board
 * with no satellite on offer is never told to allow one — a remedy for a problem
 * this trip does not have is worse than no remedy, because somebody will spend a
 * minute on it.
 */
export const BOARD_RECOVERY_ACTIONS = [
  'narrow_scope',
  'broaden_scope',
  'allow_satellite',
  'change_base_strategy',
  'change_transport',
  'adjust_travel_tolerance',
  'continue_smaller',
  'return_to_shaping',
] as const;
export type BoardRecoveryAction = (typeof BOARD_RECOVERY_ACTIONS)[number];

export const BOARD_RECOVERY_ACTION_LABELS: Record<BoardRecoveryAction, string> = {
  narrow_scope: 'Cover less ground',
  broaden_scope: 'Cover more ground',
  allow_satellite: 'Allow a side trip',
  change_base_strategy: 'Change where you sleep',
  change_transport: 'Change how you get around',
  adjust_travel_tolerance: 'Accept more travel in a day',
  continue_smaller: 'Carry on with what is here',
  return_to_shaping: 'Go back and reshape the trip',
};

export const BOARD_RECOVERY_ACTION_BLURBS: Record<BoardRecoveryAction, string> = {
  narrow_scope: 'This board is spread over more areas than the trip has days to reach them.',
  broaden_scope: 'Places were set aside for sitting outside the ground this trip covers.',
  allow_satellite: 'Side trips are on offer here, and nothing uses one until you say so.',
  change_base_strategy: 'More than one area is in play, and one base cannot serve them all.',
  change_transport: 'What is missing is a way of getting about rather than somewhere to go.',
  adjust_travel_tolerance: 'What is missing is the willingness to travel rather than the places.',
  continue_smaller: 'The board is short and everything on it is real. Nothing has to change.',
  return_to_shaping: 'The trip as it stands does not have a board in it. That is worth revisiting.',
};

/**
 * Where the action is taken, as a kind rather than a URL.
 *
 * Routes are the web app's business, and a core module that knew one would be
 * wrong the first time a route moved. Three kinds is all this needs: the answers
 * a traveller gave, the shape of the trip itself, and nothing at all.
 */
export const BOARD_RECOVERY_TARGETS = ['trip_answers', 'trip_shape', 'this_board'] as const;
export type BoardRecoveryTarget = (typeof BOARD_RECOVERY_TARGETS)[number];

export const BOARD_RECOVERY_ACTION_TARGETS: Record<BoardRecoveryAction, BoardRecoveryTarget> = {
  narrow_scope: 'trip_shape',
  broaden_scope: 'trip_shape',
  allow_satellite: 'trip_shape',
  change_base_strategy: 'trip_shape',
  change_transport: 'trip_answers',
  adjust_travel_tolerance: 'trip_answers',
  continue_smaller: 'this_board',
  return_to_shaping: 'trip_shape',
};

/**
 * What each blocking constraint can actually be answered with.
 *
 * An empty list is a real answer and appears three times: a place that is shut,
 * that costs too much or that is the wrong kind of thing is not fixed by any
 * setting on this screen, and offering one would be a provably useless
 * suggestion — which is the defect the `/discover` empty state used to be.
 */
const BLOCKER_REMEDIES: Record<BlockerCode, readonly BoardRecoveryAction[]> = {
  exceeds_daily_travel: ['adjust_travel_tolerance', 'change_base_strategy'],
  needs_car: ['change_transport'],
  mode_declined: ['change_transport'],
  service_unavailable: ['change_transport'],
  rough_road: ['change_transport'],
  no_services: ['change_transport'],
  no_way_in: ['change_transport'],
  too_strenuous: [],
  mobility: [],
  too_expensive: [],
  avoided_interest: [],
  closed_on_your_dates: [],
  no_open_hours: [],
};

/**
 * What a *published* artifact recorded about the ground either side of the board.
 *
 * Every field optional, and the optionality is the design. Containment runs in
 * the compiler and its verdicts are not carried on the places that survive it,
 * so a board can see what it refused and cannot see what was removed before it
 * ever got there. Rather than guess, the reading omits the fact — and the moment
 * the compiler persists these, the same panel starts saying them with no change
 * on this side.
 */
export interface RecordedBoardSupply {
  /** Practical stops the inventory kept apart from the board. */
  supportKeptSeparately?: number;
  /** Admitted, and withheld from final slots because nobody could place them. */
  withheldUnplaceable?: number;
  /** Removed before ranking for sitting outside the chosen ground. */
  removedOutOfScope?: number;
  /** Kept as ways in and out. */
  gateways?: number;
  /** Deliberately included by a regional expansion. */
  expansionMembers?: number;
  /** Offered as optional side trips, still labelled as such. */
  satellites?: number;
}

/** A named area of the trip, and which of this board's places sit in it. */
export interface BoardArea {
  name: string;
  placeIds: readonly string[];
}

export interface BoardIntegrityReading {
  state: BoardIntegrityState;
  /** One sentence with real numbers in it. Names no destination. */
  summary: string;
  /** Only what is genuinely known, in the declared order. */
  facts: { id: BoardIntegrityFactId; value: number }[];
  /**
   * Interests the traveller leaned into that nothing on this board satisfies.
   *
   * Identifiers, deliberately: the caller renders them through `INTEREST_LABELS`
   * and drops anything unmapped, which is the one convention that survives a
   * stored artifact written by a build that knew a value this one does not.
   */
  missingInterests: Interest[];
  /** Named areas of this trip with nothing on the board in them. */
  missingAreas: string[];
  /** The single most common reason a candidate here is unusable. */
  bindingConstraint?: { code: BlockerCode; count: number };
  actions: BoardRecoveryAction[];
}

export interface ReadBoardIntegrityInput {
  board: DiscoveryBoard;
  profile: TravelerProfile;
  /** Days the trip runs. Decides what "enough" means. */
  tripDays: number;
  /** Named areas, where the artifact holds any. Absent is "we do not divide it". */
  areas?: readonly BoardArea[];
  recorded?: RecordedBoardSupply;
}

/** Interest levels that count as "the traveller asked for this". */
const REQUESTED_LEVELS: readonly InterestLevel[] = ['frequent', 'core'];

/** More areas than days is the condition under which covering less ground helps. */
const AREAS_PER_DAY_TOO_MANY = 1;

/** Choices per day at which a board stops needing an apology. */
const CHOICES_PER_DAY_STRONG = 3;
const CHOICES_PER_DAY_USABLE = 2;

/**
 * A count, or nothing at all.
 *
 * The whole "never a fabricated zero" rule, in one function. A recorded value
 * wins where there is one; otherwise the board's own derivation is used, and a
 * derivation that came out at nought is treated as *nothing to say* rather than
 * as a nought — because on every live artifact these gates run against a
 * population that structurally cannot trip them, and a permanent zero beside a
 * label reads as a broken panel.
 */
function known(recorded: number | undefined, derived: number): number | undefined {
  if (recorded !== undefined) return recorded;
  return derived > 0 ? derived : undefined;
}

/**
 * The blocker that is stopping the most places, where one is.
 *
 * Counted over unworkable candidates, one vote per candidate per distinct code,
 * so a place blocked twice for the same reason does not outvote two places. Ties
 * break alphabetically, which is arbitrary and — more importantly — stable: a
 * panel that renamed its own binding constraint between two renders of the same
 * artifact would be worse than one that picked the wrong tie.
 */
export function bindingBoardConstraint(
  candidates: readonly DiscoveryCandidate[],
): { code: BlockerCode; count: number } | undefined {
  const counts = new Map<BlockerCode, number>();
  for (const candidate of candidates) {
    if (candidate.fit.band !== 'not_workable') continue;
    for (const code of new Set(candidate.fit.blockers.map((blocker) => blocker.code))) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0];
  return top ? { code: top[0], count: top[1] } : undefined;
}

export function readBoardIntegrity(input: ReadBoardIntegrityInput): BoardIntegrityReading {
  const { board, profile, tripDays, areas, recorded } = input;

  const workable = board.candidates.filter((candidate) => candidate.fit.band !== 'not_workable');
  const attractions = workable.length;
  const categoryDiversity = new Set(workable.map((candidate) => candidate.place.category)).size;

  /*
   * Areas are counted only where the artifact names them.
   *
   * The authored fixture carries none and a compiled region carries as many as
   * the expansion found, so "how many areas" is genuinely unknown on one of the
   * two paths through this product. `undefined` says so; a 1 would be a claim.
   */
  const onBoard = new Set(workable.map((candidate) => candidate.place.id));
  const coveredAreas = areas?.filter((area) => area.placeIds.some((id) => onBoard.has(id)));
  const regionalDiversity = coveredAreas?.length;
  const missingAreas =
    areas && areas.length > 0
      ? areas
          .filter((area) => !area.placeIds.some((id) => onBoard.has(id)))
          .map((area) => area.name)
          .sort((a, b) => a.localeCompare(b))
      : [];

  /*
   * Interests they leaned into and we found nothing for.
   *
   * `frequent` and `core` only. Every rung below them is "if it is right there",
   * and reporting an unmet "only if it is right there" as a gap would turn the
   * ordinary shape of a questionnaire into a list of failures.
   */
  const satisfied = new Set(workable.flatMap((candidate) => candidate.place.interests));
  const missingInterests = (Object.entries(profile.interests) as [Interest, InterestLevel][])
    .filter(([interest, level]) => REQUESTED_LEVELS.includes(level) && !satisfied.has(interest))
    .map(([interest]) => interest)
    .sort((a, b) => a.localeCompare(b));

  const refused = new Map(board.integrity.refused.map((entry) => [entry.refusal, entry.count]));
  const external = new Map(board.integrity.external.map((entry) => [entry.reason, entry.count]));

  /*
   * A uniform unknown is not a fact about this board.
   *
   * Every place in a region authored before the role convention carries no role,
   * so `roleUnknown === admitted` is the resting state of the most-tested journey
   * in the product. Naming it there would be a permanent warning about nothing.
   * A *mixed* population is different: it means one source wrote roles and
   * another did not, which is worth a line.
   */
  const roleUnclassified =
    board.integrity.roleUnknown > 0 && board.integrity.roleUnknown < board.integrity.admitted
      ? board.integrity.roleUnknown
      : undefined;

  const values: Partial<Record<BoardIntegrityFactId, number | undefined>> = {
    attractions,
    categoryDiversity,
    regionalDiversity,
    supportKeptSeparately: recorded?.supportKeptSeparately,
    withheldUnplaceable: known(recorded?.withheldUnplaceable, external.get('membership_unknown') ?? 0),
    removedOutOfScope: recorded?.removedOutOfScope,
    removedUtilityRole: known(undefined, refused.get('utility_role') ?? 0),
    gateways: known(recorded?.gateways, refused.get('gateway_only') ?? 0),
    expansionMembers: known(
      recorded?.expansionMembers,
      external.get('regional_expansion_member') ?? 0,
    ),
    satellites: known(recorded?.satellites, external.get('optional_satellite') ?? 0),
    roleUnclassified,
  };

  const facts = BOARD_INTEGRITY_FACTS.flatMap((id) => {
    const value = values[id];
    return value === undefined ? [] : [{ id, value }];
  });

  const bindingConstraint = bindingBoardConstraint(board.candidates);

  const state = boardIntegrityState({
    attractions,
    tripDays,
    categoryDiversity,
    regionalDiversity,
    gaps: missingInterests.length + missingAreas.length,
    withheld: values.withheldUnplaceable ?? 0,
  });

  return {
    state,
    summary: integritySummary({
      state,
      attractions,
      tripDays,
      regionalDiversity,
      ...(bindingConstraint ? { bindingConstraint } : {}),
    }),
    facts,
    missingInterests,
    missingAreas,
    ...(bindingConstraint ? { bindingConstraint } : {}),
    actions: recoveryActions({
      state,
      attractions,
      tripDays,
      regionalDiversity,
      missingAreas: missingAreas.length,
      satellites: values.satellites ?? 0,
      removedOutOfScope: values.removedOutOfScope ?? 0,
      ...(bindingConstraint ? { bindingConstraint } : {}),
    }),
  };
}

interface StateInput {
  attractions: number;
  tripDays: number;
  categoryDiversity: number;
  regionalDiversity: number | undefined;
  gaps: number;
  withheld: number;
}

/**
 * The ladder, and it is total.
 *
 * Measured per day rather than in absolutes, because "enough" is a relation
 * between what is here and what has to be filled. An unknown area count never
 * downgrades anything — not knowing how a region divides is a gap in our
 * evidence, not a shortage of places.
 */
export function boardIntegrityState(input: StateInput): BoardIntegrityState {
  const { attractions, categoryDiversity, regionalDiversity, gaps, withheld } = input;
  if (attractions === 0) return 'blocked';
  const perDay = attractions / Math.max(1, input.tripDays);
  if (perDay < 1) return 'thin';
  if (perDay < CHOICES_PER_DAY_USABLE || gaps > 0) return 'partial';
  if (
    perDay < CHOICES_PER_DAY_STRONG ||
    withheld > 0 ||
    categoryDiversity < 2 ||
    (regionalDiversity !== undefined && regionalDiversity < 2)
  ) {
    return 'usable';
  }
  return 'strong';
}

function integritySummary(input: {
  state: BoardIntegrityState;
  attractions: number;
  tripDays: number;
  regionalDiversity: number | undefined;
  bindingConstraint?: { code: BlockerCode; count: number };
}): string {
  const { state, attractions, tripDays, regionalDiversity, bindingConstraint } = input;
  const days = `${tripDays} ${tripDays === 1 ? 'day' : 'days'}`;
  const things = `${attractions} ${attractions === 1 ? 'thing' : 'things'} to choose between`;
  const across =
    regionalDiversity !== undefined && regionalDiversity > 1
      ? ` across ${regionalDiversity} areas`
      : '';

  const head =
    state === 'blocked'
      ? `Nothing we found here is workable over your ${days}.`
      : state === 'thin'
        ? `${things}${across}, which is fewer than one for each of your ${days}.`
        : state === 'partial'
          ? `${things}${across} for your ${days}, and some things we looked for are not among them.`
          : state === 'usable'
            ? `${things}${across} — enough to build your ${days} from.`
            : `${things}${across}, which is more than your ${days} can hold.`;

  if (!bindingConstraint) return head;
  const clause = BOARD_BLOCKER_CLAUSES[bindingConstraint.code];
  if (!clause) return head;
  const subject =
    bindingConstraint.count === 1 ? 'One other place is' : `${bindingConstraint.count} other places are`;
  const opener = state === 'blocked' ? `${bindingConstraint.count} of them are` : subject;
  return `${head} ${opener} out because ${clause}.`;
}

function recoveryActions(input: {
  state: BoardIntegrityState;
  attractions: number;
  tripDays: number;
  regionalDiversity: number | undefined;
  missingAreas: number;
  satellites: number;
  removedOutOfScope: number;
  bindingConstraint?: { code: BlockerCode; count: number };
}): BoardRecoveryAction[] {
  const chosen = new Set<BoardRecoveryAction>();

  /*
   * The binding constraint first, because it is the only input that names a
   * *cause*. Everything else below is shape.
   */
  if (input.bindingConstraint) {
    for (const action of BLOCKER_REMEDIES[input.bindingConstraint.code]) chosen.add(action);
  }

  // Only where a satellite genuinely exists to be allowed.
  if (input.satellites > 0) chosen.add('allow_satellite');
  // Only where something was actually removed for sitting outside.
  if (input.removedOutOfScope > 0) chosen.add('broaden_scope');
  // Only where there is more ground than there are days to cross it.
  if (
    input.regionalDiversity !== undefined &&
    input.regionalDiversity > input.tripDays * AREAS_PER_DAY_TOO_MANY
  ) {
    chosen.add('narrow_scope');
  }
  // Only where more than one area is in play, so a base choice has an effect.
  if ((input.regionalDiversity !== undefined && input.regionalDiversity > 1) || input.missingAreas > 0) {
    chosen.add('change_base_strategy');
  }

  if (input.attractions > 0 && (input.state === 'partial' || input.state === 'thin')) {
    chosen.add('continue_smaller');
  }
  if (input.state === 'thin' || input.state === 'blocked') chosen.add('return_to_shaping');

  return BOARD_RECOVERY_ACTIONS.filter((action) => chosen.has(action));
}

export interface ReadProvisionalIntegrityInput {
  /** Days the trip runs. Decides what "enough" means, exactly as on the final board. */
  tripDays: number;
  /** Cards the board holds. */
  cards: number;
  /** Distinct kinds of thing among them. */
  categoryDiversity: number;
  /** Areas the board divides itself into. Always at least one, and always known. */
  areas: number;
  /**
   * Practical stops the build kept apart from the board.
   *
   * The honest number, and — unlike anything on the final board — an already
   * persisted one: `ProvisionalBoard.counts.droppedUtilityRole` is written when
   * the board is committed and read back on every render, so this survives a
   * refresh and does not care whether a single provider is switched on.
   */
  supportKeptSeparately?: number;
}

/**
 * The same reading, for the board that exists before anything is verified.
 *
 * A separate entry point rather than a shared one because the two boards know
 * genuinely different things: nothing here has been routed, so there is no
 * binding constraint to name and no blocker to answer, and the areas *are*
 * known because clustering is what produced them. What they share is the ladder,
 * the sentence and the remedies, and sharing those is what makes the two screens
 * describe the same product rather than two.
 */
export function readProvisionalIntegrity(
  input: ReadProvisionalIntegrityInput,
): BoardIntegrityReading {
  const { tripDays, cards, categoryDiversity, areas } = input;
  const state = boardIntegrityState({
    attractions: cards,
    tripDays,
    categoryDiversity,
    regionalDiversity: areas,
    gaps: 0,
    withheld: 0,
  });

  const values: Partial<Record<BoardIntegrityFactId, number | undefined>> = {
    attractions: cards,
    categoryDiversity,
    regionalDiversity: areas,
    supportKeptSeparately: known(input.supportKeptSeparately, 0),
  };

  return {
    state,
    summary: integritySummary({ state, attractions: cards, tripDays, regionalDiversity: areas }),
    facts: BOARD_INTEGRITY_FACTS.flatMap((id) => {
      const value = values[id];
      return value === undefined ? [] : [{ id, value }];
    }),
    missingInterests: [],
    missingAreas: [],
    actions: recoveryActions({
      state,
      attractions: cards,
      tripDays,
      regionalDiversity: areas,
      missingAreas: 0,
      satellites: 0,
      removedOutOfScope: 0,
    }),
  };
}
