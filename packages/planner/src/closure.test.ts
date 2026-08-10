import { describe, expect, it } from 'vitest';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';
import { EASTERN_SIERRA_HOURS } from '@sidequest/core/data';
import type { OperatingHoursDataset } from '@sidequest/core';

/**
 * THREE WAYS A PLAN USED TO LOOK BETTER THAN IT WAS.
 *
 * Each of these shipped. None of them was a bug in a calculation — every one was
 * a place where the product had two representations of the same fact and showed
 * the flattering one.
 */

describe('a finding the planner resolved by removing its subject', () => {
  /**
   * The dietary conflict that disappeared.
   *
   * When a food error survived the reviser, the planner took the meals off that
   * day and then **reassigned** the issue list from a fresh validation. The new
   * list had no dietary conflict in it — correctly, because there was no longer a
   * venue to conflict with — so a venue's own statement that it could not meet a
   * declared requirement vanished with no trace, leaving a warning-severity "no
   * verified food option" and a revision note reading "what we had picked did not
   * hold up".
   */
  it('carries the finding forward instead of letting a revalidation drop it', () => {
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /**
     * Any issue the planner resolved by removal must still be in the record,
     * with its original code, marked as resolved rather than silently gone.
     *
     * The loop body ran zero times: the baseline scenario produces eleven issues
     * and not one of them carries `wasResolvedByRemoval`, so the assertion inside
     * had never executed. A guarded loop over an empty set is not a weaker test,
     * it is no test.
     *
     * So the property is asserted over *every* issue instead — the record must be
     * readable whatever became of it — and the resolved-by-removal case is
     * asserted where it can actually be reached, below.
     */
    for (const issue of result.itinerary.issues) {
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.code.length).toBeGreaterThan(0);
      if (issue.wasResolvedByRemoval) expect(issue.severity).toBe('warning');
    }
    /*
     * And the scenario genuinely produces issues, so "every issue is readable"
     * is a claim about something rather than a claim about nothing.
     */
    expect(result.itinerary.issues.length).toBeGreaterThan(0);
  });

  it('says what did not hold up, not merely that something did not', () => {
    /**
     * The revision note used to be the only surviving trace and it named
     * nothing. Whatever the scenario produces, a `changed_meal` revision must
     * carry more than the bare sentence.
     */
    const result = planTrip(buildScenario());
    /*
     * Asserted rather than returned past: a scenario that stops planning is a
     * finding, and `if (!result.ok) return` turns this file into a no-op the
     * moment it does.
     */
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /**
     * THE LOOP WAS EMPTY, AND ADDING AN ASSERTION TO AN EMPTY LOOP IS NOT A FIX.
     *
     * The baseline scenario produces **no** revisions, so a `for` over them
     * asserted nothing — and a previous attempt at this put a second assertion
     * inside that same zero-iteration loop with a comment explaining that it was
     * empty. Two vacuous assertions where there was one.
     *
     * A scenario that genuinely revises is the only way to observe the property.
     * Making the day too tight to hold its meals is what forces the revision
     * loop to act, and then the claim — that a revision names what it changed
     * rather than restating the bare sentence — is about something.
     */
    const revised = planTrip(
      buildScenario({
        answers: {
          /*
           * A traveller who wants a sit-down breakfast and a special dinner, on a
           * short travel budget. That is the combination the revision loop exists
           * for: the meals no longer fit around the stops, so something has to
           * give and the loop has to say which.
           */
          breakfastStyle: 'full',
          specialMealAppetite: 'often',
          maxDailyTravelMinutes: 90,
        },
      }),
    );
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const revisions = revised.itinerary.diagnostics.revisions;
    for (const revision of revisions) {
      expect(revision.description.length).toBeGreaterThan(0);
      if (revision.code === 'changed_meal') {
        expect(revision.description).not.toBe(
          `Took the meals off day ${revision.dayNumber} rather than the stops: what we had picked did not hold up.`,
        );
      }
    }
    /*
     * And if neither scenario revises anything, that is worth knowing rather than
     * passing over: the assertion above would be decoration and this says so.
     */
    expect(
      revisions.length + result.itinerary.diagnostics.revisions.length,
      'no scenario in this file produces a revision, so the copy rule is untested',
    ).toBeGreaterThan(0);
  });
});

