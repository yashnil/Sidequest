import {
  INTEREST_LABELS,
  INTEREST_LEVEL_LABELS,
  type Interest,
  type InterestLevel,
  type PhysicalIntensity,
} from '../schemas/common';
import type { Place } from '../schemas/place';
import { standsAsEstablishedName, WIDELY_NOTED_PROMINENCE } from '../quality/significance';
import type { TravelerProfile } from '../schemas/profile';
import type { TravelerNeed } from '../schemas/trip';
import { kindEvidences, namesOwnKind } from '../interests/offer';
import type { SatelliteAssessment } from '../region/expansion';
import { describeOpenSeason } from '../region/season';
import type { AccessBlockerCode } from '../access/feasibility';
import { detourToleranceMinutesFor, REACH_MODE_PHRASE } from '../travel/reach';

/**
 * Transparent, deterministic fit scoring.
 *
 * Two design rules hold this together:
 *
 * 1. Feasibility is a gate, not a penalty. A place you cannot reach, cannot
 *    physically do, or that is closed on your dates is not "low scoring" — it is
 *    unavailable, and it says why.
 * 2. Every number that reaches the UI is explainable. Each factor keeps its raw
 *    score, weight and contribution, and the copy shown to the traveller is
 *    generated from those values rather than written separately. That is also
 *    the feature vector a learned ranker would consume later.
 */

/**
 * THE DIMENSIONS OF *MATCH*. SIGNIFICANCE IS NOT ONE OF THEM, AND MAY NOT BE.
 *
 * §9 asks for a ranking whose dimensions stay distinct — personal fit, local
 * significance, uniqueness, hiddenness, evidence quality, logistics, season,
 * budget, frequency — and specifically forbids collapsing them into one opaque
 * notion. Everything in this list answers *does this suit you*. How much a place
 * matters in its own right is a different question with a different answer, it
 * is composed in `quality/significance.ts#composeExperienceSignificance`, and it
 * travels beside the fit rather than inside it.
 *
 * That boundary was tested rather than assumed. Adding `experienceSignificance`
 * here as a tenth weighted factor — bounded at 0.1, renormalised so an authored
 * place with no such field scored exactly as before — made the product strictly
 * worse, and the reason is a scale mismatch rather than a bug. The nine factors
 * above occupy 0.75–1.0 for any candidate worth showing; significance occupies
 * 0.12–0.6 for real records, because most of the scale is reserved for places
 * the world has actually written about. Averaging the two deflates every
 * compiled candidate by the gap. Measured on the §29 B dense-city world: the
 * board's three `strong` cards all fell to `good` or `optional`, and the plan
 * lost a stop — days of 2,3,2 became 2,2,2, which is a thinner trip bought with
 * no gain in ordering.
 *
 * `interestMatch` is where the traveller's *category preference* lives, and it
 * is a preference of theirs rather than a prior about kinds — so nothing in this
 * file multiplies a score by a category weight, and `significance-is-not-fit` in
 * `fit.test.ts` fails if anything starts to.
 */
export const FIT_FACTORS = [
  'interestMatch',
  'detourFit',
  'intensityFit',
  'hiddenGemAlignment',
  'crowdComfort',
  'seasonFit',
  'budgetFit',
  'logisticsEase',
  'transportFit',
] as const;
export type FitFactorId = (typeof FIT_FACTORS)[number];

const WEIGHTS: Record<FitFactorId, number> = {
  interestMatch: 0.28,
  detourFit: 0.12,
  intensityFit: 0.11,
  hiddenGemAlignment: 0.11,
  crowdComfort: 0.1,
  seasonFit: 0.1,
  budgetFit: 0.08,
  logisticsEase: 0.06,
  transportFit: 0.04,
};

export const FIT_FACTOR_LABELS: Record<FitFactorId, string> = {
  interestMatch: 'Matches your interests',
  detourFit: 'Distance from base',
  intensityFit: 'Effort level',
  hiddenGemAlignment: 'Famous vs. hidden',
  crowdComfort: 'Crowds',
  seasonFit: 'Seasonal access',
  budgetFit: 'Cost',
  logisticsEase: 'Logistics',
  transportFit: 'Getting there',
};

export type FitBand = 'top_pick' | 'strong' | 'good' | 'optional' | 'weak' | 'not_workable';

export const FIT_BAND_LABELS: Record<FitBand, string> = {
  top_pick: 'Top pick for you',
  strong: 'Strong fit',
  good: 'Good fit',
  optional: 'Optional',
  weak: 'Probably skip',
  not_workable: 'Not workable this trip',
};

/** Five-step meter. Deliberately coarse — the underlying score is not that precise. */
export const FIT_BAND_METER: Record<FitBand, number> = {
  top_pick: 5,
  strong: 4,
  good: 3,
  optional: 2,
  weak: 1,
  not_workable: 0,
};

export type BlockerCode =
  | 'needs_car'
  | 'no_way_in'
  | 'service_unavailable'
  | 'mode_declined'
  | 'closed_on_your_dates'
  /** Reachable, but nobody will let you in on any day of this trip. */
  | 'no_open_hours'
  | 'exceeds_daily_travel'
  | 'avoided_interest'
  | 'rough_road'
  | 'no_services'
  | 'too_strenuous'
  | 'mobility'
  | 'too_expensive';

