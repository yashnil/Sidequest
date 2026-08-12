import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_VERSION, type Place } from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import { planTrip } from './plan';
import { removeStopFromDay, swapStopOnDay } from './edit';
import { buildScenario } from './testing/scenario';

/**
 * PR-PLAN-14: THE NAME THE TRAVELLER PICKED IS THE NAME ON THE PLAN.
 *
 * `displayNameOf` was added as a presentation seam and wired into the board's
 * components. The planner writes its titles as plain strings at plan time and
 * every one of them read `place.name`, so a traveller who chose "Sumida River"
 * off the board was handed an itinerary headed 隅田川 — and the artifacts that
 * reuse those titles verbatim (the calendar file, the print sheet, the Google
 * and Apple Maps stop lists) inherited the unresolved half.
 *
 * The fixture below gives one Eastern Sierra place a resolved English display
 * name over a local one, then asserts that the local name appears nowhere a
 * traveller reads: not in a stop title, not in the leg that gets them there,
 * not in the reason a stop was left off.
 */

const LOCAL = 'Lago del Convicto';
const DISPLAY = 'Convict Lake (resolved)';

/** The golden places, with one carrying a resolved display name over a local one. */
function placesWithResolvedName(): Place[] {
  const renamed = EASTERN_SIERRA_PLACES.map((place) =>
    place.id === 'convict-lake'
      ? ({
          ...place,
          name: LOCAL,
          names: {
            schemaVersion: DISPLAY_NAME_VERSION,
            display: DISPLAY,
            displayLanguage: 'en',
            local: LOCAL,
            canonical: LOCAL,
            sources: ['fixture'],
          },
        } satisfies Place)
      : place,
  );
  expect(
    renamed.some((place) => place.names?.display === DISPLAY),
    'the fixture must still contain convict-lake to rename',
  ).toBe(true);
  return renamed;
}

describe('display names reach the itinerary', () => {
  it('titles the stop, its travel leg and any refusal with the resolved name', () => {
    const input = buildScenario({ places: placesWithResolvedName(), manualIncludes: ['convict-lake'] });
    const result = planTrip(input);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    /*
     * Everything a traveller reads, in one string. Deliberately includes the
     * unscheduled reasons and the travel legs' endpoint names: those are what
     * the map links and the "left off for room" panel are built from.
     */
    const readable = JSON.stringify({
      days: result.itinerary.days.map((day) => ({
        items: day.items.map((item) => ({
          title: item.title,
          reason: item.reason,
          from: item.travel?.fromName,
          to: item.travel?.toName,
        })),
        backups: day.weather.backups,
      })),
      unscheduled: result.itinerary.unscheduled,
      issues: result.itinerary.issues,
    });

    const mentioned =
      readable.includes(DISPLAY) || readable.includes(LOCAL);
    expect(mentioned, 'the renamed place should appear somewhere in the plan at all').toBe(true);
    expect(
      readable.includes(LOCAL),
      `the plan still shows the local name "${LOCAL}" somewhere a traveller reads`,
    ).toBe(false);
  });

  it('names an edited-away stop by its display name too', () => {
    const input = buildScenario({ places: placesWithResolvedName(), manualIncludes: ['convict-lake'] });
    const built = planTrip(input);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const day = built.itinerary.days.find((entry) =>
      entry.items.some((item) => item.placeId === 'convict-lake'),
    );
    expect(day, 'the manual include should be scheduled somewhere').toBeDefined();
    if (!day) return;

    const edited = removeStopFromDay(input, built.itinerary, day.dayNumber, 'convict-lake');
    expect(edited.ok, edited.ok ? '' : edited.message).toBe(true);
    if (!edited.ok) return;
    expect(edited.changed).toContain(DISPLAY);
    expect(edited.changed).not.toContain(LOCAL);
  });

  /* An edit's *refusals* name places too, and were reading the raw name. */
  it('names a place by its display name when it refuses an edit about it', () => {
    const input = buildScenario({ places: placesWithResolvedName(), manualIncludes: ['convict-lake'] });
    const built = planTrip(input);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const home = built.itinerary.days.find((entry) =>
      entry.items.some((item) => item.placeId === 'convict-lake'),
    )!;
    const otherDay = built.itinerary.days.find(
      (entry) =>
        entry.dayNumber !== home.dayNumber &&
        entry.items.some((item) => item.kind === 'activity' && item.placeId),
    );
    expect(otherDay, 'the fixture needs a second day with a stop on it').toBeDefined();
    if (!otherDay) return;
    const victim = otherDay.items.find((item) => item.kind === 'activity' && item.placeId)!;

    /* Already on another day, so this is refused — and the refusal names it. */
    const refused = swapStopOnDay(
      input,
      built.itinerary,
      otherDay.dayNumber,
      victim.placeId!,
      'convict-lake',
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain(DISPLAY);
    expect(refused.message).not.toContain(LOCAL);
  });
});
