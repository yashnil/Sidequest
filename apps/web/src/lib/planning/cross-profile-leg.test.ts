import { describe, expect, it } from 'vitest';
import { reconcileTripDraft } from './reconcile';
import { draftOf, fictionalWorld } from './acceptance/harness';

/**
 * A FIGURE MEASURED FOR ANOTHER PROFILE IS NOT THIS LEG'S FIGURE.
 *
 * A driving trip's matrix is measured on the car profile. A short hop the plan
 * walks used to borrow that car cell and shipped as "Walk · 6 min measured,
 * 2 km" — nineteen km/h on foot. The walk gets a walking figure, labelled
 * estimated; the drive keeps its measured car figure.
 */
describe('a walk never borrows a car measurement', () => {
  it('a walked hop on a car-measured trip is estimated at walking pace, and a drive stays measured', async () => {
    const world = fictionalWorld({
      name: 'Harbourland',
      center: { lat: 64.14, lng: -21.94 },
      places: [
        { name: 'Harbour Town', lat: 64.146, lng: -21.94, entityType: 'city' as const },
        { name: 'Hill Church', lat: 64.1417, lng: -21.9266 },
        { name: 'Lighthouse Point', lat: 64.164, lng: -22.022 },
      ],
      basics: { startDate: '2026-05-01', endDate: '2026-05-03' },
    });
    expect(world.context.matrix.mode).toBe('car');
    const draft = draftOf({
      bases: [{ id: 'b', name: 'Harbour Town', nights: 2 }],
      days: [
        { base: 'b', anchors: [{ name: 'Hill Church', role: 'core', transport: 'walk' }] },
        { base: 'b', anchors: [{ name: 'Lighthouse Point', role: 'core', transport: 'car' }] },
        { base: 'b', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const legs = result.itinerary.days.flatMap((d) => d.items).filter((i) => i.kind === 'travel' && i.travel);
    const walk = legs.find((l) => l.travel!.mode === 'walk' && l.travel!.toName === 'Hill Church');
    expect(walk, 'the hop to the church is walked').toBeDefined();
    expect(walk!.travel!.provenance).toBe('estimated');
    expect(walk!.travel!.provider).toBe('sidequest-geo-estimate');
    // Under ~6 km/h: a walking figure, never the car cell.
    const straight = 0.75;
    expect(walk!.travel!.minutes!).toBeGreaterThanOrEqual(Math.round((straight / 6) * 60));
    const drive = legs.find((l) => l.travel!.mode === 'drive' && l.travel!.toName === 'Lighthouse Point');
    expect(drive?.travel!.provenance).toBe('measured');
    // The drive earns its road shape from one direct request; the walk is never given one.
    expect(drive?.travel!.geometry).toBeTruthy();
    expect(walk!.travel!.geometry).toBeUndefined();
  });
});