/**
 * Access blockers speak the language of transport; fit blockers speak the
 * language of the board. This is the one place the two vocabularies meet, so a
 * card can say "there is no way to reach this without your own vehicle" rather
 * than "logistics".
 */
function blockerCodeFor(code: AccessBlockerCode): BlockerCode {
  switch (code) {
    case 'needs_private_vehicle':
      return 'needs_car';
    case 'service_out_of_season':
    case 'service_not_operating':
    case 'private_vehicle_prohibited':
      return 'service_unavailable';
    // Not "the service is unavailable" — the service runs, and the traveller
    // ruled it out. Different fact, different remedy.
    case 'shuttle_declined':
      return 'mode_declined';
    case 'walk_too_long':
      return 'too_strenuous';
    default:
      return 'no_way_in';
  }
}

export interface Blocker {
  code: BlockerCode;
  message: string;
}

export interface FitFactor {
  id: FitFactorId;
  label: string;
  weight: number;
  /** 0-1 raw factor score. */
  score: number;
  /** weight * score — how much this factor added to the total. */
  contribution: number;
}

export interface FitAssessment {
  placeId: string;
  /** 0-100. Never shown as a bare number in the UI; the band is what people see. */
  score: number;
  band: FitBand;
  /**
   * True when the band was capped because nothing establishes this place's
   * significance — no knowledge base, no second catalogue, no authority.
   *
   * The live failure this encodes: twenty-four of twenty-four cards read
   * "Strong fit" while every trust panel underneath said "0 of 6 checked". A
   * fit score is a statement about *match*, and match against a place nobody
   * has verified cannot honestly exceed "worth considering". The UI reads this
   * to say so ("looks promising — not verified yet") instead of overclaiming.
   */
  evidenceLimited?: boolean;
  factors: FitFactor[];
  /** Flat numeric view of the same factors, for logging and future model training. */
  features: Record<FitFactorId, number>;
  blockers: Blocker[];
  reasons: string[];
  cautions: string[];
  /** The interest that drove the match, when there was one. */
  primaryInterest?: Interest;
  /**
   * Every interest this place genuinely satisfies for this traveller. A hike to a
   * viewpoint is both a hike and a viewpoint, and it has to count against both
   * frequency ceilings or "a few hikes" quietly becomes six.
   */
  matchedInterests: Interest[];
}

export interface ScoringContext {
  profile: TravelerProfile;
  travelerNeeds: TravelerNeed[];
}

const LEVEL_WEIGHT: Record<InterestLevel, number> = {
  avoid: 0,
  low: 0.35,
  occasional: 0.6,
  frequent: 0.85,
  core: 1,
};

const INTENSITY_ORDER: PhysicalIntensity[] = ['none', 'easy', 'moderate', 'strenuous'];

