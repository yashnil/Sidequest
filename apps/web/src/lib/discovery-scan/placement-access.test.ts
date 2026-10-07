import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleScanRegion, estimatedScanMatrix, normalizeScanProposal, planScanPoints, validateCompiledRegion } from '@sidequest/core';

vi.mock('server-only', () => ({}));
vi.mock('../providers/registry', () => ({ capability: () => ({ configured: false }) }));

/* A fictional valley: the area rows a geocoder gives for routes, and the access rows it gives when asked properly. */
const AREA = { lat: '46.6000', lon: '12.3000', place_rank: 12, category: 'natural', type: 'mountain_range', name: 'Summit Lakes', address: { country_code: 'it' } };
const TRAILHEAD = { lat: '46.6130', lon: '12.2950', place_rank: 30, category: 'highway', type: 'trailhead', name: 'Summit Lakes trailhead', address: { country_code: 'it' } };
const PEAK = { lat: '46.6200', lon: '12.3050', place_rank: 18, category: 'natural', type: 'peak', name: 'Grey Ridge', address: { country_code: 'it' } };
const MUSEUM = { lat: '46.5400', lon: '12.1400', place_rank: 30, category: 'tourism', type: 'museum', name: 'Valley Museum', address: { country_code: 'it' } };
const calls: string[] = [];

vi.mock('../providers/nominatim', () => ({
  geocode: vi.fn(async (query: string) => {
    calls.push(query);
    const q = query.toLowerCase();
    const places = q.startsWith('summit lakes trailhead') ? [TRAILHEAD]
      : q.startsWith('summit lakes') || q.startsWith('quiet lakes') ? [{ ...AREA, name: q.startsWith('quiet') ? 'Quiet Lakes' : 'Summit Lakes' }]
      : q.startsWith('grey ridge') ? [PEAK]
      : q.startsWith('valley museum') ? [MUSEUM]
      : [];
    return { places, calls: 1, cacheHit: false };
  }),
}));

const CENTER = { lat: 46.54, lng: 12.14 };
const options = (extra: Record<string, unknown> = {}) => ({ center: CENTER, maxDistanceKm: 120, countryCode: 'IT', countryName: 'Italy', placesBudget: 0, deadline: () => false, ...extra });
function proposal(candidates: Record<string, unknown>[]) {
  const n = normalizeScanProposal({ bases: [{ name: 'Valley Town', locality: 'Valley Town', nightsHint: 4, why: 'Central.' }], candidates });
  if (!n.ok) throw new Error(n.reason);
  return n.proposal;
}
beforeEach(() => calls.splice(0));

describe('access-point recovery for routes and areas', () => {
  it('an area-level classic hike with a real trailhead is kept, routed from the trailhead, and keeps its own name and footprint', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Summit Lakes loop', locality: 'Upper Valley', kind: 'day_hike', tier: 'classic', why: 'Defining.' }]);
    const result = await placeScanProposal({ ...p, bases: [] }, options());
    const key = p.candidates[0]!.key;
    const position = result.positions.get(key)!;
    expect(position.approximate).toBe(false);
    expect(position.coordinates).toEqual({ lat: 46.613, lng: 12.295 });
    expect(position.accessPoint).toMatchObject({ kind: 'trailhead', provider: 'nominatim', footprint: { lat: 46.6, lng: 12.3 } });
    expect(result.diagnostics.find((d) => d.key === key)?.recovery).toMatchObject({ originalOutcome: 'approximate_only', outcome: 'recovered_access_point' });

    /* Routing uses the access point; the itinerary keeps the activity. */
    const positions = new Map(result.positions);
    positions.set(p.bases[0]!.key, { coordinates: CENTER, method: 'geocoder', provider: 'test', approximate: false });
    const plan = planScanPoints(p, positions);
    const region = validateCompiledRegion(assembleScanRegion({
      regionId: 'r1', destinationName: 'Valley', entityType: 'subregion', breadth: 'subregion', center: CENTER, countryCode: 'IT', timeZone: 'Europe/Rome', dates: ['2027-06-08', '2027-06-09', '2027-06-10'],
      carAvailable: true, maxBaseChanges: 1, proposal: p, positions, plan, matrix: estimatedScanMatrix(plan.points, 'car'), createdAt: '2027-01-01T00:00:00Z',
      providers: { proposal: 'test', placement: ['nominatim'], routing: 'none' },
    } as never).region);
    const place = region.places.find((pl) => pl.name === 'Summit Lakes loop')!;
    expect(place.coordinates).toEqual({ lat: 46.613, lng: 12.295 });
    expect(place.tags).toEqual(expect.arrayContaining(['access:trailhead', 'footprint:46.60000,12.30000']));
    expect(place.source.name).toMatch(/routed from its trailhead/);
  });

  it('with no credible access point the area candidate stays unresolved — never the summit, never the centroid', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Grey Ridge ridge walk', locality: 'Upper Valley', kind: 'day_hike', tier: 'classic', why: 'Defining.' }]);
    const result = await placeScanProposal({ ...p, bases: [] }, options());
    const key = p.candidates[0]!.key;
    const position = result.positions.get(key);
    // The peak answered the name and every access query; it was never promoted.
    expect(position?.accessPoint).toBeUndefined();
    expect(result.diagnostics.find((d) => d.key === key)?.recovery?.outcome).toBe('no_access_point');
    // The summit row is area-level for a route: kept only as an approximate footprint, never as a routing point.
    expect(position?.approximate).toBe(true);
    expect(position?.accessPointUnverified).toBe(true);
    const positions = new Map(result.positions);
    positions.set(p.bases[0]!.key, { coordinates: CENTER, method: 'geocoder', provider: 'test', approximate: false });
    const plan = planScanPoints(p, positions);
    expect(plan.points.some((pt) => pt.key === key)).toBe(false);
    expect(plan.unplaced.find((u) => u.key === key)?.reason).toMatch(/no trailhead, car park or lift could be verified/);
  });

  it('an ordinary POI takes the existing path, with no access queries', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Valley Museum', locality: 'Valley Town', kind: 'museum', tier: 'classic', why: 'History.' }]);
    const result = await placeScanProposal({ ...p, bases: [] }, options());
    expect(result.positions.get(p.candidates[0]!.key)?.accessPoint).toBeUndefined();
    expect(calls).toEqual(['Valley Museum, Valley Town, Italy']);
  });

  it('a hike the traveller named is searched for even when it is not a classic; a low-value one is not', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Summit Lakes loop', locality: 'Upper Valley', kind: 'day_hike', tier: 'hidden_gem', why: 'Named.' }]);
    const named = await placeScanProposal({ ...p, bases: [] }, options({ namedByTraveller: ['Summit Lakes loop'] }));
    expect(named.positions.get(p.candidates[0]!.key)?.accessPoint?.kind).toBe('trailhead');

    calls.splice(0);
    const q = proposal([{ name: 'Quiet Lakes loop', locality: 'Upper Valley', kind: 'day_hike', tier: 'hidden_gem', why: 'Nice.' }]);
    const lowValue = await placeScanProposal({ ...q, bases: [] }, options());
    expect(lowValue.diagnostics[0]?.recovery).toBeUndefined();
    expect(calls.some((c) => /trailhead|parking|cable car/.test(c))).toBe(false);
  });
});

