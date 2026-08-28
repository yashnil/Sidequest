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
  scheduledTransportUnmeasured,
  travelKnowledgeFor,
  type ReachFromBase,
  type ScheduledNetworkPresence,
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
  FIT_BAND_METER,
  type BlockerCode,
  type FitAssessment,
} from '../scoring/fit';
import {
  assessCandidateQuality,
  type CandidateOutcome,
  type QualityAssessment,
  type ReasonBasis,
} from '../quality/candidate';
import { standsAsEstablishedName } from '../quality/significance';
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
  /**
   * Where this card sits on the board, and the two dimensions that decided it.
   *
   * Carried rather than derived at the sort so that the ordering is inspectable:
   * a card can say *why* it is above another one, and a test can assert on the
   * parts instead of on the outcome of a comparator.
   */
  ordering: BoardOrdering;
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
   * Whether `travelMinutesFromBase` is the journey or only stands in for it.
   *
   * Carried from the assessment rather than re-derived here, because the two
   * surfaces that re-derived it read `detourClass` — which is a statement about
   * the traveller's *budgets* — and so said "2 hr 17 min on foot from base" and
   * "too far for this trip" about a landmark a quarter of an hour away by
   * train. See `SatelliteAssessment.journeyProxy`.
   */
  journeyProxy: boolean;
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
  /**
   * A second record for a subject the board is already showing.
   *
   * A live metro board carried four cards for two places — one theme park named
   * identically twice, described once as an amusement park and once as a water
   * park, and a second park sitting beside a record of itself whose name
   * carried both the local and the English reading — over an integrity block
   * reading `offered: 24, admitted: 24, refused: []`.
   * A large site is mapped as several features, and the compiler's
   * `dedupeCandidates` is deliberately conservative about joining them (same
   * name within 120 m) because *it* merges records, and a wrong merge deletes a
   * place. Refusing a card does not: both records survive, and the board shows
   * the subject once.
   */
  'duplicate_subject',
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
 * Every name a record might be recognised by, normalised for comparison.
 *
 * Split on the slash because `Local/English` is a common way for a catalogue to
 * carry both readings in one field, and two Disneyland records differed by
 * exactly that. Segments under three characters are dropped: they collide
 * across unrelated places far more often than they identify one.
 */
function subjectKeys(name: string): string[] {
  return name
    .split(/[/／|｜]/)
    .map((part) =>
      part
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, ''),
    )
    .filter((part) => part.length >= 3);
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
  /**
   * ONE SUBJECT, ONE CARD — DECIDED HERE, BEFORE ANYTHING COUNTS THE REGION.
   *
   * In this gate rather than later for the same reason gateways are: everything
   * downstream — the expansion's satellite counts, the category saturation
   * tally, the integrity block a traveller reads — is computed over what this
   * function admits, so a repeat that survives to the cards has already been
   * counted twice in every number describing "how much is here".
   *
   * The survivor is chosen by the records' own standing rather than by fit,
   * because admission is a statement about the region and takes no traveller:
   * `partitionBoardPlaces` is not given a profile and must not start needing
   * one. Popularity first, then the id, so one region always partitions the
   * same way.
   *
   * Names only, and no distance in it. Partly because this file may not compute
   * one — `routing/semantics.architecture.test` holds the board to rendering
   * `place.travelFromBase` and never deriving a second answer beside it — but
   * mostly because distance is not what makes this a defect. A card carries a
   * name, a description and a journey, and two cards carrying the same name are
   * indistinguishable to the person reading them however far apart the two
   * records sit.
   */
  const byStanding = [...places].sort(
    (a, b) => (b.popularityScore ?? 0) - (a.popularityScore ?? 0) || a.id.localeCompare(b.id),
  );
  const heldKeys = new Set<string>();
  const repeats = new Set<string>();
  for (const place of byStanding) {
    const keys = subjectKeys(place.name);
    if (keys.length === 0) continue;
    if (keys.some((key) => heldKeys.has(key))) {
      repeats.add(place.id);
      continue;
    }
    for (const key of keys) heldKeys.add(key);
  }

  const admissions = places.map((place) =>
    repeats.has(place.id)
      ? { place, admitted: false as const, refusal: 'duplicate_subject' as const }
      : admitToBoard(place),
  );
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

// ---------------------------------------------------------------------------
// The order of the list, composed from two dimensions that stay apart
// ---------------------------------------------------------------------------

