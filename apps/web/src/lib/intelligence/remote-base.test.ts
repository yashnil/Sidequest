import { describe, expect, it } from 'vitest';
import { boardWorld, draftOf } from '@/lib/planning/acceptance/harness';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import { buildTravelIntelligence } from './build';
import type { TripDraft } from '@/lib/planning/trip-draft';

/**
 * §26 — A BASE IS REMOTE, OR IT IS NOT. A DAY TRIP DOES NOT MAKE IT SO.
 *
 * The live Hong Kong build told the traveller to book early because
 * "Sheung Wan / Central, Hong Kong Island — a remote base with few beds". One
 * hiking day on Dragon's Back made day 5 remote, the trip's only base inherited
 * it, and the section whose whole job is telling somebody what is scarce stated
 * a falsehood about one of the densest hotel markets on earth.
 */

async function bookingReasons(draft: TripDraft) {
  const context = boardWorld();
  const result = await reconcileTripDraft({ draft, context });
  const intelligence = buildTravelIntelligence({
    tripId: context.tripId,
    itinerary: result.itinerary,
    draft: { days: draft.days.map((d) => ({ anchors: d.anchors.map((a) => ({ name: a.name, ...(a.transport ? { transport: a.transport } : {}) })) })), bases: draft.bases.map((b) => ({ id: b.id, ...(b.overnight ? { overnight: b.overnight } : {}) })) },
    profile: context.profile,
    basics: context.basics,
    destination: { name: 'Mammoth Lakes' },
    composer: null,
    booked: [],
    readinessProfile: null,
    sourcedAreas: [],
    worthSkipping: [],
    userPlaces: [],
    bookedHonored: [],
    bookedConflicts: [],
    now: new Date('2026-06-01T00:00:00.000Z'),
    fx: null,
  });
  return intelligence.bookings.items.map((item) => item.reason ?? '').join(' | ');
}

describe('remoteness is a property of where you sleep', () => {
  it('a city base with one hard hiking day out is not remote', async () => {
    const reasons = await bookingReasons(
      draftOf({
        bases: [{ id: 'city', name: 'Mammoth Lakes', nights: 3, style: 'midrange hotel in the centre' }],
        days: [
          { base: 'city', anchors: [{ name: 'Convict Lake' }] },
          { base: 'city', anchors: [{ name: 'Mono Lake' }] },
          { base: 'city', anchors: [{ name: 'Hot Creek', category: 'hike' }], intensity: 'intense' },
        ],
      }),
    );
    expect(reasons).not.toMatch(/remote base with few beds/);
  });

  it('a base that IS a hut says so', async () => {
    const reasons = await bookingReasons(
      draftOf({
        bases: [{ id: 'hut', name: 'Mammoth Lakes', nights: 3, style: 'mountain hut on the ridge', overnight: 'hut' }],
        days: [
          { base: 'hut', anchors: [{ name: 'Convict Lake' }] },
          { base: 'hut', anchors: [{ name: 'Mono Lake' }] },
          { base: 'hut', anchors: [{ name: 'Hot Creek' }] },
        ],
      }),
    );
    expect(reasons).toMatch(/remote base with few beds/);
  });
});
