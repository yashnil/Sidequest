import {
  assessPlaceAccess,
  capabilityFromProfile,
  type PlaceAccessAssessment,
} from '../access/feasibility';
import { assessOperatingHours, type OperatingAssessment } from '../hours/availability';
import type { AccessDataset } from '../schemas/access';
import { findOperatingCalendar, type OperatingHoursDataset } from '../schemas/hours';
import type { Place } from '../schemas/place';
import type { TravelerProfile } from '../schemas/profile';
import type { Region, WorthDetourLabel } from '../schemas/region';
import type { TransportMode } from '../schemas/access';
import {
  dailyCapFor,
  detourToleranceMinutesFor,
  DETOUR_STRETCH_MULTIPLIER,
  resolveCandidateReach,
  transitBlindWalk,
  type ReachFromBase,
  type TravelKnowledge,
} from '../travel/reach';
import { assessSeason, type SeasonAssessment } from './season';

/**
 * HOW MUCH OF A DETOUR THIS IS, FOR THIS TRAVELLER, IN THE MODE THEY WOULD USE.
 *
 * `unknown` is the value Phase 15D added, and it is not a shade of `too_far`.
 * Before it, a candidate whose journey nobody could measure fell through to the
 * final `return 'too_far'` — so a provider timing out and a place being two
 * hours away produced the same card, the same penalty and the same silent
 * removal from auto-pick. One of those is a fact about the trip; the other is a
 * fact about our instruments, and the traveller is entitled to know which.
 */
export type DetourClass = 'base' | 'in_tolerance' | 'stretch' | 'too_far' | 'unknown';

export interface SatelliteAssessment {
  place: Place;
  detourClass: DetourClass;
  /**
   * ONE-WAY TIME FROM THE BASE, IN THE MODE THAT WOULD ACTUALLY BE USED.
   *
   * This was `driveMinutes` and it was not a driving figure. It came off
   * `place.travelFromBase.driveMinutes`, which the compiler fills from whichever
   * single mode the region's matrix happened to be — so on a car-free city trip
   * it held *walking* minutes under a name that says driving, and the detour
   * classifier, the fit scorer, the quality assessor and the card all read it as
   * time in a car.
   *
   * `null` where nothing usable was measured. Never zero: a zero here is a
   * teleport, and the board has shipped one before.
   */
  travelMinutesFromBase: number | null;
  /** The mode that figure is in, so no reader has to assume one. */
  travelModeFromBase: TransportMode | null;
  /** The shared reach relationship this assessment was derived from. */
  reach: ReachFromBase;
  /**
   * Road distance, where the journey is one that puts kilometres on a vehicle.
   * `null` on a ride: a metro journey adds minutes to a day, not kilometres.
   */
  distanceKm: number | null;
  /**
   * Round-trip travel as a share of the budget that actually bounds it.
   *
   * Which budget depends on the mode, because the traveller gave two separate
   * answers: an hour at the wheel and an hour on a train with a book are not the
   * same hour. This used to be a drive-only figure that was flatly `0` for every
   * non-driving candidate — so a car-free board had no travel-burden term at
   * all, which is not a lenient budget, it is an absent one.
   */
  travelBudgetShare: number;
  season: SeasonAssessment;
  /** Whether this traveller can legally reach it, date by date. */
  access: PlaceAccessAssessment;
  /**
   * Whether it will let anyone in when they arrive, date by date. Kept beside
   * `access` rather than merged into it: reachable and open fail independently,
   * and a card that says only "this will not work" has said nothing useful.
   */
  operating: OperatingAssessment;
}