export function scorePlace(
  assessment: SatelliteAssessment,
  context: ScoringContext,
): FitAssessment {
  const { place, season, detourClass, travelMinutesFromBase, travelModeFromBase } = assessment;
  const { profile, travelerNeeds } = context;
  const derived = profile.derived;
  /*
   * The journey, and the mode it is made in, from the shared resolver. Both may
   * be absent — nothing was measured — and every use below has to say what it
   * does about that rather than substituting a number.
   */
  const travelMinutes = travelMinutesFromBase;
  const travelMode = travelModeFromBase;
  /** True only where the traveller is the one at the wheel. */
  const isDriving = travelMode === 'drive' && assessment.access.requiredModes.includes('drive');

  /**
   * HOW STRONGLY THEY SAID NO, WHERE "NO" WAS NOT A REFUSAL.
   *
   * `profile.avoidances` is a boolean list, and a boolean can only ever mean
   * "remove this". That was the whole of the free-text reader's effect on a
   * board: somebody who wrote "not massively into long walks" had it recorded
   * identically to somebody who wrote "no hiking", and a category vanished.
   *
   * The taxonomy now separates polarity from magnitude, and `avoidances` holds
   * only the signals that passed `canApplyAsExclusion` — an explicit,
   * deterministic, confirmed refusal. Everything softer arrives here instead, as
   * a number between 0 and 1, and it **ranks** rather than removes.
   *
   * Zero for a profile with no interpreted preferences, so every existing score
   * is unchanged. That is the property that makes this safe to add to a scorer
   * with a dozen tuned constants: the new term contributes nothing until somebody
   * has actually said something.
   */
  const refusal = (key: string): number => {
    let strongest = 0;
    for (const signal of profile.preferenceSignals ?? []) {
      if (signal.key !== key) continue;
      if (signal.polarity !== 'refuses') continue;
      /*
       * An exclusionary signal is already in `avoidances` and has already had its
       * effect there. Counting it again here would penalise it twice — once by
       * removing the place and once by lowering the score of a place that is
       * gone.
       */
      if (signal.exclusionary) continue;
      strongest = Math.max(strongest, signal.magnitude);
    }
    return strongest;
  };

  const blockers: Blocker[] = [];
  const cautions: string[] = [];

  // --- Interest match -----------------------------------------------------
  const levels = place.interests.map((interest) => ({
    interest,
    level: profile.interests[interest] ?? 'low',
  }));
  const ranked = [...levels].sort(
    (a, b) =>
      LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level] || a.interest.localeCompare(b.interest),
  );
  const best = ranked[0];
  const bestWeight = best ? LEVEL_WEIGHT[best.level] : 0;
  // The place's own dominant character, filtered through what the traveller
  // wants: the first interest it actually leads with that they care about.
  const primary =
    levels.find(({ level }) => LEVEL_WEIGHT[level] >= 0.6) ??
    (bestWeight > 0 ? best : undefined);
  const matchCount = levels.filter(({ level }) => LEVEL_WEIGHT[level] >= 0.6).length;
  const interestMatch = clamp01(bestWeight * 0.85 + (Math.min(matchCount, 3) / 3) * 0.15);

  if (bestWeight === 0) {
    blockers.push({
      code: 'avoided_interest',
      message: `This is entirely ${place.interests
        .map((interest) => INTEREST_LABELS[interest].toLowerCase())
        .join(' and ')}, which you asked us to skip.`,
    });
  }

  // --- Season -------------------------------------------------------------
  const seasonFit = season.status === 'open' ? 1 : season.status === 'partially_open' ? 0.55 : 0;
  if (season.status === 'closed') {
    blockers.push({
      code: 'closed_on_your_dates',
      message: `${describeOpenSeason(place)} — it will not be reachable on your dates.`,
    });
  } else if (season.status === 'partially_open') {
    cautions.push(
      `Only reachable for part of your trip window. ${season.note ?? describeOpenSeason(place)}`,
    );
  } else if (place.seasonalAccess.closureRisk === 'high' && season.note) {
    cautions.push(season.note);
  }
  // --- Opening hours ------------------------------------------------------
  // A separate gate from the season above, and from transport below. The season
  // says whether the road is open; this says whether anyone is there to let you
  // in. A place can pass one and fail the other, and the card has to say which.
  const operating = assessment.operating;
  if (operating.status === 'closed_throughout') {
    blockers.push({
      code: 'no_open_hours',
      // Any weekday closure among the dates is the more specific answer, and on
      // a trip that straddles a season boundary it need not be the first one.
      message: `${place.name} is shut on every day of your trip${
        operating.byDate.some((entry) => entry.closedReason === 'closed_weekday')
          ? ' — your dates fall on the days of the week it does not open.'
          : ' — your dates fall outside its season.'
      }`,
    });
  } else if (operating.status === 'open_some_days') {
    cautions.push(
      `Open on ${operating.openDates.length} of your ${operating.byDate.length} days — we will only put it on one of those.`,
    );
  }
  if (operating.status === 'unknown') {
    cautions.push(
      'We could not confirm its opening hours. Check them before you build a day around it.',
    );
  }
  if (operating.lastAdmissionSummary) cautions.push(operating.lastAdmissionSummary);
  cautions.push(...operating.cautions);

  // --- Transport ----------------------------------------------------------
  // Whether the traveller can get here at all is not a score, it is a fact, and
  // it comes from the access rules rather than from a guess about this place.
  const access = assessment.access;
  let transportFit = access.status === 'open' ? 1 : access.status === 'partial' ? 0.55 : 0;
  if (access.status === 'blocked') {
    for (const blocker of access.blockers) {
      blockers.push({ code: blockerCodeFor(blocker.code), message: blocker.message });
    }
  } else {
    cautions.push(...access.cautions);
    if (access.requiredModes.includes('shuttle') || access.requiredModes.includes('public_bus')) {
      // Someone else is driving, which is a different day and worth saying.
      transportFit = Math.min(transportFit, 0.9);
    }
  }
  if (assessment.travelBudgetShare > 1 && assessment.reach.status === 'measured') {
    /*
     * A HARD BLOCKER ONLY FOR TIME AT A WHEEL THE TRAVELLER IS HOLDING.
     *
     * The driving cap is the traveller's own stated answer, so exceeding it is
     * a fact they recognise and the sentence quotes them fairly. The transport
     * cap for a non-driver is a product default — the question that would set
     * it is never shown to them — and a hard refusal built on a number somebody
     * never said, phrased as "you said", is a lie with a citation. Worse, it
     * voided the whole fit assessment: a seventy-eight-minute measured train to
     * a strong-fit candidate became `not_workable` and a skip-list row over a
     * threshold three minutes wide.
     *
     * A non-driving journey past the transport budget is still marked: the
     * detour classifier calls it `too_far` from the same arithmetic, the card
     * says so, and auto-pick leaves it alone. What it is not is unworkable —
     * the traveller may take it anyway, and the planner will lay the day out
     * against the same caps and say honestly what fits.
     */
    if (isDriving) {
      blockers.push({
        code: 'exceeds_daily_travel',
        message: `${assessment.reach.roundTripMinutes} min of driving round trip is past the ${profile.transport.maxDailyDriveMinutes} min at the wheel you said you would accept in a day.`,
      });
    } else {
      cautions.push(
        `Getting there and back is about ${assessment.reach.roundTripMinutes} min ${REACH_MODE_PHRASE[assessment.reach.mode]} — more than a day of this trip comfortably holds.`,
      );
    }
  }

  const roughRoad = place.access.roadSurface !== 'paved';
  if (roughRoad) {
    const refuses =
      profile.avoidances.includes('rough_or_gravel_roads') ||
      (place.access.roadSurface === 'unpaved' && !profile.transport.comfortableGravelRoads);
    if (refuses) {
      blockers.push({
        code: 'rough_road',
        message: 'The approach is unpaved, which you said you would rather avoid.',
      });
    } else {
      cautions.push('The last stretch of road is unpaved.');
    }
  }
  if (place.access.mountainRoad && !profile.transport.comfortableMountainRoads) {
    cautions.push('Steep mountain road with drop-offs.');
  }
  if (place.access.remoteNoServices) {
    if (profile.avoidances.includes('remote_areas_without_services')) {
      blockers.push({
        code: 'no_services',
        message: 'No fuel, food or reliable signal out here, which you asked us to avoid.',
      });
    } else {
      cautions.push('No services nearby — bring water and fuel up first.');
    }
  }

  // --- Physical intensity -------------------------------------------------
  // Peaks at the effort they want, falls off in both directions, and falls off
  // much faster above their ceiling than below it.
  const placeIntensity = INTENSITY_ORDER.indexOf(place.physicalIntensity);
  const maxIntensity = INTENSITY_ORDER.indexOf(derived.maxPhysicalIntensity);
  const preferredIntensity = INTENSITY_ORDER.indexOf(derived.preferredPhysicalIntensity);
  const fromPreferred = placeIntensity - preferredIntensity;
  const overCeiling = placeIntensity - maxIntensity;

  let intensityFit: number;
  if (overCeiling > 0) {
    intensityFit = overCeiling === 1 ? 0.3 : 0.1;
  } else if (fromPreferred === 0) {
    intensityFit = 1;
  } else if (fromPreferred < 0) {
    // Easier than they asked for is fine — a viewpoint is not a failure — but a
    // trip of nothing but car parks is not what "intense" meant either.
    intensityFit = fromPreferred === -1 ? 0.9 : 0.75;
  } else {
    intensityFit = 0.8;
  }

  if (profile.accessibility.mobilityLimited && placeIntensity > INTENSITY_ORDER.indexOf('easy')) {
    blockers.push({
      code: 'mobility',
      message: 'The terrain here is beyond what you told us works for your group.',
    });
  } else if (
    profile.avoidances.includes('strenuous_activity') &&
    place.physicalIntensity === 'strenuous'
  ) {
    blockers.push({
      code: 'too_strenuous',
      message: 'A sustained climb, and you asked us to leave strenuous activity out.',
    });
  } else if (
    profile.avoidances.includes('long_hikes') &&
    place.category === 'day_hike' &&
    place.typicalDurationMinutes > 180
  ) {
    blockers.push({
      code: 'too_strenuous',
      message: 'A half-day hike, and you asked us to skip the long ones.',
    });
  }

  /*
   * The graded half of the same two statements the blockers above make.
   *
   * A soft refusal cannot reach `avoidances`, so it cannot reach those branches;
   * it lands here and lowers the fit of exactly the places the hard version would
   * have removed. Half weight, because "I would rather not" should move a place
   * down the board and must not move it off.
   */
  if (place.physicalIntensity === 'strenuous') {
    intensityFit = clamp01(intensityFit - refusal('avoidance:strenuous_activity') * 0.5);
  }
  if (place.category === 'day_hike' && place.typicalDurationMinutes > 180) {
    intensityFit = clamp01(intensityFit - refusal('avoidance:long_hikes') * 0.5);
  }

  if (
    travelerNeeds.includes('altitude_sensitive') &&
    place.physicalIntensity !== 'none' &&
    place.tags.some((tag) => tag === 'alpine' || tag === 'high-trailhead')
  ) {
    cautions.push('Real effort above 10,000 ft — worth saving for later in the trip.');
  }

  // --- Cost ---------------------------------------------------------------
  const costDelta = place.costLevel - derived.comfortableCostLevel;
  let budgetFit = costDelta <= 0 ? 1 : costDelta === 1 ? 0.6 : costDelta === 2 ? 0.25 : 0.1;
  if (place.costLevel >= derived.comfortableCostLevel + 1) {
    budgetFit = clamp01(budgetFit - refusal('avoidance:expensive_activities') * 0.4);
  }
  if (profile.avoidances.includes('expensive_activities') && place.costLevel >= 3) {
    blockers.push({
      code: 'too_expensive',
      message: 'One of the pricier tickets in the area, which you asked us to leave out.',
    });
  }

  // --- Crowds -------------------------------------------------------------
  const crowdTolerance = profile.avoidances.includes('crowds_and_tourist_traps')
    ? 'avoid_crowds'
    : profile.crowdTolerance;
  const crowdTable = {
    avoid_crowds: { quiet: 1, moderate: 0.8, busy: 0.35, very_busy: 0.15 },
    mild: { quiet: 1, moderate: 0.9, busy: 0.65, very_busy: 0.45 },
    dont_mind: { quiet: 1, moderate: 1, busy: 0.9, very_busy: 0.85 },
  } as const;
  let crowdComfort: number = crowdTable[crowdTolerance][place.crowdLevel];
  /*
   * A THRESHOLD THAT ONLY THE NAME COUNT KEPT ALIVE.
   *
   * This read `popularityScore >= 0.8`, and the highest prominence the standing
   * model could reach was 0.81 — attainable only by a record that held an open
   * identifier, a second catalogue *and* four translated names. Removing the
   * name count from prominence would have taken this branch below the ceiling
   * and killed it silently. The bar now comes from the model that produces the
   * number, so a threshold nothing can clear cannot be written here again.
   */
  if (
    profile.avoidTouristTraps &&
    place.popularityScore >= WIDELY_NOTED_PROMINENCE &&
    place.hiddenGemScore <= 0.2
  ) {
    crowdComfort = clamp01(crowdComfort - 0.15);
  }

  // --- Famous vs. hidden --------------------------------------------------
  const hiddenGemAlignment = clamp01(1 - Math.abs(place.hiddenGemScore - derived.hiddenGemTarget));


  // --- Detour -------------------------------------------------------------
  /*
   * THE RADIUS IS A PROPERTY OF THE MODE, NOT OF THE TRAVELLER ALONE.
   *
   * `effectiveDetourMinutes` is a driving figure, and for anybody who said they
   * would not drive it is replaced wholesale by a constant twenty. Dividing a
   * measured twenty-seven-minute train ride by that gave a ratio of 1.35 and a
   * `detourFit` of 0.45 — a ten-point penalty for taking the metro in a city
   * with one, on evidence this product paid to measure.
   *
   * `detourToleranceMinutesFor` is the same function the detour classifier uses,
   * so the score and the class cannot disagree about what "within tolerance"
   * means.
   */
  const radius = Math.max(detourToleranceMinutesFor(profile, travelMode ?? 'drive'), 1);
  /*
   * An unresolved journey scores neutrally rather than badly. There is no ratio
   * to compute, and defaulting the minutes to anything at all would turn a
   * provider failure into a verdict about the place. 0.6 sits between "inside
   * the radius" and "past it", which is exactly what "we do not know" means
   * here.
   *
   * A journey *classed* unknown scores neutrally for the same reason and by the
   * same rule, and the quality layer already draws the line in these words. The
   * case is the transit-blind walk: a measured walking figure on a trip whose
   * scheduled modes nobody could time. Dividing those minutes by any radius
   * re-derives, from raw arithmetic, the distance verdict the classifier
   * declined to pass — on a live car-free dense-metro board that arrived as a
   * ten-point penalty and a `weak` band on every canonical seat, each one a
   * thirty-nine to seventy minute walk standing in for a train. The walk itself
   * stays on the card as a walk.
   */
  let detourFit: number;
  if (detourClass === 'base') detourFit = 1;
  else if (travelMinutes === null || detourClass === 'unknown') detourFit = 0.6;
  else {
    const ratio = travelMinutes / radius;
    detourFit = ratio <= 0.5 ? 1 : ratio <= 1 ? 0.85 : ratio <= 1.5 ? 0.45 : 0.15;
  }
  if (
    isDriving &&
    place.travelFromBase.driveIsScenic &&
    LEVEL_WEIGHT[profile.interests.scenic_drives ?? 'low'] >= 0.6
  ) {
    detourFit = clamp01(detourFit + 0.1);
  }
  /*
   * "Long drives" is an answer about driving. Applied to a train it charged a
   * car-free traveller for a preference they were never asked to hold, and the
   * questionnaire never offers them the driving questions at all.
   */
  if (isDriving && travelMinutes !== null && travelMinutes > radius) {
    if (profile.avoidances.includes('long_drives')) detourFit = clamp01(detourFit - 0.2);
    else detourFit = clamp01(detourFit - refusal('avoidance:long_drives') * 0.4);
  }

  // --- Logistics ----------------------------------------------------------
  /*
   * Parking is a fact about arriving in a car. Charging it to somebody who will
   * arrive on foot or by train is the same category of error as timing their
   * journey off a road matrix: a real property of the place, applied to a
   * journey nobody is making. It cost up to 3.3 points of 100 on every card of
   * every car-free board, uniformly enough to look like a scoring baseline.
   */
  const parkingMatters = profile.transport.willDrive;
  let logisticsEase =
    !parkingMatters || place.access.parkingDifficulty === 'easy'
      ? 1
      : place.access.parkingDifficulty === 'moderate'
        ? 0.75
        : 0.45;
  if (place.access.remoteNoServices) {
    logisticsEase -= 0.15 + refusal('avoidance:remote_areas_without_services') * 0.4;
  }
  if (roughRoad) logisticsEase -= 0.1 + refusal('avoidance:rough_or_gravel_roads') * 0.4;
  if (place.typicalDurationMinutes > 240) logisticsEase -= 0.1;
  if (place.typicalDurationMinutes > 300 && profile.pace === 'slow') logisticsEase -= 0.1;
  logisticsEase = clamp01(logisticsEase);

  if (parkingMatters && place.access.parkingDifficulty === 'hard') {
    cautions.push('Parking fills early — go first thing or expect to wait.');
  }

  const features: Record<FitFactorId, number> = {
    interestMatch,
    detourFit,
    intensityFit,
    hiddenGemAlignment,
    crowdComfort,
    seasonFit,
    budgetFit,
    logisticsEase,
    transportFit,
  };

  const factors: FitFactor[] = FIT_FACTORS.map((id) => ({
    id,
    label: FIT_FACTOR_LABELS[id],
    weight: WEIGHTS[id],
    score: features[id],
    contribution: WEIGHTS[id] * features[id],
  }));

  const raw = factors.reduce((total, factor) => total + factor.contribution, 0);
  const score = Math.round(raw * 100);
  const uncapped: FitBand = blockers.length > 0 ? 'not_workable' : bandFor(score);

  /*
   * ZERO VERIFIED SIGNIFICANCE CAPS THE LABEL, WHATEVER THE MATCH SAYS.
   *
   * The test is deliberately narrow. `evidenceRichness` defined means this is
   * a compiled record whose standing was assessed; both significance channels
   * absent means that assessment established nothing — no knowledge base, no
   * corroborating catalogue, no authority, not even the region's own naming.
   * An authored place carries none of these fields and is exempt: curation is
   * itself the evidence there. The cap lands on `good` — "worth considering"
   * — because excitement about an unverified place is allowed and a top label
   * on one is a lie with a meter beside it.
   */
  const evidenceLimited =
    place.evidenceRichness !== undefined &&
    place.globalProminence === undefined &&
    place.localSignificance === undefined;
  const band: FitBand =
    evidenceLimited && (uncapped === 'top_pick' || uncapped === 'strong') ? 'good' : uncapped;

  return {
    placeId: place.id,
    score,
    band,
    ...(evidenceLimited ? { evidenceLimited } : {}),
    factors,
    features,
    blockers,
    reasons: buildReasons({ place, assessment, context, features, band }),
    cautions: dedupe([...cautions, ...(place.logisticsNote ? [place.logisticsNote] : [])]),
    matchedInterests: levels
      .filter(({ level }) => LEVEL_WEIGHT[level] >= 0.6)
      .map(({ interest }) => interest)
      .sort(),
    ...(primary ? { primaryInterest: primary.interest } : {}),
  };
}

