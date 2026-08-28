import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import { planTrip } from '@sidequest/planner';
import { transitBlindScenario } from '../../../../packages/planner/src/testing/transit-blind-city';
import { ItineraryView } from './ItineraryView';

vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({
  EaseDayButton: () => null,
  PrintExpand: () => null,
  StopEditMenu: () => null,
}));
vi.mock('./PrintButton', () => ({ PrintButton: () => null }));

/**
 * A ROW THAT DISAGREED WITH ITSELF ABOUT ITS OWN WALK.
 *
 * From a rendered six-day Osaka plan, verbatim:
 *
 *     11:00  10 min   Walk back to Osaka
 *                     14 min back to Osaka.
 *
 * The schedule column and the sentence beneath it describe the same leg and
 * differ by forty per cent, and the smaller number is the one in the column a
 * traveller budgets from. The cause was one shared helper: every span on the
 * page floored to five minutes, which is right for free time and time at stops
 * — those are promises about time the traveller *has* — and inverted for
 * travel, which is time they spend.
 *
 * Asserted against the real planner's output through the real component: the
 * defect was invisible to every model-level test because the model held 14 all
 * along. It was the render that lost the four minutes.
 */

const PLAN: Itinerary = (() => {
  const result = planTrip(transitBlindScenario('observed'));
  if (!result.ok) throw new Error(`the car-free scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

const HTML = renderToStaticMarkup(
  createElement(ItineraryView, {
    itinerary: PLAN,
    preparation: [],
    tripId: 'trip-travel-span',
    dateLabel: '12–15 Aug',
    renderedAt: Date.parse('2026-08-27T09:00:00.000Z'),
    coordinates: {},
    rationale: {},
  }),
);

const TEXT = HTML.replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/** Every travel leg in the plan whose duration is not already a multiple of five. */
function awkwardLegs() {
  return PLAN.days
    .flatMap((day) => day.items)
    .filter((item) => item.kind === 'travel' && item.durationMinutes % 5 !== 0);
}

/** "1 hr 14 min" / "14 min", the way `formatMinutes` writes a span. */
function spanText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

describe('what a travel row prints for its own duration', () => {
  it('has legs that do not land on a five-minute boundary, or it asserts nothing', () => {
    /*
     * The witness. A plan whose every leg is already a multiple of five cannot
     * tell a floor from a ceiling, and this file would pass on the defect.
     */
    expect(awkwardLegs().length).toBeGreaterThan(0);
  });

  it('never prints a leg as shorter than the leg is', () => {
    for (const leg of awkwardLegs()) {
      const floored = Math.floor(leg.durationMinutes / 5) * 5;
      /*
       * The exact string the defect produced. Guarded on the value being
       * distinguishable — a leg under five minutes keeps its own number and has
       * no floored form to look for.
       */
      if (floored < 5) continue;
      const understated = `${spanText(floored)} ${leg.title}`;
      expect(TEXT).not.toContain(understated);
    }
  });

  it('prints the rounded-up duration beside the leg it describes', () => {
    for (const leg of awkwardLegs()) {
      const ceiled = Math.ceil(leg.durationMinutes / 5) * 5;
      expect(TEXT).toContain(`${spanText(ceiled)} ${leg.title}`);
    }
  });

  it('still rounds free time down, because that is time the traveller has', () => {
    const awkwardFree = PLAN.days
      .flatMap((day) => day.items)
      .filter((item) => item.kind === 'free_time' && item.durationMinutes % 5 !== 0);
    for (const free of awkwardFree) {
      const ceiled = Math.ceil(free.durationMinutes / 5) * 5;
      if (ceiled < 5) continue;
      expect(TEXT).not.toContain(`${spanText(ceiled)} ${free.title}`);
    }
  });

  it('gives one answer for one quantity, summary and panel alike', () => {
    /**
     * The half of this fix that was missed first time. `summarise` composed the
     * same travel totals with exact minutes while the page rendered them
     * rounded, so one screen carried both — a delivered plan read "2 hr 51 min
     * on foot to reach them" in the hero line and "On foot to reach things
     * 2 hr 55 min" five lines below, and another read "3 hr 38 min" against
     * "3 hr 40 min". Neither figure understated the journey, which is the
     * property that matters, and a reader still has to decide which of two
     * numbers for one quantity to believe.
     */
    const walk = PLAN.days.reduce((sum, day) => sum + day.totals.walkMinutes, 0);
    const unverified = PLAN.days.reduce((sum, day) => sum + day.totals.unverifiedMinutes, 0);

    /*
     * Only a total that is not already on a five-minute boundary can tell the
     * two roundings apart; at least one has to be, or this asserts nothing.
     */
    const awkward = [walk, unverified].filter((total) => total > 0 && total % 5 !== 0);
    expect(awkward.length, 'no travel total is off a five-minute boundary').toBeGreaterThan(0);

    for (const total of awkward) {
      const rounded = spanText(Math.ceil(total / 5) * 5);
      expect(PLAN.summary, `summary for ${total} min`).toContain(rounded);
      expect(PLAN.summary, `summary states exact ${total} min`).not.toContain(spanText(total));
      expect(TEXT, `page for ${total} min`).toContain(rounded);
    }
  }, 30_000);
});
