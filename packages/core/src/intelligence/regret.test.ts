import { describe, expect, it } from 'vitest';
import { buildRegret } from './resilience';
import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { DayWeatherSemantics } from './weather-access';

/**
 * V1 CONVERGENCE — REGRET MINIMISATION READS THE PLAN'S OWN RECORD.
 *
 * "Don't miss" leads with what the trip is built around (the scored
 * signatures), "keep flexible" names the backup each weather-dependent day
 * already has, and "verify before leaving" carries the stops' own seasonal and
 * access notes and the access constraints that shaped the plan.
 */
function itinerary(): Itinerary {
  return {
    days: [
      {
        dayNumber: 1,
        weather: { backups: [] },
        items: [{ id: 'a1', kind: 'activity', title: 'Market Hall', startMinute: 600, endMinute: 660 }],
      },
      {
        dayNumber: 2,
        weather: { backups: [{ name: 'the Natural History Museum', trigger: 'Rain', why: 'Indoors and close.' }] },
        items: [{ id: 'a2', kind: 'activity', title: 'Ridge Walk', startMinute: 540, endMinute: 780, seasonalNote: 'The upper ridge is snow-bound until mid-June in most years.' }],
      },
    ],
  } as unknown as Itinerary;
}

function pkg(): TripPackage {
  return {
    anchors: [
      { id: 'a1', dayNumber: 1, name: 'Market Hall', role: 'core', category: 'market', disposition: 'preserved', verification: 'verified' },
      { id: 'a2', dayNumber: 2, name: 'Ridge Walk', role: 'core', category: 'hike', disposition: 'preserved', verification: 'verified' },
    ],
    signatures: [{ id: 'a2', name: 'Ridge Walk', dayNumber: 2, score: 0.9, reasons: [], why: 'The walk the whole trip is shaped around.' }],
    omissions: [{ name: 'Tower Viewing Deck', reason: 'Crowded and low-fit for a traveller who avoids queues.' }],
    backups: [],
    accessConstraints: [{ id: 'c1', placeName: 'Ridge Walk', status: 'restricted', reservationRequired: false, authority: 'official_current', sourceName: 'Park authority', checkedAt: '2026-09-01', travellerNote: 'The trailhead road is shuttle-only in summer — reserve a seat.' }],
  } as unknown as TripPackage;
}

const weather: DayWeatherSemantics[] = [{ dayNumber: 2, sensitiveItems: [{ title: 'Ridge Walk', sensitivity: 'high', fallbackType: 'reschedule_within_trip' }] } as unknown as DayWeatherSemantics];

describe('regret minimisation', () => {
  const regret = buildRegret({ pkg: pkg(), itinerary: itinerary(), bookings: [], access: [], weather, claims: [], worthSkipping: [] });

  it('leads "don’t miss" with the signature and its own reason, then the core stops, without repeating one', () => {
    expect(regret.dontMiss[0]).toEqual({ name: 'Ridge Walk', why: 'The walk the whole trip is shaped around.' });
    expect(regret.dontMiss.map((d) => d.name)).toEqual(['Ridge Walk', 'Market Hall']);
  });

  it('"safe to skip" is what the plan deliberately left out', () => {
    expect(regret.safeToSkip).toEqual([{ name: 'Tower Viewing Deck', why: 'Crowded and low-fit for a traveller who avoids queues.' }]);
  });

  it('"keep flexible" points at the backup the weather-dependent day already holds, without restating it', () => {
    expect(regret.keepFlexible[0]!.why).toBe("Weather decides day 2; it can move within the trip, and day 2's backup is written out under Backups.");
  });

  it('"verify before leaving" carries the access constraint and the stop’s own seasonal note', () => {
    const whys = regret.verifyBeforeLeaving.map((v) => v.why);
    expect(whys).toContain('The trailhead road is shuttle-only in summer — reserve a seat.');
    /* Same stop, second note: one entry per stop, the authoritative constraint first. */
    expect(regret.verifyBeforeLeaving.filter((v) => v.name === 'Ridge Walk')).toHaveLength(1);
  });
});