export interface RegionExpansion {
  region: Region;
  /**
   * One-way minutes from base the traveller will accept **when driving**.
   *
   * Kept as the headline figure because it is the one the questionnaire asked
   * for in so many words, and it is what the region preview quotes. It is no
   * longer the only radius: `classifyDetour` reads
   * `detourToleranceMinutesFor(profile, mode)`, which widens for a ride to half
   * the traveller's daily transport budget. A single number cannot describe a
   * traveller who will walk fifteen minutes and ride an hour.
   */
  radiusMinutes: number;
  base: SatelliteAssessment[];
  satellites: SatelliteAssessment[];
  /** Places the region contains that fall outside the traveller's radius entirely. */
  beyondRadius: SatelliteAssessment[];
  /** Places whose journey nobody could measure. Not the same as too far. */
  unmeasured: SatelliteAssessment[];
}

export interface ExpansionInput {
  region: Region;
  places: Place[];
  profile: TravelerProfile;
  /** Calendar months the trip covers. */
  months: number[];
  /**
   * Every date of the trip. Months are enough to say "the road is shut in
   * February"; only dates can say "the shuttle does not run on a Tuesday".
   */
  dates: string[];
  access: AccessDataset;
  hours: OperatingHoursDataset;
  /**
   * MEASURED TRAVEL, AND THE BASE IT IS MEASURED FROM.
   *
   * Required, not optional, and that is the point of Phase 15D. When this was
   * absent the expansion fell back to `place.travelFromBase.driveMinutes` — a
   * scalar with no mode on it — and the board reached conclusions the planner
   * would have contradicted. An optional field would have let a caller keep the
   * old behaviour by omission, and "omission" is exactly how this shipped: the
   * web app had the matrix, the transit evidence and the base id in scope at the
   * board call site and passed none of them.
   *
   * The same `TravelKnowledge` the planner is built with, so the two cannot hold
   * different opinions about what this traveller may board.
   */
  travel: {
    knowledge: TravelKnowledge;
    baseId: string;
    /**
     * EVERY BASE THE TRIP SLEEPS AT, WHEN THERE IS MORE THAN ONE.
     *
     * A multi-base trip visits each place from *its* base, and the compiler has
     * measured it that way since the Bali regression — a stop beside the third
     * base scored as though driven to from the first, six hours away. Resolving
     * the whole board from the primary base alone would reintroduce exactly
     * that: a place fifteen minutes from base B, hard-blocked for exceeding a
     * day's travel from base A.
     *
     * So the expansion resolves each candidate against every base and keeps the
     * best answer, and `ReachFromBase.baseId` records which one it was.
     * Optional; absent means the one base in `baseId` is the whole trip.
     */
    baseIds?: readonly string[];
  };
}

/**
 * Turns "Mammoth Lakes" into a base plus a set of satellites, classified by how
 * far outside the traveller's stated tolerance each one sits. This is the step
 * that makes the product region-aware rather than destination-aware; it is
 * deliberately independent of fit scoring so that "how far" and "how good"
 * stay separable.
 */
