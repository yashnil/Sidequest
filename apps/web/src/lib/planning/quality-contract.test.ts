import { describe, expect, it } from 'vitest';
import type { DiscoveryCandidate, TripQualityContract } from '@sidequest/core';
import { essentialIdsFor, spreadAcrossAreas } from './quality-contract';

/* A fictional reserve country: one crater area with several stops, two other parks far away. */
const candidate = (id: string, name: string, kind: string, lat: number, lng: number, score: number) =>
  ({ place: { id, name, tags: [`kind:${kind}`], coordinates: { lat, lng } }, fit: { score, blockers: [] } }) as unknown as DiscoveryCandidate;

const board = [
  candidate('crater-floor', 'Crater floor game drive', 'wildlife', -3.2, 35.5, 0.95),
  candidate('crater-view', 'Eastern Crater viewpoint', 'viewpoint', -3.15, 35.55, 0.93),
  candidate('crater-hippo', 'Crater hippo pool', 'wildlife', -3.18, 35.52, 0.94),
  candidate('crater-forest', 'Crater rim forest reserve walk', 'nature', -3.22, 35.6, 0.92),
  candidate('plains', 'Northern plains sunset drive', 'wildlife', -2.4, 34.8, 0.7),
  candidate('river-park', 'River park', 'national_park', -3.9, 36.0, 0.6),
];

const contract = (distinctAreas: boolean): TripQualityContract =>
  ({
    essentials: [{ id: 'wildlife_viewing', label: 'Game drives in the parks', requirement: 'requirement', source: 'request', kinds: ['wildlife', 'national_park'], nameTerms: ['game drive', 'crater', 'reserve'], minCount: 3, ...(distinctAreas ? { distinctAreas } : {}), recovery: 'x' }],
  }) as unknown as TripQualityContract;

describe('an essential that needs several different places', () => {
  it('builds around one candidate per area, of the essential’s own kind before a name match', () => {
    expect([...essentialIdsFor(contract(true), board)].sort()).toEqual(['crater-floor', 'plains', 'river-park']);
  });

  it('without distinctAreas keeps the plain fit order (a count of walks is not a count of places)', () => {
    /* Kind matches first, then fit: two of the three in the crater area. */
    expect([...essentialIdsFor(contract(false), board)].sort()).toEqual(['crater-floor', 'crater-hippo', 'plains']);
    const nameOnly = contract(false);
    (nameOnly.essentials[0] as { kinds?: unknown }).kinds = [];
    expect([...essentialIdsFor(nameOnly, board)].sort()).toEqual(['crater-floor', 'crater-hippo', 'crater-view']);
  });

  it('never reduces the count: same-area candidates fill in when nothing is elsewhere', () => {
    const oneArea = [board[0]!, board[1]!, board[3]!];
    expect(spreadAcrossAreas(oneArea, 3).map((c) => c.place.id)).toEqual(['crater-floor', 'crater-view', 'crater-forest']);
    expect(spreadAcrossAreas(board, 2).map((c) => c.place.id)).toEqual(['crater-floor', 'plains']);
  });
});
