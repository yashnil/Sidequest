import { describe, expect, it } from 'vitest';
import { routeCoverage } from './route-coverage';

const pt = (lat: number, lng: number) => ({ coordinates: { lat, lng } });
/* A ring of points round a centre, radius in degrees. */
const ringOf = (lat: number, lng: number, r: number, n = 12) => Array.from({ length: n }, (_, i) => pt(lat + r * Math.sin((i / n) * 2 * Math.PI), lng + (r * 2 * Math.cos((i / n) * 2 * Math.PI))));
/* Points strung along one line, west to east. */
const lineOf = (lat: number, fromLng: number, toLng: number, n = 10) => Array.from({ length: n }, (_, i) => pt(lat + (i % 2) * 0.05, fromLng + ((toLng - fromLng) * i) / (n - 1)));

describe('whether a proposal covers a route', () => {
  it('a loop whose places enclose ground is covered; one strung along a line is one side of it', () => {
    expect(routeCoverage({ kind: 'loop', points: ringOf(65, -18, 1.2), reachKm: 500 }).covered).toBe(true);
    const line = routeCoverage({ kind: 'loop', points: lineOf(63.8, -22, -15), reachKm: 500 });
    expect(line.covered).toBe(false);
    expect(line.uncovered.sort()).toEqual(['north', 'south']);
  });

  it('with an extent, names the compass parts nothing reaches', () => {
    const extent = { southWest: { lat: 63.3, lng: -24.5 }, northEast: { lat: 66.6, lng: -13.5 } };
    const south = routeCoverage({ kind: 'loop', points: lineOf(63.6, -22, -15), extent, reachKm: 500 });
    expect(south.basis).toBe('extent');
    expect(south.covered).toBe(false);
    expect(south.uncovered).toContain('north');
    expect(routeCoverage({ kind: 'loop', points: ringOf(65, -19, 1.4, 16), extent, reachKm: 500 }).covered).toBe(true);
  });

  it('a linear route checks its ends and the stretches between them', () => {
    const stops = [
      { label: 'Tokyo', center: { lat: 35.69, lng: 139.7 } },
      { label: 'Kyoto', center: { lat: 35.0, lng: 135.77 } },
      { label: 'Hiroshima', center: { lat: 34.39, lng: 132.46 } },
    ];
    const tokyoKyoto = [pt(35.68, 139.69), pt(35.7, 139.75), pt(35.3, 139.5), pt(35.1, 138.9), pt(35.0, 135.76), pt(35.02, 135.8)];
    const result = routeCoverage({ kind: 'linear', points: tokyoKyoto, stops, reachKm: 800 });
    expect(result.covered).toBe(false);
    expect(result.uncovered).toEqual(expect.arrayContaining(['near Hiroshima', 'between Kyoto and Hiroshima']));
  });

  it('too few points, or a linear route with no resolved ends, is not judged', () => {
    expect(routeCoverage({ kind: 'loop', points: [pt(1, 1), pt(2, 2)], reachKm: 500 }).checked).toBe(false);
    expect(routeCoverage({ kind: 'linear', points: lineOf(50, 0, 3), reachKm: 500 }).checked).toBe(false);
  });

  it('a road trip whose places sit in one corner of what it could reach is clustered', () => {
    expect(routeCoverage({ kind: 'touring', points: ringOf(57.4, -4.2, 0.1), reachKm: 500 }).covered).toBe(false);
    expect(routeCoverage({ kind: 'touring', points: lineOf(57.5, -6.2, -3.1), reachKm: 500 }).covered).toBe(true);
  });
});
