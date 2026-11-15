import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * FINAL PASS — THE PLACEMENT REACH NEVER STOPS SHORT OF A NAMED PART.
 * Live Mode 3: "Tokyo, Kyoto, Osaka and Sapporo" refused Sapporo as outside the envelope.
 */
describe('the scan placement reach', () => {
  it('covers the farthest named part of the destination, with a margin', async () => {
    const { scanPlacementReachKm, placementReachKm } = await import('./run');
    const centre = { lat: 35.2, lng: 137.3 }; // between Tokyo and Osaka
    const sapporo = { lat: 43.06, lng: 141.35 };
    const plain = placementReachKm('region', 9);
    const reach = scanPlacementReachKm('region', 9, centre, [{ center: { lat: 35.68, lng: 139.76 } }, { center: sapporo }]);
    expect(plain).toBeLessThan(950);
    expect(reach).toBeGreaterThan(950);
  });
  it('never shrinks the ordinary reach', async () => {
    const { scanPlacementReachKm, placementReachKm } = await import('./run');
    expect(scanPlacementReachKm('country', 8, { lat: -6.5, lng: 35.8 }, [])).toBe(placementReachKm('country', 8));
  });
});
