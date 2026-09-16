import { deriveAffordances, type DestinationAffordanceProfile } from '../destinations/affordances';
import { rolesFor } from '../intent/roles';
import { deriveOperatingModel, type OperatingType, type TripOperatingModel } from '../operating/model';
import { deriveTravelerIntent } from '../intent/traveler-intent';
import type { TravelerIntent } from '../intent/traveler-intent';
import type { QuestionnaireAnswers, TravelerProfile } from '../schemas/profile';
import type { InterviewContext } from './catalog';

/**
 * V12.1 §25 §26 §27 — WHAT KIND OF TRIP THE ANSWERS SO FAR DESCRIBE.
 *
 * ── THE GAP V12 LEFT ────────────────────────────────────────────────────────
 *
 * `TravelerIntent` and `TripOperatingModel` are derived before the composition
 * call and read by composition, readiness and quality. The **intake** never saw
 * them, so every traveller was asked the same questions in the same order
 * whatever trip they were describing, and V12's own report listed §10/§11 as
 * audited and not implemented.
 *
 * This is the missing join, and it is deliberately small: the operating model is
 * already a pure derivation from intent × affordances × trip facts, and all
 * three of those can be built from what the interview already has. Nothing new
 * is collected and no call is made.
 *
 * ── WHY IT IS DERIVED HERE RATHER THAN PASSED IN ────────────────────────────
 *
 * `InterviewContext` is built by the page, once, and handed to a client
 * component. A diagnosis passed in would be the diagnosis of the *first*
 * screen — and the whole point is that answering "I want to walk the whole
 * thing" should change what is asked next. Deriving it inside `planInterview`
 * from `(ctx, answers)` makes it recompute on every answer, which is what makes
 * the intake feel like it is listening.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * Not a label the traveller ever sees. §25 is explicit: *"Do not expose
 * operating-family terminology."* A question may be *asked because* the trip
 * looks like a trek; it may never say the word.
 *
 * Pure, cheap (table walks over at most 29 traits and 30 interests), and
 * memoised per `(ctx, answers)` pair because `relevance` is called once per
 * question per render.
 */

export interface TripDiagnosis {
  /** The operating family the answers point at. `mixed_regional` is the honest "not yet". */
  type: OperatingType;
  /** 0–1. Below `STABLE_CONFIDENCE` the intake is still working out what this is. */
  confidence: number;
  /** Families that nearly fit, best first. A mixed trip is normal. */
  alternatives: readonly { type: OperatingType; score: number }[];
  intent: TravelerIntent;
  affordances: DestinationAffordanceProfile;
  operating: TripOperatingModel;
}

/**
 * When the family is settled enough to ask its own questions.
 *
 * Deliberately low. A confident family is worth a targeted question, and asking
 * a trek question of somebody who turns out not to be trekking costs one screen
 * — while *not* asking it costs the plan. The stop condition (§29) uses the same
 * number from the other side.
 */
export const STABLE_CONFIDENCE = 0.35;

/**
 * A traveller profile good enough to derive intent from part-answered input.
 *
 * `buildTravelerProfile` needs a `QuestionnaireContext` the selector does not
 * have, and every field `deriveTravelerIntent` reads is on the answers already.
 * So this is the narrow projection rather than a second derivation: the shape
 * the intent derivation asks for, filled from the answers, with the parts it
 * never reads left at their schema defaults.
 */
function profileFrom(answers: QuestionnaireAnswers): TravelerProfile {
  return {
    version: 1,
    interests: answers.interests,
    pace: answers.pace,
    dayStart: answers.dayStart,
    dailyIntensity: answers.dailyIntensity,
    freeTime: answers.freeTime,
    budgetStyle: answers.budgetStyle,
    discoveryMix: answers.discoveryMix,
    crowdTolerance: answers.crowdTolerance,
    avoidTouristTraps: answers.avoidTouristTraps,
    transport: {
      willDrive: answers.willDrive,
      comfortableMountainRoads: answers.comfortableMountainRoads,
      comfortableGravelRoads: answers.comfortableGravelRoads,
      maxDailyTravelMinutes: answers.maxDailyTravelMinutes,
      willUseShuttles: answers.willUseShuttles,
      maxAccessWalkMinutes: answers.maxAccessWalkMinutes,
      priority: answers.transportPriority,
    },
    food: { style: answers.foodStyle, breakfast: answers.breakfastStyle, specialMealBudget: 1, willPackLunch: answers.willPackLunch, dietaryNeeds: answers.dietaryNeeds, dietaryStrict: answers.dietaryStrict },
    regionalExpansion: answers.regionalExpansion,
    detourToleranceMinutes: answers.detourToleranceMinutes,
    avoidances: answers.avoidances,
    preferenceSignals: [],
    accessibility: { mobilityLimited: answers.mobilityLimited },
    interview: {
      baseMoveTolerance: answers.baseMoveTolerance,
      iconicCrowdStrategy: answers.iconicCrowdStrategy,
      convenienceSpend: answers.convenienceSpend,
      lodgingStyle: answers.lodgingStyle,
      rusticLodgingOk: answers.rusticLodgingOk,
      guideWillingness: answers.guideWillingness,
      privateTransfers: answers.privateTransfers,
      boatsAndFerries: answers.boatsAndFerries,
      internalFlights: answers.internalFlights,
      remoteComfort: answers.remoteComfort,
      altitudeComfort: answers.altitudeComfort,
      hikeAppetite: answers.hikeAppetite,
      trailSetting: answers.trailSetting,
      permitSensitiveActivities: answers.permitSensitiveActivities,
      walkingTolerance: answers.walkingTolerance,
      stairsAndHills: answers.stairsAndHills,
      lateNights: answers.lateNights,
      dayTripAppetite: answers.dayTripAppetite,
      scopeStrategy: answers.scopeStrategy,
      everyoneEveryDay: answers.everyoneEveryDay,
    },
    hard: answers.hardConstraints,
    provenance: answers.provenance,
    derived: { activitySlotsPerDay: 3, maxPhysicalIntensity: 'moderate', frequencyCaps: {}, hiddenGemTarget: 0.4, comfortableCostLevel: 2, effectiveDetourMinutes: answers.detourToleranceMinutes },
  } as unknown as TravelerProfile;
}

