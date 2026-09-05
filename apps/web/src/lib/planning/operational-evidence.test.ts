import { describe, expect, it } from 'vitest';
import { itinerarySchema, type OperationalEvidence } from '@sidequest/core';
import { reconcileTripDraft, type ProviderPlaceIdentity, type ReconcileContext } from './reconcile';
import { draftOf, fictionalWorld } from './acceptance/harness';

/**
 * LIVE WORLD V1 closure — operational evidence through the reconciler.
 * The world knows no venues; a places seam identifies them; an operational
 * seam answers with normalised evidence shaped like the recorded fixtures.
 */
const PLACES = [
  { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' as const },
  { name: 'Corner Bistro', lat: 50.01, lng: 10.01, known: false },
  { name: 'Monday Museum', lat: 50.02, lng: 10.02, known: false },
  { name: 'Gone Gallery', lat: 50.03, lng: 10.03, known: false },
  { name: 'Ridge Trail', lat: 50.04, lng: 10.04, known: false },
  { name: 'Slow Cafe', lat: 50.05, lng: 10.05, known: false },
  { name: 'Late Bar', lat: 50.06, lng: 10.06, known: false },
];
const weekly = (days: number[], open: number, close: number) => days.map((day) => ({ day, openMinute: open, closeMinute: close }));
const CHECKED = '2026-04-20T09:00:00.000Z';
// 2026-05-04 is a Monday, 2026-05-05 a Tuesday.
const EVIDENCE: Record<string, OperationalEvidence> = {
  'Corner Bistro': { provider: 'google-places', providerRef: 'g:bistro', checkedAt: CHECKED, status: 'operational', hoursBasis: 'regular', weekly: weekly([0, 1, 2, 3, 4, 5, 6], 480, 1320), attribution: 'Place data © Google' },
  'Monday Museum': { provider: 'google-places', providerRef: 'g:museum', checkedAt: CHECKED, status: 'operational', hoursBasis: 'regular', weekly: weekly([2, 3, 4, 5, 6, 0], 600, 1020), attribution: 'Place data © Google' },
  'Gone Gallery': { provider: 'google-places', providerRef: 'g:gone', checkedAt: CHECKED, status: 'closed_permanently', hoursBasis: 'none', attribution: 'Place data © Google' },
  'Slow Cafe': { provider: 'google-places', providerRef: 'g:slow', checkedAt: CHECKED, status: 'unknown', hoursBasis: 'none', attribution: 'Place data © Google', unavailableReason: 'timeout' },
  'Late Bar': { provider: 'google-places', providerRef: 'g:late', checkedAt: CHECKED, status: 'operational', hoursBasis: 'regular', weekly: weekly([0, 1, 2, 3, 4, 5, 6], 1080, 1439), attribution: 'Place data © Google' },
};
const CLASS: Record<string, ProviderPlaceIdentity['placeClass']> = { 'Corner Bistro': 'business_venue', 'Monday Museum': 'business_venue', 'Gone Gallery': 'business_venue', 'Ridge Trail': 'open_ground', 'Slow Cafe': 'business_venue', 'Late Bar': 'business_venue' };

function seams(asked: string[]): Pick<ReconcileContext, 'resolvePlaceIdentity' | 'operationalEvidence'> {
  return {
    resolvePlaceIdentity: async (input) => {
      const place = PLACES.find((p) => p.name === input.name);
      if (!place || place.name === 'Base Town') return null;
      return { providerRef: `g:${place.name.split(' ')[0]!.toLowerCase()}`, provider: 'google-places', name: place.name, coordinates: { lat: place.lat, lng: place.lng }, placeClass: CLASS[place.name] ?? 'unknown', confidence: 'exact', attribution: 'Place data © Google' };
    },
    operationalEvidence: async (input) => {
      asked.push(input.name);
      return EVIDENCE[input.name] ?? null;
    },
  };
}

async function reconcile(anchors: { name: string; category: 'food' | 'museum' | 'historic' | 'hike' | 'landmark'; minutes?: number }[], dates = { startDate: '2026-05-04', endDate: '2026-05-05' }, nowIso = '2026-04-20T09:00:00Z') {
  const world = fictionalWorld({ name: 'Venueland', center: { lat: 50, lng: 10 }, places: PLACES, basics: dates });
  const asked: string[] = [];
  const draft = draftOf({ bases: [{ id: 'b1', name: 'Base Town', nights: 1 }], days: [{ base: 'b1', anchors: anchors.map((a) => ({ name: a.name, category: a.category, minutes: a.minutes ?? 90 })) }, { base: 'b1', anchors: [{ name: 'Corner Bistro', category: 'food', minutes: 60 }] }] });
  const result = await reconcileTripDraft({ draft, context: { ...world.context, now: new Date(nowIso), ...seams(asked) } });
  return { result, asked };
}

describe('LIVE WORLD V1 closure — reconciler consumes normalised operational evidence', () => {
  it('A. a bistro open all day at the planned time is retained and its Sidequest outcome persists — no hours values, no Google name', async () => {
    const { result } = await reconcile([{ name: 'Corner Bistro', category: 'food' }]);
    const stop = result.itinerary.days[0]!.items.find((i) => i.title === 'Corner Bistro')!;
    expect(stop.operational?.outcome).toBe('open_at_time');
    expect(stop.operational?.provider).toBe('google-places');
    expect(stop.operational?.attribution).toBe('Place data © Google');
    expect(stop.hours).toBeUndefined();
    expect(JSON.stringify(result.itinerary)).not.toMatch(/weekly|openMinute":480/);
    expect(result.itinerary.package!.anchors.find((a) => a.name === 'Corner Bistro')?.disposition).toBe('preserved');
    expect(itinerarySchema.safeParse(result.itinerary).success).toBe(true);
  });

  it('B. a museum closed on Monday is moved to Tuesday, minimally; the same museum on an open weekday is arrived at when it opens', async () => {
    const { result } = await reconcile([{ name: 'Monday Museum', category: 'museum' }]);
    const anchor = result.itinerary.package!.anchors.find((a) => a.name === 'Monday Museum')!;
    expect(anchor.disposition).toBe('moved_other_day');
    expect(anchor.scheduledDayNumber).toBe(2);
    const moved = result.itinerary.days[1]!.items.find((i) => i.title === 'Monday Museum')!;
    expect(moved.startMinute).toBeGreaterThanOrEqual(600);
    expect(['open_at_time', 'opens_later']).toContain(moved.operational?.outcome);
    expect(result.itinerary.diagnostics.revisions.some((r) => r.code === 'moved_to_another_day' && /Monday Museum/.test(r.description))).toBe(true);
    // With no other day at that base, the museum is a named conflict, never a silent drop.
    const single = await reconcile([{ name: 'Monday Museum', category: 'museum' }], { startDate: '2026-05-04', endDate: '2026-05-04' });
    expect(single.result.itinerary.package!.anchors.find((a) => a.name === 'Monday Museum')?.disposition).toBe('rejected_contradiction');
    expect(single.result.itinerary.unscheduled.find((u) => u.name === 'Monday Museum')?.reasonCode).toBe('closed_on_trip_dates');
  });

  it('C. a permanently closed gallery is rejected with the provider named; the count of dispositions never changes', async () => {
    const { result } = await reconcile([{ name: 'Gone Gallery', category: 'historic' }, { name: 'Corner Bistro', category: 'food' }]);
    const gone = result.itinerary.package!.anchors.find((a) => a.name === 'Gone Gallery')!;
    expect(gone.disposition).toBe('rejected_contradiction');
    expect(result.itinerary.unscheduled.find((u) => u.name === 'Gone Gallery')?.reason).toMatch(/permanently closed.*Google/);
    expect(result.itinerary.package!.anchors).toHaveLength(3);
  });

  it('D. a trail is never asked for hours and is retained with no operational state', async () => {
    const { result, asked } = await reconcile([{ name: 'Ridge Trail', category: 'hike' }]);
    expect(asked).not.toContain('Ridge Trail');
    const trail = result.itinerary.days[0]!.items.find((i) => i.title === 'Ridge Trail')!;
    expect(trail.operational).toBeUndefined();
    expect(result.itinerary.package!.anchors.find((a) => a.name === 'Ridge Trail')?.disposition).toBe('preserved');
  });

  it('E. a provider timeout retains the stop as unverified and says so', async () => {
    const { result } = await reconcile([{ name: 'Slow Cafe', category: 'food' }]);
    const cafe = result.itinerary.days[0]!.items.find((i) => i.title === 'Slow Cafe')!;
    expect(cafe.operational?.outcome).toBe('unavailable');
    expect(cafe.operational?.recheck).toBe(true);
    expect(result.itinerary.package!.anchors.find((a) => a.name === 'Slow Cafe')?.disposition).toBe('preserved');
  });

  it('F. a far-future trip with regular hours is confirmed for the weekday only with a recheck; a bar that opens in the evening pulls the visit later within the day', async () => {
    const far = await reconcile([{ name: 'Corner Bistro', category: 'food' }], { startDate: '2026-11-02', endDate: '2026-11-03' });
    const bistro = far.result.itinerary.days[0]!.items.find((i) => i.title === 'Corner Bistro')!;
    expect(bistro.operational?.outcome).toBe('open_at_time');
    expect(bistro.operational?.recheck).toBe(true);
    expect(bistro.operational?.note).toMatch(/check again/);
    const { result } = await reconcile([{ name: 'Late Bar', category: 'landmark', minutes: 60 }]);
    const bar = result.itinerary.days[0]!.items.find((i) => i.title === 'Late Bar')!;
    // Either it was pulled to opening time or honestly flagged as before opening; never silently scheduled at 10:00 as if open.
    expect(bar.startMinute >= 1080 || bar.operational?.outcome === 'opens_later' || bar.operational?.outcome === 'closes_earlier').toBe(true);
  });
});
