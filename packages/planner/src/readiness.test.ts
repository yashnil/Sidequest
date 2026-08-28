import { describe, expect, it } from 'vitest';
import {
  buildTravelerProfile,
  defaultAnswers,
  plannerReadinessSchema,
  PLANNER_READINESS_LEVEL_LABELS,
  type QuestionnaireAnswers,
  type TravelerProfile,
  type UnscheduledPlace,
} from '@sidequest/core';
import { planTrip } from './plan';
import { buildPlannerReadiness } from './readiness';
import { buildScenario } from './testing/scenario';

/**
 * A PLAN WITH NO STOPS IS NOT A PLAN.
 *
 * These exist because a live Bali compilation produced five dated days, a
 * transport strategy, a food plan, a status of `ready_with_cautions` and **zero
 * stops** — and would have shown it to a traveller as their trip. The single
 * sentence explaining it was a warning sitting beneath seven food warnings.
 *
 * The cause was not a bug in any one layer. Every candidate was reachable and
 * open; the nearest was a 157-minute round trip from the base against the
 * traveller's own 150-minute daily driving limit. Zero stops was the *correct*
 * answer, and presenting it as an itinerary was not.
 */

function rejection(reasonCode: UnscheduledPlace['reasonCode'], name: string): UnscheduledPlace {
  return { placeId: name, name, wasManual: false, reasonCode, reason: 'Because.' };
}

/** A traveller built from their own answers, so no threshold below is a literal. */
function traveller(overrides: Partial<QuestionnaireAnswers>): TravelerProfile {
  const context = { travelerNeeds: [] as never[], tripDays: 6 };
  return buildTravelerProfile({ ...defaultAnswers(context), ...overrides }, context);
}

/** An ordinary trip: nobody asked for space, and nobody asked for a checklist. */
const ORDINARY = traveller({ pace: 'balanced', dailyIntensity: 'moderate' });

/**
 * The traveller who asked for room.
 *
 * "Slow, and light days" is how this product records "lots of free time" — the
 * two answers are what `derived.activitySlotsPerDay` is built from, and it is
 * the only number the questionnaire produces for how full a day should be.
 */
const SPACIOUS = traveller({ pace: 'slow', dailyIntensity: 'light' });

