import { describe, expect, it } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import { planTrip } from './plan';
import { easeDay, swapAlternativesForStop, swapStopOnDay } from './edit';
import { blockingIssues } from './validate';
import { buildScenario } from './testing/scenario';

/**
 * PR-EDIT-05: AN EDIT MAY NOT PERSIST A PLAN THE BUILDER WOULD HAVE REFUSED.
 *
 * `planTrip` refuses to hand back a plan carrying an unresolved error. The
 * editing surface had no equivalent: `rebuildDay` laid a day out with
 * `layoutBestOrder` — which is deliberately limit-free, because `packDay` owns
 * the limits — and `assemble` saved whatever came back. So the product's own
 * "Swap for something similar…" menu offered thirty-three replacements on the
 * golden Eastern Sierra trip and eight of them produced and saved a plan the
 * builder would have flatly refused: one day forty minutes over the driving cap
 * the traveller set, and a departure-day drive home landing at 16:09 for a
 * 17:00 flight.
 *
 * The property is stated over the offers the product itself generates rather
 * than over a hand-picked pair, because a hand-picked pair is exactly what
 * passed while eight real ones did not.
 */

function baseline(): { input: ReturnType<typeof buildScenario>; itinerary: Itinerary } {
  const input = buildScenario();
  const result = planTrip(input);
  expect(result.ok, result.ok ? '' : result.message).toBe(true);
  if (!result.ok) throw new Error('the golden scenario must plan');
  return { input, itinerary: result.itinerary };
}

/** Every (day, stop, offer) triple the swap menu would put in front of a traveller. */
function everyOfferedSwap(input: ReturnType<typeof buildScenario>, itinerary: Itinerary) {
  const swaps: { dayNumber: number; stopTitle: string; placeId: string; offer: string; replacementId: string }[] = [];
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      for (const offer of swapAlternativesForStop(input, itinerary, day.dayNumber, item.placeId)) {
        swaps.push({
          dayNumber: day.dayNumber,
          stopTitle: item.title,
          placeId: item.placeId,
          offer: offer.name,
          replacementId: offer.placeId,
        });
      }
    }
  }
  return swaps;
}