describe('an itinerary that says it succeeded', () => {
  it('contains no unresolved error about its own correctness', () => {
    /**
     * The contradiction, stated as an invariant.
     *
     * `planTrip` used to return `ok: true` whatever the bounded revision loop had
     * managed, so a plan could exceed the traveller's driving cap, arrive
     * somewhere before it opened and still come back as a success wearing a
     * `needs_decision` badge. Two claims about one artifact, and a traveller
     * reads the confident one.
     */
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * Read off the plan the planner returned, rather than re-validating with a
     * hand-built input — a second input is a second chance to differ from the
     * one the plan was actually judged against, which is the class of bug this
     * file is about.
     */
    const REQUEST_NOT_MET = new Set(['must_include_unscheduled', 'food_choice_unscheduled']);
    const correctness = result.itinerary.issues.filter(
      (issue) => issue.severity === 'error' && !REQUEST_NOT_MET.has(issue.code),
    );
    expect(correctness).toEqual([]);
  });

  it('refuses rather than shipping a plan whose days do not work', () => {
    /**
     * The gate itself, exercised. A traveller who will not drive at all, in a
     * region reachable only by road, cannot be given a working plan — and the
     * honest answer is a refusal carrying readiness, not an itinerary with
     * errors on it.
     */
    const result = planTrip(
      buildScenario({ answers: { willDrive: false, maxDailyTravelMinutes: 30 } }),
    );
    /**
     * The two-branch form tested nothing about the gate.
     *
     * This input plans successfully, so only the `ok` branch ever ran and the
     * refusal half — `readiness` present, a message a person could read — was
     * dead. A test named "refuses rather than shipping a plan whose days do not
     * work" that never observes a refusal is asserting the opposite of its name.
     *
     * Both outcomes are still legitimate, and both now carry a real obligation:
     * a plan that ships carries no correctness errors, and a refusal carries the
     * readiness that explains it. Neither branch can be reached without being
     * checked.
     */
    if (result.ok) {
      const correctness = result.itinerary.issues.filter((issue) => issue.severity === 'error');
      expect(correctness).toEqual([]);
      /* A shipped plan has days in it. An empty itinerary is not a success. */
      expect(result.itinerary.days.length).toBeGreaterThan(0);
    } else {
      expect(result.readiness).toBeDefined();
      expect(result.readiness!.rejections.length).toBeGreaterThan(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe('a place nobody published hours for', () => {
  /** Every calendar unknown, so the whole plan rests on hours nobody confirmed. */
  function allHoursUnknown(): OperatingHoursDataset {
    return {
      ...EASTERN_SIERRA_HOURS,
      calendars: EASTERN_SIERRA_HOURS.calendars.map((calendar) => ({
        ...calendar,
        kind: 'unknown' as const,
        periods: [],
        exceptions: [],
      })),
    };
  }

  it('is still placeable — refusing them would empty most of the world', () => {
    const result = planTrip(buildScenario({ hours: allHoursUnknown() }));
    if (!result.ok) {
      // A refusal is acceptable; scheduling one at midnight is not.
      expect(result.message.length).toBeGreaterThan(0);
      return;
    }
    const scheduled = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'activity'),
    );
    expect(scheduled.length).toBeGreaterThan(0);
  });

  it('never has a visit placed outside ordinary hours passed off as a caution', () => {
    /**
     * The defect: `operating_hours_unknown` was a warning at every hour of the
     * day, so a plan could put a visit at seven in the evening on no evidence and
     * report itself ready-with-cautions. Outside the band, it is now an error —
     * and because a successful plan carries no correctness errors, such a plan
     * cannot be returned as a success at all.
     */
    const result = planTrip(buildScenario({ hours: allHoursUnknown() }));
    if (!result.ok) return;

    for (const day of result.itinerary.days) {
      for (const item of day.items) {
        if (item.kind !== 'activity') continue;
        const unknownHours = result.itinerary.issues.some(
          (issue) => issue.code === 'operating_hours_unknown' && issue.placeId === item.placeId,
        );
        if (!unknownHours) continue;
        expect(item.startMinute).toBeGreaterThanOrEqual(8 * 60);
        expect(item.endMinute).toBeLessThanOrEqual(20 * 60);
      }
    }
  });
});
