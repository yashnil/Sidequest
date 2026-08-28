import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Itinerary, UnscheduledPlace } from '@sidequest/core';
import { planTrip } from '@sidequest/planner';
import { buildScenario } from '../../../../packages/planner/src/testing/scenario';
import { ItineraryView } from './ItineraryView';

vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({
  EaseDayButton: () => null,
  PrintExpand: () => null,
  StopEditMenu: () => null,
}));
vi.mock('./PrintButton', () => ({ PrintButton: () => null }));

/**
 * A HEADING THAT CONTRADICTED EVERY CARD UNDER IT.
 *
 * From a rendered six-day Tokyo plan, verbatim:
 *
 *   Left off for room
 *   These were on your board but there were not the hours for them.
 *     Daiba 6      We have no travel time recorded to this place, so we cannot
 *                  fit it into a day honestly.
 *     金神の滝      We have no travel time recorded to this place, so we cannot
 *                  fit it into a day honestly.
 *
 * The heading and its blurb were constants naming one cause; the reason on each
 * card comes from the planner and named a different one. Nothing here was too
 * full — the way there could not be measured — and the traveller was told the
 * opposite about their own trip.
 */

function render(itinerary: Itinerary): string {
  const html = renderToStaticMarkup(
    createElement(ItineraryView, {
      itinerary,
      preparation: [],
      tripId: 'trip-dropped-heading',
      dateLabel: '12–15 Aug',
      renderedAt: Date.parse('2026-08-27T09:00:00.000Z'),
      coordinates: {},
      rationale: {},
    }),
  );
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the scenario did not plan: ${result.message}`);
  return result.itinerary;
})();

function withUnscheduled(entries: UnscheduledPlace[]): Itinerary {
  return { ...PLAN, unscheduled: entries };
}

const UNMEASURED: UnscheduledPlace = {
  placeId: 'p-unmeasured',
  name: 'Daiba 6',
  wasManual: false,
  reasonCode: 'missing_travel_data',
  reason: 'We have no travel time recorded to this place, so we cannot fit it into a day honestly.',
};

const NO_ROOM: UnscheduledPlace = {
  placeId: 'p-no-room',
  name: 'A stop that did not fit',
  wasManual: false,
  reasonCode: 'no_time_left',
  reason: 'There were no hours left in any day for this.',
};

describe('the section listing what did not make the plan', () => {
  it('does not claim it was about hours when nothing there is', () => {
    const text = render(withUnscheduled([UNMEASURED]));
    expect(text).toContain('Left off, and why');
    expect(text).not.toContain('there were not the hours for them');
    // The specific cause still reaches the traveller, on the card.
    expect(text).toContain('We have no travel time recorded to this place');
  });

  it('still says "for room" when room is what stopped every one of them', () => {
    /*
     * The control. The original copy is correct for the case it was written
     * for, and this fix must not spend it.
     */
    const text = render(withUnscheduled([NO_ROOM]));
    expect(text).toContain('Left off for room');
    expect(text).toContain('there were not the hours for them');
  });

  it('drops the room claim as soon as one entry is about something else', () => {
    const text = render(withUnscheduled([NO_ROOM, UNMEASURED]));
    expect(text).toContain('Left off, and why');
    expect(text).not.toContain('there were not the hours for them');
  });
});