/**
 * WHERE SIGNIFICANCE FINALLY REACHES THE TRAVELLER.
 *
 * `quality/significance.ts` composes one number for "does this place matter",
 * the compiler writes it onto every record it ranks, and until this section
 * existed no traveller-facing list read it. The board sorted by `fit.score`
 * alone, so two candidates identical in every personal dimension and wildly
 * apart in local standing came out indistinguishable.
 *
 * Measured on the stored Tokyo artifact (Overture release 2026-07-22.0, 24
 * cards, six days). The eight cards at ranks 8–15 were anonymous galleries the
 * *fit scorer itself* had capped at "Good fit" for having established nothing —
 * no knowledge base, no corroborating catalogue, no authority — and they
 * outranked every card the same scorer called "Strong fit". Institute for
 * Nature Study, significance 0.76, sat 16th of 24. Tokyo Dome City Attractions,
 * significance 0.76 and ten minutes from the bed, sat 24th of 24, last. The
 * order of the list contradicted the label printed on the cards.
 *
 * THE RULE, AND WHY IT IS A COMPOSITION RATHER THAN A BLEND.
 *
 * §9 asks for dimensions that stay distinct and interpretable, and the tempting
 * repair — weight `experienceSignificance` into `fit.score` as a tenth factor —
 * was measured and refused: the nine match factors occupy 0.75–1.0 for anything
 * worth showing while significance occupies 0.12–0.76 on real records, so
 * averaging the two deflates every compiled candidate and costs a planned day a
 * stop. `significance-is-not-fit` in `fit.test.ts` fails if anyone tries it.
 *
 * So the two are composed *here*, where ordering happens, in one lexicographic
 * rule:
 *
 *   1. **The band**, which is the verdict the traveller is actually shown.
 *   2. **Significance and fit together**, inside that band.
 *   3. The id, so the board never reshuffles between two renders.
 *
 * Putting the band first is what makes this safe, and it is the guard against
 * the failure this change could otherwise create. No amount of standing lifts a
 * card above one the scorer rates higher: a famous place that does not suit this
 * traveller still loses, structurally rather than by choice of weight. It also
 * ends a second contradiction for free — the fit scorer's own evidence cap now
 * decides position as well as label, so a card that reads "Good fit" can no
 * longer sit above one that reads "Strong fit".
 */

/**
 * How much of the within-band key significance may move.
 *
 * Generous on purpose. Inside one band the remaining difference in `fit.score`
 * is below the resolution the product claims for it — `FIT_BAND_METER` is
 * documented "deliberately coarse — the underlying score is not that precise" —
 * so ordering ties in the coarse verdict by how much each place matters is the
 * whole point rather than a nudge. Fit stays in the key underneath, which is
 * what separates two places of equal standing.
 */
export const SIGNIFICANCE_ORDERING_SHARE = 0.3;

/**
 * The point on the 0–1 scale that neither lifts a card nor drops one.
 *
 * The scale's own midpoint rather than any pack's median, so this does not have
 * to be recalibrated against whatever was last compiled.
 */
export const NEUTRAL_SIGNIFICANCE = 0.5;

/**
 * THE RESOLUTION SIGNIFICANCE IS ALLOWED TO CLAIM.
 *
 * A tenth, and the coarseness is the point. The composed figure is a category
 * prior plus a unioned evidence channel; on live packs it lands on values a
 * hundredth apart — 0.59 against 0.60 — that carry no information whatsoever
 * about which place a traveller would rather see. Ordering on a difference that
 * small is §8.3's metadata heuristic wearing a decimal point: it reshuffles a
 * board on arithmetic nobody could defend to the person reading it, and the
 * §29 B evaluation caught it doing exactly that, demoting the region's most
 * established place two positions past a feature 0.01 above it.
 *
 * So the lean is quantised before it is spent. Two places whose significance
 * differs by less than a step order by fit and then by id, exactly as they did
 * before this existed; a step apart is a real difference and is acted on. The
 * same reasoning `expectCrowd` states for using bands rather than a scale, and
 * the same reasoning `FIT_BAND_METER` states for being deliberately coarse.
 */
export const SIGNIFICANCE_STEP = 0.1;

/**
 * How far this place sits from the middle of the significance scale, or nothing.
 *
 * `null` is load-bearing and must never become a zero-valued *score*: an
 * authored region carries no `experienceSignificance` at all, and reading that
 * absence as "this place does not matter" would push every hand-curated place
 * to the bottom of its band on the strength of a field nobody filled in. It
 * reads instead as no opinion — a board where nothing carries the field orders
 * exactly as it did before this existed.
 *
 * Exported because auto-pick reads the same lean against its own share. One
 * definition of the dimension, two callers, so the board and the pre-selection
 * cannot come to different views of which place matters more.
 */
export function significanceLean(place: Pick<Place, 'experienceSignificance'>): number | null {
  const value = place.experienceSignificance;
  if (value === undefined) return null;
  const steps = Math.round(Math.min(1, Math.max(0, value)) / SIGNIFICANCE_STEP);
  return steps * SIGNIFICANCE_STEP - NEUTRAL_SIGNIFICANCE;
}

