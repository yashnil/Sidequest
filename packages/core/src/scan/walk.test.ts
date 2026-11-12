import { describe, expect, it } from 'vitest';
import { normalizeScanProposal, walkingMinutes, type ScanCandidateProposal } from './proposal';
import { walkDuration, walkTags, type ResolvedPosition } from './assemble';

const base = { bases: [{ name: 'Hongū', locality: 'Tanabe', nightsHint: 3, why: 'Central.' }], foodAreas: [], skipped: [], package: {} };
const stage = (walk: unknown, kind = 'day_hike') => ({ name: 'Nakahechi: Takijiri to Chikatsuyu', locality: 'Tanabe', kind, tier: 'classic', durationMinutes: 90, intensity: 'moderate', costLevel: 0, exposure: 'outdoor', bestTime: 'morning', crowd: 'moderate', booking: 'none', rainyDayOk: false, interests: ['hiking'], why: 'The pilgrim trail.', walk });
const at = (lat: number, lng: number, approximate = false): ResolvedPosition => ({ coordinates: { lat, lng }, method: 'geocoder', provider: 'test', approximate });

describe('the shape of a walk', () => {
  it('keeps a point-to-point walk with a named end, its distance and ascent', () => {
    const r = normalizeScanProposal({ ...base, candidates: [stage({ shape: 'point_to_point', endName: 'Chikatsuyu', endLocality: 'Tanabe', km: 13, ascentM: 1000 })] });
    expect(r.ok && r.proposal.candidates[0]!.walk).toEqual({ shape: 'point_to_point', endName: 'Chikatsuyu', endLocality: 'Tanabe', km: 13, ascentM: 1000 });
  });

  it('never invents a shape: a point-to-point with no end, or a walk on a museum, carries none', () => {
    const noEnd = normalizeScanProposal({ ...base, candidates: [stage({ shape: 'point_to_point', km: 13 })] });
    expect(noEnd.ok && noEnd.proposal.candidates[0]!.walk).toBeUndefined();
    const museum = normalizeScanProposal({ ...base, candidates: [stage({ shape: 'loop' }, 'museum')] });
    expect(museum.ok && museum.proposal.candidates[0]!.walk).toBeUndefined();
  });

  it('estimates walking time from distance and ascent, and uses it when the stated time is implausibly short', () => {
    expect(walkingMinutes(13, 1000)).toBe(273);
    const c = { durationMinutes: 90, walk: { shape: 'point_to_point', km: 13, ascentM: 1000 } } as unknown as ScanCandidateProposal;
    expect(walkDuration(c)).toBe(273);
    expect(walkDuration({ ...c, durationMinutes: 300 })).toBe(300);
    expect(walkDuration({ durationMinutes: 90 } as ScanCandidateProposal)).toBe(90);
  });

  it('carries a placed end on the place, and refuses one that is approximate or implausibly far', () => {
    const c = { walk: { shape: 'point_to_point', endName: 'Chikatsuyu', km: 13 } } as unknown as ScanCandidateProposal;
    expect(walkTags(c, at(33.78, 135.45), at(33.81, 135.52))).toEqual(['walk:point_to_point', 'walk-km:13', 'walk-end:33.81000,135.52000', 'walk-end-name:Chikatsuyu']);
    expect(walkTags(c, at(33.78, 135.45), at(33.81, 135.52, true))[0]).toBe('walk:point_to_point_unplaced');
    expect(walkTags(c, at(33.78, 135.45), at(35.0, 135.75))[0]).toBe('walk:point_to_point_unplaced');
    expect(walkTags(c, at(33.78, 135.45), null)[0]).toBe('walk:point_to_point_unplaced');
  });
});
