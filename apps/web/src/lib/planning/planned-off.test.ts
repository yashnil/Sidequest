import { describe, expect, it } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import { plannedOffByDay } from './planned-off';

/**
 * A DAY THAT PROMISES SOMETHING IT DOES NOT HOLD.
 *
 * The live Kyrgyzstan trip printed a day themed "Scenic return via Burana Tower"
 * above the words "Nothing scheduled", with the reason four screens away. These
 * cover the join that lets the day answer for itself, including the case that
 * matters most: a dropped anchor with no recorded sentence still gets an honest
 * one rather than none.
 */

function itineraryWith(anchors: { name: string; dayNumber: number; disposition: string }[], unscheduled: { name: string; reason: string }[] = []): Itinerary {
  return {
    unscheduled: unscheduled.map((entry) => ({ placeId: entry.name, name: entry.name, wasManual: false, reasonCode: 'day_full', reason: entry.reason })),
    package: { anchors: anchors.map((anchor) => ({ ...anchor, id: anchor.name, role: 'core', category: 'landmark', verification: 'unverified' })) },
  } as unknown as Itinerary;
}

describe('what a day was for, when the day ended up empty', () => {
  it('pairs each dropped stop with the reason the traveller was already given', () => {
    const itinerary = itineraryWith(
      [
        { name: 'Burana Tower', dayNumber: 11, disposition: 'unscheduled_capacity' },
        { name: 'Drive to Bishkek', dayNumber: 11, disposition: 'unscheduled_capacity' },
      ],
      [{ name: 'Burana Tower', reason: 'Day 11 ends with your departure not booked yet, so it would have run past it.' }],
    );
    expect(plannedOffByDay(itinerary)[11]).toEqual([
      { name: 'Burana Tower', reason: 'Day 11 ends with your departure not booked yet, so it would have run past it.' },
      { name: 'Drive to Bishkek', reason: 'the day did not have room for it once the travel was counted.' },
    ]);
  });

  it('says nothing about a day whose stops are all still on the trip', () => {
    const itinerary = itineraryWith([
      { name: 'Ala-Too Square', dayNumber: 1, disposition: 'preserved' },
      { name: 'Karakol market', dayNumber: 2, disposition: 'moved_other_day' },
      { name: 'A cafe', dayNumber: 3, disposition: 'folded_into_meal' },
    ]);
    expect(plannedOffByDay(itinerary)).toEqual({});
  });

  it('explains a contradiction differently from a full day', () => {
    const itinerary = itineraryWith([
      { name: 'Osh Bazaar', dayNumber: 1, disposition: 'rejected_contradiction' },
      { name: 'A fixed thing', dayNumber: 2, disposition: 'rejected_hard_constraint' },
    ]);
    expect(plannedOffByDay(itinerary)[1]![0]!.reason).toMatch(/evidence contradicted it/);
    expect(plannedOffByDay(itinerary)[2]![0]!.reason).toMatch(/told Sidequest was fixed/);
  });

  it('reads an itinerary that has no package or nothing unscheduled', () => {
    expect(plannedOffByDay({} as Itinerary)).toEqual({});
  });
});