/**
 * Thresholds are set so that "Top pick" stays rare enough to mean something. A
 * well-matched traveller in a region that suits them should see a handful, not
 * a board where everything is a top pick.
 */
function bandFor(score: number): FitBand {
  if (score >= 88) return 'top_pick';
  if (score >= 78) return 'strong';
  if (score >= 66) return 'good';
  if (score >= 52) return 'optional';
  return 'weak';
}

interface ReasonInput {
  place: Place;
  assessment: SatelliteAssessment;
  context: ScoringContext;
  features: Record<FitFactorId, number>;
  band: FitBand;
}

/**
 * THE INTEREST A REASON MAY NAME: GRADED BY THE TRAVELLER, CARRIED BY THE KIND.
 *
 * The sentence this feeds says "you marked X … and that is what this delivers",
 * and its second clause is a claim about the record's own kind. On a live board
 * that claim was made from the stamped interest alone, and stamps arrive
 * through the thirteen-value category bucket — so a theme park filed under the
 * food category told a food-graded traveller that a theme park was their food
 * interest delivered, and an easy city park was dressed as a core
 * scenic-viewpoint pick. Field-backed in form, false in substance.
 *
 * So where a record names its own kind (`namesOwnKind` — the display noun or
 * the source's leaf category, which every compiled place carries), the named
 * interest must be one that kind actually evidences (`kindEvidences`). The
 * first qualifying graded interest in the place's own order keeps the
 * "leads with" semantics the reason tests pin. An authored place names no
 * kind and keeps the curated behaviour — its interests were written by the
 * same hand as its category. Where nothing qualifies, no interest is named,
 * and the reason falls through to the standing, trade-off and locality lines
 * that are true of any record.
 */