export function expandRegion(input: ExpansionInput): RegionExpansion {
  const { region, places, profile, months, dates, access, hours, travel } = input;
  const radiusMinutes = profile.derived.effectiveDetourMinutes;
  const capability = capabilityFromProfile(profile);
  /* Primary base first, so ties resolve to it deterministically. */
  const baseIds = [
    travel.baseId,
    ...(travel.baseIds ?? []).filter((id) => id !== travel.baseId),
  ];

  const assessed = places
    .filter((place) => place.regionId === region.id)
    .map<SatelliteAssessment>((place) => {
      /*
       * The one place this module asks how far anything is, and it asks the
       * resolver rather than a field. Everything below reads its answer.
       */
      const reach = bestReachAcrossBases(travel.knowledge, baseIds, place.id);
      const placeAccess = assessPlaceAccess({
        placeId: place.id,
        dataset: access,
        dates,
        capability,
      });
      return {
        place,
        detourClass: classifyDetour(place, reach, profile, placeAccess, travel.knowledge),
        travelMinutesFromBase: reach.status === 'measured' ? reach.travelMinutes : null,
        travelModeFromBase: reach.status === 'measured' ? reach.mode : null,
        reach,
        distanceKm: reach.status === 'measured' ? reach.distanceKm : null,
        travelBudgetShare: travelBudgetShareOf(reach, travel.knowledge, placeAccess),
        season: assessSeason(place, months),
        access: placeAccess,
        operating: assessOperatingHours({
          calendar: findOperatingCalendar(hours, place.id) ?? unknownCalendarFor(place.id),
          dates,
        }),
      };
    })
    /*
     * Nearest first, with an unresolved journey last rather than first.
     *
     * A `null` sorted as a zero would put every place nobody could route at the
     * head of the board — and the ordering is load-bearing beyond cosmetics: the
     * quality layer counts category saturation in exactly this order, so the
     * first of a kind is the one that keeps its full score.
     */
    .sort(
      (a, b) =>
        (a.travelMinutesFromBase ?? Number.POSITIVE_INFINITY) -
          (b.travelMinutesFromBase ?? Number.POSITIVE_INFINITY) ||
        a.place.id.localeCompare(b.place.id),
    );

  return {
    region,
    radiusMinutes,
    base: assessed.filter((item) => item.detourClass === 'base'),
    satellites: assessed.filter(
      (item) => item.detourClass === 'in_tolerance' || item.detourClass === 'stretch',
    ),
    beyondRadius: assessed.filter((item) => item.detourClass === 'too_far'),
    unmeasured: assessed.filter((item) => item.detourClass === 'unknown'),
  };
}

/**
 * The best answer any of the trip's bases can give for this candidate.
 *
 * Measured beats everything, and among measured journeys the shortest wins —
 * "from base" on a multi-base trip means the base you would actually be at. A
 * refusal beats a blank, because "the only measured way is one you ruled out"
 * is information and "nobody measured it" is not. Order inside each tier is the
 * caller's base order, primary first, so the answer is deterministic.
 */
function bestReachAcrossBases(
  knowledge: TravelKnowledge,
  baseIds: readonly string[],
  candidateId: string,
): ReachFromBase {
  let best: ReachFromBase | null = null;
  for (const baseId of baseIds) {
    const reach = resolveCandidateReach(knowledge, baseId, candidateId);
    if (reach.status === 'measured') {
      if (best === null || best.status !== 'measured' || reach.travelMinutes < best.travelMinutes) {
        best = reach;
      }
    } else if (best === null || (best.status === 'unmeasured' && reach.status === 'conflict')) {
      best = reach;
    }
  }
  return best ?? resolveCandidateReach(knowledge, baseIds[0] ?? '', candidateId);
}

/**
 * How much of the budget that actually bounds this journey it would spend.
 *
 * `dailyCapFor` picks the budget from the mode — the wheel-time cap for a drive,
 * the whole-transport cap for anything else — which is the same rule the
 * scheduler applies, imported rather than restated. A journey with no
 * measurement spends nothing, because charging an unknown against a budget is
 * inventing a number, and this figure feeds a hard blocker.
 */
function travelBudgetShareOf(
  reach: ReachFromBase,
  knowledge: TravelKnowledge,
  access: PlaceAccessAssessment,
): number {
  if (reach.status !== 'measured') return 0;
  const cap = dailyCapFor(knowledge, budgetedModeOf(reach.mode, access));
  if (cap <= 0) return 0;
  return reach.roundTripMinutes / cap;
}

/**
 * WHICH BUDGET A JOURNEY SPENDS, WHICH IS NOT ALWAYS WHICH VEHICLE COVERS IT.
 *
 * The road matrix measures a road, and a road is how a shuttle gets there too.
 * A gateway the access dataset says is reached *only* by shuttle is still a
 * forty-minute journey along that road — but none of it is time at the wheel, so
 * charging it to the driving cap would refuse a stop over driving nobody does.
 *
 * That is the same error, mirrored, as the one this pass exists to fix: there,
 * a walk was charged to a driving cap of zero; here, a ride would be charged to
 * a driving cap it never touches. The distinction between *how far* and *who is
 * driving* is the whole reason the profile carries two budgets.
 */
