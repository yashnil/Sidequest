import {
  CLARIFICATION_SET_VERSION,
  type ClarificationQuestion,
  type ClarificationSet,
  type PlanningDecision,
  type TripPreflight,
} from '@sidequest/core';

/**
 * QUESTIONS THAT COULD ONLY HAVE BEEN ASKED ABOUT THIS TRIP.
 *
 * The clarification bank next door is seven fixed templates gated on traits of
 * the *destination record* — is it a country, is it an island, is it big. That
 * is adaptive in the sense that a form with conditional fields is adaptive:
 * every trip to a country gets the same question, in the same words, whatever
 * the preliminary scan found.
 *
 * This file asks the other kind. Each rule below reads the **preflight** — the
 * cheap scan that has already run, over this destination's own index records,
 * with this traveller's dates and length — and fires only when that evidence
 * shows a decision genuinely unresolved. The question then carries the evidence
 * that triggered it, so the claim "this changes your plan" is checkable rather
 * than asserted.
 *
 * Four rules hold, and they are the difference between this and a longer form:
 *
 * 1. **No destination names anywhere.** Every predicate is over typed evidence —
 *    cluster counts, transfer minutes, excluded areas, reach classes. A rule
 *    that mentioned a city would be a lookup table wearing a question mark.
 * 2. **Do not ask what can be inferred.** Every rule records
 *    `canInferWithoutAsking`, and a rule that can infer with confidence does
 *    not fire. The record is kept either way so the unnecessary-question rate
 *    is measurable.
 * 3. **Do not ask what does not change anything.** `planChangeByAnswer` must
 *    differ between options. Writing that field is what exposes a question
 *    whose answers all lead to the same trip.
 * 4. **Ask few.** A hard ceiling, applied after ranking by importance, because
 *    completion falls roughly four points per question asked and the marginal
 *    question is worth less than the one before it.
 */

/**
 * The most adaptive questions any trip may be asked.
 *
 * Section 6.3 asks for roughly nought to six after the core intake, and these
 * sit *on top of* the trait-gated clarifications — so the ceiling here is lower
 * than six rather than equal to it. A blocking question bypasses the ceiling;
 * nothing else does.
 */
export const MAX_ADAPTIVE_QUESTIONS = 3;

export interface AdaptiveInput {
  preflight: TripPreflight | null;
  /** Nights on the ground, when the traveller has settled them. */
  nights: number | null;
  /**
   * What the composer already established. A question already answered here is
   * not asked, which is the single most effective suppression rule there is.
   */
  known?: {
    transport?: string | undefined;
    shape?: string | undefined;
    /** Whether a scope strategy was chosen on the preflight screen. */
    scopeStrategy?: boolean;
    /** Verbatim text from "anything you would regret missing". */
    mustDo?: string | undefined;
    /**
     * Whether the traveller has actually fixed their dates.
     *
     * False for `month`, `season` and `undecided`; true for `exact` and
     * `flexible`. Its own field rather than inferred from a night count,
     * because those are different questions and conflating them is what made
     * the date rule fire at people who had already answered it.
     */
    datesSettled?: boolean;
    /** They ticked "tell me when this place is at its best". */
    wantsDateAdvice?: boolean;
  };
  /** Question ids already present, so nothing is asked twice. */
  existingIds?: readonly string[];
}

export const ADAPTIVE_QUESTION_IDS = {
  hotelSwitchTolerance: 'adaptive.hotel-switch-tolerance',
  longHaulDayTrips: 'adaptive.long-haul-day-trips',
  extendReach: 'adaptive.extend-reach',
  datesForSeason: 'adaptive.dates-for-season',
} as const;

/**
 * The adaptive questions this trip's own evidence justifies.
 *
 * Pure and deterministic, like `deriveClarificationQuestions`: the same
 * preflight gives the same questions, which is what lets a stored answer keep
 * matching its question when the set is rebuilt.
 */