function spokenInterestFor(
  place: Place,
  profile: TravelerProfile,
): { interest: Interest; level: InterestLevel } | undefined {
  const graded = place.interests
    .map((interest) => ({
      interest,
      level: profile.interests[interest] ?? ('low' as InterestLevel),
    }))
    .filter(({ level }) => LEVEL_WEIGHT[level] >= 0.6);
  if (!namesOwnKind(place)) return graded[0];
  return graded.find(({ interest }) => kindEvidences(place, interest));
}

/**
 * CLAUSES THAT DESCRIBE OUR RECORD RATHER THAN THE PLACE.
 *
 * The compiler's fallback description is a category noun followed by whatever
 * the source record happened to carry, and three of those clauses are about the
 * record: the local name (which the card already prints under the heading), the
 * body that manages it, and a sentence named after the map data (duplicated by
 * the cost chip beside it). `describedFacts` states the rule they break in its
 * own header — *never provenance; every entry restates something a source
 * recorded about the place*.
 *
 * They are stripped **here**, in core, rather than at one render site, because
 * they reach a traveller by more than one route and the first repair only
 * closed the quiet one. A delivered board suppressed the small secondary line
 * on five of twenty-four Tokyo cards and seven of twenty-four Osaka cards while
 * the card's *headline* argument printed the identical paragraph in full —
 * "…and that is what this delivers: An easy walk. Known locally as X. Run by Y.
 * The map data records a charge to enter. Mapped at roughly 1000 m across."
 * That line is composed from `place.shortDescription` right here.
 *
 * The measurement is kept but may not stand alone: how big a thing is belongs
 * on a description that earned its place and may not *be* one.
 */
