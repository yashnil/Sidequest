import { describe, expect, it } from 'vitest';
import { trailLinksFor } from './assemble';
import type { ScanCandidateProposal } from './proposal';

const stage = (key: string, walk: ScanCandidateProposal['walk'], durationMinutes = 180) => ({ id: `place-${key}`, proposal: { key, name: key, locality: 'x', kind: 'day_hike', tier: 'classic', durationMinutes, walk } as unknown as ScanCandidateProposal });

describe('trail stages that join two beds', () => {
  const beds = [{ id: 'bed-a', proposal: { key: 'a' } }, { id: 'bed-b', proposal: { key: 'b' } }];
  const bedAt = (id: string) => (id === 'bed-a' ? { lat: 33.83, lng: 135.6 } : { lat: 33.84, lng: 135.77 });
  const positions = new Map<string, { coordinates: { lat: number; lng: number } }>([
    ['s1', { coordinates: { lat: 33.86, lng: 135.68 } }],
    ['s1#end', { coordinates: { lat: 33.841, lng: 135.772 } }],
    ['loop', { coordinates: { lat: 33.83, lng: 135.61 } }],
    ['far', { coordinates: { lat: 33.86, lng: 135.68 } }],
    ['far#end', { coordinates: { lat: 34.2, lng: 136.2 } }],
  ]);
  it('links a point-to-point stage that starts near one bed and ends at another, timed from its distance and ascent', () => {
    const links = trailLinksFor([stage('s1', { shape: 'point_to_point', endName: 'b', km: 7, ascentM: 300 })], beds, (k) => positions.get(k) ?? null, bedAt);
    expect(links).toEqual([{ fromBaseId: 'bed-a', toBaseId: 'bed-b', walkMinutes: 123, placeId: 'place-s1' }]);
  });
  it('a loop, or a stage that ends nowhere near a bed, links nothing', () => {
    expect(trailLinksFor([stage('loop', { shape: 'loop' })], beds, (k) => positions.get(k) ?? null, bedAt)).toEqual([]);
    expect(trailLinksFor([stage('far', { shape: 'point_to_point', endName: 'z' })], beds, (k) => positions.get(k) ?? null, bedAt)).toEqual([]);
  });
});
