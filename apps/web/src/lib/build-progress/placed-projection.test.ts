import { describe, expect, it } from 'vitest';
import { formatElapsed, projectPlaced } from './placed-projection';

describe('projectPlaced', () => {
  const bounds = { southWest: { lat: -5, lng: 34 }, northEast: { lat: 1, lng: 40 } };

  it('returns nothing for nothing', () => {
    expect(projectPlaced([], { center: { lat: 0, lng: 37 }, bounds })).toEqual([]);
  });

  it('keeps every point inside the frame with room to the edge', () => {
    const points = [
      { name: 'Corner', lat: -5, lng: 34 },
      { name: 'Other corner', lat: 1, lng: 40 },
      { name: 'Middle', lat: -2, lng: 37 },
    ];
    for (const point of projectPlaced(points, { center: { lat: -2, lng: 37 }, bounds })) {
      expect(point.x).toBeGreaterThan(5);
      expect(point.x).toBeLessThan(95);
      expect(point.y).toBeGreaterThan(5);
      expect(point.y).toBeLessThan(95);
    }
  });

  it('puts north at the top and east on the right', () => {
    const [south, north] = projectPlaced(
      [
        { name: 'South-west', lat: -5, lng: 34 },
        { name: 'North-east', lat: 1, lng: 40 },
      ],
      { center: { lat: -2, lng: 37 }, bounds },
    );
    expect(south!.x).toBeLessThan(north!.x);
    expect(south!.y).toBeGreaterThan(north!.y);
  });

  it('widens the frame to hold a point placed outside the published bounds', () => {
    const [far] = projectPlaced([{ name: 'Far', lat: 4, lng: 45 }], { center: { lat: -2, lng: 37 }, bounds });
    expect(far!.x).toBeLessThanOrEqual(100);
    expect(far!.y).toBeGreaterThanOrEqual(0);
  });

  it('frames a lone point around the centre when nothing was published', () => {
    const [only] = projectPlaced([{ name: 'Only', lat: 10, lng: 20 }], { center: { lat: 10, lng: 20 }, bounds: null });
    expect(only!.x).toBeCloseTo(50, 0);
    expect(only!.y).toBeCloseTo(50, 0);
  });

  it('keeps the placement order, which is what the drawn line follows', () => {
    const names = projectPlaced(
      [
        { name: 'First', lat: 0, lng: 36 },
        { name: 'Second', lat: -1, lng: 37 },
        { name: 'Third', lat: -3, lng: 39 },
      ],
      { center: { lat: -2, lng: 37 }, bounds },
    ).map((point) => point.name);
    expect(names).toEqual(['First', 'Second', 'Third']);
  });
});

describe('formatElapsed', () => {
  it('counts seconds under a minute and minutes above it', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(48)).toBe('48s');
    expect(formatElapsed(60)).toBe('1:00');
    expect(formatElapsed(92)).toBe('1:32');
    expect(formatElapsed(-3)).toBe('0s');
  });
});