export function deriveAdaptiveQuestions(input: AdaptiveInput): ClarificationQuestion[] {
  const preflight = input.preflight;
  if (!preflight?.portfolio) return [];

  const portfolio = preflight.portfolio;
  const existing = new Set(input.existingIds ?? []);
  const candidates: { question: ClarificationQuestion; rank: number }[] = [];

  const gatewayName = portfolio.gateway?.name ?? portfolio.route[0]?.name ?? 'your base';

  /*
   * R1 — MOVING BASE IS ON THE TABLE AND NOBODY HAS SAID.
   *
   * Fires when the structure genuinely proposes more than one base *and* the
   * transfer between them is long enough to be a decision rather than a detail.
   * A short hop between two adjacent towns is not worth a question; four hours
   * with luggage is.
   *
   * Suppressed by a composer shape or a preflight strategy, both of which are
   * the same answer given earlier.
   */
  const longestTransfer = Math.max(
    0,
    ...portfolio.baseReasons.map((entry) => entry.transferMinutes),
  );
  const shapeKnown =
    input.known?.scopeStrategy === true ||
    (input.known?.shape !== undefined && input.known.shape !== 'undecided');
  if (
    !shapeKnown &&
    portfolio.basesProposed >= 2 &&
    longestTransfer >= 120 &&
    (input.nights ?? 0) >= 5
  ) {
    candidates.push({
      rank: 0,
      question: {
        id: ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance,
        reason: 'base_strategy_unknown',
        question: 'Would you rather move once, or stay put and travel further each day?',
        whyItMatters: `The best of this region is spread out. Moving hotel opens ground a day trip cannot reach; staying put means roughly ${hours(longestTransfer * 2)} of travelling, there and back, on the days you go furthest — a straight-line estimate rather than a routed time.`,
        answerType: 'single_choice',
        options: [
          {
            value: 'move',
            label: 'Move once',
            detail: 'Two bases, less travelling, one afternoon spent changing hotel',
          },
          {
            value: 'stay',
            label: 'Stay in one place',
            detail: 'One hotel, longer days, some of the region out of reach',
          },
          { value: 'either', label: 'Whichever suits the region', detail: 'Decide for me' },
        ],
        required: false,
        source: 'rule',
        decisionAffected: 'base_structure' satisfies PlanningDecision,
        evidenceThatTriggeredIt: [
          {
            kind: 'region_structure',
            detail: `${portfolio.basesProposed} areas worth basing in, roughly ${hours(longestTransfer)} apart at the widest by straight-line estimate.`,
          },
        ],
        planChangeByAnswer: {
          move: 'We plan around two bases and put the transfer on a light day.',
          stay: `We keep one base at ${gatewayName} and drop anything that cannot be reached and returned from in a day.`,
          either: 'We choose whichever costs less total travel, and say which we picked.',
        },
        importance: 'high',
        canInferWithoutAsking: { possible: false, confidence: 0 },
        allowIndifference: true,
      },
    });
  }

  /*
   * R2 — WITHOUT A CAR, HOW MUCH SCHEDULED TRAVEL IS ACCEPTABLE.
   *
   * Fires only when there is something worth reaching that a short hop cannot
   * reach: at least one area an hour or more out. For a compact destination
   * this never fires, which is the point — the same traveller in a dense city
   * is not asked a question whose answer changes nothing.
   */
  const farAreas = [...portfolio.satellites, ...portfolio.excluded.map((entry) => ({
    cluster: entry.cluster,
    transferMinutes: entry.cluster.transferMinutesFromGateway,
  }))].filter((entry) => entry.transferMinutes >= 60);
  if (
    input.known?.transport === 'public_transport' &&
    farAreas.length >= 1 &&
    !existing.has(ADAPTIVE_QUESTION_IDS.longHaulDayTrips)
  ) {
    candidates.push({
      rank: 1,
      question: {
        id: ADAPTIVE_QUESTION_IDS.longHaulDayTrips,
        reason: 'base_strategy_unknown',
        question: 'How long a journey is worth it for a day out?',
        whyItMatters: `Without a car, ${farAreas.length === 1 ? 'one area' : `${farAreas.length} areas`} here look like an hour or more from ${gatewayName} — a straight-line estimate, since nothing has measured a timetable. Where you draw the line decides how much of the region is on the board at all.`,
        answerType: 'single_choice',
        options: [
          { value: '60', label: 'Up to an hour', detail: 'Keep the days short' },
          { value: '120', label: 'Up to two hours', detail: 'A long day, for something worth it' },
          { value: 'worth_it', label: 'As long as it is worth it', detail: 'Decide for me' },
        ],
        required: false,
        source: 'rule',
        decisionAffected: 'region_extent' satisfies PlanningDecision,
        evidenceThatTriggeredIt: [
          {
            kind: 'reachable_areas',
            detail: `Estimated, not routed: ${farAreas
              .slice(0, 3)
              .map((entry) => `${entry.cluster.name} ~${hours(entry.transferMinutes)}`)
              .join(', ')}`,
          },
          { kind: 'stated_transport', detail: 'Travelling without a car.' },
        ],
        planChangeByAnswer: {
          '60': 'Anything beyond an hour comes off the board rather than being planned and cut later.',
          '120': 'Longer day trips stay in, paired with a lighter day either side.',
          worth_it: 'We keep the furthest one only if its fit clearly beats what is closer.',
        },
        importance: 'moderate',
        canInferWithoutAsking: { possible: false, confidence: 0 },
        allowIndifference: true,
      },
    });
  }

  /*
   * R3 — SOMETHING GOOD IS SITTING JUST OUTSIDE THE LINE.
   *
   * Fires when the structure excluded an area *for reach* — not for hotel
   * tolerance, not for thinness — and it is close enough that a small change of
   * mind would admit it. This is the question a traveller most often wishes
   * they had been asked, because the alternative is finding out afterwards that
   * the place they had heard of was two hundred metres outside a radius.
   */
  const nearMisses = portfolio.excluded.filter(
    (entry) =>
      entry.cluster.transferMinutesFromGateway > 0 &&
      entry.cluster.transferMinutesFromGateway <= 240 &&
      /not worth the change of hotel|does not fit|too far/i.test(entry.reason),
  );
  if (nearMisses.length > 0 && !existing.has(ADAPTIVE_QUESTION_IDS.extendReach)) {
    const first = nearMisses[0]!;
    candidates.push({
      rank: 2,
      question: {
        id: ADAPTIVE_QUESTION_IDS.extendReach,
        reason: 'scope_too_broad',
        question: `We are leaving ${nearMisses.length === 1 ? first.cluster.name : `${nearMisses.length} areas`} out. Keep it that way?`,
        whyItMatters: `${first.cluster.name} is about ${hours(first.cluster.transferMinutesFromGateway)} from ${gatewayName}. On the trip as it stands it does not fit — but it is close enough that it would, if you wanted it enough.`,
        answerType: 'single_choice',
        options: [
          { value: 'leave_out', label: 'Leave it out', detail: 'Keep the days shorter' },
          { value: 'include', label: 'Make room for it', detail: 'Accept a longer travel day' },
        ],
        required: false,
        source: 'rule',
        decisionAffected: 'region_extent' satisfies PlanningDecision,
        evidenceThatTriggeredIt: nearMisses.slice(0, 3).map((entry) => ({
          kind: 'excluded_area',
          detail: `${entry.cluster.name}: ${entry.reason}`,
        })),
        planChangeByAnswer: {
          leave_out: 'Nothing changes; those areas stay off the board with the reason shown.',
          include: 'We widen the ground to take it in and rebuild the structure around it.',
        },
        importance: 'moderate',
        canInferWithoutAsking: { possible: false, confidence: 0 },
        allowIndifference: false,
      },
    });
  }

  /*
   * R4 — THE DATES ARE OPEN AND THE SEASON MATTERS HERE.
   *
   * Fires only when the traveller has *not* fixed dates and the preflight found
   * real climate evidence to choose between windows. A destination with no
   * climate record, or a traveller who has already booked, is not asked — which
   * is most of them.
   */
  /*
   * Keyed on how settled the dates are, not on whether a night count was typed.
   *
   * This was `input.nights === null`, which is true for every traveller who
   * gave two dates instead of a number — so the product asked somebody who had
   * just entered exact dates whether they would move them. Section 6.3 forbids
   * asking what is already answered, and "I typed 12–20 September" answers it.
   */
  const dateGuidance = preflight.dates;
  const datesOpen =
    input.known?.datesSettled === false || input.known?.wantsDateAdvice === true;
  if (
    dateGuidance?.kind === 'recommended' &&
    dateGuidance.windows.length >= 2 &&
    datesOpen &&
    !existing.has(ADAPTIVE_QUESTION_IDS.datesForSeason)
  ) {
    const best = dateGuidance.windows[0]!;
    const worst = dateGuidance.windows[dateGuidance.windows.length - 1]!;
    if (best.score - worst.score >= 0.2) {
      candidates.push({
        rank: 3,
        question: {
          id: ADAPTIVE_QUESTION_IDS.datesForSeason,
          reason: 'seasonal_conflict',
          question: 'Would you move your dates for better conditions?',
          whyItMatters: `${best.label} and ${worst.label} are genuinely different trips here — ${best.evidenceNote}`,
          answerType: 'single_choice',
          options: [
            { value: 'flexible', label: 'Yes, if it is worth it', detail: 'Plan around the better window' },
            { value: 'fixed', label: 'No, my dates are set', detail: 'Plan around what you have' },
          ],
          required: false,
          source: 'rule',
          decisionAffected: 'trip_dates' satisfies PlanningDecision,
          evidenceThatTriggeredIt: [
            {
              /*
               * The climate fact, not the score it produced. A unitless 0-1
               * with two decimals reads as a measurement and is not one — it is
               * our own ranking, and `evidenceNote` already carries the thing
               * it was computed from.
               */
              kind: 'climate_windows',
              detail: `${best.label}: ${best.evidenceNote} ${worst.label} comes out materially worse on the same record.`,
            },
          ],
          planChangeByAnswer: {
            flexible: 'We build against the better window and show you what it gains.',
            fixed: 'We keep your dates and plan around whatever is shut or unreliable.',
          },
          importance: 'moderate',
          canInferWithoutAsking: { possible: false, confidence: 0 },
          allowIndifference: false,
        },
      });
    }
  }

  /*
   * Ranked, deduplicated against what is already being asked, then capped.
   *
   * The cap is applied last rather than by breaking out of the rules early, so
   * the *most important* three survive rather than the first three written.
   */
  return candidates
    .filter((entry) => !existing.has(entry.question.id))
    .sort((a, b) => importanceRank(a.question) - importanceRank(b.question) || a.rank - b.rank)
    .slice(0, MAX_ADAPTIVE_QUESTIONS)
    .map((entry) => entry.question);
}

function importanceRank(question: ClarificationQuestion): number {
  return question.importance === 'blocking' ? 0 : question.importance === 'high' ? 1 : 2;
}

/** Minutes as something a traveller reads without converting. */
function hours(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  const value = minutes / 60;
  return `${value % 1 === 0 ? value : value.toFixed(1)} hours`;
}

/**
 * Fold adaptive questions into an existing set, preserving every answer.
 *
 * Additive by construction. A traveller who has answered three questions and
 * then triggers a fourth must not lose the three, and a question that stops
 * being justified must not silently discard the answer somebody gave it —
 * `rebuildClarificationSet` next door already holds that contract for the
 * trait-gated bank, and this holds it for the same reason.
 */
export function withAdaptiveQuestions(
  set: ClarificationSet,
  adaptive: readonly ClarificationQuestion[],
): ClarificationSet {
  if (adaptive.length === 0) return set;
  const known = new Set(set.questions.map((question) => question.id));
  const additions = adaptive.filter((question) => !known.has(question.id));
  if (additions.length === 0) return set;
  return {
    schemaVersion: CLARIFICATION_SET_VERSION,
    questions: [...set.questions, ...additions],
    answers: [...set.answers],
  };
}
