import { describe, expect, it } from 'vitest';
import type { DiscoverySelection } from '../schemas/discovery';
import { buildDiscoveryDecisions, describeAutoPickChange, travellerDecided, type DecisionCandidate } from './decisions';

function candidate(id: string, score: number): DecisionCandidate {
  return {
    place: {
      id,
      name: `Place ${id}`,
      category: 'viewpoint',
      coordinates: { lat: 1, lng: 2 },
      typicalDurationMinutes: 60,
      physicalIntensity: 'easy',
    } as never,
    fit: { score },
  };
}

function row(placeId: string, status: DiscoverySelection['status'], source: DiscoverySelection['source'], at: string, reason?: DiscoverySelection['reason']): DiscoverySelection {
  return { placeId, status, source, updatedAt: `2026-01-01T00:00:${at}.000Z`, ...(reason ? { reason } : {}) };
}

describe('buildDiscoveryDecisions', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => candidate(`p${String(i).padStart(2, '0')}`, 40 + i));

  it('puts every row in exactly one list by author and intent', () => {
    const decisions = buildDiscoveryDecisions(candidates, [
      row('p01', 'included', 'user', '01'),
      row('p02', 'included', 'auto', '01'),
      row('p03', 'maybe', 'user', '02'),
      row('p04', 'excluded', 'user', '03', 'too_expensive'),
      row('p05', 'dismissed', 'user', '04'),
      row('gone', 'included', 'user', '05'),
    ]);
    expect(decisions.travellerMustIncludes.entries.map((e) => e.placeId)).toEqual(['p01']);
    expect(decisions.sidequestRecommended.entries.map((e) => e.placeId)).toEqual(['p02']);
    expect(decisions.travellerMaybes.entries.map((e) => e.placeId)).toEqual(['p03']);
    expect(decisions.travellerExclusions.entries[0]).toMatchObject({ placeId: 'p04', reason: 'too_expensive' });
    expect(decisions.dismissedAutoPicks.entries.map((e) => e.placeId)).toEqual(['p05']);
    expect(decisions.notOnBoard).toEqual(['gone']);
  });

  it('carries the planner metadata by reference to the board candidate', () => {
    const decisions = buildDiscoveryDecisions(candidates, [row('p07', 'included', 'user', '01')]);
    const entry = decisions.travellerMustIncludes.entries[0]!;
    expect(entry).toMatchObject({ name: 'Place p07', fitScore: 47, category: 'viewpoint', durationMinutes: 60, intensity: 'easy', coordinates: { lat: 1, lng: 2 } });
    expect(entry.candidate).toBe(candidates[7]);
  });

  it('orders traveller lists by when they decided, then fit; Sidequest picks by fit then id', () => {
    const decisions = buildDiscoveryDecisions(candidates, [
      row('p10', 'included', 'user', '05'),
      row('p02', 'included', 'user', '01'),
      row('p20', 'included', 'user', '01'),
      row('p03', 'included', 'auto', '00'),
      row('p25', 'included', 'auto', '00'),
    ]);
    // Same instant: the better fit first.
    expect(decisions.travellerMustIncludes.entries.map((e) => e.placeId)).toEqual(['p20', 'p02', 'p10']);
    expect(decisions.sidequestRecommended.entries.map((e) => e.placeId)).toEqual(['p25', 'p03']);
  });

  it('caps deterministically, counts what it omits, and never drops a traveller include', () => {
    const selections = [
      ...candidates.slice(0, 15).map((c, i) => row(c.place.id, 'included', 'user', String(i).padStart(2, '0'))),
      ...candidates.slice(15).map((c) => row(c.place.id, 'included', 'auto', '00')),
    ];
    const once = buildDiscoveryDecisions(candidates, selections, { sidequestRecommended: 4 });
    const reversed = buildDiscoveryDecisions(candidates, [...selections].reverse(), { sidequestRecommended: 4 });
    expect(once.travellerMustIncludes.entries).toHaveLength(15);
    expect(once.travellerMustIncludes.omittedCount).toBe(0);
    expect(once.sidequestRecommended.entries.map((e) => e.placeId)).toEqual(['p29', 'p28', 'p27', 'p26']);
    expect(once.sidequestRecommended.omittedCount).toBe(11);
    // Input order does not change the answer.
    expect(reversed.sidequestRecommended.entries.map((e) => e.placeId)).toEqual(once.sidequestRecommended.entries.map((e) => e.placeId));
    expect(reversed.travellerMustIncludes.entries.map((e) => e.placeId)).toEqual(once.travellerMustIncludes.entries.map((e) => e.placeId));
  });
});

describe('travellerDecided', () => {
  it('holds every traveller row, dismissed included, and no Sidequest row', () => {
    expect(
      travellerDecided([
        row('a', 'included', 'auto', '01'),
        row('b', 'dismissed', 'user', '01'),
        row('c', 'excluded', 'user', '01'),
        row('d', 'included', 'user', '01'),
      ]),
    ).toEqual({ b: 'dismissed', c: 'excluded', d: 'included' });
  });
});

describe('describeAutoPickChange', () => {
  it('says so when the board already has the best mix', () => {
    const change = describeAutoPickChange({ before: ['a', 'b'], after: ['b', 'a'], travellerPicks: 2 });
    expect(change.changed).toBe(false);
    expect(change.message).toBe('Your board already has the best mix we can find for this trip — nothing changed, and your 2 picks stay as they are.');
  });

  it('says what changed', () => {
    expect(describeAutoPickChange({ before: [], after: ['a', 'b', 'c'], travellerPicks: 0 }).message).toBe('We added 3 places.');
    expect(describeAutoPickChange({ before: ['a', 'x'], after: ['a', 'b', 'c'], travellerPicks: 1 }).message).toBe(
      'We added 2 places, took off 1 earlier pick of ours and kept your 1 pick.',
    );
  });
});