const RECORD_CLAUSES: readonly RegExp[] = [
  /\bKnown locally as [^.]*\.\s*/g,
  /\bRun by [^.]*\.\s*/g,
  /\bThe map data records [^.]*\.\s*/g,
];

const MEASUREMENT_CLAUSE = /\bMapped at roughly [^.]*\.\s*/g;

/**
 * The part of a compiled description that is about the place, or null when
 * nothing substantive is left.
 *
 * One implementation for every surface that prints a description to a
 * traveller: the fit reason below, the card's fallback line, and anything that
 * follows them. Two copies of this rule are how the headline and the secondary
 * line came to disagree about the same sentence.
 */
export function descriptionAboutThePlace(description: string): string | null {
  let text = description.trim();
  for (const pattern of RECORD_CLAUSES) text = text.replace(pattern, '');
  text = text.replace(/\s{2,}/g, ' ').trim();
  return substantiveDescription(text.replace(MEASUREMENT_CLAUSE, '').trim()) ? text : null;
}

/**
 * Whether a description says anything.
 *
 * The bare-stub form — an article, a noun phrase, a full stop — is exactly
 * what §8.7 names, and it is what a compiler emits for a record it knows
 * nothing about. The length floor catches the same shape with a couple of
 * extra words. Applied by `descriptionAboutThePlace` to what is *left* after
 * the record clauses come out, because those clauses are precisely what pushed
 * a stub past it.
 */
