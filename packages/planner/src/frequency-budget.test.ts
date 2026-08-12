import { describe, expect, it } from 'vitest';
import type { DiscoverySelection, Interest, Place } from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';

/**
 * WHAT THE TRAVELLER SAID ABOUT *HOW MUCH*, APPLIED WHERE THE PLAN IS COMPOSED.
 *
 * `frequencyCaps` has always existed on the profile and has always been read in
 * exactly two places: the board's auto-pick, which chooses a set, and the
 * itinerary validator, which afterwards observes that the set was too big and
 * emits a warning. Nothing between the two ever refused to schedule anything,
 * and `frequency_reached` — a reason code with its own remedies and its own
 * traveller-facing sentence — had no producer anywhere in the product.
 *
 * That gap is what §9.3 is about: "personalization means composition, not just
 * ranking". A board carrying five viewpoints because the auto-pick counted a
 * lakeside viewpoint against lakes, or because the traveller changed their
 * answers and rebuilt without re-picking, produced five viewpoints in the plan
 * and a caution nobody could act on.
 *
 * The rule these pin, and its one exception:
 *
 * - a stop **the machine chose** may not push an interest past what the
 *   traveller asked for, and one that would is left out by name and reason;
 * - a stop **the traveller chose by hand** always outranks a policy derived from
 *   their own answers, and the warning is the honest response to it.
 */

/** Places built around one interest, so a cap can be pointed at exactly them. */
function placesOfInterest(interest: Interest): Place[] {
  return EASTERN_SIERRA_PLACES.filter((place) => place.interests[0] === interest);
}

function autoSelections(placeIds: readonly string[]): DiscoverySelection[] {
  return placeIds.map((placeId) => ({
    placeId,
    status: 'included' as const,
    source: 'auto' as const,
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));
}

function scheduledPlaceIds(itinerary: {
  days: readonly { items: readonly { kind: string; placeId?: string | undefined }[] }[];
}): string[] {
  return itinerary.days.flatMap((day) =>
    day.items.filter((item) => item.kind === 'activity' && item.placeId).map((item) => item.placeId!),
  );
}

describe('interest frequency budgets bind the plan, not only the board', () => {
  /**
   * The fixture region has to actually carry enough of one interest for a cap to
   * be exceeded, or every assertion below is vacuously true.
   */
  const viewpoints = placesOfInterest('scenic_viewpoints');

  it('has a fixture with more of one interest than a low answer allows', () => {
    expect(viewpoints.length).toBeGreaterThan(1);
  });

  it('leaves out the machine-chosen stops that would exceed the allowance', () => {
    const input = buildScenario({
      // "Low" is one for the whole trip, whatever the trip length.
      answers: { interests: { scenic_viewpoints: 'low' } },
      selections: autoSelections(viewpoints.map((place) => place.id)),
    });
    expect(input.profile.derived.frequencyCaps.scenic_viewpoints).toBe(1);

    const result = planTrip(input);
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const scheduled = scheduledPlaceIds(result.itinerary).filter((id) =>
      viewpoints.some((place) => place.id === id),
    );
    expect(
      scheduled.length,
      `the plan holds ${scheduled.length} viewpoints against an allowance of 1`,
    ).toBeLessThanOrEqual(1);
  });

  it('says which allowance left a stop out, rather than blaming the clock', () => {
    const input = buildScenario({
      answers: { interests: { scenic_viewpoints: 'low' } },
      selections: autoSelections(viewpoints.map((place) => place.id)),
    });
    const result = planTrip(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byFrequency = result.itinerary.unscheduled.filter(
      (entry) => entry.reasonCode === 'frequency_reached',
    );
    /*
     * The half that makes the refusal usable. "There was no day with the hours
     * for it" sends somebody to add days; the real answer is that they asked for
     * one of these, and the fix is on the questionnaire or the board.
     */
    expect(byFrequency.length, 'nothing was reported as over the allowance').toBeGreaterThan(0);
    for (const entry of byFrequency) {
      expect(entry.reason).toMatch(/asked for/i);
      expect(entry.suggestedRemedy ?? '').not.toBe('');
    }
  });

  it('never refuses a stop the traveller picked by hand', () => {
    const chosen = viewpoints.slice(0, 3).map((place) => place.id);
    const input = buildScenario({
      answers: { interests: { scenic_viewpoints: 'low' } },
      selections: chosen.map((placeId) => ({
        placeId,
        status: 'included' as const,
        source: 'user' as const,
        updatedAt: '2026-07-30T00:00:00.000Z',
      })),
    });

    const result = planTrip(input);
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    /*
     * A cap derived from an answer must never overrule an instruction. What the
     * plan owes the traveller here is the warning, which the validator already
     * writes — not a silent deletion of something they ticked themselves.
     */
    for (const entry of result.itinerary.unscheduled) {
      expect(entry.reasonCode, `${entry.name} was dropped for its allowance`).not.toBe(
        'frequency_reached',
      );
    }
  });

  it('leaves an ordinary trip alone, because its board already respects the answers', () => {
    /*
     * The regression guard on the whole change. Auto-pick charges the same caps
     * when it builds the set, so a plan built the ordinary way must come out
     * exactly as it did before this existed — otherwise the budget is being
     * charged twice for the same stop.
     */
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.itinerary.unscheduled.filter((entry) => entry.reasonCode === 'frequency_reached'),
    ).toEqual([]);
    expect(scheduledPlaceIds(result.itinerary).length).toBeGreaterThan(0);
  });
});