describe('planner readiness', () => {
  it('is schema-valid and counts every rejection exactly once', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 37,
        selected: 9,
        eligible: 9,
        accessFeasible: 9,
        hoursFeasible: 9,
        feasible: 9,
        scheduled: 0,
      },
      dayCount: 5,
      unscheduled: [
        rejection('exceeds_daily_travel', 'A'),
        rejection('exceeds_daily_travel', 'B'),
        rejection('exceeds_daily_travel', 'C'),
        rejection('hours_do_not_fit', 'D'),
      ],
    });

    expect(() => plannerReadinessSchema.parse(readiness)).not.toThrow();
    expect(readiness.rejections.reduce((sum, entry) => sum + entry.count, 0)).toBe(4);
    // Largest first, so the answer is the first thing read.
    expect(readiness.rejections[0]?.reasonCode).toBe('exceeds_daily_travel');
    expect(readiness.rejections[0]?.examples).toEqual(['A', 'B', 'C']);
  });

  it('reproduces the live Bali shape: everything reachable, nothing schedulable', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 37,
        selected: 9,
        eligible: 9,
        accessFeasible: 9,
        hoursFeasible: 9,
        feasible: 9,
        scheduled: 0,
      },
      dayCount: 5,
      unscheduled: Array.from({ length: 9 }, (_, index) =>
        rejection('exceeds_daily_travel', `Place ${index}`),
      ),
    });

    expect(readiness.dominantBlockers).toHaveLength(1);
    expect(readiness.dominantBlockers[0]?.reasonCode).toBe('exceeds_daily_travel');
    expect(readiness.summary).toContain('9 of the 9 places you picked were reachable and open');
    expect(readiness.summary).toContain('further than you said you would drive');

    const helps = new Map(readiness.remedies.map((entry) => [entry.remedy, entry.likelyToHelp]));
    // The two things that would actually change the outcome.
    expect(helps.get('adjust_transport')).toBe(true);
    expect(helps.get('adjust_scope')).toBe(true);
    // And the two that would not, said out loud so nobody spends an afternoon
    // on them.
    expect(helps.get('more_days')).toBe(false);
    expect(helps.get('retry')).toBe(false);
  });

  it('names the right remedy when nothing could be measured at all', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 12,
        selected: 5,
        eligible: 0,
        accessFeasible: 0,
        hoursFeasible: 0,
        feasible: 0,
        scheduled: 0,
      },
      dayCount: 4,
      unscheduled: Array.from({ length: 5 }, (_, index) =>
        rejection('missing_travel_data', `Place ${index}`),
      ),
      unresolved: { routePairs: 5 },
    });
    expect(readiness.summary).toContain('travel time we could measure');
    /**
     * Our failure, not the destination's.
     *
     * "We could not measure anything" must never be reported as "there is
     * nothing here" — the first is an outage on our side and the second is a
     * claim about somebody's trip.
     */
    expect(readiness.level).toBe('infrastructure_failure');
    const helps = new Map(readiness.remedies.map((entry) => [entry.remedy, entry.likelyToHelp]));
    expect(helps.get('retry')).toBe(true);
    expect(helps.get('adjust_transport')).toBe(false);
  });

  it('names the right remedy when everything is shut', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 20,
        selected: 6,
        eligible: 6,
        accessFeasible: 6,
        hoursFeasible: 0,
        feasible: 0,
        scheduled: 0,
      },
      dayCount: 3,
      unscheduled: Array.from({ length: 6 }, (_, index) =>
        rejection('closed_on_trip_dates', `Place ${index}`),
      ),
    });
    expect(readiness.summary).toContain('unreachable or shut on every one of your 3 days');
    const helps = new Map(readiness.remedies.map((entry) => [entry.remedy, entry.likelyToHelp]));
    expect(helps.get('refresh_evidence')).toBe(true);
    expect(helps.get('more_days')).toBe(false);
  });

  it('keeps two tied blockers rather than picking one of them', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 10,
        selected: 4,
        eligible: 4,
        accessFeasible: 4,
        hoursFeasible: 4,
        feasible: 4,
        scheduled: 0,
      },
      dayCount: 3,
      unscheduled: [
        rejection('exceeds_daily_travel', 'A'),
        rejection('exceeds_daily_travel', 'B'),
        rejection('hours_do_not_fit', 'C'),
        rejection('hours_do_not_fit', 'D'),
      ],
    });
    expect(readiness.dominantBlockers).toHaveLength(2);
  });

  it('produces the same result twice for the same input', () => {
    const input = {
      funnel: {
        considered: 9,
        selected: 9,
        eligible: 9,
        accessFeasible: 9,
        hoursFeasible: 9,
        feasible: 9,
        scheduled: 0,
      },
      dayCount: 5,
      unscheduled: [
        rejection('hours_do_not_fit', 'B'),
        rejection('exceeds_daily_travel', 'A'),
        rejection('hours_do_not_fit', 'C'),
      ],
    };
    expect(JSON.stringify(buildPlannerReadiness(input))).toBe(
      JSON.stringify(buildPlannerReadiness(input)),
    );
  });
});