/**
 * WHICH WAY "HOW MUCH EACH PLACE MATTERS" LEANS FOR *THIS* TRAVELLER.
 *
 * The within-band significance lift existed to order fit-ties toward the
 * established, and it was worth the same +`SIGNIFICANCE_ORDERING_SHARE · lean`
 * to every traveller — including the one who had just answered "mostly hidden
 * gems". The §29 B evaluation caught the consequence on a compiled board: a
 * hidden-leaning preference dropped the most established place's *score*, and
 * its *rank* did not move, because the preference-driven fit delta was smaller
 * than the preference-blind ordering lift holding the card at the head of its
 * band. §29 B's guarantee is that famous sights can be deprioritised by
 * preference — ranking, not just scoring — so the lift's direction now follows
 * the traveller's own discovery answer.
 *
 * The pivot is the scale's midpoint, matching `NEUTRAL_SIGNIFICANCE`'s own
 * rationale: a `hiddenGemTarget` above 0.5 is a traveller who asked for the
 * finds, and among places their fit cannot separate, the *less* established
 * one reads first — the same magnitude, leaning the other way. At or below the
 * midpoint (classics-minded and balanced alike) the order is exactly what it
 * has always been. A step function rather than a slope for the reason
 * `SIGNIFICANCE_STEP` is a step: the answer behind the number is a four-rung
 * choice, and a continuous multiplier would order boards on distinctions the
 * questionnaire cannot express.
 */
export function establishedOrderingLean(
  profile: Pick<TravelerProfile, 'derived'>,
): 1 | -1 {
  return profile.derived.hiddenGemTarget > NEUTRAL_SIGNIFICANCE ? -1 : 1;
}

/**
 * WHAT AN UNTIMED JOURNEY COSTS THE ORDER, AND WHY IT IS EXACTLY THIS MUCH.
 *
 * §9.1 asks that a top pick mean something. On the stored post-fix Tokyo board —
 * car-free, road matrix by substitution, no transit provider — the two cards at
 * the head of the list were both journeys nobody could establish, while the two
 * stops the traveller could walk to in nineteen and twenty-four minutes sat
 * third and fourth. Nothing about the ranking was arbitrary: the fit scorer
 * cannot see reach, so the order was decided entirely by terms that are blind to
 * whether the traveller can get there.
 *
 * The cost is `SIGNIFICANCE_ORDERING_SHARE / 2` — the most that local standing
 * can ever move a card — so the rule states in one sentence: *being somewhere we
 * can get you is worth as much as being the best-known place in the region, and
 * no more.* Two dimensions the traveller can weigh against each other, neither
 * able to swamp the other.
 *
 * Three things it deliberately is not:
 *
 *   - **not a verdict.** `worthDetourLabel` still refuses to call an unmeasured
 *     journey far, `classifyDetour` still refuses to call it too far, and the
 *     card keeps its band, its badges and its place on the board. This decides
 *     which of two cards the traveller reads first, nothing else.
 *   - **not a band change.** The band leads the comparator and normalises ahead
 *     of this in `boardPriorityOf`, so no amount of reach lifts a card over one
 *     the scorer rates higher — the same structural guarantee significance gets.
 *   - **not a charge on distance.** A measured two-hour journey pays nothing
 *     here. The question is whether anybody established the journey at all.
 */
export const UNVERIFIED_REACH_ORDERING_COST = SIGNIFICANCE_ORDERING_SHARE / 2;

export interface BoardOrdering {
  /**
   * The band's rank, from `FIT_BAND_METER`. Higher is better, and it is total.
   *
   * Read from the meter rather than from a list declared here so that a band
   * added to the scorer gets an ordering without anybody remembering to come
   * back. It also subsumes the "unworkable sorts last" rule the sort used to
   * carry as a special case: `not_workable` is the bottom of that meter.
   */
  bandRank: number;
  /** 0–1. `fit.score` on the scale every term here is expressed in. */
  fitShare: number;
  /** The recorded 0–1 significance, or `null` where nothing established one. */
  significance: number | null;
  /** What that is worth to the order. Exactly 0 where significance is absent. */
  significanceLift: number;
  /**
   * What an unestablished journey costs, as a non-positive number.
   *
   * Exactly 0 for a card at the base, for a card with a resolved journey, and
   * for a caller that did not say — an absent reach is "we were not told",
   * which leans neither way, exactly as an absent significance does.
   */
  reachLift: number;
  /**
   * `fitShare + significanceLift + reachLift`. Only ever compared inside one
   * band.
   */
  withinBand: number;
}

