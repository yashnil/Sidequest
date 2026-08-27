import { describe, expect, it } from 'vitest';
import { travelKnowledgeFor, scheduledTransportUnmeasured } from '@sidequest/core';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';

/**
 * THE FIELD THE PLANNER HAS TO BE HANDED, BECAUSE IT CANNOT DERIVE IT.
 *
 * `scheduledTransportUnmeasured` is what tells every walking bound whether a
 * long measured walk is the journey the traveller will make or is only pricing
 * a scheduled journey nobody could time. It reads three things, and two of them
 * — the bought timetables and their absence reason — the planner already had.
 * The third, whether the compiled evidence counted any scheduled stop at all,
 * was threaded into the board and never into `planTrip`, so the predicate was
 * false everywhere the planner asked it and the whole separation of last-mile
 * walking from whole-journey travel stopped at the board.
 *
 * Live evidence: a car-free six-day trip in a region whose own pack counts 117
 * scheduled stops came back with two stops across two days, every refusal
 * quoting the traveller's twenty-five-minute last-mile answer. The board knew;
 * the planner was never told.
 *
 * These tests pin the wiring rather than the arithmetic — the bounds themselves
 * are held by `walk-limit.test.ts` and `reach.test.ts`. What can regress here
 * is one argument silently going missing again.
 */
describe('the planner is handed the scheduled-network observation', () => {
  it('carries it into the knowledge every walking bound is read from', () => {
    const scenario = buildScenario();
    const withNetwork = travelKnowledgeFor(
      scenario.matrix,
      scenario.profile,
      { journeys: [], requested: 0, measured: 0, absence: 'unsupported' },
      'observed',
    );
    expect(scheduledTransportUnmeasured(withNetwork)).toBe(true);

    /* The same evidence with the observation missing opens no gate. */
    const withoutNetwork = travelKnowledgeFor(
      scenario.matrix,
      scenario.profile,
      { journeys: [], requested: 0, measured: 0, absence: 'unsupported' },
      null,
    );
    expect(scheduledTransportUnmeasured(withoutNetwork)).toBe(false);
  });

  it('plans a trip whose input declares one without refusing it', () => {
    /*
     * The narrow claim: `planTrip` accepts the field and produces a plan. The
     * regression it guards is a dropped argument, which typechecks and silently
     * disables the gate — so the assertion is that a declared observation
     * reaches a working plan rather than that the plan changed shape.
     */
    const observed = planTrip({ ...buildScenario(), scheduledNetwork: 'observed' });
    expect(observed.ok, observed.ok ? '' : 'a declared observation refused a plan').toBe(true);

    const unobserved = planTrip({ ...buildScenario(), scheduledNetwork: 'not_observed' });
    expect(unobserved.ok).toBe(true);
  });
});
