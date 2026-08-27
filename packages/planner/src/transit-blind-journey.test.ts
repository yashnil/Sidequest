import { describe, expect, it } from 'vitest';
import {
  walkingLegBoundMinutes,
  detourToleranceMinutesFor,
  DETOUR_STRETCH_MULTIPLIER,
  type ItineraryItem,
} from '@sidequest/core';
import { planTrip } from './plan';
import { formatSpan } from './modelled-walk';
import {
  transitBlindScenario,
  TRANSIT_BLIND_IDS as IDS,
  TRANSIT_BLIND_WALKS as WALKS,
} from './testing/transit-blind-city';

/**
 * A TRANSIT-BLIND WALK IS A PROXY, NEVER AN INSTRUCTION AND NEVER AN EXCUSE.
 *
 * The production shape behind three audited findings, run end to end through
 * the real pipeline — questionnaire answers → profile → discovery board →
 * auto-pick → planner → rendered itinerary — because the last wave's repair
 * passed its own unit tests while the production branch bypassed the invariant.
 * Nothing here hand-builds a candidate or a planner input.
 *
 * The shape: no car; twenty-five minutes as the answer to "how far will you
 * walk to reach a stop"; a much larger answer to "how far will you travel one
 * way for one stop"; a destination whose evidence observes a scheduled network
 * and whose journeys nobody could time. On that ground the compiler prices
 * every journey on the only network anybody measured — the pedestrian one — so
 * the seats a traveller would ride to in twenty minutes arrive as walks of
 * three quarters of an hour and more.
 *
 * One number then answered two questions that need different answers, and both
 * answers were wrong:
 *
 *   - as a *reach* verdict it was too narrow, and the canon was filed under
 *     "Probably skip" reading a walking clock;
 *   - as a *walking* ceiling it was far too wide — a hundred and twelve minutes
 *     for somebody who answered twenty-five — and two live itineraries shipped
 *     rows reading "Walk to X — 67 min on foot".
 *
 * What this file gates is that both stay closed at once, on the rendered
 * result, which is what a reviewer actually reads.
 */

function travelItems(items: readonly ItineraryItem[]): ItineraryItem[] {
  return items.filter((item) => item.kind === 'travel');
}

/** The minutes a set of legs actually spends, read off the legs themselves. */
function minutesOf(legs: readonly { minutes: number | null }[]): number {
  return legs.reduce((sum, leg) => sum + (leg.minutes ?? 0), 0);
}

/** Every traveller-facing string a rendered plan puts in front of somebody. */
function renderedClaims(plan: ReturnType<typeof planTrip>): string[] {
  if (!plan.ok) return [plan.message];
  const claims: string[] = [];
  for (const day of plan.itinerary.days) {
    for (const item of day.items) {
      claims.push(item.title, item.reason);
    }
  }
  for (const left of plan.itinerary.unscheduled) {
    claims.push(left.reason);
    if (left.suggestedRemedy) claims.push(left.suggestedRemedy);
  }
  return claims;
}

/** The sentence core mints for a journey nobody could verify. */
const UNVERIFIED = /could not verify the transit route/i;