function budgetedModeOf(mode: TransportMode, access: PlaceAccessAssessment): TransportMode {
  if (mode !== 'drive') return mode;
  return access.requiredModes.includes('drive') ? 'drive' : 'shuttle';
}

/**
 * The provider boundary refuses a dataset that leaves a place out, so this is
 * unreachable through the normal path. It exists because the safe way to be
 * wrong is to say "we do not know", never to say "open whenever you like".
 */
function unknownCalendarFor(placeId: string) {
  return {
    kind: 'unknown' as const,
    placeId,
    admission: {
      reservationRequired: false,
      timedEntry: false,
      permitRequired: false,
      walkInAllowed: true,
      capacityLimited: false,
    },
    daylightOnly: false,
    note: 'We hold no opening-hours record for this place.',
    provenance: {
      kind: 'estimated' as const,
      sourceName: 'No source',
      confidence: 0,
      volatility: 'dynamic' as const,
      recheckNote: 'No opening-hours record exists for this place.',
    },
  };
}

/**
 * HOW MUCH OF A DETOUR THIS IS, MEASURED IN THE MODE THE TRAVELLER WOULD USE.
 *
 * The version this replaces took one scalar named `driveMinutes` — which on a
 * car-free trip held walking minutes — and compared it against one radius, which
 * for a car-free traveller was the constant twenty. So a place twenty-seven
 * minutes away by measured metro arrived as an eighty-five-minute walk, failed a
 * twenty-minute radius twice over, and was filed as too far to bother with.
 *
 * Four rules now, in order, and each answers a different question:
 *
 *   1. **Did we measure anything usable?** No measurement is `unknown`, and a
 *      journey this traveller is not permitted to make is `too_far` — the second
 *      is a real refusal ("the only road here is a road, and you have no car"),
 *      the first is a gap in our evidence and must not wear the same badge.
 *   2. **Does the round trip fit the day at all?** Against the budget the mode
 *      actually spends, via the scheduler's own `dailyCapFor`. This is where a
 *      two-hour walk goes: measured, permitted, and past what the traveller said
 *      a day of getting about could hold.
 *   3. **Is it inside the radius for this mode?** `detourToleranceMinutesFor`
 *      widens for a ride and never narrows below the stated driving radius.
 *   4. **Is a walk longer than the walk they agreed to?** A ninety-minute walk
 *      and a twenty-five-minute subway ride are not the same journey even when
 *      the clock agrees, and the traveller already told us how far they walk. A
 *      walk past that is a stretch at best — never promoted to comfortable.
 *
 * And one verdict rules 3 and 4 may not pass at all, which is why it is asked
 * before either of them. Where the walk that priced this journey is standing in
 * for scheduled transport nobody could measure — `transitBlindWalk`: the
 * compilation signed the gap, the destination evidence observes a scheduled
 * network, and the walk is past what the traveller said they would walk — a
 * radius verdict is a verdict about the wrong mode in *either* direction, and
 * the honest class is `unknown`. The Tokyo skip list is the witness: "1 hr
 * 42 min each way on foot is past how far you said you would go", over a city
 * whose own pack records a hundred-odd railway stations, for a traveller who
 * chose public transport. The walk survives on the card as a walk; only the
 * distance *verdict* is withheld, and withholding it is what keeps the card
 * saying the transit route is unverified rather than quoting a walking clock as
 * this traveller's distance. Rule 2 still runs first, so a walk past what any
 * day of this trip holds stays `too_far` whatever the network — the planner's
 * settled caps would refuse it on the same arithmetic, and softening it here
 * would put a card on the board the plan must always take back.
 *
 * What a withheld verdict is emphatically not is a refusal, and the surfaces
 * that must *act* on one of these journeys — the pre-selection, the scheduler's
 * walking cap — bound it by the ride budget through
 * `detourToleranceMinutesFor(profile, 'walk', { transitUnmeasured })`, because
 * the journey the traveller will make is the ride. Bounding it by walking
 * appetite is what refused every canonical seat on two live car-free
 * dense-metro boards, each one priced at thirty-nine to seventy measured
 * walking minutes against a twenty-five minute answer about the last mile from
 * a stop, and left one of them with a single scheduled stop out of twenty-four
 * cards.
 *
 * Every radius on this page is the **journey bound**, and that is the only
 * question asked here: how far away is this, for a traveller who will make the
 * journey however they make it. It is not the ceiling on a leg the itinerary
 * tells somebody to walk — that is `walkingLegBoundMinutes`, a separate
 * function taking no evidence at all, so the widening above cannot reach it.
 * When one number answered both, the widened figure arrived at the scheduler as
 * a walking allowance and laid hour-long walks for a traveller who had answered
 * twenty-five minutes.
 *
 * Nothing here reads a kilometre. Distance survives as a card fact, not as a
 * verdict: the transport network decides how far away somewhere is.
 */
