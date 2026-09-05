import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { buildScenario } from '../../../../packages/planner/src/testing/scenario';
import { EASTERN_SIERRA, EASTERN_SIERRA_PLACES } from '../../../../packages/core/src/data/index';
import type { Itinerary } from '@sidequest/core';
import { ItineraryView, type StopRationale } from './ItineraryView';

/*
 * The per-stop menu lives beside the server actions it calls, so importing it
 * would open a database. Nothing below presses anything; what is under test is
 * the document.
 */
vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({
  EaseDayButton: () => null,
  PrintExpand: () => null,
  StopEditMenu: () => null,
}));
vi.mock('./PrintButton', () => ({ PrintButton: () => null }));

/**
 * THE PRODUCT'S ENTIRE DELIVERABLE, GRADED AS A DELIVERABLE.
 *
 * A fresh designer's summary of this page: "1440x6280 of 11px gray text: no
 * photograph, no map, no day hero, no cost, no weather badge, no transport
 * chip", and a per-stop rationale that is "one template sentence with an
 * interest name substituted", which on the only finished plan in the database
 * produced a car wash captioned "Matches your interest in food & mountain
 * towns".
 *
 * Every assertion below is one of those, measured on the document the real
 * planner produces from the golden fixture. Offline by construction: no
 * provider, no database, no clock.
 */

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

/** Where each fixture place is, exactly as the page reads it off the region. */
const COORDINATES: Record<string, { lat: number; lng: number }> = Object.fromEntries([
  ...EASTERN_SIERRA_PLACES.map((place) => [place.id, place.coordinates] as const),
  [EASTERN_SIERRA.id, EASTERN_SIERRA.baseCoordinates] as const,
]);

function render(
  overrides: {
    rationale?: Record<string, StopRationale>;
    coordinates?: Record<string, { lat: number; lng: number }>;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(ItineraryView, {
      itinerary: PLAN,
      preparation: [],
      tripId: 'trip-itinerary-render',
      dateLabel: '12–15 Aug',
      renderedAt: Date.parse('2026-08-10T09:00:00.000Z'),
      coordinates: overrides.coordinates ?? COORDINATES,
      ...(overrides.rationale ? { rationale: overrides.rationale } : {}),
    }),
  );
}

/** The base id every day of the fixture plan is anchored to. */
function stopIdsOf(itinerary: Itinerary): string[] {
  return itinerary.days.flatMap((day) =>
    day.items
      .filter((item) => item.kind === 'activity' && item.placeId !== undefined)
      .map((item) => item.placeId!),
  );
}

