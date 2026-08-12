import { describe, expect, it } from 'vitest';
import { planTrip } from './plan';
import { easeDay, removeStopFromDay, swapAlternativesForStop, swapStopOnDay } from './edit';
import { buildScenario } from './testing/scenario';
import type { Itinerary } from '@sidequest/core';

/**
 * PR-EDIT-01/02/04: A TRIP CAN BE ALTERED WITHOUT RESTARTING, AND A LOCAL EDIT
 * STAYS LOCAL.
 *
 * The properties, in the contract's own order: structured intent produces a
 * deterministic replan of exactly one day (§11.1); swap offers are drawn from
 * this trip's own unused board supply under the outgoing stop's constraints
 * (§11.3); unaffected days are preserved — not "mostly preserved", byte for
 * byte (DoD 40); and a lock survives a rebuild (§11.2).
 */

function baseline(): { input: ReturnType<typeof buildScenario>; itinerary: Itinerary } {
  const input = buildScenario();
  const result = planTrip(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('baseline scenario must plan');
  return { input, itinerary: result.itinerary };
}

/** A day with at least two stops, so removing one leaves a day to rebuild. */
function editableDay(itinerary: Itinerary) {
  const day = itinerary.days.find(
    (entry) => entry.items.filter((item) => item.kind === 'activity').length >= 2,
  );
  expect(day, 'the golden scenario should produce a multi-stop day').toBeDefined();
  return day!;
}

describe('removing a stop', () => {
  it('replans only the affected day and keeps every other day byte-identical', () => {
    const { input, itinerary } = baseline();
    const day = editableDay(itinerary);
    const target = day.items.find((item) => item.kind === 'activity' && item.placeId)!;

    const result = removeStopFromDay(input, itinerary, day.dayNumber, target.placeId!);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    /* The stop is gone from the edited day. */
    const edited = result.itinerary.days.find((entry) => entry.dayNumber === day.dayNumber)!;
    expect(
      edited.items.some((item) => item.placeId === target.placeId),
      'the removed stop is still on the day',
    ).toBe(false);

    /* Every other day is the stored day, byte for byte. */
    for (const before of itinerary.days) {
      if (before.dayNumber === day.dayNumber) continue;
      const after = result.itinerary.days.find((entry) => entry.dayNumber === before.dayNumber)!;
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    }

    /*
     * The removal was the traveller's decision, so it must not resurface as an
     * unscheduled "conflict" — and the edit is named in the revision record as
     * theirs, not as the planner's own judgement.
     */
    expect(result.itinerary.unscheduled.some((entry) => entry.placeId === target.placeId)).toBe(
      false,
    );
    const revision = result.itinerary.diagnostics.revisions.at(-1)!;
    expect(revision.code).toBe('traveller_edit');
    expect(revision.description).toContain(target.title);
  });

  it('refuses honestly when the day does not visit the place', () => {
    const { input, itinerary } = baseline();
    const result = removeStopFromDay(input, itinerary, 1, 'place-that-is-not-here');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('swap offers', () => {
  it('come from the unused board supply and fit the day, the effort and the interests', () => {
    const { input, itinerary } = baseline();
    const day = editableDay(itinerary);
    const target = day.items.find((item) => item.kind === 'activity' && item.placeId)!;

    const scheduledIds = new Set(
      itinerary.days.flatMap((entry) =>
        entry.items
          .filter((item) => item.kind === 'activity' && item.placeId)
          .map((item) => item.placeId!),
      ),
    );
    const offers = swapAlternativesForStop(input, itinerary, day.dayNumber, target.placeId!);

    /* Not a generic list: nothing already on the plan, nothing excluded. */
    const excluded = new Set(
      input.selections
        .filter((selection) => selection.status === 'excluded')
        .map((selection) => selection.placeId),
    );
    for (const offer of offers) {
      expect(scheduledIds.has(offer.placeId), `${offer.name} is already scheduled`).toBe(false);
      expect(excluded.has(offer.placeId), `${offer.name} was excluded by the traveller`).toBe(
        false,
      );
      expect(offer.reason.length).toBeGreaterThan(0);
    }
  });

  it('swapping places the replacement on the same day and preserves the rest', () => {
    const { input, itinerary } = baseline();
    const day = editableDay(itinerary);
    const target = day.items.find((item) => item.kind === 'activity' && item.placeId)!;
    const offers = swapAlternativesForStop(input, itinerary, day.dayNumber, target.placeId!);
    if (offers.length === 0) return; // Nothing to swap in is a legitimate board state.

    const result = swapStopOnDay(
      input,
      itinerary,
      day.dayNumber,
      target.placeId!,
      offers[0]!.placeId,
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const edited = result.itinerary.days.find((entry) => entry.dayNumber === day.dayNumber)!;
    expect(edited.items.some((item) => item.placeId === offers[0]!.placeId)).toBe(true);
    expect(edited.items.some((item) => item.placeId === target.placeId)).toBe(false);

    for (const before of itinerary.days) {
      if (before.dayNumber === day.dayNumber) continue;
      const after = result.itinerary.days.find((entry) => entry.dayNumber === before.dayNumber)!;
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    }
  });
});

describe('making a day easier', () => {
  it('steps the day down an intensity band or says plainly why it cannot', () => {
    const { input, itinerary } = baseline();
    const heavy = itinerary.days.find((entry) => entry.intensity !== 'light');
    if (!heavy) return; // A trip of light days has nothing to ease; also legitimate.

    const result = easeDay(input, itinerary, heavy.dayNumber);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
      return;
    }

    const edited = result.itinerary.days.find((entry) => entry.dayNumber === heavy.dayNumber)!;
    const rank = { light: 0, moderate: 1, intense: 2 } as const;
    expect(rank[edited.intensity]).toBeLessThan(rank[heavy.intensity]);

    /* What came off is named, with the traveller's own request as the reason. */
    const eased = result.itinerary.unscheduled.filter((entry) =>
      entry.reason.includes('at your request'),
    );
    expect(eased.length).toBeGreaterThan(0);

    for (const before of itinerary.days) {
      if (before.dayNumber === heavy.dayNumber) continue;
      const after = result.itinerary.days.find((entry) => entry.dayNumber === before.dayNumber)!;
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    }
  });
});

describe('locks across a rebuild', () => {
  /**
   * THE NEGATIVE CONTROL IS THE TEST.
   *
   * The previous version of this test withdrew one selection on another day
   * and asserted the target stop was still on its own day. It passed with
   * `locks: []`, and it passed with the planner's lock map forced empty — the
   * perturbation never moved that stop, so geography satisfied the assertion
   * whether or not a lock existed. §11.2 and PR-EDIT-02 had no guard at all,
   * and this is the fixture-encodes-the-non-defect class: the scenario proved
   * the planner was stable, not that the pin held.
   *
   * So the scenario is *searched for* rather than assumed. The rebuild below
   * is one the planner demonstrably re-decides — the stop lands on a different
   * day when nothing is pinned — and the search fails loudly if the fixture
   * ever stops producing one, because at that moment the test underneath it
   * would go vacuous again in silence.
   */
  function relocatingRebuild(): {
    input: ReturnType<typeof buildScenario>;
    withdrawnId: string;
    placeId: string;
    fromDay: number;
    toDay: number;
  } {
    const { input, itinerary } = baseline();
    const dayOf = (plan: Itinerary, placeId: string): number | null =>
      plan.days.find((entry) => entry.items.some((item) => item.placeId === placeId))?.dayNumber ??
      null;

    const scheduled = itinerary.days.flatMap((entry) =>
      entry.items
        .filter((item) => item.kind === 'activity' && item.placeId)
        .map((item) => ({ placeId: item.placeId!, dayNumber: entry.dayNumber })),
    );

    for (const withdrawn of scheduled) {
      const rebuilt = planTrip({
        ...input,
        selections: input.selections.map((selection) =>
          selection.placeId === withdrawn.placeId
            ? { ...selection, status: 'excluded' as const, source: 'user' as const }
            : selection,
        ),
      });
      if (!rebuilt.ok) continue;
      for (const stop of scheduled) {
        if (stop.placeId === withdrawn.placeId) continue;
        const landed = dayOf(rebuilt.itinerary, stop.placeId);
        if (landed !== null && landed !== stop.dayNumber) {
          return {
            input,
            withdrawnId: withdrawn.placeId,
            placeId: stop.placeId,
            fromDay: stop.dayNumber,
            toDay: landed,
          };
        }
      }
    }
    throw new Error(
      'no withdrawal in the golden scenario relocates another stop, so nothing here can exercise a lock',
    );
  }

  /** The same rebuild, with or without the pin. */
  function rebuild(
    scenario: ReturnType<typeof relocatingRebuild>,
    locks: { placeId: string; dayNumber: number }[],
  ): Itinerary {
    const result = planTrip({
      ...scenario.input,
      selections: scenario.input.selections.map((selection) =>
        selection.placeId === scenario.withdrawnId
          ? { ...selection, status: 'excluded' as const, source: 'user' as const }
          : selection,
      ),
      locks,
    });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) throw new Error(result.message);
    return result.itinerary;
  }

  it('moves the stop when nothing is pinned — the control this test would be worthless without', () => {
    const scenario = relocatingRebuild();
    const free = rebuild(scenario, []);
    const landed = free.days.find((entry) =>
      entry.items.some((item) => item.placeId === scenario.placeId),
    )?.dayNumber;
    expect(
      landed,
      `${scenario.placeId} did not move without a lock, so the lock assertion below proves nothing`,
    ).toBe(scenario.toDay);
    expect(scenario.toDay).not.toBe(scenario.fromDay);
  });

  it('keeps a locked stop on the day it was pinned to, through that same rebuild', () => {
    const scenario = relocatingRebuild();
    const pinned = rebuild(scenario, [
      { placeId: scenario.placeId, dayNumber: scenario.fromDay },
    ]);

    const lockedDay = pinned.days.find((entry) => entry.dayNumber === scenario.fromDay)!;
    expect(
      lockedDay.items.some((item) => item.placeId === scenario.placeId),
      `the locked stop left day ${scenario.fromDay} for day ${scenario.toDay}`,
    ).toBe(true);
    /* And nowhere else: a lock is a pin, not a duplicate. */
    for (const entry of pinned.days) {
      if (entry.dayNumber === scenario.fromDay) continue;
      expect(entry.items.some((item) => item.placeId === scenario.placeId)).toBe(false);
    }
  });
});