function classifyDetour(
  place: Place,
  reach: ReachFromBase,
  profile: TravelerProfile,
  access: PlaceAccessAssessment,
  knowledge: TravelKnowledge,
): DetourClass {
  if (place.relationship === 'base') return 'base';

  if (reach.status !== 'measured') {
    /*
     * A REFUSED JOURNEY AND AN UNREACHABLE PLACE ARE NOT THE SAME THING.
     *
     * `conflict` says the only journey anybody *measured* is one this traveller
     * may not make — a road for somebody with no car. That is a refusal about
     * the measurements, and the access dataset is a second, independent source
     * on the same question: it carries authored services, scheduled buses and
     * shuttles that no travel-time matrix can price, and it evaluates them date
     * by date.
     *
     * So when access still finds a legal way in, the honest verdict is that the
     * journey is *unverified* rather than impossible. Calling it too far would
     * put "too far for this trip" on a town with four buses a day each way, each
     * one published by its operator — which is the mirror image of the defect
     * this pass exists to fix, and just as confident.
     *
     * When access agrees there is no way in, `too_far` is the truth and the
     * card's blockers say which constraint bit.
     */
    if (access.status === 'blocked') return 'too_far';
    return 'unknown';
  }

  const budgetedMode = budgetedModeOf(reach.mode, access);
  const dailyCap =
    budgetedMode === 'drive'
      ? profile.transport.maxDailyDriveMinutes
      : profile.transport.maxDailyTransportMinutes;
  if (dailyCap > 0 && reach.roundTripMinutes > dailyCap) return 'too_far';

  /*
   * The one case no radius may decide, and it is asked before any of them are.
   * See the header: a walking figure standing in for unmeasurable scheduled
   * transport is not this traveller's distance, and `unknown` is what unknown is
   * called.
   *
   * It sat *below* the radius rules, where it only ever caught what the walking
   * radius had already refused. That position was safe only while a car-free
   * traveller's radius was a twenty-minute constant. Their stated one-way travel
   * answer now reaches it, so a seventy-minute stand-in walk would fall inside a
   * sixty-minute radius and be handed a confident "in tolerance" — a distance
   * verdict about a mode nobody measured, in place of the withheld one, and the
   * card would drop the sentence saying the transit route is unverified.
   */
  if (reach.mode === 'walk' && transitBlindWalk(knowledge, reach.travelMinutes)) return 'unknown';

  /*
   * The same substituted mode the cap used, so one journey is never bounded by
   * one mode's budget and measured against another mode's radius. A road ride
   * on a shuttle is bounded like a ride and given a ride's radius.
   */
  const radius = detourToleranceMinutesFor(profile, budgetedMode);
  const walkedTooFar =
    reach.mode === 'walk' && reach.travelMinutes > profile.transport.maxAccessWalkMinutes;

  if (reach.travelMinutes <= radius) return walkedTooFar ? 'stretch' : 'in_tolerance';
  if (reach.travelMinutes <= radius * DETOUR_STRETCH_MULTIPLIER) return 'stretch';
  return 'too_far';
}