/**
 * THE WITHIN-BAND KEY IS QUANTISED, AND IT IS ABOUT BINARY FLOATS, NOT TASTE.
 *
 * `fitShare` is an integer score over a hundred and `significanceLift` is an
 * already-quantised lean times a constant, so in exact arithmetic every
 * `withinBand` on a board is a clean multiple of a hundredth. In binary they are
 * not: on the stored Tokyo artifact `0.81 + 0.03` came out `0.8400000000000001`
 * and outranked a card whose `0.84` was exact — a real position on a real board
 * decided by the last bit of a double.
 *
 * That would be untidy on its own. What makes it a defect is the planner: it
 * sorts on a scalar, so `boardPriorityOf` folds these two terms into one number,
 * and a difference of one part in 10^16 does not survive the fold. The
 * comparator would then act on a distinction the scalar cannot see, and the trip
 * would come out in a different order from the board — the exact disagreement
 * this section exists to end, reintroduced by arithmetic.
 *
 * A millionth is far finer than either term can express, so this removes the
 * representation error and nothing else.
 */
const ORDERING_QUANTUM = 1e-6;

export function boardOrderingOf(input: {
  place: Place;
  fit: FitAssessment;
  /**
   * The journey this card is an answer about, where the caller has one.
   *
   * Optional so that every existing caller keeps compiling and keeps its exact
   * order — and because the absence is meaningful in the same way
   * `experienceSignificance`'s is. A caller that does not pass a reach has not
   * said the journey is unknown; it has said nothing, and nothing costs nothing.
   * `buildDiscoveryBoard` and the planner both pass the whole candidate, so the
   * two surfaces that have to agree do agree by construction.
   */
  reach?: ReachFromBase;
  /** `base` exempts a card: there is no journey from the bed to the bed. */
  detourClass?: DetourClass;
  /**
   * Which way the lift leans for this traveller — `establishedOrderingLean`.
   *
   * Optional, defaulting to the established-first direction every caller has
   * always had, so a caller that says nothing keeps its exact order. The two
   * surfaces that must agree — the board and the planner's priority — both
   * derive it from the same profile through the same function.
   */
  establishedLean?: 1 | -1;
}): BoardOrdering {
  const lean = significanceLean(input.place);
  const fitShare = input.fit.score / 100;
  const significanceLift =
    SIGNIFICANCE_ORDERING_SHARE * (lean ?? 0) * (input.establishedLean ?? 1);
  const reachLift =
    input.reach !== undefined &&
    input.detourClass !== 'base' &&
    input.reach.status !== 'measured'
      ? -UNVERIFIED_REACH_ORDERING_COST
      : 0;
  return {
    bandRank: FIT_BAND_METER[input.fit.band],
    fitShare,
    significance: input.place.experienceSignificance ?? null,
    significanceLift,
    reachLift,
    withinBand:
      Math.round((fitShare + significanceLift + reachLift) / ORDERING_QUANTUM) * ORDERING_QUANTUM,
  };
}

/** The board's order, as a comparator, so every reader of it agrees. */
export function compareBoardOrder(a: DiscoveryCandidate, b: DiscoveryCandidate): number {
  return (
    b.ordering.bandRank - a.ordering.bandRank ||
    b.ordering.withinBand - a.ordering.withinBand ||
    a.place.id.localeCompare(b.place.id)
  );
}

/** Rungs on the band meter, counting `not_workable`. Read, never assumed. */
const BAND_RUNGS = Math.max(...Object.values(FIT_BAND_METER)) + 1;

/**
 * How far below zero `withinBand` can fall: the significance lean at its most
 * negative, plus the whole of the untimed-journey cost.
 *
 * Derived rather than written down, because the normalisation below has to
 * agree with the terms exactly. A hand-kept constant that fell behind a third
 * term would clamp a real card to zero and silently flatten the bottom of every
 * band into one value.
 */
const WITHIN_BAND_FLOOR = SIGNIFICANCE_ORDERING_SHARE / 2 + UNVERIFIED_REACH_ORDERING_COST;

/**
 * The full width `withinBand` can occupy: one whole fit, plus the lean upward,
 * plus everything below zero. Named so that widening any ordering term cannot
 * silently let a within-band difference reach across a band boundary.
 */
const WITHIN_BAND_WIDTH = 1 + SIGNIFICANCE_ORDERING_SHARE / 2 + WITHIN_BAND_FLOOR;