function substantiveDescription(description: string): boolean {
  if (description.length < 45) return false;
  return !/^an?\s+[a-z\s]+\.\s*$/i.test(description);
}

/**
 * "Why this fits you" is generated from the same numbers that produced the score,
 * so the explanation cannot drift from the ranking. When a place does not fit,
 * this says that plainly instead of manufacturing enthusiasm.
 *
 * A REASON LEADS WITH THE STRONGEST TRUE CONNECTION, AND EVERY CLAUSE HAS A
 * BACKING FIELD.
 *
 * Measured on a live Tokyo board: of twenty-one card reasons, eleven were the
 * logistics-only travel-time form, six were a locality line, and two named a
 * graded interest. The material for better sentences was already in this
 * function's inputs — the graded levels, the place's own description, its
 * standing, the detour verdict — but the interest sentence was identical on
 * every card sharing a grade, and the board's one-sentence-per-card rule
 * (`whysForBoard`) then discarded every copy after the first. What survived on
 * most cards was the one line unique to each: its travel time.
 *
 * The hierarchy, strongest first, each clause guarded by the field that makes
 * it true:
 *
 *   1. The traveller's graded interest, by name, with what this place offers
 *      for it — the place's own description, which makes the sentence concrete
 *      and different on every card. Composed only when the description says
 *      something (§8.7's bare-stub forms do not qualify): "you like X and this
 *      is X" with no offer named is the §9.2 tautology however it is phrased.
 *      And only when the record's own kind carries the interest — a claim
 *      stamped through the category bucket is how a theme park came to be
 *      "delivered" as food (`spokenInterestFor`).
 *   2. The earned detour, when the classifier called the journey a stretch and
 *      the scorer still called the match strong — the most specific fact about
 *      such a candidate is why it is on the board at all.
 *   3. Established standing, when the record establishes it and the traveller
 *      asked for names at all.
 *   4. The specific trade-off the scorer found — a quiet find for a
 *      crowd-avoider, a stop off the standard loop for a hidden-gem lean,
 *      effort that lines up, a free stop on a tight budget.
 *   5. Logistics. Appended after the personal case, and allowed to lead only
 *      when nothing personal is true — nearness is a fact worth one line,
 *      never the whole argument.
 */