describe('a car-free trip whose scheduled network nobody could time', () => {
  const input = transitBlindScenario('observed');
  const walkBound = walkingLegBoundMinutes(input.profile);
  const journeyBound = detourToleranceMinutesFor(input.profile, 'walk', {
    transitUnmeasured: true,
  });

  it('is the shape the live journeys were, at both bounds', () => {
    /*
     * The fixture is only a witness while the two bounds disagree, and while
     * the canon sits in the gap between them. If either stops being true this
     * whole file is asserting nothing.
     */
    expect(input.profile.transport.willDrive).toBe(false);
    expect(walkBound).toBe(25);
    expect(journeyBound).toBeGreaterThan(walkBound);
    for (const minutes of [WALKS.canonA, WALKS.canonB, WALKS.canonC]) {
      expect(minutes).toBeGreaterThan(walkBound * DETOUR_STRETCH_MULTIPLIER);
      expect(minutes).toBeLessThanOrEqual(journeyBound);
    }
    expect(WALKS.near).toBeLessThanOrEqual(walkBound);
    expect(WALKS.outlier).toBeGreaterThan(journeyBound * DETOUR_STRETCH_MULTIPLIER);
  });

  it('keeps the canon eligible instead of collapsing the plan to what you can walk to', () => {
    /*
     * The half the widening bought and must not lose. Bounding reach by the
     * walking answer refused every canonical seat on two live boards and left
     * one of them with a single scheduled stop out of a twenty-four card board.
     */
    const board = new Map(input.candidates.map((entry) => [entry.place.id, entry]));
    for (const id of [IDS.canonA, IDS.canonB, IDS.canonC]) {
      const card = board.get(id);
      expect(card, `${id} missing from the board`).toBeDefined();
      expect(card!.quality.outcome, `${id} filed as a skip`).not.toBe('not_worth_detour');
      expect(card!.quality.reason).not.toMatch(/past how far you said you would go/);
    }

    const plan = planTrip(input);
    expect(plan.ok, plan.ok ? '' : plan.message).toBe(true);
    if (!plan.ok) return;
    const scheduled = plan.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'activity'),
    );
    expect(scheduled.length).toBeGreaterThan(2);
  });

  it('never renders a walking instruction past the traveller’s own answer', () => {
    /*
     * FINDING 1, ON THE RENDERED RESULT. The per-leg ceiling reached a hundred
     * and twelve minutes for a traveller who answered twenty-five, and the
     * itinerary laid legs reading "Walk to X — 67 min on foot".
     *
     * The band is the stated answer stretched, which is the one band the board
     * and the planner share; anything laid as a walk sits inside it, and
     * anything that does not is not laid as a walk.
     */
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const ceiling = walkBound * DETOUR_STRETCH_MULTIPLIER;
    for (const day of plan.itinerary.days) {
      for (const item of travelItems(day.items)) {
        const leg = item.travel;
        if (!leg || leg.mode !== 'walk' || leg.minutes === null) continue;
        if (UNVERIFIED.test(item.reason)) continue;
        expect(
          leg.minutes,
          `"${item.title}" instructs a ${leg.minutes} min walk against a ${walkBound} min answer`,
        ).toBeLessThanOrEqual(ceiling);
      }
    }

    /* And no row anywhere tells the traveller to walk for longer than that. */
    for (const claim of renderedClaims(plan)) {
      if (UNVERIFIED.test(claim)) continue;
      expect(claim).not.toMatch(/\b(?:[4-9]\d|1\d\d) min on foot/);
    }
  });

  it('presents an unpriced journey as unverified, never as verified and never as a walk', () => {
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const unverified = plan.itinerary.days
      .flatMap((day) => travelItems(day.items))
      .filter((item) => UNVERIFIED.test(item.reason));
    expect(unverified.length, 'no journey was presented as unverified at all').toBeGreaterThan(0);

    for (const item of unverified) {
      /* Not an instruction to walk. */
      expect(item.title).not.toMatch(/^Walk /);
      /* Not a measurement of the journey, and not a published timetable either. */
      expect(item.travel?.provenance).toBe('modelled');
      /* No train invented: the only number is still the one somebody measured. */
      expect(item.travel?.minutes).toBeGreaterThan(0);
      expect(item.reason).toMatch(/on foot/);
    }
  });

  it('books a proxy journey to no mode’s total, and still reserves the whole of its time', () => {
    /*
     * THE HALF THE TITLE-ONLY REPAIR LEFT OPEN.
     *
     * The row read "Travel to X" and every number behind it still said walking:
     * a stored day carried `{"travelMinutes":124,"walkMinutes":124}` for a
     * traveller who answered twenty-five minutes, and the day header, the split
     * line, the trip header and the transport panel each read that total back.
     *
     * The two halves of the contract are asserted together on purpose. A bucket
     * that quietly dropped the minutes would clear the walking total and lie
     * about the day, so the arithmetic is checked in the same breath: nothing
     * mode-named holds a proxy minute, and the day's travel figure is still
     * every minute the timeline spends getting somewhere.
     */
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    let daysWithProxy = 0;
    for (const day of plan.itinerary.days) {
      const legs = travelItems(day.items)
        .map((item) => item.travel)
        .filter((leg): leg is NonNullable<typeof leg> => leg !== undefined && leg.minutes !== null);
      const proxy = legs.filter((leg) => leg.unverifiedScheduled === true);
      if (proxy.length === 0) continue;
      daysWithProxy += 1;

      const onFoot = legs.filter((leg) => leg.mode === 'walk' && leg.unverifiedScheduled !== true);
      expect(minutesOf(proxy), `day ${day.dayNumber} has no proxy minutes`).toBeGreaterThan(0);

      /* Not on foot, and no train invented for it either. */
      expect(day.totals.walkMinutes, `day ${day.dayNumber} walking`).toBe(minutesOf(onFoot));
      expect(day.totals.transitMinutes, `day ${day.dayNumber} riding`).toBe(0);
      expect(day.totals.driveMinutes, `day ${day.dayNumber} driving`).toBe(0);

      /* Its own bucket, holding exactly what the timeline holds. */
      expect(day.totals.unverifiedMinutes, `day ${day.dayNumber} unverified`).toBe(
        minutesOf(proxy),
      );

      /* And the day still reserves every minute it actually spends travelling. */
      expect(day.totals.travelMinutes, `day ${day.dayNumber} travelling`).toBe(minutesOf(legs));

      /*
       * The mode is a stand-in, so it is not how this day is got through
       * either. A day whose only travel is a proxy announced walking as its
       * method, which is what carried the claim up to the trip's own headline.
       */
      if (onFoot.length === 0) {
        expect(day.transport.modes, `day ${day.dayNumber} modes`).not.toContain('walk');
      }
    }
    expect(daysWithProxy, 'no day carried a proxy journey at all').toBeGreaterThan(0);
  });

  it('keeps the measured figure on the row, stated as the upper bound it is', () => {
    /*
     * The one real number here is the walk somebody measured, and dropping it
     * would leave a row with a duration and no account of where it came from.
     * It stays, named as the bound rather than as the journey — never a
     * duration for the scheduled route, which nobody timed.
     */
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const proxies = plan.itinerary.days
      .flatMap((day) => travelItems(day.items))
      .filter((item) => item.travel?.unverifiedScheduled === true);
    expect(proxies.length).toBeGreaterThan(0);

    for (const item of proxies) {
      expect(item.reason).toMatch(UNVERIFIED);
      /* The figure the day reserves is the figure the sentence quotes. */
      expect(item.reason).toContain(formatSpan(item.travel!.minutes!));
      expect(item.durationMinutes).toBe(item.travel!.minutes);
      /* Said to be a ceiling, not a duration. */
      expect(item.reason).toMatch(/longest/);
    }
  });

  it('carries the same verdict into the trip totals and the trip’s own headline', () => {
    /*
     * "6 hr 46 min on foot to reach them" was the first sentence of a live plan
     * whose long legs were every one of them a proxy. The trip-level figures
     * are a second surface reading the day totals, and a fix that repaired only
     * the days would have left that sentence exactly as it was.
     */
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const legs = plan.itinerary.days
      .flatMap((day) => travelItems(day.items))
      .map((item) => item.travel)
      .filter((leg): leg is NonNullable<typeof leg> => leg !== undefined && leg.minutes !== null);
    const proxyMinutes = minutesOf(legs.filter((leg) => leg.unverifiedScheduled === true));
    const walkedMinutes = minutesOf(
      legs.filter((leg) => leg.mode === 'walk' && leg.unverifiedScheduled !== true),
    );
    expect(proxyMinutes).toBeGreaterThan(0);
    expect(walkedMinutes).toBeGreaterThan(0);

    const totals = plan.itinerary.transportStrategy.totals;
    expect(totals.walkMinutes).toBe(walkedMinutes);
    expect(totals.unverifiedMinutes).toBe(proxyMinutes);

    /* The headline counts the walking that happened, and names the rest. */
    expect(plan.itinerary.summary).toContain(`${formatSpan(walkedMinutes)} on foot to reach them`);
    expect(plan.itinerary.summary).not.toContain(
      `${formatSpan(walkedMinutes + proxyMinutes)} on foot`,
    );
    expect(plan.itinerary.summary).toContain('could not verify');
  });

  it('leaves the validator checking the same legs the layout charged', () => {
    /*
     * The day totals and the stored timeline are classified by one function on
     * both sides, and this check is the whole reason that matters: a bucket the
     * validator could not re-derive would fail every plan carrying a proxy leg,
     * and a bucket only the layout knew about would let one drift unnoticed.
     */
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.itinerary.issues.map((issue) => issue.code)).not.toContain(
      'inconsistent_transport_totals',
    );
  });

  it('counts, badges and describes a genuine walk as a walk, exactly as before', () => {
    /*
     * The control that keeps the repair narrow. Inside the traveller's stated
     * answer the walk is simply the journey: it is titled as one, charged to
     * the walking total, and the day says it walked.
     */
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    let walked = 0;
    for (const day of plan.itinerary.days) {
      for (const item of travelItems(day.items)) {
        const leg = item.travel;
        if (!leg || leg.mode !== 'walk' || leg.unverifiedScheduled === true) continue;
        walked += 1;
        expect(item.title).toMatch(/^Walk /);
        expect(item.reason).not.toMatch(UNVERIFIED);
        expect(leg.provenance).toBe('measured');
        expect(day.totals.walkMinutes).toBeGreaterThanOrEqual(leg.minutes!);
        expect(day.transport.modes).toContain('walk');
      }
    }
    expect(walked, 'no genuine walk was scheduled at all').toBeGreaterThan(0);
  });

  it('never bills the traveller’s walking answer for a route nobody could price', () => {
    /*
     * FINDING 11. "1 hr 29 min each way on foot is past how far you said you
     * would go" is false in all three of its clauses — not the distance, not
     * the mode, and not their answer that ruled it out. Every refusal and every
     * remedy this plan renders about a proxy journey says what is true instead.
     */
    const plan = planTrip(input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    for (const claim of renderedClaims(plan)) {
      if (!UNVERIFIED.test(claim)) continue;
      expect(claim).not.toMatch(/furthest you would walk/);
      expect(claim).not.toMatch(/you said/);
    }

    const outlier = plan.itinerary.unscheduled.find((entry) => entry.placeId === IDS.outlier);
    if (outlier) {
      expect(outlier.reason).not.toMatch(/furthest you would walk/);
    }
  });

  it('leaves the honest walk exactly as it was, where no network was observed', () => {
    /*
     * The control, and the regression this pass must not cause. Identical
     * matrix, identical traveller, identical journeys — over ground whose
     * evidence records no scheduled network at all. There is nothing standing
     * in for anything: the walk is the journey, the walking bound is the only
     * bound, and the refusal names the walk and the answer that rules it out.
     */
    const honest = transitBlindScenario('not_observed');
    expect(detourToleranceMinutesFor(honest.profile, 'walk', { transitUnmeasured: false })).toBe(
      walkBound,
    );

    const plan = planTrip(honest);
    if (!plan.ok) return;
    for (const claim of renderedClaims(plan)) {
      expect(claim).not.toMatch(UNVERIFIED);
    }
  });
});