/**
 * THE SAME ORDER, AS ONE NUMBER, FOR THE READER THAT CANNOT TAKE A COMPARATOR.
 *
 * `compareBoardOrder` is the authority and the planner cannot use it: a planning
 * queue carries a scalar `priority`, sorted and re-sorted in five places, and
 * offset by the band the traveller's own choice puts a place in. So the board's
 * two terms are composed into one figure here — once, beside the comparator they
 * come from — rather than half-copied into `packages/planner/src/candidates.ts`,
 * which is what that file did: `base + candidate.fit.score`, so inside a
 * priority band the plan ordered by match alone while the board ordered by band
 * and then by how much each place matters. Two orders, one traveller, and the
 * trip disagreed with the board it was built from.
 *
 * Two properties, and both are load-bearing:
 *
 *   - **It agrees with the comparator, exactly.** `withinBand` is normalised
 *     against its own full width before it is added, so no amount of standing
 *     can lift a card over one the scorer bands higher — the same structural
 *     guarantee `compareBoardOrder` gets from lexicographic ordering, bought
 *     here arithmetically because a scalar has no second key.
 *   - **It stays on `fit.score`'s scale.** 0–100, deliberately, because the
 *     planner adds this to selection-band offsets a thousand apart and because
 *     `plan.ts` and `edit.ts` promote a pinned place with `10_000 + fitScore`.
 *     A term on any other scale would quietly reorder pinned places against
 *     unpinned ones from two files this change does not touch.
 */
export function boardPriorityOf(ordering: BoardOrdering): number {
  const within = Math.min(
    1,
    Math.max(0, (ordering.withinBand + WITHIN_BAND_FLOOR) / WITHIN_BAND_WIDTH),
  );
  return ((ordering.bandRank + within) / BAND_RUNGS) * 100;
}

// ---------------------------------------------------------------------------
// Which heading a card sits under, and how much of the board one may hold
// ---------------------------------------------------------------------------

/**
 * THE LARGEST SHARE OF A BOARD ONE HEADING MAY HOLD BEFORE IT STOPS GROUPING.
 *
 * §10.2 asks for traveller-friendly groups that mean something. A group means
 * something by *dividing* — and a live Tokyo board had 13 of its 24 cards under
 * "Rainy days and easy days", because `groupsFor` files anything sheltered and
 * easy-going there and in a dense city almost everything is both. A metropolis
 * read as a shelf of rainy-day reserves. Nothing about any individual card was
 * wrong; the heading simply carried no information, in the same way §9.1's
 * twenty-four "Top pick" labels carried none.
 *
 * So the guard is the same guard, one layer along from `MAX_TOP_BAND_SHARE`,
 * and the share is lower for a reason rather than by taste. A label is a verdict
 * each card earns on its own, so most of a board may honestly share one; a group
 * is a *partition*, and with three or more headings in play a third is already
 * the most any one of them can hold and still be a part rather than the whole.
 *
 * What it does **not** do is invent a distinction the data does not support.
 * Over the cap, the lowest-ordered members move to the heading they would have
 * had otherwise — which is a claim their card already supports — and the cards
 * that keep the heading are the ones the board ranks highest, so the reserve
 * shelf holds the best reserves rather than an arbitrary eight.
 *
 * And it is bounded by honesty rather than applied blindly. A heading only sheds
 * where the card underneath it has a *second true* heading to move to, which
 * `groupsFor` declares per card; the verdict groups and the residual distance
 * groups declare none and keep everything they hold. So this cannot promise that
 * no heading ever dominates — a destination where most places genuinely cannot
 * be verified will say so on most of its cards, and should. What it promises is
 * that no heading dominates a board *while a truer one was available*.
 */
export const MAX_BOARD_GROUP_SHARE = 1 / 3;

/**
 * A group has to be over the share *and* hold more than a few cards.
 *
 * The same floor `SHARED_MIN_CARDS` uses one layer up in
 * `apps/web/src/components/BoardCopy.ts`, and for the same reason: on a board of
 * six, three cards under one heading is a group and not a takeover, and a bare
 * share test would shred small boards into headings of two.
 */
export const MIN_CARDS_TO_SWALLOW_A_BOARD = 3;

/**
 * A card, and the headings it could honestly sit under, best first.
 *
 * A single-entry list is the load-bearing case: it says this card has **no**
 * second true heading, so the guard may never move it. That is how the two
 * verdict groups — "Probably skip" and "Worth checking first" — stay honest on a
 * board where most cards genuinely are one or the other, and it is how the
 * residual distance groups avoid being demoted into a claim about shelter that
 * nobody established.
 */
export interface BoardGroupChoice {
  id: string;
  groups: readonly BoardGroup[];
}

/**
 * Settle every card into one heading, with no heading swallowing the board.
 *
 * `choices` arrives in board order, and that is what decides who moves: the
 * excess comes off the tail, so a demotion is always of the cards the board
 * itself ranks lowest. Deterministic, and a group with nothing movable in it
 * keeps every card it has — an honest over-full group beats a dishonest tidy one.
 */