const CACHE = new WeakMap<QuestionnaireAnswers, { ctx: InterviewContext; diagnosis: TripDiagnosis }>();

/**
 * What kind of trip this is, as far as the answers so far can say.
 *
 * Memoised on the answers object, with the context checked by identity — the
 * selector rebuilds a plan on every answer, and every answer produces a new
 * answers object, so the cache turns forty relevance calls into one derivation
 * and is discarded the moment anything changes.
 */
export function diagnoseTrip(ctx: InterviewContext, answers: QuestionnaireAnswers): TripDiagnosis {
  const cached = CACHE.get(answers);
  if (cached && cached.ctx === ctx) return cached.diagnosis;

  const affordances = deriveAffordances({ destination: ctx.destination });
  const intent = deriveTravelerIntent({
    profile: profileFrom(answers),
    ...(answers.interestRoles ? { interestRoles: answers.interestRoles } : {}),
    ...(ctx.traveller.children > 0 ? { party: { children: ctx.traveller.children } } : {}),
  });
  const operating = deriveOperatingModel({
    intent,
    affordances,
    nights: Math.max(1, ctx.traveller.tripDays - 1),
    willDrive: answers.willDrive,
  });

  const diagnosis: TripDiagnosis = {
    type: operating.type,
    confidence: operating.confidence,
    alternatives: operating.alternatives,
    intent,
    affordances,
    operating,
  };
  CACHE.set(answers, { ctx, diagnosis });
  return diagnosis;
}

/**
 * Whether this trip looks like the given family, allowing for a near miss.
 *
 * A question keyed on the *lead* family alone would never fire on a genuinely
 * mixed trip — and a mixed trip is normal (V12 §44). So a family that is the
 * lead, or a close runner-up, counts: the cost of asking a trek question of a
 * half-trek is one screen; the cost of not asking is a plan that does not know
 * whether anybody is carrying their own gear.
 */
export function looksLike(diagnosis: TripDiagnosis, family: OperatingType): number {
  if (diagnosis.type === family) return Math.max(STABLE_CONFIDENCE, diagnosis.confidence);
  const alternative = diagnosis.alternatives.find((entry) => entry.type === family);
  if (!alternative) return 0;
  /*
   * A RUNNER-UP HAS TO BE A REAL CONTENDER, NOT MERELY PRESENT.
   *
   * `alternatives` holds the top three scoring families, and something always
   * scores. A five-day city break in a transit-rich capital carries
   * `rail_journey` at 0.5 simply because the ground has trains — and the first
   * version of this asked that traveller how they wanted to book their long
   * train legs. Two bars, both needed: an absolute floor, so a weak fit asks
   * nothing, and a share of the lead, so a clear winner is not second-guessed.
   */
  const lead = diagnosis.alternatives[0]?.score ?? 0;
  if (alternative.score < RUNNER_UP_FLOOR || alternative.score < lead * RUNNER_UP_SHARE) return 0;
  /* A genuine runner-up asks its questions more quietly than a lead. */
  return Math.min(0.8, alternative.score * 0.8);
}

/** A family below this scores no questions however close the race. */
const RUNNER_UP_FLOOR = 0.6;
/** And it has to be within this share of the lead to count as a mixed trip at all. */
const RUNNER_UP_SHARE = 0.6;

/**
 * Whether one of a set of families fits, taking the best.
 *
 * Several questions are worth asking of more than one family — "are you carrying
 * your own gear" matters to a trek and to a backpacking trip — and a per-family
 * copy of each would be the same question wearing two ids.
 */
export function looksLikeAny(diagnosis: TripDiagnosis, families: readonly OperatingType[]): number {
  return families.reduce((best, family) => Math.max(best, looksLike(diagnosis, family)), 0);
}

/**
 * Whether the traveller has said enough for the family to be worth acting on.
 *
 * Roles are the signal, not the count of questions answered: the operating model
 * is intent-led by construction, and with no stated role every family scores
 * zero and `mixed_regional` is chosen by default rather than by evidence.
 */
export function intentIsSpecified(answers: QuestionnaireAnswers): boolean {
  const roles = rolesFor({ levels: answers.interests, ...(answers.interestRoles ? { roles: answers.interestRoles } : {}) });
  return Object.values(roles).some((source) => source.basis === 'stated' && source.role !== 'opportunistic' && source.role !== 'avoid');
}