describe('the finished plan is a document about places, not a bare schedule', () => {
  it('draws each day it can place, rather than offering only a maps link', () => {
    const html = render();
    const maps = [...html.matchAll(/data-testid="day-map"/g)].length;
    const daysWithStops = PLAN.days.filter((day) =>
      day.items.some((item) => item.kind === 'activity' && item.placeId !== undefined),
    ).length;
    expect(daysWithStops).toBeGreaterThan(0);
    expect(maps, 'a day with stops was rendered with no map at all').toBe(daysWithStops);
    // Drawn, not linked: the numbers on the drawing are in the document.
    expect(html).toContain('Numbered in the order of the day');
  });

  it('numbers the rows over the stops it could draw, not over every stop', () => {
    /*
     * Two surfaces showing one day have to be tied together or they are two
     * documents about one thing — and the join is the number. The numbering
     * therefore runs over the stops the drawing could actually *place*: number
     * over every activity instead and a day whose second stop has no published
     * position renders "1, 3, 4" against marks 1, 2, 3, sending the reader
     * hunting for a mark that was never drawn.
     *
     * Proved by withholding one stop's coordinates, because on the authored
     * fixture every stop has them and the two numberings agree.
     */
    const withStops = PLAN.days.find((day) =>
      day.items.filter((item) => item.kind === 'activity' && item.placeId).length >= 2,
    );
    expect(withStops, 'no day of this plan has two placed stops').toBeDefined();
    const stops = withStops!.items
      .filter((item) => item.kind === 'activity' && item.placeId)
      .map((item) => item.placeId!);
    const partial = { ...COORDINATES };
    delete partial[stops[0]!];

    const html = render({ coordinates: partial });
    const from = html.indexOf(`id="day-${withStops!.dayNumber}"`);
    const next = html.indexOf(`id="day-${withStops!.dayNumber + 1}"`);
    const day = html.slice(from, next < 0 ? undefined : next);
    const marks = [
      ...day.matchAll(/rounded-full bg-ink text-\[11px\] font-semibold text-paper">(\d+)</g),
    ].map((match) => Number(match[1]));

    expect(marks.length, 'the day rendered no numbered rows at all').toBeGreaterThan(0);
    /* One number per mark the drawing made, and no more. */
    expect(
      marks.length,
      'a stop with no published position was numbered anyway, so the last number has no mark',
    ).toBe(stops.length - 1);
    expect(marks, 'the numbering skips a mark the drawing never made').toEqual(
      marks.map((_, index) => index + 1),
    );
    // And the drawing says how many it could not place, rather than implying it is whole.
    expect(html).toContain('not drawn, because nobody publishes where');
  });

  it('never claims a mark for a stop the region cannot place', () => {
    /*
     * The refusal half, and the one that matters: a drawing must not invent a
     * coordinate. With no coordinates at all there is no map and no numbering,
     * and the page says so rather than drawing an empty frame.
     */
    const html = render({ coordinates: {} });
    expect(html).not.toContain('data-testid="day-map"');
  });

  it('argues for a stop in that stop\'s own words rather than one template', () => {
    const stops = stopIdsOf(PLAN);
    expect(stops.length).toBeGreaterThan(2);
    const rationale: Record<string, StopRationale> = Object.fromEntries(
      stops.map((placeId, index) => [
        placeId,
        { why: `Reason ${index} for ${placeId}`, facets: [`${index * 5} min from your base`] },
      ]),
    );
    const html = render({ rationale });
    const whys = [...html.matchAll(/data-testid="stop-why"[^>]*>([^<]*)</g)].map(
      (match) => match[1] ?? '',
    );
    expect(whys.length, 'no stop carried a fit sentence at all').toBe(stops.length);
    expect(
      new Set(whys).size,
      'every stop on the plan is captioned with the same sentence',
    ).toBe(whys.length);
  });

  it('says the true thing about a blank mid-trip day', () => {
    /*
     * The empty-day sentence was unconditional, so a blank Saturday in the
     * middle of a five-day trip was captioned "on an arrival or departure day
     * that is usually the honest answer" — false about the day it was printed
     * on, and printed directly under the note that says the true thing when a
     * day really is an arrival or departure.
     */
    const middle = PLAN.days.length > 2 ? 1 : 0;
    const blanked: Itinerary = {
      ...PLAN,
      days: PLAN.days.map((day, index) =>
        index === middle
          ? { ...day, items: [], totals: { ...day.totals, activityMinutes: 0 } }
          : day,
      ),
    };
    const html = renderToStaticMarkup(
      createElement(ItineraryView, {
        itinerary: blanked,
        preparation: [],
        tripId: 'trip-itinerary-render',
        dateLabel: '12–15 Aug',
        renderedAt: Date.parse('2026-08-10T09:00:00.000Z'),
        coordinates: COORDINATES,
      }),
    );
    expect(html).toContain('this is not an arrival or departure day');
  });

  it('does not print "nothing was checked" under a list of what the weather changed', () => {
    /*
     * The attribution was taken off the first day carrying any, which on almost
     * every trip is day 1 — the arrival day, usually unavailable, whose
     * attribution is the sentence "nothing here has been checked against the
     * weather". So a plan that had just listed three things the forecast moved
     * printed that sentence immediately underneath them.
     */
    const UNCHECKED = 'Nothing here has been checked against the weather';
    const withUnchecked: Itinerary = {
      ...PLAN,
      days: PLAN.days.map((day, index) =>
        index === 0
          ? {
              ...day,
              weather: { ...day.weather, evidence: 'unavailable' as const, attribution: `${UNCHECKED}. Rebuild once a forecast is available.` },
            }
          : {
              ...day,
              weather: { ...day.weather, evidence: 'forecast' as const, attribution: 'Weather data by Open-Meteo.com' },
            },
      ),
    };
    const html = renderToStaticMarkup(
      createElement(ItineraryView, {
        itinerary: withUnchecked,
        preparation: [],
        tripId: 'trip-itinerary-render',
        dateLabel: '12–15 Aug',
        renderedAt: Date.parse('2026-08-10T09:00:00.000Z'),
        coordinates: COORDINATES,
      }),
    );
    /*
     * Scoped to the trip-level panel. The individual unavailable day still says
     * its own piece further down, and must — the defect is that one day's
     * sentence was promoted to speak for the whole trip.
     */
    // The trip-level weather panel lives in the hub's Backups section now, after the days.
    const start = html.indexOf('>Weather</h2>');
    const stop = html.indexOf('data-testid="backups"', start);
    const panel = html.slice(start, stop < 0 ? undefined : stop);
    expect(panel.length).toBeGreaterThan(100);
    expect(panel).toContain('Open-Meteo.com');
    expect(panel, 'the arrival day\'s "nothing was checked" spoke for the whole trip').not.toContain(
      UNCHECKED,
    );
  });

  it('gives each day a colour of its own kind, and says where you are sleeping', () => {
    const html = render({
      rationale: Object.fromEntries(
        stopIdsOf(PLAN).map((placeId) => [
          placeId,
          {
            category: (EASTERN_SIERRA_PLACES.find((place) => place.id === placeId)?.category ??
              'lake') as StopRationale['category'],
          },
        ]),
      ),
    });
    expect(html).toContain('based in');
    expect(html, 'no day carries a colour of its own').toMatch(/--plate-hue:\s*\d+/);
  });
});