export function calibrateBoardGroups(
  choices: readonly BoardGroupChoice[],
): Map<string, BoardGroup> {
  const assigned = new Map(choices.map((choice) => [choice.id, choice.groups[0]!]));
  if (choices.length === 0) return assigned;

  const cap = Math.max(
    MIN_CARDS_TO_SWALLOW_A_BOARD,
    Math.floor(choices.length * MAX_BOARD_GROUP_SHARE),
  );

  /*
   * Holders are re-read per group rather than counted once, exactly as the band
   * calibration re-reads its own: a group that has just received an overflow is
   * a different group, and deciding from a stale count is how a fix for one
   * heading creates the same defect in the one below it.
   */
  for (const group of BOARD_GROUPS) {
    const holders = choices.filter((choice) => assigned.get(choice.id) === group);
    if (holders.length <= cap) continue;
    const movable = holders.filter((choice) => nextGroup(choice, group) !== group);
    for (const choice of movable.slice(-(holders.length - cap))) {
      assigned.set(choice.id, nextGroup(choice, group));
    }
  }

  return assigned;
}

/** The next heading down this card's own list, or the same one where none is left. */
function nextGroup(choice: BoardGroupChoice, current: BoardGroup): BoardGroup {
  const at = choice.groups.indexOf(current);
  return at < 0 ? current : (choice.groups[at + 1] ?? current);
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
  /**
   * Whether every walking figure on this board is standing in for a scheduled
   * journey nobody could time — `scheduledTransportUnmeasured`, asked of this
   * board's own travel knowledge.
   *
   * Carried out of the board because the pre-selection has to bound a walk the
   * same way the classifier and the planner do, and it is handed candidates
   * rather than knowledge. A fact about the destination's evidence, so it sits
   * on the board rather than on a card.
   */
  transitUnmeasured: boolean;
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
    /**
     * Whether the destination's own evidence records a scheduled network —
     * see `ScheduledNetworkPresence` in the reach module. Optional, and the
     * absence is "nobody said": every caller written before the observation
     * existed keeps its exact board. It is a fact about the ground, supplied
     * by whoever read the destination evidence, never inferred here.
     */
    scheduledNetwork?: ScheduledNetworkPresence | null;
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
  const knowledge = travelKnowledgeFor(
    travel.matrix,
    profile,
    travel.transit,
    travel.scheduledNetwork,
  );
  /*
   * Whether a walking figure on this board is a walk or a stand-in for the
   * scheduled journey nobody could time, asked once from the same predicate the
   * detour classifier and the planner's walking cap read. Carried out on the
   * board because the pre-selection has to bound such a walk exactly as the
   * planner will and is handed candidates rather than knowledge. See
   * `scheduledTransportUnmeasured`.
   */
  const transitUnmeasured = scheduledTransportUnmeasured(knowledge);

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

  /**
   * Each card's own heading preferences, kept beside the cards rather than on
   * them: they are an input to the board-wide settlement below and mean nothing
   * once it has run, and a card carrying both its preferences and its answer
   * would give two readers two ways to ask the same question.
   */
  const groupChoices = new Map<string, readonly BoardGroup[]>();

  const ranked: DiscoveryCandidate[] = assessments
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
         *
         * A journey *classed* unknown passes none either, and the two cases
         * are one rule: `unknown` means no distance verdict can honestly be
         * passed. The second case is the transit-blind walk — a measured
         * walking figure on a trip whose scheduled modes nobody could time —
         * and handing quality those minutes would let it re-derive from raw
         * arithmetic the exact "past how far you said you would go" skip
         * verdict the classifier just declined to pass. The walk itself stays
         * on the card via `travelMinutesFromBase`, as a walk.
         */
        ...(assessment.travelMinutesFromBase === null || assessment.detourClass === 'unknown'
          ? {}
          : { detourMinutes: assessment.travelMinutesFromBase }),
        ...(assessment.travelModeFromBase === null || assessment.detourClass === 'unknown'
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
        /*
         * Only this layer holds the fact, so only this layer can supply it: the
         * one measured journey is a walk, and it is standing in for a scheduled
         * route nobody could time. Without it the skip sentence is built from
         * the two things that are untrue about such a journey — a walking clock
         * for a ride, and "you said" for an answer that ruled nothing out.
         */
        journeyUnverified: transitUnmeasured && assessment.travelModeFromBase === 'walk',
      });
      const groups = groupsFor(
        assessment.place,
        fit.band,
        quality.outcome,
        quality.reasonBasis,
        assessment.detourClass,
      );
      groupChoices.set(assessment.place.id, groups);
      return {
        place: assessment.place,
        fit,
        ...(placeEvidence ? { evidence: placeEvidence } : {}),
        quality,
        ordering: boardOrderingOf({
          place: assessment.place,
          fit,
          reach: assessment.reach,
          detourClass: assessment.detourClass,
          establishedLean: establishedOrderingLean(profile),
        }),
        detourClass: assessment.detourClass,
        travelMinutesFromBase: assessment.travelMinutesFromBase,
        travelModeFromBase: assessment.travelModeFromBase,
        reach: assessment.reach,
        journeyProxy: assessment.journeyProxy,
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
        worthDetour: worthDetourLabel(assessment.detourClass, fit.band, assessment.journeyProxy),
        group: groups[0]!,
      };
    })
    /*
     * The band the traveller is shown, then how much each place matters, then
     * how well it suits them. See `compareBoardOrder`: anything unworkable is
     * the bottom of the meter and still sorts below everything you can do.
     */
    .sort(compareBoardOrder);

  /*
   * Headings are settled *after* the sort, because the guard on a group's share
   * spends the board's own order: over the cap, the cards it ranks lowest are
   * the ones that move. Ordering first is what makes that sentence true.
   */
  const settled = calibrateBoardGroups(
    ranked.map((candidate) => ({
      id: candidate.place.id,
      groups: groupChoices.get(candidate.place.id) ?? [candidate.group],
    })),
  );
  const candidates: DiscoveryCandidate[] = ranked.map((candidate) => ({
    ...candidate,
    group: settled.get(candidate.place.id) ?? candidate.group,
  }));

  const groups = BOARD_GROUPS.map((group) => ({
    group,
    candidates: candidates.filter((candidate) => candidate.group === group),
  })).filter((entry) => entry.candidates.length > 0);

  return { expansion, candidates, groups, integrity, transitUnmeasured };
}

