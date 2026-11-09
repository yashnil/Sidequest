import { describe, expect, it } from 'vitest';
import recorded from './fixtures/live-scans-2026-11.json';
import { chooseScanBases } from './assemble';
import { estimateLegMinutes, haversineKm } from '../travel/estimate';
import type { ScanBaseProposal, ScanCandidateProposal } from './proposal';

/**
 * BASE CHOICE ON REAL SCANS, WITH THE ESTIMATOR THE SCAN USES.
 *
 * Six scans recorded from the live release pass (2026-11-08): the model's
 * proposals as placed by Nominatim — coordinates and durations only. Every
 * travel time is recomputed here with `estimateLegMinutes`, exactly as an
 * estimated scan matrix is, so a change to the estimator that would move a
 * trip's hotels shows up as a failing expectation rather than in production.
 *
 * What is expected is realistic logistics, not the fewest hotels: a car trip on
 * a small island sleeps in one place; a Highlands-and-Skye road trip moves; a
 * Tokyo-and-Kyoto trip sleeps in both cities; a car-free Tenerife trip may
 * spend a couple of nights in the south, because the southern sights are an
 * hour and a half by bus from the north — but never one night anywhere.
 */

type Scan = (typeof recorded.scans)[number];

function choose(scan: Scan, mode: 'car' | 'foot' = scan.mode as 'car' | 'foot', extra: Partial<Pick<Parameters<typeof chooseScanBases>[0], 'traveller' | 'mustCover'>> = {}) {
  const at = new Map<string, { lat: number; lng: number }>([...scan.bases.map((b) => [b.id, b.coordinates] as const), ...scan.places.map((p) => [p.id, p.coordinates] as const)]);
  const minutes = (a: string, b: string): number | null => {
    const pa = at.get(a)!;
    const pb = at.get(b)!;
    if (mode === 'foot' && haversineKm(pa, pb) <= 1.6) return estimateLegMinutes({ from: pa, to: pb, mode: 'walk' })!.minutes;
    return estimateLegMinutes({ from: pa, to: pb, mode: mode === 'car' ? 'drive' : 'rail' })?.minutes ?? null;
  };
  const choice = chooseScanBases({
    bases: scan.bases.map((b) => ({ id: b.id, proposal: { key: b.id, name: b.name, locality: b.name, nightsHint: b.nightsHint, why: '' } satisfies ScanBaseProposal })),
    places: scan.places.map((p) => ({ id: p.id, proposal: { tier: p.popularity >= 0.7 ? 'classic' : p.popularity >= 0.35 ? 'side_quest' : 'hidden_gem', durationMinutes: p.minutes } as ScanCandidateProposal })),
    minutes,
    nights: scan.nights,
    maxBaseChanges: 3,
    ...extra,
    traveller: { carAvailable: mode === 'car', ...extra.traveller },
  });
  const nights = new Map<string, number>();
  for (const k of choice.kept) {
    const name = scan.bases.find((b) => b.id === k.id)!.name;
    nights.set(name, (nights.get(name) ?? 0) + k.nights);
  }
  return nights;
}

const scan = (label: string): Scan => recorded.scans.find((s) => s.label === label)!;

describe('base choice on recorded live scans (release pass, 2026-11)', () => {
  it('a car trip on one small island sleeps in one place', () => {
    for (const label of ['tenerife-car-a', 'tenerife-car-b']) {
      expect([...choose(scan(label)).entries()], label).toEqual([['Puerto de la Cruz', 6]]);
    }
  });

  /* Was three bases: the third move costs more than it buys for most travellers (`stay-objective.ts`). Longest on Skye still, and the road trip still moves. */
  it('a Highlands-and-Skye road trip moves at least once and stays longest on Skye', () => {
    const nights = choose(scan('scotland-road-trip'));
    expect([...nights.keys()]).toContain('Portree');
    expect(nights.size).toBeGreaterThanOrEqual(2);
    expect(nights.get('Portree')).toBe(Math.max(...nights.values()));
  });

  /* Was asserted from the geometry alone. Without the traveller's own phrase, a week from Shinjuku is the cheaper trip; "Tokyo and Kyoto" is what makes it two cities. */
  it('a trip the traveller named as Tokyo and Kyoto sleeps in both, by car estimates or by public transport', () => {
    const s = scan('tokyo-kyoto');
    const idOf = (name: string) => s.bases.find((b) => b.name === name)!.id;
    const mustCover = [{ name: 'Tokyo', baseIds: [idOf('Shinjuku')] }, { name: 'Kyoto', baseIds: [idOf('Higashiyama')] }];
    for (const mode of ['car', 'foot'] as const) {
      const nights = choose(s, mode, { mustCover });
      expect([...nights.keys()].sort(), mode).toEqual(['Higashiyama', 'Shinjuku']);
    }
  });

  it('a car-free Tenerife trip never moves for one night and uses at most two bases', () => {
    const nights = choose(scan('tenerife-no-car'));
    expect(nights.size).toBeLessThanOrEqual(2);
    for (const n of nights.values()) expect(n).toBeGreaterThanOrEqual(2);
  });

  it('no recorded scan of four nights or more keeps a one-night stay', () => {
    for (const s of recorded.scans) {
      if (s.nights < 4) continue;
      for (const n of choose(s).values()) expect(n, s.label).toBeGreaterThanOrEqual(2);
    }
  });
});