describe('a plan that would have had no stops', () => {
  /**
   * The end-to-end version, through the real planner, over the authored region.
   *
   * A daily driving limit below the round trip to anything is exactly the Bali
   * situation, expressed against a fixture rather than a destination — the same
   * shape of failure with none of Bali in it.
   */
  function unreachableTrip() {
    const scenario = buildScenario();
    return {
      ...scenario,
      profile: {
        ...scenario.profile,
        transport: {
          ...scenario.profile.transport,
          // Lower than the round trip to anything on the board, which is the
          // Bali situation stated as a number rather than as a destination.
          maxDailyDriveMinutes: 5,
          maxDailyTransportMinutes: 5,
        },
      },
    };
  }

  it('refuses instead of returning dated days with nothing on them', () => {
    const result = planTrip(unreachableTrip());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('planner_coverage_insufficient');
    expect(result.readiness?.funnel.scheduled).toBe(0);
    expect(result.readiness?.funnel.selected).toBeGreaterThan(0);
    expect(result.readiness?.level).toBe('insufficient');
  });

  it('says the round trip is the problem, with the real number in it', () => {
    const result = planTrip(unreachableTrip());
    expect(result.ok).toBe(false);
    if (result.ok || !result.readiness) return;
    const blocker = result.readiness.dominantBlockers[0];
    expect(blocker?.reasonCode).toBe('exceeds_daily_travel');
    // `no_time_left` was the old, generic answer and it sent travellers to free
    // up room that was never the constraint.
    expect(
      result.readiness.rejections.some((entry) => entry.reasonCode === 'no_time_left'),
    ).toBe(false);
  });

  it('still returns a real plan when the limits allow one', () => {
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scheduled = result.itinerary.days.reduce(
      (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
      0,
    );
    expect(scheduled).toBeGreaterThan(0);
    expect(result.itinerary.diagnostics.counts.scheduled).toBe(scheduled);
  });
});

describe('a plan that is feasible and not yet a trip', () => {
  /**
   * LIVE EVIDENCE CLASS: coverage-blind verdict.
   *
   * Two compilations of six-day city trips produced funnels of
   * `{considered:24, selected:5, eligible:1, scheduled:1}` and
   * `{considered:24, selected:8, eligible:2, scheduled:2}`, with itinerary
   * summaries "1 stop across 1 of 6 days, 4 left off" and "2 stops across 2 of
   * 6 days" — five days each rendering "An open day … Nothing scheduled". Both
   * were headed "Ready, with cautions / The plan works", because the verdict was
   * computed from feasibility and conflicts and nothing anywhere asked how much
   * of the trip got filled. Feasibility is not completeness: a plan with no
   * internal contradiction can still be obviously unusable.
   */
  function liveShape(profile: TravelerProfile) {
    return buildPlannerReadiness({
      funnel: {
        considered: 24,
        selected: 5,
        eligible: 1,
        accessFeasible: 1,
        hoursFeasible: 1,
        feasible: 1,
        scheduled: 1,
      },
      dayCount: 6,
      daysWithActivity: 1,
      unscheduled: Array.from({ length: 4 }, (_, index) =>
        rejection('exceeds_daily_travel', `Place ${index}`),
      ),
      profile,
    });
  }

  it('does not call an ordinary-pace six-day trip with one stop ready', () => {
    const readiness = liveShape(ORDINARY);

    expect(readiness.level).not.toBe('ready');
    /*
     * The level names the shortfall in the vocabulary the panel already prints,
     * rather than a parallel one: this is the label a traveller reads.
     */
    expect(readiness.level).toBe('insufficient');
    expect(PLANNER_READINESS_LEVEL_LABELS[readiness.level]).toBe('Not enough to plan on');
    // The two counts that matter, in the sentence, in the traveller's terms.
    expect(readiness.summary).toContain('1 stop across 1 of your 6 days');
    expect(readiness.summary).toMatch(/not yet enough here to plan a trip around/);
  });

  it('still reads as ready for a traveller who asked for the room', () => {
    /*
     * LIVE EVIDENCE CLASS: the false positive the fix must not create. A slow,
     * light-day traveller who gets one anchor a day and space around it has the
     * trip they asked for, and a flat "three stops a day" rule would call it a
     * failure.
     */
    const spacious = buildPlannerReadiness({
      funnel: {
        considered: 24,
        selected: 6,
        eligible: 6,
        accessFeasible: 6,
        hoursFeasible: 6,
        feasible: 6,
        scheduled: 3,
      },
      dayCount: 5,
      daysWithActivity: 3,
      unscheduled: Array.from({ length: 3 }, (_, index) =>
        rejection('frequency_reached', `Place ${index}`),
      ),
      profile: SPACIOUS,
    });

    expect(spacious.level).toBe('ready');
  });

  it('draws the line from the profile rather than from a number in this file', () => {
    /*
     * The same plan — same stops, same days, same picks — judged twice. Nothing
     * about the itinerary differs; only the answers the traveller gave about
     * pace and day intensity do, and the verdict moves with them. That is the
     * whole claim: the bar is `activitySlotsPerDay` over the days the trip can
     * fill, so a constant could not produce both of these.
     */
    const shape = {
      funnel: {
        considered: 24,
        selected: 6,
        eligible: 6,
        accessFeasible: 6,
        hoursFeasible: 6,
        feasible: 6,
        scheduled: 3,
      },
      dayCount: 5,
      /*
       * Two of the three days this trip can fill, deliberately: the anchored
       * clause is the *other* way to clear the bar, and leaving it satisfied
       * here would let both travellers pass through it and prove nothing about
       * pace. With it unsatisfied, the only thing separating the two verdicts
       * is the number their own answers put on a day.
       */
      daysWithActivity: 2,
      unscheduled: Array.from({ length: 3 }, (_, index) =>
        rejection('frequency_reached', `Place ${index}`),
      ),
    };

    /*
     * `partial` rather than `ready` on the spacious side, and the reason is the
     * unfilled day this shape deliberately holds: a day the trip could have
     * filled and did not now keeps a plan off `ready` whatever its volume. The
     * claim under test is untouched — the two verdicts still differ, and they
     * differ only because the volume bar moved with the profile.
     */
    expect(buildPlannerReadiness({ ...shape, profile: SPACIOUS }).level).toBe('partial');
    expect(buildPlannerReadiness({ ...shape, profile: ORDINARY }).level).toBe('insufficient');
    expect(SPACIOUS.derived.activitySlotsPerDay).toBeLessThan(
      ORDINARY.derived.activitySlotsPerDay,
    );

    /*
     * And the volume bar really is what separated them: fill the third day and
     * the spacious traveller's plan clears every gate, while the ordinary one's
     * is still short of what their own answers asked a day to hold.
     */
    const anchored = { ...shape, daysWithActivity: 3 };
    expect(buildPlannerReadiness({ ...anchored, profile: SPACIOUS }).level).toBe('ready');
    expect(buildPlannerReadiness({ ...anchored, profile: ORDINARY }).level).not.toBe('ready');
  });

  it('leaves a fully scheduled trip usable, and does not call it finished', () => {
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * WHAT "FULLY SCHEDULED" IS AND IS NOT.
     *
     * This asserted `ready`, on the reasoning that a plan holding every place
     * the traveller picked is finished. An independent review measured what
     * that reasoning licences: `everyDayAnchored` needs one activity a day and
     * auto-pick scales its target to the region's supply, so
     * `scheduled === selected` is the ordinary case — and the carve-out then
     * waived the volume test *and* the "is this a trip at all" floor. Five
     * stops on a six-day metropolitan trip read `ready`, with the spacious
     * sentence telling a traveller their empty afternoons were the pace they
     * had asked for. They had answered `balanced`.
     *
     * So the two halves are asserted apart, which is what they always were:
     * **nothing went wrong** — no stop was lost, no cap broken, the plan stands
     * on its own and the header does not send anybody to a decision — and
     * **it is not full**, which the shortfall issue says as a warning and the
     * summary says in the trip's own units.
     */
    expect(result.itinerary.status).not.toBe('needs_decision');
    const shortfall = result.itinerary.issues.filter(
      (issue) => issue.code === 'coverage_below_pace',
    );
    expect(shortfall.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(result.readiness?.level).not.toBe('insufficient');
    expect(result.readiness?.summary).toMatch(/All \d+ places you picked are in the plan/);
  });

  it('makes the itinerary header agree with the board, end to end', () => {
    /*
     * LIVE EVIDENCE CLASS: two surfaces, one plan, opposite verdicts.
     *
     * The reported defect was an itinerary headed "Ready, with cautions / The
     * plan works" over days that were mostly empty, because `statusFor` reads
     * conflicts and a thin plan has none. Eight days over the authored region
     * with a tight daily travel budget reproduces that shape through the real
     * planner: a plan is built, it holds five stops across four of eight days,
     * and both surfaces now say so.
     */
    const result = planTrip(
      buildScenario({
        basics: { startDate: '2026-08-12', endDate: '2026-08-19' },
        answers: { maxDailyTravelMinutes: 45 },
      }),
    );
    expect(result.ok, result.ok ? '' : `refused: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const withActivity = result.itinerary.days.filter((day) =>
      day.items.some((item) => item.kind === 'activity'),
    ).length;
    expect(withActivity).toBeLessThan(result.itinerary.days.length);

    expect(result.readiness?.level).toBe('insufficient');
    expect(result.itinerary.status).toBe('needs_decision');
    const coverage = result.itinerary.issues.find(
      (issue) => issue.code === 'coverage_below_pace',
    );
    expect(coverage?.severity).toBe('error');
    expect(coverage?.message).toContain(`of your ${result.itinerary.days.length} days`);
  });

  it('does not print a second day fraction beside the summary\u2019s own', () => {
    /**
     * TWO TRUE FRACTIONS, ONE CONTRADICTION.
     *
     * A rendered six-day Osaka plan opened with
     *
     *   "8 stops across 6 of 6 days, 5 hr 21 min on foot to reach them"
     *
     * and closed with
     *
     *   "This plan holds 8 stops across 4 of the 4 days it could fill."
     *
     * Both are true — `summarise` counts every day of the trip, the shortfall
     * counts the days a stop can be built around, and arrival and departure days
     * are in one and not the other. A traveller has no way to know that, and
     * what they read is the same sentence giving two different answers.
     *
     * The volume gap is what this warning exists to say, so that is what it says
     * in figures; the spread is said in words. Asserted through the real planner
     * rather than on the template, because the collision only exists once both
     * sentences are on the same plan.
     */
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = result.itinerary.summary;
    expect(summary).toMatch(/across \d+ of \d+ days/);

    /*
     * The witness. `buildScenario()` with no overrides is the fully-scheduled
     * shape the test above establishes: nothing went wrong, and it is still not
     * full — which is exactly when the warning fires and collides.
     */
    const warnings = result.itinerary.issues.filter(
      (issue) => issue.code === 'coverage_below_pace' && issue.severity === 'warning',
    );
    expect(warnings.length).toBeGreaterThan(0);

    for (const issue of result.itinerary.issues) {
      if (issue.code !== 'coverage_below_pace') continue;
      /*
       * The shape that collides: "N stops across X of Y days". The error-level
       * variant says "of your N days" — the same denominator the summary uses,
       * which is agreement rather than contradiction and is left alone.
       */
      if (issue.severity === 'warning') {
        expect(issue.message).not.toMatch(/stops? across \d+ of (the )?\d+ days?/);
        expect(issue.message).toContain('it could build one around');
      }
    }

    /*
     * The board's own summary is the other half, and it collided the same way:
     * "This fills 4 of the 4 days the trip can use" sat one screen before "8
     * stops across 6 of 6 days" on a plan that used all six.
     */
    const readinessSummary = result.readiness?.summary ?? '';
    expect(readinessSummary).not.toMatch(/\d+ of the \d+ days? the trip can use/);
    if (readinessSummary.includes('room for around')) {
      expect(readinessSummary).toContain('it can build one around');
    }
  });

  it('never calls a plan finished while a day it could fill holds nothing', () => {
    /**
     * FOUR BLANK DAYS UNDER "ALL 8 PLACES YOU PICKED ARE IN THE PLAN".
     *
     * A real ten-day Mammoth plan for a traveller answering slow pace, light
     * days and lots of free time. Eight stops landed on days 1–6; days 7, 8, 9
     * and 10 came out completely empty — 585, 585, 553 and 435 free minutes
     * with nothing in them — and the verdict read `ready`.
     *
     * Eight stops clears both `expected` and `floor`, so `incomplete` was false,
     * and `everyDayAnchored` was consulted only from inside `spacious` and
     * `short`, neither of which sits on the path to `ready`. The volume bar
     * cannot see distribution, and nothing else was looking: `plan.ts` gates the
     * completeness warning on the same two booleans, so that surface was silent
     * too. A tester books ten days and is told the plan is done.
     *
     * Driven through the real planner rather than `buildPlannerReadiness`,
     * because the defect is in what a delivered plan's own shape produces.
     */
    const result = planTrip(
      buildScenario({
        basics: { startDate: '2026-08-12', endDate: '2026-08-21' },
        answers: { pace: 'slow', dailyIntensity: 'light', freeTime: 'lots' },
      }),
    );
    expect(result.ok, result.ok ? '' : `refused: ${result.message}`).toBe(true);
    if (!result.ok) return;

    /* Arrival and departure are lighter by construction; the inner days are the
     * ones the trip could have filled. */
    const inner = result.itinerary.days.slice(1, -1);
    const blank = inner.filter(
      (day) =>
        day.window.usableMinutes > 0 && day.items.every((item) => item.kind !== 'activity'),
    );
    /*
     * The witness. If the planner ever fills these days the fixture has moved,
     * and this test would be asserting about a shape that no longer exists.
     */
    expect(blank.length, 'the ten-day slow-pace plan should still leave days empty').toBeGreaterThan(0);

    expect(result.readiness?.level).not.toBe('ready');
    expect(result.itinerary.status).not.toBe('ready');
  });

  it('does not send a traveller back to the board when nothing could be laid out', () => {
    /**
     * A COUNTRY TRIP WITH NOTHING IN IT, TOLD TO PICK MORE.
     *
     * Measured on a live eight-day Iceland build. All thirteen selections came
     * back `missing_travel_data` — the routing service refuses any pair over
     * 400 km and the country is wider than that — so the funnel read
     * `{considered: 59, selected: 13, scheduled: 0}` and the plan was empty.
     *
     * The panel then marked `choose_manually` as likely to help, with "Add a
     * few more from the board — there is room in these days for more than is in
     * the plan", beside five remedies it had correctly ruled out. That advice
     * cannot work: the next pick comes off the same board and the same
     * unmeasured matrix. `retry` is the remedy that applies, and it was already
     * there.
     *
     * The shortfall override exists for a real case — a plan that stands and is
     * not full — and the guard is only that a plan has to exist.
     */
    const nothingScheduled = buildPlannerReadiness({
      funnel: { considered: 59, selected: 13, eligible: 0, accessFeasible: 0, hoursFeasible: 0, feasible: 0, scheduled: 0 },
      unscheduled: Array.from({ length: 13 }, (_, index) =>
        rejection('missing_travel_data', `Place ${index}`),
      ),
      dayCount: 8,
      daysWithActivity: 0,
      profile: ORDINARY,
    });

    const manual = nothingScheduled.remedies.find((entry) => entry.remedy === 'choose_manually');
    expect(manual?.likelyToHelp).toBe(false);
    expect(manual?.detail).not.toContain('room in these days');

    /* The remedy that does apply is still offered. */
    expect(
      nothingScheduled.remedies.find((entry) => entry.remedy === 'retry')?.likelyToHelp,
    ).toBe(true);
  });

  it('says nothing about coverage when there is no traveller to judge against', () => {
    /*
     * Absent is not zero. A caller that hands over no profile has not told us
     * the trip is empty — it has told us nothing, and a bar nobody could compute
     * must not read as a bar the plan failed.
     */
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 24,
        selected: 5,
        eligible: 1,
        accessFeasible: 1,
        hoursFeasible: 1,
        feasible: 1,
        scheduled: 1,
      },
      dayCount: 6,
      unscheduled: [rejection('exceeds_daily_travel', 'A')],
    });
    expect(readiness.level).toBe('partial');
  });
});

describe('remedies against the transport the trip actually has', () => {
  /**
   * LIVE EVIDENCE CLASS: a remedy proposing what the traveller ruled out.
   *
   * On a car-free trip whose own itinerary page stated "This plan assumes no
   * car", the board's readiness panel led with "Change your travel limits.
   * Raising your daily driving limit, or planning around a car, is what would
   * bring these within reach." The itinerary page gave the correct reason for
   * the very same places — "you said 25 min is the furthest you would walk" —
   * so two surfaces contradicted each other about one journey.
   */
  const CAR_FREE = traveller({ willDrive: false, maxAccessWalkMinutes: 25 });
  const DRIVER = traveller({ willDrive: true });

  /** The sentence `overLimitWalkOutcome` composes, which the itinerary page prints. */
  const PLANNER_REFUSAL =
    'Rope Bridge: The only usable way to make this leg is about 1 hr 5 min on foot, and you said 25 min is the furthest you would walk to reach a stop. Raise that answer if you would take this walk.';

  function walkBound(profile: TravelerProfile) {
    return buildPlannerReadiness({
      funnel: {
        considered: 18,
        selected: 6,
        eligible: 6,
        accessFeasible: 2,
        hoursFeasible: 2,
        feasible: 2,
        scheduled: 2,
      },
      dayCount: 4,
      daysWithActivity: 2,
      unscheduled: Array.from({ length: 4 }, (_, index) => ({
        placeId: `far-${index}`,
        name: `Far ${index}`,
        wasManual: false,
        reasonCode: 'transport_mode_unavailable' as const,
        reason: PLANNER_REFUSAL,
        suggestedRemedy: 'Raise how far you will walk to reach a stop, or pick something closer.',
      })),
      profile,
    });
  }

  it('never mentions driving or a car to a traveller who will not drive', () => {
    const readiness = walkBound(CAR_FREE);
    for (const entry of readiness.remedies) {
      expect(entry.detail, `${entry.remedy} proposes what this trip ruled out`).not.toMatch(
        /\b(driv\w+|cars?|rent\w*|vehicles?|wheel)\b/i,
      );
    }
    // The summary sits directly above the remedies and must not undo them.
    expect(readiness.summary).not.toMatch(/\b(driv\w+|cars?)\b/i);
  });

  it('names the walking answer that actually bound the leg', () => {
    const readiness = walkBound(CAR_FREE);
    const transport = readiness.remedies.find((entry) => entry.remedy === 'adjust_transport');

    expect(transport?.likelyToHelp).toBe(true);
    /*
     * Byte-identical to the planner's own refusal, deliberately. The board
     * quoting the sentence the itinerary page already prints is what stops the
     * two surfaces composing different answers about the same journey.
     */
    expect(transport?.detail).toBe(PLANNER_REFUSAL);
    expect(transport?.detail).toContain('25 min');
    expect(transport?.detail).toMatch(/on foot/);
  });

  it('leaves the copy a driving trip has always had exactly as it was', () => {
    const transport = walkBound(DRIVER).remedies.find(
      (entry) => entry.remedy === 'adjust_transport',
    );
    expect(transport?.detail).toBe(
      'Raising your daily driving limit, or planning around a car, is what would bring these within reach.',
    );
  });

  it('falls back to the answers themselves when there is nothing to quote', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 18,
        selected: 6,
        eligible: 6,
        accessFeasible: 6,
        hoursFeasible: 6,
        feasible: 6,
        scheduled: 2,
      },
      dayCount: 4,
      daysWithActivity: 2,
      unscheduled: Array.from({ length: 4 }, (_, index) => ({
        placeId: `far-${index}`,
        name: `Far ${index}`,
        wasManual: false,
        reasonCode: 'exceeds_daily_travel' as const,
        // The old road-matrix sentence, which names the mode this trip has not.
        reason: 'Far: The only measured way here is 9.4 km by road — this trip has no car.',
      })),
      profile: CAR_FREE,
    });

    const transport = readiness.remedies.find((entry) => entry.remedy === 'adjust_transport');
    expect(transport?.detail).toMatch(/25 min/);
    expect(transport?.detail).toMatch(/walk to reach a stop/);
    expect(transport?.detail).not.toMatch(/\b(driv\w+|cars?)\b/i);
  });
});

describe('a spacious plan and a thin one are different sentences', () => {
  /**
   * LIVE EVIDENCE CLASS: coverage-blind verdict, the other side of it.
   *
   * The same low stop count means opposite things depending on how it is spread
   * and who asked for it. Without this the slow traveller's plan and the
   * six-day-one-stop plan read identically, and the second is the one that was
   * shipping as "The plan works".
   */
  it('says the room is the pace when every day is anchored', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 20,
        selected: 6,
        eligible: 6,
        accessFeasible: 6,
        hoursFeasible: 6,
        feasible: 6,
        scheduled: 4,
      },
      dayCount: 5,
      daysWithActivity: 4,
      unscheduled: Array.from({ length: 2 }, (_, index) =>
        rejection('frequency_reached', `Place ${index}`),
      ),
      profile: SPACIOUS,
    });

    expect(readiness.level).toBe('ready');
    expect(readiness.summary).toContain('the room around it is the pace you asked for');
  });

  it('says no such thing about a plan that left days empty', () => {
    const readiness = buildPlannerReadiness({
      funnel: {
        considered: 24,
        selected: 8,
        eligible: 2,
        accessFeasible: 2,
        hoursFeasible: 2,
        feasible: 2,
        scheduled: 2,
      },
      dayCount: 6,
      daysWithActivity: 2,
      unscheduled: Array.from({ length: 6 }, (_, index) =>
        rejection('exceeds_daily_travel', `Place ${index}`),
      ),
      profile: SPACIOUS,
    });

    expect(readiness.level).toBe('insufficient');
    expect(readiness.summary).not.toContain('the room around it is the pace you asked for');
    expect(readiness.summary).toContain('2 stops across 2 of your 6 days');
  });
});