function buildReasons(input: ReasonInput): string[] {
  const { place, assessment, context, features, band } = input;
  const { profile } = context;

  if (band === 'not_workable') return [];

  const connections: string[] = [];

  // 1 — the graded interest, connected to what the place concretely offers.
  //     Named only where the record's own kind carries the interest — see
  //     `spokenInterestFor` for the bucket-laundered claims this refuses.
  const offer = descriptionAboutThePlace(place.shortDescription);
  const spoken = spokenInterestFor(place, profile);
  if (spoken && offer !== null) {
    connections.push(
      `You marked ${INTEREST_LABELS[spoken.interest].toLowerCase()} as "${INTEREST_LEVEL_LABELS[
        spoken.level
      ].toLowerCase()}", and that is what this delivers: ${offer.endsWith('.') ? offer : `${offer}.`}`,
    );
  }

  // 2 — the earned detour. The most specific fact about a stretch candidate is
  //     why it is on the board at all, so it outranks the generic standing line.
  if (
    assessment.detourClass === 'stretch' &&
    assessment.reach.status === 'measured' &&
    (band === 'top_pick' || band === 'strong')
  ) {
    /*
     * "Stretch" is the detour classifier's own verdict — past the radius the
     * traveller stated, short of unreachable — and the band beside it is the
     * scorer still calling the match strong. Only that pair earns the label.
     */
    connections.push(
      `${assessment.reach.travelMinutes} min ${REACH_MODE_PHRASE[assessment.reach.mode]} — further than you said you would usually go, but a strong enough fit that it earns the extra travel.`,
    );
  }

  // 3 — established standing, for a traveller who wants the names at all.
  //     `standsAsEstablishedName` holds the whole condition, and the board's
  //     classics group reads the same function: this clause and that heading
  //     make the identical claim about the identical record, and while each
  //     kept its own copy they were free to disagree — which is how a live
  //     board captioned a suburban lake and a small municipal beach as the
  //     names a destination is known for while its famous waterfall rendered
  //     under "Probably skip".
  if (standsAsEstablishedName(place) && profile.discoveryMix !== 'deep_cuts') {
    connections.push(
      profile.discoveryMix === 'mostly_classics'
        ? 'One of the names people come here for, and you wanted the highlights.'
        : 'One of the established names here — the kind of stop this area is known for.',
    );
  }

  // 4 — the specific trade-offs the scorer actually found.
  if (features.crowdComfort >= 0.95 && profile.crowdTolerance === 'avoid_crowds') {
    connections.push('Stays quiet even in season, which matters more to you than a famous name.');
  }

  if (features.hiddenGemAlignment >= 0.8 && place.hiddenGemScore >= 0.6) {
    connections.push('Well off the standard loop — the kind of find you said you wanted.');
  } else if (features.hiddenGemAlignment >= 0.85 && profile.discoveryMix === 'balanced') {
    connections.push('Sits right in the middle of famous and quiet, which is the mix you asked for.');
  }

  if (features.intensityFit >= 1 && place.physicalIntensity !== 'none') {
    connections.push(`Effort level lines up with the ${profile.dailyIntensity} days you asked for.`);
  }

  if (place.costLevel === 0 && profile.budgetStyle === 'budget') {
    connections.push('Free, which keeps the trip inside the budget you set.');
  }

  if (place.weather.poorWeatherBackup) {
    connections.push('Holds up even if the weather turns.');
  }

  if (
    assessment.travelModeFromBase === 'drive' &&
    assessment.access.requiredModes.includes('drive') &&
    place.travelFromBase.driveIsScenic &&
    LEVEL_WEIGHT[profile.interests.scenic_drives ?? 'low'] >= 0.6
  ) {
    connections.push('The drive there is part of the appeal, and you wanted scenic driving.');
  }

  // 5 — logistics, appended. An empty personal case is the one time it leads.
  const logistics: string[] = [];
  if (assessment.detourClass === 'base') {
    logistics.push('Minutes from where you are staying, so it fits any day.');
  } else if (features.detourFit >= 0.85 && assessment.reach.status === 'measured') {
    /*
     * The mode and the radius both come from the resolved journey. The sentence
     * used to read "45 min out, inside the 20 min detour you were happy with" —
     * a contradiction in its own clause — because the minutes were the walk and
     * the radius was the car-free constant.
     */
    const mode = assessment.reach.mode;
    logistics.push(
      `${assessment.reach.travelMinutes} min ${REACH_MODE_PHRASE[mode]}, inside the ${detourToleranceMinutesFor(profile, mode)} min you were happy to travel.`,
    );
  }

  return [...dedupe(connections).slice(0, 2), ...logistics.slice(0, 1)];
}

/**
 * The largest share of a board any single label may hold before it stops
 * meaning anything. §9.1's failure was 24 of 24 cards reading the same top
 * label; past this share the label is a background, not a signal.
 */
export const MAX_TOP_BAND_SHARE = 0.6;

/** The next band down, for recalibration. Stops at `optional` on purpose. */
const DEMOTION: Partial<Record<FitBand, FitBand>> = {
  top_pick: 'strong',
  strong: 'good',
  good: 'optional',
};

/**
 * Recalibrate a board on which *any* label has stopped discriminating.
 *
 * When more than `MAX_TOP_BAND_SHARE` of the workable candidates share a band,
 * the lowest-scoring members of that band are demoted one band until the share
 * holds. Deterministic — score ascending, then id — and bounded: nothing is
 * ever demoted past `optional`, because pushing cards into "probably skip" to
 * fix a distribution would trade an overclaim for a lie in the other direction.
 * Returns a new array; the inputs are not touched.
 *
 * EVERY BAND IN THE LADDER IS CHECKED, AND THE DEMOTIONS CASCADE.
 *
 * The loop used to `break` the moment it met a band that was *within* budget,
 * and `break` again after its first demotion — so it only ever inspected the
 * highest band present and only ever fixed that one. On a real Eastern Sierra
 * board that terminated on `top_pick` holding 2 of 23 workable cards, which is
 * inside the share, and the guard never reached `strong` holding 20 of 23:
 * 87% of the board read "Strong fit" while the product's own constant says at
 * most 60% of it may. Continuing also matters for the demotions themselves —
 * a top band drained into the next one can push *that* band over its share,
 * and re-reading the holders each turn is what lets the overflow keep falling.
 */
export function calibrateBandDistribution(
  assessments: readonly FitAssessment[],
): FitAssessment[] {
  const result = assessments.map((assessment) => ({ ...assessment }));
  const workable = result.filter((assessment) => assessment.band !== 'not_workable');
  if (workable.length < 3) return result;

  const ladder: FitBand[] = ['top_pick', 'strong', 'good'];
  const allowed = Math.max(1, Math.floor(workable.length * MAX_TOP_BAND_SHARE));
  for (const band of ladder) {
    const holders = workable.filter((assessment) => assessment.band === band);
    if (holders.length <= allowed) continue;
    const demoteTo = DEMOTION[band];
    if (!demoteTo) continue;
    const demotions = holders
      .sort((a, b) => a.score - b.score || a.placeId.localeCompare(b.placeId))
      .slice(0, holders.length - allowed);
    for (const assessment of demotions) assessment.band = demoteTo;
  }
  return result;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
