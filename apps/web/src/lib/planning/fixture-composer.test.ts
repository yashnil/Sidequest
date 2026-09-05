import { describe, expect, it } from 'vitest';
import { FIXTURE_UNVERIFIABLE_ANCHOR, FixtureComposer, fixtureDraftFor } from './fixture-composer';
import { generateTripDraft, type CompositionContext } from './composition';
import { buildHybridTripRequest } from './hybrid-request';
import { defaultProfileFor } from './production-plan';
import { tripDraftSchema } from './trip-draft';
import type { Trip } from '@sidequest/core';

const TRIP: Trip = {
  id: 't',
  basics: { mode: 'known_destination', destinationInput: 'Harbour City', regionId: 'dynamic', startDate: '2026-08-12', endDate: '2026-08-16', arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] },
  status: 'draft',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function context(): CompositionContext {
  return {
    request: buildHybridTripRequest({ trip: TRIP, composer: null, profile: defaultProfileFor(TRIP, null), now: new Date('2026-08-01T00:00:00Z') }),
    envelope: { name: 'Harbour City', countryCode: 'XX', scale: 'city', center: { lat: 1, lng: 2 } },
    mode: 'full',
  };
}

describe('the fixture composer', () => {
  it('composes a complete, schema-valid draft for every day with meals, a package and one deliberately unverifiable place', () => {
    const draft = fixtureDraftFor(context(), { placeNames: [{ name: 'Harbour Museum', category: 'museum' }, { name: 'North Beach', category: 'beach' }], baseNames: ['Harbour City'] });
    expect(tripDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.days).toHaveLength(5);
    expect(draft.bases.reduce((s, b) => s + b.nights, 0)).toBe(4);
    expect(draft.days.every((d) => d.anchors.length >= 2)).toBe(true);
    expect(draft.days.flatMap((d) => d.anchors).some((a) => a.name === FIXTURE_UNVERIFIABLE_ANCHOR)).toBe(true);
    expect(draft.package.packing.length).toBeGreaterThan(3);
    expect(draft.package.beforeYouGo.some((line) => /entry requirements/i.test(line))).toBe(true);
  });

  it('is exactly one call through the same seam the real model fills, and refuses a second', async () => {
    const composer = new FixtureComposer(context(), { placeNames: [], baseNames: [] });
    const first = await generateTripDraft({ model: composer, context: context() });
    expect(first.ok).toBe(true);
    const second = await generateTripDraft({ model: composer, context: context() });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failureKind).toBe('budget_exhausted');
  });
});