/**
 * Every heading this candidate could honestly sit under, best first.
 *
 * The order of these checks is the editorial priority: a weak fit is called out
 * as such no matter how famous it is, and a genuine hidden gem is never buried
 * under the classics.
 *
 * WHY THIS RETURNS A LIST RATHER THAN A HEADING.
 *
 * It used to return one, and the first branch that matched was final — which is
 * how "Rainy days and easy days" came to hold 13 of a live Tokyo board's 24
 * cards: the shelter-and-effort test is checked before the two distance groups,
 * and in a dense city almost everything is indoors and easy going. The rule was
 * right about each card and useless across all of them.
 *
 * A list separates the two questions that were tangled together. *Which heading
 * suits this card best* is decided here, per card, from the place. *Whether that
 * heading is still saying anything* is a property of the whole board and is
 * decided by `calibrateBoardGroups`, which needs somewhere true to move a card
 * to — and this is where that second truth is stated. A single-entry list means
 * there is no second true heading and the card must not be moved.
 */
function groupsFor(
  place: Place,
  band: FitAssessment['band'],
  outcome: CandidateOutcome,
  /** Which of the three claims the quality layer's sentence makes. */
  reasonBasis: ReasonBasis,
  /**
   * How far out this is *for this traveller*, in the mode they would make the
   * journey in. Read by the two groups whose headings talk about distance.
   */
  detourClass: DetourClass,
): readonly BoardGroup[] {
  /**
   * Evidence outcomes go under the evidence heading, whatever the band says.
   *
   * This tested the band first and sent every `weak` card to `weak_fit`, then
   * routed only `low_confidence` to `needs_verification` — while its own
   * comment named the reason the split exists ("statements about *our*
   * knowledge rather than about the place, and a traveller acts on them
   * differently"). `insufficient_evidence` and the unpriced-journey form of
   * `not_worth_detour` are the same kind of statement and were going to the
   * other heading, so "Probably skip · a poor match for this trip" stood over
   * "Too little is published about this" and over "we could not confirm any
   * route here". Both sentences say we did not check; neither says we weighed
   * it and it lost.
   *
   * `reasonBasis` decides it rather than the outcome list, so the heading a
   * card lands under and the sentence printed on it are two readings of one
   * value and cannot come apart again.
   *
   * Still a verdict with no fallback, on purpose. A board where most places
   * genuinely cannot be verified must say so on most of its cards; moving the
   * excess under a cheerful heading to flatten a distribution would trade a
   * dull board for a dishonest one.
   */
  if (band === 'not_workable' || band === 'weak') return ['weak_fit'];
  /**
   * A CAVEAT ABOUT A CARD IS NOT A SUBSTITUTE FOR WHAT THE CARD IS.
   *
   * `evidence_gap` used to be the first thing tested, ahead of every content
   * heading, and on a dense-metropolis board that meant the heading a traveller
   * read was almost never about the place. Twenty of twenty-four cards on one
   * delivered board and nineteen of twenty-four on another sat under
   * "Promising — check before you go", the destination's principal temple,
   * shrine and palace among them, and "Classics worth your time" rendered on
   * neither board — not because no card earned it, but because the cards that
   * had earned it were routed away before the earning was checked.
   *
   * So a record whose standing something *outside it* established keeps its
   * content heading, and the verification caveat rides on the card, where it
   * already does: every one of these cards carries its own sentence saying what
   * could not be confirmed. `standsAsEstablishedName` is the same predicate the
   * caption uses, so the heading and the sentence cannot come apart.
   *
   * Two conditions, and both are about honesty rather than tidiness:
   *
   *   - `too_far` stays out. "The well-known ones **that still suit how you
   *     travel**" is false of a place this trip cannot reach, and putting it
   *     there would be the board promising what the planner must take back.
   *   - `needs_verification` is kept as the second true heading, so
   *     `calibrateBoardGroups` still has somewhere to move a card if the
   *     classics group over-subscribes.
   */
  if (
    detourClass !== 'too_far' &&
    outcome !== 'closed_or_unavailable' &&
    outcome !== 'redundant' &&
    standsAsEstablishedName(place)
  ) {
    return reasonBasis === 'evidence_gap'
      ? ['must_see_classics', 'needs_verification']
      : ['must_see_classics'];
  }
  if (reasonBasis === 'evidence_gap') return ['needs_verification'];
  if (outcome === 'not_worth_detour') return ['weak_fit'];

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
   *
   * Distance is also the one thing known about every card, which is what makes
   * it the fallback below.
   */
  const byDistance: BoardGroup =
    detourClass === 'stretch' || detourClass === 'too_far' ? 'scenic_detours' : 'nearby_side_quests';

  /*
   * WHICH HEADINGS HAVE A SECOND TRUE ONE UNDER THEM, AND WHICH DO NOT.
   *
   * Only the reserve shelf does, and the asymmetry is a fact about the copy
   * rather than a preference about distributions. "Easy wins · smaller stops
   * that slot into a day rather than reshaping it" is true of anything the
   * backup branch admits — the branch tests for `none` or `easy` going, which is
   * what a small stop *is* — and it is flatly false of a must-see classic, which
   * is the stop a day is built around. Demoting a classic to flatten a
   * distribution would produce exactly the heading-contradicts-contents failure
   * the distance split above exists to end.
   *
   * So a gem and a classic say one thing and say it however much of the board
   * agrees: a destination that really is mostly quiet finds should read that way.
   * The reserve shelf is the one heading that makes a claim about the *trip* —
   * hold this back for when the weather turns — and the one a board can
   * therefore be wrong about as a whole.
   */
  if (place.hiddenGemScore >= 0.6) return ['hidden_gems'];
  /*
   * A classics seat requires standing the evidence actually bought, and the
   * whole of that condition lives in `standsAsEstablishedName` — the same
   * function the fit scorer's "one of the established names here" line reads,
   * because the heading and the caption assert the same thing and two copies
   * of one rule are two rules. It refuses a bounded standing, a prominence
   * below the widely-noted bar, and a prominence nothing pointing at the place
   * ever established.
   *
   * That third refusal used to be "no observed `globalProminence`", and the
   * delivered boards showed what it actually selected for: it is true of a ward
   * park whose catalogue row a mapper linked and false of the destination's
   * principal temple, so "Classics worth your time — the well-known ones"
   * rendered **empty on both metro boards**, and on the third it rendered over
   * exactly one card, a suburban pond, while the destination's famous sites sat
   * elsewhere on the same board. It now turns on `prominenceBasis`, so a
   * standing that was withheld and independently established qualifies and a
   * standing that was merely substituted does not.
   *
   * A refused card keeps its seat and falls through to the groups whose
   * headings it can honestly stand under; if no card earns the heading, the
   * group holds nothing and `buildDiscoveryBoard` drops it — the filter on
   * `candidates.length > 0` where the groups are assembled — which is the same
   * "never render an empty group" rule every other heading follows. Famous is
   * not mandatory, so a board with no classics is a true board, not a broken
   * one.
   */
  if (
    place.weather.poorWeatherBackup &&
    (place.physicalIntensity === 'none' || place.physicalIntensity === 'easy')
  ) {
    return ['low_effort_backups', byDistance];
  }
  return [byDistance];
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
  'removedDuplicateSubject',
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
  removedDuplicateSubject: 'Second records for something already shown',
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
  removedDuplicateSubject:
    'A large site is often mapped several times over. These are the extra records; the place itself is on the board once.',
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
    removedDuplicateSubject: known(undefined, refused.get('duplicate_subject') ?? 0),
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
