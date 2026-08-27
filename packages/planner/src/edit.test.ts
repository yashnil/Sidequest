import { describe, expect, it } from 'vitest';
import { planTrip } from './plan';
import { easeDay, removeStopFromDay, swapAlternativesForStop, swapStopOnDay } from './edit';
import { buildScenario } from './testing/scenario';
import { compareBoardOrder, type Itinerary } from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';

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

  /**
   * THE MENU IS THE BOARD'S LIST, IN THE BOARD'S ORDER.
   *
   * `feasibleReplacements` sorted on `fitScore`, so the one list whose entire
   * job is to say "here is what else your board holds" ranked those places by
   * match alone, while every card the traveller had just been reading was ranked
   * by band and then by how much each place matters. It also decides *which*
   * five are shown, so the disagreement was not only an ordering: a place the
   * board put fourth could fall out of a five-row menu altogether.
   *
   * Standing is written across the region in four steps because the authored
   * fixture carries none, and on a board where nothing carries it the two orders
   * coincide and this would pass over the defect — the same lever
   * `candidates.test.ts` uses for the planning queue.
   */
  it('lists replacements in the board’s order, not by fit score', () => {
    const steps = [0.1, 0.4, 0.6, 0.9];
    const input = buildScenario({
      places: EASTERN_SIERRA_PLACES.map((place, index) => ({
        ...place,
        experienceSignificance: steps[index % steps.length]!,
      })),
    });
    const result = planTrip(input);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const boardById = new Map(input.candidates.map((entry) => [entry.place.id, entry]));
    let discriminating = 0;
    const wrong: string[] = [];
    for (const day of result.itinerary.days) {
      for (const item of day.items) {
        if (item.kind !== 'activity' || !item.placeId) continue;
        const offered = swapAlternativesForStop(
          input,
          result.itinerary,
          day.dayNumber,
          item.placeId,
        ).map((offer) => offer.placeId);
        if (offered.length < 2) continue;

        const asBoarded = [...offered].sort((a, b) =>
          compareBoardOrder(boardById.get(a)!, boardById.get(b)!),
        );
        const byFit = [...offered].sort(
          (a, b) =>
            boardById.get(b)!.fit.score - boardById.get(a)!.fit.score || a.localeCompare(b),
        );
        /* Only the menus where the two keys actually disagree prove anything. */
        if (JSON.stringify(asBoarded) !== JSON.stringify(byFit)) discriminating += 1;
        if (JSON.stringify(offered) !== JSON.stringify(asBoarded)) {
          wrong.push(
            `day ${day.dayNumber} ${item.title}: offered [${offered.join(', ')}], the board reads [${asBoarded.join(', ')}]`,
          );
        }
      }
    }

    expect(
      discriminating,
      'no menu here separates the board’s key from fit alone, so this proves nothing',
    ).toBeGreaterThan(0);
    expect(wrong, `${wrong.length} swap menus contradicted the board:\n${wrong.join('\n')}`).toEqual(
      [],
    );
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

  /**
   * WHICH PIN WINS THE LAST SLOT IS THE BOARD'S ANSWER, NOT A SECOND ONE.
   *
   * The lift into the manual band was `10_000 + fitScore`, written out by hand
   * here and in `edit.ts`. That is the board's key from before it began
   * composing standing into its order — so the moment two pins competed for one
   * slot, the plan resolved them by match alone while the board that produced
   * them had resolved them the other way, and nothing on either screen said why.
   *
   * The scenario is a one-day trip whose window holds exactly one stop, with
   * both places pinned to it. The two are three points apart in match and a
   * band-mate in every other respect, and the one the region is known for is the
   * one behind on match — so the two keys give opposite answers and the day can
   * only satisfy one of them.
   */
  it('gives the day’s only slot to the pin the board ranked first, not the higher fit score', () => {
    const better = 'panorama-gondola';
    const higherFit = 'hot-creek-geologic-site';
    const places = EASTERN_SIERRA_PLACES.map((place) =>
      place.id === better
        ? { ...place, experienceSignificance: 0.9 }
        : place.id === higherFit
          ? { ...place, experienceSignificance: 0.5 }
          : place,
    );

    const scenario = buildScenario({
      places,
      basics: { startDate: '2026-08-13', endDate: '2026-08-13' },
    });
    const chosen = [higherFit, better].map((placeId) => ({
      placeId,
      status: 'included' as const,
      source: 'auto' as const,
      updatedAt: '2026-07-30T00:00:00.000Z',
    }));
    const boarded = chosen.map(
      (entry) => scenario.candidates.find((candidate) => candidate.place.id === entry.placeId)!,
    );
    expect(boarded.every(Boolean), 'the authored region no longer holds this pair').toBe(true);
    expect(
      { fit: boarded.map((candidate) => candidate.fit.score), band: boarded.map((c) => c.fit.band) },
      'the pair no longer sits three points apart inside one band, so the two keys now agree',
    ).toEqual({ fit: [84, 81], band: ['strong', 'strong'] });
    expect([...boarded].sort(compareBoardOrder)[0]!.place.id).toBe(better);

    const result = planTrip({
      ...scenario,
      selections: chosen,
      locks: chosen.map((entry) => ({ placeId: entry.placeId, dayNumber: 1 })),
    });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const scheduled = result.itinerary.days
      .flatMap((day) => day.items)
      .filter((item) => item.kind === 'activity' && item.placeId)
      .map((item) => item.placeId!);
    expect(
      scheduled.length,
      'the day now holds both, so nothing here is choosing between the two keys',
    ).toBe(1);
    expect(
      scheduled,
      'the trip kept the higher match where the board it was built from ranked the other first',
    ).toEqual([better]);
    expect(result.itinerary.unscheduled.map((entry) => entry.placeId)).toEqual([higherFit]);
  });
});
