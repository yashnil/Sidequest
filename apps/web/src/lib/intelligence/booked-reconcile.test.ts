import { describe, expect, it } from 'vitest';
import { itinerarySchema, type BookedPlanItem } from '@sidequest/core';
import { reconcileTripDraft } from '../planning/reconcile';
import { draftOf, fictionalWorld, type FictionalPlace } from '../planning/acceptance/harness';
import { applyBookedFacts } from './booked-reconcile';

const NOW = '2026-04-01T00:00:00.000Z';

async function cityTrip() {
  const centre = { lat: 48.2, lng: 16.37 };
  const names = ['Old Town', 'Great Museum', 'Market Hall', 'River Walk', 'Palace', 'Opera Quarter'];
  const places: FictionalPlace[] = names.map((name, i) => ({ name, lat: centre.lat + ((i % 3) - 1) * 0.02, lng: centre.lng + (Math.floor(i / 3) - 1) * 0.02, known: true }));
  const world = fictionalWorld({ name: 'Danubia', center: centre, places, basics: { startDate: '2026-06-01', endDate: '2026-06-04', arrivalTime: '10:00', departureTime: '18:00' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } });
  const draft = draftOf({
    bases: [{ id: 'centre', name: 'Danubia', nights: 3, area: 'the Old Town' }],
    days: [
      { base: 'centre', anchors: [{ name: 'Old Town', category: 'neighbourhood', transport: 'walk' }] },
      { base: 'centre', anchors: [{ name: 'Great Museum', category: 'museum', transport: 'metro', minutes: 120 }, { name: 'Market Hall', category: 'market', role: 'secondary', transport: 'walk' }, { name: 'Palace', category: 'historic', role: 'optional', transport: 'walk', minutes: 90 }] },
      { base: 'centre', anchors: [{ name: 'River Walk', category: 'neighbourhood', transport: 'walk' }, { name: 'Opera Quarter', category: 'neighbourhood', role: 'secondary', transport: 'walk' }] },
      { base: 'centre', anchors: [{ name: 'Market Hall', category: 'market', transport: 'walk' }] },
    ],
  });
  const result = await reconcileTripDraft({ draft, context: world.context });
  return result.itinerary;
}

function booked(partial: Partial<BookedPlanItem> & Pick<BookedPlanItem, 'type' | 'title'>): BookedPlanItem {
  return { id: partial.title.toLowerCase().replace(/\s+/g, '-'), tripId: 't', status: 'booked', locked: true, createdAt: NOW, ...partial };
}

describe('booked facts modify the itinerary deterministically', () => {
  it('a booked hotel B replaces the model’s hotel A as the base for its nights, and nothing else changes', async () => {
    const itinerary = await cityTrip();
    const before = itinerary.days.map((d) => d.items.filter((i) => i.kind === 'activity').map((i) => i.title));
    const { itinerary: next, honored, conflicts } = applyBookedFacts(itinerary, [booked({ type: 'lodging', title: 'Hotel B by the river', date: '2026-06-01', endDate: '2026-06-04', location: 'Riverside' })]);
    expect(conflicts).toEqual([]);
    expect(honored[0]).toMatch(/Hotel B/);
    expect(next.days.every((d) => d.baseName === 'Riverside')).toBe(true);
    expect(next.days.map((d) => d.items.filter((i) => i.kind === 'activity').map((i) => i.title))).toEqual(before);
    expect(next.diagnostics.revisions.some((r) => r.code === 'base_locked_to_booking')).toBe(true);
    expect(itinerarySchema.safeParse(next).success).toBe(true);
  });

  it('a fixed 11:00 museum ticket is locked in place, the day’s model content fits around it, and a real overflow is flagged rather than dropped', async () => {
    const itinerary = await cityTrip();
    const day2 = itinerary.days[1]!;
    const { itinerary: next, conflicts, honored } = applyBookedFacts(itinerary, [booked({ type: 'activity', title: 'Great Museum timed ticket', date: day2.date, startTime: '11:00', endTime: '13:00' })]);
    const nextDay = next.days[1]!;
    const lockedItem = nextDay.items.find((i) => i.id.startsWith('booked:'))!;
    expect(lockedItem.startMinute).toBe(11 * 60);
    expect(lockedItem.endMinute).toBe(13 * 60);
    expect(honored.some((h) => /11:00 is fixed/.test(h))).toBe(true);
    // Nothing overlaps the ticket.
    for (const item of nextDay.items.filter((i) => i.kind !== 'free_time' && i.id !== lockedItem.id)) {
      expect(item.endMinute <= lockedItem.startMinute || item.startMinute >= lockedItem.endMinute, `${item.title} overlaps the ticket`).toBe(true);
    }
    // Every model activity is either still on the day or named in a conflict — never silently gone.
    const modelBefore = day2.items.filter((i) => i.kind === 'activity').map((i) => i.title);
    const modelAfter = nextDay.items.filter((i) => i.kind === 'activity' && !i.id.startsWith('booked:')).map((i) => i.title);
    for (const title of modelBefore) expect(modelAfter.includes(title) || conflicts.some((c) => c.includes(title))).toBe(true);
    expect(itinerarySchema.safeParse(next).success).toBe(true);
  });

  it('a booked departure flight tightens the last day and names what runs past the leave-by time', async () => {
    const itinerary = await cityTrip();
    const last = itinerary.days[itinerary.days.length - 1]!;
    const { itinerary: next, conflicts, honored } = applyBookedFacts(itinerary, [booked({ type: 'flight', title: 'Flight home', date: last.date, startTime: '13:00' })]);
    const nextLast = next.days[next.days.length - 1]!;
    expect(nextLast.window.endMinute).toBeLessThan(last.window.endMinute);
    expect(nextLast.window.note).toMatch(/Leave base by/);
    expect(honored.some((h) => /Departure flight at 13:00/.test(h))).toBe(true);
    const late = last.items.filter((i) => i.kind === 'activity' && i.endMinute > nextLast.window.endMinute);
    for (const item of late) expect(conflicts.some((c) => c.includes(item.title))).toBe(true);
  });

  it('re-applying is idempotent on the pristine itinerary: the same bookings give the same result', async () => {
    const itinerary = await cityTrip();
    const items = [booked({ type: 'lodging', title: 'Hotel B', date: '2026-06-01', endDate: '2026-06-04' }), booked({ type: 'activity', title: 'Palace tour', date: itinerary.days[2]!.date, startTime: '15:00', endTime: '16:30' })];
    const a = applyBookedFacts(itinerary, items);
    const b = applyBookedFacts(itinerary, items);
    expect(b.itinerary).toEqual(a.itinerary);
    expect(b.conflicts).toEqual(a.conflicts);
  });

  it('an idea or a soft hold binds nothing', async () => {
    const itinerary = await cityTrip();
    const { itinerary: next, honored } = applyBookedFacts(itinerary, [booked({ type: 'lodging', title: 'Maybe hotel', date: '2026-06-01', endDate: '2026-06-04', status: 'idea' })]);
    expect(honored).toEqual([]);
    expect(next.days.map((d) => d.baseName)).toEqual(itinerary.days.map((d) => d.baseName));
  });
});