describe('the editing surface answers to the builder’s own acceptance', () => {
  it('applies every swap the product offers and persists no plan carrying a blocking error', () => {
    const { input, itinerary } = baseline();
    const swaps = everyOfferedSwap(input, itinerary);
    /*
     * A guard on the guard. If the fixture ever stops producing offers this
     * test would pass over an empty list and prove nothing at all.
     */
    expect(swaps.length, 'the golden scenario should offer swaps to exercise').toBeGreaterThan(10);

    const persistedInvalid: string[] = [];
    let applied = 0;
    for (const swap of swaps) {
      const result = swapStopOnDay(
        input,
        itinerary,
        swap.dayNumber,
        swap.placeId,
        swap.replacementId,
      );
      // A refusal is a correct outcome: it is the gate doing its job, and it
      // arrives with a sentence naming the limit.
      if (!result.ok) {
        expect(result.message.length, 'a refusal must say why').toBeGreaterThan(0);
        continue;
      }
      applied += 1;
      const blocking = blockingIssues(result.itinerary.issues);
      if (blocking.length > 0) {
        persistedInvalid.push(
          `day ${swap.dayNumber} ${swap.stopTitle} → ${swap.offer}: ${blocking
            .map((issue) => `${issue.code} [${issue.message}]`)
            .join(' | ')}`,
        );
      }
      /*
       * One out, one in. A swap that quietly takes a *third* stop off the day
       * to make the replacement fit is a different trip than the one asked for,
       * and it is what the layout does when nothing packs the day first: the
       * layout drops whatever it cannot place and reports a legal-looking day.
       * A day that cannot hold the replacement must be refused, not trimmed.
       */
      const before = itinerary.days.find((entry) => entry.dayNumber === swap.dayNumber)!;
      const after = result.itinerary.days.find((entry) => entry.dayNumber === swap.dayNumber)!;
      const count = (day: typeof before) =>
        day.items.filter((item) => item.kind === 'activity').length;
      if (count(after) !== count(before)) {
        persistedInvalid.push(
          `day ${swap.dayNumber} ${swap.stopTitle} → ${swap.offer}: the day went from ${count(before)} stops to ${count(after)} — the swap took something else off too`,
        );
      }
    }

    expect(applied, 'every offer refused would also make this test vacuous').toBeGreaterThan(0);
    expect(
      persistedInvalid,
      `${persistedInvalid.length} of ${swaps.length} offered swaps persisted a plan planTrip would refuse:\n${persistedInvalid.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * AND EVERY OFFER MUST APPLY — THE HALF THE TEST ABOVE ACCEPTS AS CORRECT.
   *
   * The gate above treats a refusal as a good outcome, and for the mutation it
   * is: a menu can be open in a tab while two other edits land. For the *offer
   * list* it is not. `feasibleReplacements` judges a candidate the way a board
   * does — open that date, a way in, no harder than the stop it replaces — and
   * then the day it would join is already three stops deep, two thirds through
   * its driving budget, and ends at a flight.
   *
   * Measured across this sweep before the offer list ran the swap it offers:
   * **228 of 676 offers could not be applied, and 26 menus were dead in full**,
   * every row an error toast. Departure days were the worst of it — four
   * options, four refusals — and a departure day is where a traveller is most
   * likely to be rearranging something.
   *
   * The scenarios vary pace and day start across four trip lengths because a
   * single fixture hides this: the failure is a function of how full the day
   * already is, and one pace fills days one way. They are the same
   * twenty-four the measurement above was taken on.
   *
   * THE TIME BUDGET, AND WHAT IT IS AND IS NOT MEASURING.
   *
   * Twenty-four plans, about 150 menus and about 470 applied swaps, and the offer
   * list now runs the swap before offering it — so this test pays for each
   * candidate twice, once inside the menu and once again here to check the menu
   * told the truth. That second pass is the whole property and cannot be
   * dropped for speed. It runs to roughly two seconds alone and past the
   * five-second default when the whole suite is running beside it, which is a
   * fact about a twenty-four-scenario sweep rather than about the product: opening
   * one menu on the golden region measures at most sixteen milliseconds.
   *
   * Stated as a budget rather than bought by cutting arms off the sweep, since
   * the arms are what make this reproduce.
   */
  it('offers no replacement that cannot then be applied', { timeout: 60_000 }, () => {
    const scenarios: { name: string; options: Parameters<typeof buildScenario>[0] }[] = [];
    for (const endDate of ['2026-08-14', '2026-08-15', '2026-08-17', '2026-08-18']) {
      for (const pace of ['slow', 'balanced', 'fast'] as const) {
        for (const dayStart of ['early', 'relaxed'] as const) {
          scenarios.push({
            name: `${endDate} ${pace}/${dayStart}`,
            options: { basics: { startDate: '2026-08-12', endDate }, answers: { pace, dayStart } },
          });
        }
      }
    }

    let offered = 0;
    const unapplicable: string[] = [];
    for (const scenario of scenarios) {
      const input = buildScenario(scenario.options);
      const result = planTrip(input);
      expect(result.ok, `${scenario.name}: ${result.ok ? '' : result.message}`).toBe(true);
      if (!result.ok) continue;
      for (const swap of everyOfferedSwap(input, result.itinerary)) {
        offered += 1;
        const applied = swapStopOnDay(
          input,
          result.itinerary,
          swap.dayNumber,
          swap.placeId,
          swap.replacementId,
        );
        if (!applied.ok) {
          unapplicable.push(
            `${scenario.name} day ${swap.dayNumber} ${swap.stopTitle} → ${swap.offer}: ${applied.message}`,
          );
        }
      }
    }

    /*
     * The guard on the guard, and it is doing real work here: filtering the
     * offers down to what applies is one edit away from filtering them down to
     * nothing at all, and an empty menu everywhere would satisfy the assertion
     * below perfectly.
     */
    expect(offered, 'the sweep must still put real offers in front of a traveller').toBeGreaterThan(
      300,
    );
    expect(
      unapplicable,
      `${unapplicable.length} of ${offered} offered replacements could not be applied — every one of them an error toast on a row the product itself put in the menu:\n${unapplicable.slice(0, 20).join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The half of the acceptance the packer cannot see.
   *
   * `packDay` measures a day against the traveller's own limits and the clock;
   * it knows nothing about whether the travel times underneath it are credible.
   * `validateItinerary` does — and before `assemble` had a gate, an edit that
   * produced an outright impossible leg was saved with a "needs decision" badge
   * on it, which is the one thing `planTrip` refuses to do.
   */
  it('refuses an edit whose own travel times are impossible, which no per-day limit would catch', () => {
    const { input, itinerary } = baseline();
    const swap = everyOfferedSwap(input, itinerary)[0];
    expect(swap, 'the golden scenario should offer at least one swap').toBeDefined();
    if (!swap) return;

    /*
     * Every leg to and from the replacement, made impossible: 400 km in five
     * minutes. Only the leg the swap itself introduces is affected, so the
     * baseline plan this is spliced into stays exactly as it was.
     */
    const index = input.matrix.ids.indexOf(swap.replacementId);
    expect(index).toBeGreaterThanOrEqual(0);
    const km = input.matrix.km!.map((row) => [...row]);
    const minutes = input.matrix.minutes.map((row) => [...row]);
    for (let other = 0; other < km.length; other += 1) {
      if (other === index) continue;
      km[index]![other] = 400;
      km[other]![index] = 400;
      minutes[index]![other] = 5;
      minutes[other]![index] = 5;
    }

    const result = swapStopOnDay(
      { ...input, matrix: { ...input.matrix, km, minutes } },
      itinerary,
      swap.dayNumber,
      swap.placeId,
      swap.replacementId,
    );
    expect(result.ok, 'an impossible travel time must not be saved into a plan').toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/not possible/);
  });

  it('refuses a replacement already scheduled on another day rather than visiting it twice', () => {
    const { input, itinerary } = baseline();
    const day = itinerary.days.find(
      (entry) => entry.items.filter((item) => item.kind === 'activity').length >= 1,
    )!;
    const victim = day.items.find((item) => item.kind === 'activity' && item.placeId)!;
    const elsewhere = itinerary.days
      .filter((entry) => entry.dayNumber !== day.dayNumber)
      .flatMap((entry) => entry.items.filter((item) => item.kind === 'activity' && item.placeId))
      .at(0);
    expect(elsewhere, 'the fixture needs a stop on some other day to attempt this with').toBeDefined();

    const result = swapStopOnDay(
      input,
      itinerary,
      day.dayNumber,
      victim.placeId!,
      elsewhere!.placeId!,
    );
    expect(result.ok, 'a stop already on another day is not a legal replacement').toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/already on day/);
  });
});

describe('making a day easier respects a pin', () => {
  /**
   * `easeDay` sorted the day's stops by burden and took the heaviest off. It
   * never read `input.locks`, so on a day pinned to its hike the heaviest stop
   * *is* the pinned one: the day came back easier, the pin stayed in storage
   * pointing at a day that no longer visited it, and the next rebuild put the
   * hike straight back.
   */
  it('never takes a locked stop off the day it is pinned to', () => {
    const { input, itinerary } = baseline();
    const heavy = itinerary.days.find(
      (entry) =>
        entry.intensity !== 'light' &&
        entry.items.filter((item) => item.kind === 'activity').length >= 2,
    );
    expect(heavy, 'the golden scenario should have a multi-stop day worth easing').toBeDefined();
    if (!heavy) return;

    const stops = heavy.items.filter((item) => item.kind === 'activity' && item.placeId);
    /* Pin the one ease would otherwise reach for first: the heaviest. */
    const rank = { none: 0, easy: 1, moderate: 2, strenuous: 3 } as const;
    const placesById = new Map(input.candidates.map((entry) => [entry.place.id, entry.place]));
    const heaviest = [...stops].sort((a, b) => {
      const left = placesById.get(a.placeId!)!;
      const right = placesById.get(b.placeId!)!;
      return (
        rank[right.physicalIntensity] - rank[left.physicalIntensity] ||
        right.typicalDurationMinutes - left.typicalDurationMinutes
      );
    })[0]!;

    const result = easeDay(
      { ...input, locks: [{ placeId: heaviest.placeId!, dayNumber: heavy.dayNumber }] },
      itinerary,
      heavy.dayNumber,
    );
    if (!result.ok) {
      /* Refusing is a legitimate outcome — as long as it says so. */
      expect(result.message.length).toBeGreaterThan(0);
      return;
    }
    const eased = result.itinerary.days.find((entry) => entry.dayNumber === heavy.dayNumber)!;
    expect(
      eased.items.some((item) => item.placeId === heaviest.placeId),
      `ease took the pinned stop ${heaviest.title} off day ${heavy.dayNumber}`,
    ).toBe(true);
  });

  it('says plainly that it cannot ease a day on which everything is pinned', () => {
    const { input, itinerary } = baseline();
    const heavy = itinerary.days.find(
      (entry) =>
        entry.intensity !== 'light' &&
        entry.items.filter((item) => item.kind === 'activity').length >= 2,
    );
    if (!heavy) return;
    const locks = heavy.items
      .filter((item) => item.kind === 'activity' && item.placeId)
      .map((item) => ({ placeId: item.placeId!, dayNumber: heavy.dayNumber }));

    const result = easeDay({ ...input, locks }, itinerary, heavy.dayNumber);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/locked/);
  });
});
