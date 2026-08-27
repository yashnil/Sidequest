import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { buildScenario } from '../../../../packages/planner/src/testing/scenario';
import { EASTERN_SIERRA, EASTERN_SIERRA_PLACES } from '../../../../packages/core/src/data/index';
import type { Itinerary } from '@sidequest/core';
import { ItineraryView } from './ItineraryView';

/**
 * THE SHARED VIEW LEAKS NOTHING THE OWNER HOLDS.
 *
 * A share link is read by somebody who must be able to read the whole plan and
 * do nothing else. The trip id is the line: every owner surface — the board,
 * the questionnaire, the rebuild, the per-stop edits — is addressed by it, so a
 * single occurrence of it anywhere in the shared document is edit access
 * handed to every reader. The component therefore takes the id's *absence* as
 * the read-only mode: no prop to forget, nothing to gate wrongly — what the
 * page does not pass, the document cannot contain.
 *
 * The stubs render markers rather than null, because half of these assertions
 * are about absence, and the absence of something that never renders proves
 * nothing.
 */

vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({
  EaseDayButton: () => 'stub-ease-day',
  PrintExpand: () => null,
  StopEditMenu: () => 'stub-stop-menu',
}));
vi.mock('@/app/(product)/trips/[id]/itinerary/share-controls', () => ({
  ShareControl: () => 'stub-share-control',
}));
vi.mock('./PrintButton', () => ({ PrintButton: () => 'stub-print-button' }));

const TRIP_ID = 'trip-share-render';

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

const COORDINATES: Record<string, { lat: number; lng: number }> = Object.fromEntries([
  ...EASTERN_SIERRA_PLACES.map((place) => [place.id, place.coordinates] as const),
  [EASTERN_SIERRA.id, EASTERN_SIERRA.baseCoordinates] as const,
]);

function render(mode: 'owner' | 'shared'): string {
  return renderToStaticMarkup(
    createElement(ItineraryView, {
      itinerary: PLAN,
      preparation: [],
      ...(mode === 'owner' ? { tripId: TRIP_ID } : {}),
      dateLabel: '12–15 Aug',
      renderedAt: Date.parse('2026-08-10T09:00:00.000Z'),
      coordinates: COORDINATES,
    }),
  );
}

describe('the shared, read-only rendering', () => {
  it('does not carry the trip id anywhere in the document', () => {
    /*
     * The strongest single statement: not "the buttons are hidden" but "the
     * key to the owner surfaces is not in the bytes". Everything below is a
     * named instance of what this catches wholesale.
     */
    const html = render('shared');
    expect(html).not.toContain(TRIP_ID);
    expect(html).not.toContain('/trips/');
  });

  it('offers no way back into the owner flow', () => {
    const html = render('shared');
    expect(html).not.toContain('Back to the board');
    expect(html).not.toContain('questionnaire');
    expect(html).not.toContain('Calendar file');
  });

  it('renders no edit controls and no share affordance', () => {
    const html = render('shared');
    expect(html).not.toContain('stub-stop-menu');
    expect(html).not.toContain('stub-ease-day');
    // Sharing is the owner's act; a reader re-sharing mints nothing anyway,
    // but the control would be a button that can only fail.
    expect(html).not.toContain('stub-share-control');
  });

  it('still is the whole plan: days, stops and printing all survive', () => {
    const html = render('shared');
    expect(html).toContain('id="day-1"');
    expect(html).toContain(`id="day-${PLAN.days.length}"`);
    expect(html).toContain('data-testid="day-map"');
    expect(html).toContain('stub-print-button');
    // Addressed to a reader, not to the traveller who built it.
    expect(html).toContain('Shared with you');
  });
});

describe('the owner rendering, as the control', () => {
  it('keeps the owner controls and the share affordance', () => {
    /*
     * A gate that hid these from everybody would pass every assertion above
     * and take the product's editing surface with it.
     */
    const html = render('owner');
    expect(html).toContain('Back to the board');
    expect(html).toContain('Calendar file');
    expect(html).toContain('stub-stop-menu');
    expect(html).toContain('stub-share-control');
    expect(html).toContain(`/trips/${TRIP_ID}/discover`);
    expect(html).not.toContain('Shared with you');
  });
});