/**
 * EVERY VERDICT A PLACE WE CAN ACTUALLY GET TO MAY CARRY, WEAKEST CLAIM FIRST.
 *
 * The order is the invariant, not a presentation detail. Fit chooses a rung;
 * distance may only ever push a candidate *down* the list, never off it and
 * never onto it. That is what stops "how far is it" from being answered out of
 * "how much would you like it".
 */
const REACHABLE_VERDICTS = [
  'only_if_nearby',
  'worth_it_if_you_like_this',
  'definitely_worth_it',
] as const;

/** How keen we are about a place before the journey is charged against it. */
const FIT_ENTHUSIASM: Record<'top_pick' | 'strong' | 'good' | 'optional', number> = {
  top_pick: 3,
  strong: 2,
  good: 1,
  optional: 0,
};

/**
 * HOW FAR IT IS, SETTLED BEFORE HOW MUCH YOU WOULD LIKE IT AND NEVER OUT OF IT.
 *
 * The version this replaces read the fit band first and let it pick the
 * *distance* sentence. One identical sixty-nine-minute journey therefore read
 * "worth it if this is your thing" at band `strong` and "too far for this trip"
 * at band `good`; and a journey the trip genuinely cannot make read "worth it if
 * this is your thing" whenever the place happened to be a top pick. Those are
 * the same error in both directions — a claim about the road answered from the
 * traveller's taste — and each one put the board at odds with the plan built
 * from the very same numbers:
 *
 *   - Auto-pick accepts exactly one stop past the stated tolerance and says so
 *     ("one pick sits past your usual detour limit because it earned the extra
 *     journey"). On the remote-road world it took a `stretch` reserve whose own
 *     card read "Too far for this trip": one screen, one place, two answers.
 *   - The mirror. `too_far` is the class auto-pick refuses outright and the
 *     scheduler's daily caps refuse again, so "Worth it if this is your thing"
 *     on one is a recommendation nothing downstream will ever honour — a board
 *     that promises and a planner that takes it back.
 *
 * So reachability is decided from `detourClass` alone: at the base, unverified,
 * past what this trip can make, or reachable. Only inside the reachable case
 * does fit choose the wording, and a `stretch` costs one rung on top of it — at
 * equal fit a longer journey is never sold harder than a shorter one.
 *
 * `skip_for_your_style` stays a fit verdict at both weak bands, ahead of
 * distance, because it is the one label here that makes no claim about a
 * journey: a place the traveller should not go to needs no travel advice.
 */
export function worthDetourLabel(
  detourClass: DetourClass,
  fitBand: 'top_pick' | 'strong' | 'good' | 'optional' | 'weak' | 'not_workable',
): WorthDetourLabel {
  if (fitBand === 'not_workable' || fitBand === 'weak') return 'skip_for_your_style';

  if (detourClass === 'base') return 'core_to_trip';
  /*
   * An unmeasured journey gets no distance verdict at all: "worth the detour"
   * and "too far" are both claims about a detour whose length nobody
   * established, and a provider that did not answer must not sound like one
   * that did.
   */
  if (detourClass === 'unknown') return 'reach_unverified';
  if (detourClass === 'too_far') return 'too_far_for_this_trip';

  const rung = FIT_ENTHUSIASM[fitBand] - (detourClass === 'stretch' ? 1 : 0);
  return REACHABLE_VERDICTS[Math.min(Math.max(rung, 0), REACHABLE_VERDICTS.length - 1)]!;
}