describe('the lookup name placement asks for', () => {
  it('asks for the place, not the recommendation, and records what it asked', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Valley Museum traditional lunch stop', locality: 'Valley Town', kind: 'museum', tier: 'classic', why: 'History.' }]);
    const result = await placeScanProposal({ ...p, bases: [] }, options());
    expect(calls[0]).toBe('Valley Museum, Valley Town, Italy');
    expect(result.positions.get(p.candidates[0]!.key)?.coordinates).toEqual({ lat: 46.54, lng: 12.14 });
    expect(result.diagnostics[0]).toMatchObject({ name: 'Valley Museum traditional lunch stop', identity: { original: 'Valley Museum traditional lunch stop', lookupName: 'Valley Museum', type: 'descriptive_suffix_removed', query: 'Valley Museum, Valley Town, Italy' } });
  });

  it('a route is looked up at its start', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Valley Museum to Grey Ridge sunset viewpoint', locality: 'Valley Town', kind: 'viewpoint', tier: 'classic', why: 'Views.' }]);
    const result = await placeScanProposal({ ...p, bases: [] }, options());
    expect(calls[0]).toBe('Valley Museum, Valley Town, Italy');
    expect(result.diagnostics[0]?.identity).toMatchObject({ lookupName: 'Valley Museum', type: 'route_anchor' });
  });

  it('two places joined are asked for as written, never as one of them', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Valley Museum and Grey Ridge view', locality: 'Valley Town', kind: 'landmark', tier: 'classic', why: 'Both.' }]);
    const result = await placeScanProposal({ ...p, bases: [] }, options());
    expect(calls.every((c) => c.startsWith('Valley Museum and Grey Ridge view'))).toBe(true);
    // The geocoder answered with one of the two; that is a guess, refused as a typed outcome.
    expect(result.positions.get(p.candidates[0]!.key)).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ outcome: 'partial_identity', identity: { type: 'ambiguous' } });
    expect(calls.some((c) => /trailhead|parking|cable car/.test(c))).toBe(false);
  });

  it('a lower-tier hike the traveller selected gets recovery; a low-value area candidate spends nothing', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Summit Lakes easy walk', locality: 'Upper Valley', kind: 'easy_walk', tier: 'side_quest', why: 'Picked.' }]);
    const picked = await placeScanProposal({ ...p, bases: [] }, options({ namedByTraveller: ['Summit Lakes easy walk'] }));
    expect(picked.diagnostics[0]?.recovery?.outcome).toBe('recovered_access_point');

    calls.splice(0);
    const q = proposal([{ name: 'Quiet Lakes easy walk', locality: 'Upper Valley', kind: 'easy_walk', tier: 'side_quest', why: 'Filler.', interests: ['photography'] }]);
    const low = await placeScanProposal({ ...q, bases: [] }, options({ priorities: ['hiking_and_trails'] }));
    expect(low.diagnostics[0]?.recovery).toBeUndefined();
    expect(calls.some((c) => /trailhead|parking|cable car/.test(c))).toBe(false);
  });

  it('a hidden-gem hike serving the traveller\'s priority interests earns recovery without being named', async () => {
    const { placeScanProposal } = await import('./placement');
    const p = proposal([{ name: 'Summit Lakes loop', locality: 'Upper Valley', kind: 'day_hike', tier: 'hidden_gem', why: 'Fits.' }]);
    const interests = p.candidates[0]!.interests;
    const result = await placeScanProposal({ ...p, bases: [] }, options({ priorities: interests }));
    expect(result.diagnostics[0]?.recovery?.outcome).toBe('recovered_access_point');
  });
});
