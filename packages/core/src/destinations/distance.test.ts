import { describe, expect, it } from 'vitest';
import { separationKm } from './distance';

describe('separationKm', () => {
  it('is zero for one point and symmetric for two', () => {
    const paris = { lat: 48.8566, lng: 2.3522 };
    const london = { lat: 51.5074, lng: -0.1278 };
    expect(separationKm(paris, paris)).toBe(0);
    expect(separationKm(paris, london)).toBeCloseTo(separationKm(london, paris), 9);
  });

  it('measures a great circle, not a flat map', () => {
    // Paris to London is about 344 km on the sphere.
    expect(separationKm({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 })).toBeGreaterThan(340);
    expect(separationKm({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 })).toBeLessThan(348);
    // One degree of longitude is ~111 km on the equator and about half that at 60° north.
    expect(separationKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.2, 0);
    expect(separationKm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })).toBeCloseTo(55.6, 0);
  });

  it('takes the short way across the antimeridian and never exceeds half the globe', () => {
    expect(separationKm({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(111.2, 0);
    const antipodal = separationKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(antipodal).toBeCloseTo(Math.PI * 6371.0088, 3);
    expect(Number.isFinite(separationKm({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }))).toBe(true);
  });
});
