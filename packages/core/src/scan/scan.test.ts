import { describe, expect, it } from 'vitest';
import { autoSelect } from '../discovery/autoselect';
import { buildDiscoveryBoard } from '../discovery/board';
import { buildTravelerProfile, defaultAnswers } from '../index';
import { validateCompiledRegion } from '../region/source';
import { unavailableWeatherDataset } from '../weather/snapshot';
import { assembleScanRegion, chooseScanBases, estimatedScanMatrix, planScanPoints, type ResolvedPosition } from './assemble';
import { normalizeScanProposal, type ScanProposal } from './proposal';
import { scanSufficiency } from './sufficiency';
import { edgeTransferCost, orderBasesForEdges, type TripEdges } from './assemble';

/*
 * A fictional coast — no real destination is named in the fixture, so nothing
 * here can quietly become a rule about a real place. Two clusters of things to
 * do, ~120 km apart, and a third proposed base nobody needs.
 */
const NORTH = { lat: 44.0, lng: 8.0 };
const SOUTH = { lat: 43.0, lng: 8.4 };

function rawProposal(): unknown {
  const north = ['Harbour Lighthouse', 'Old Fort', 'Cliff Path', 'Fish Market', 'Chapel of the Sea', 'Tide Pools', 'Upper Town', 'Salt Museum'];
  const south = ['Gorge Trail', 'Hot Pools', 'Lagoon Boat Trip', 'Ridge Viewpoint', 'Cork Forest Walk', 'Hill Village'];
  return {
    bases: [
      { name: 'Northport', locality: 'Northport', nightsHint: 3, why: 'The harbour town with the most to do on foot.' },
      { name: 'Southbay', locality: 'Southbay', nightsHint: 3, why: 'Gateway to the gorge country.' },
      { name: 'Midvale', locality: 'Midvale', nightsHint: 1, why: 'Halfway.' },
    ],
    candidates: [
      ...north.map((name, i) => ({ name, locality: 'Northport', kind: i === 1 ? 'castle_or_palace' : i === 3 ? 'market' : i === 7 ? 'museum' : i === 2 ? 'easy_walk' : 'viewpoint', tier: i % 3 === 0 ? 'hidden_gem' : 'classic', durationMinutes: 90, intensity: 'easy', costLevel: 1, exposure: i === 7 ? 'indoor' : 'outdoor', bestTime: i === 0 ? 'sunset' : 'any', crowd: 'moderate', booking: 'none', rainyDayOk: i === 7, interests: ['scenic_viewpoints'], why: `${name} suits a slow coastal day.` })),
      ...south.map((name, i) => ({ name, locality: 'Southbay', kind: i === 0 ? 'day_hike' : i === 1 ? 'hot_spring' : i === 2 ? 'boat_trip' : 'viewpoint', tier: 'classic', durationMinutes: i === 0 ? 240 : 90, intensity: i === 0 ? 'strenuous' : 'easy', costLevel: 1, exposure: 'outdoor', bestTime: 'morning', crowd: 'quiet', booking: i === 2 ? 'recommended' : 'none', rainyDayOk: false, interests: i === 0 ? ['hiking'] : ['scenic_viewpoints'], why: `${name} is the reason to come south.` })),
      { name: 'Nameless Thing', locality: '' },
      { name: 'Hidden Bakery', locality: 'Northport', kind: 'not-a-kind', tier: 'classic' },
    ],
    foodAreas: [{ name: 'Harbour front', locality: 'Northport', specialty: 'grilled fish', why: 'Where the boats land.' }],
    skipped: [{ name: 'Mega Waterpark', reason: 'Loud and crowded; nothing you asked for.' }],
    package: { transportSummary: 'A hire car; the two halves are a two-hour drive apart.', transportNotes: [], beforeYouGo: ['Book the lagoon boat.'], packing: ['Hiking shoes'], foodStrategy: [], bookingPriorities: ['Lagoon boat trip'] },
  };
}

function positionsFor(proposal: ScanProposal): Map<string, ResolvedPosition | null> {
  const positions = new Map<string, ResolvedPosition | null>();
  const offset = (centre: { lat: number; lng: number }, i: number) => ({ lat: centre.lat + ((i % 4) - 1.5) * 0.02, lng: centre.lng + (Math.floor(i / 4) - 1) * 0.03 });
  proposal.bases.forEach((b) => {
    const centre = b.name === 'Northport' ? NORTH : b.name === 'Southbay' ? SOUTH : { lat: 43.5, lng: 8.2 };
    positions.set(b.key, { coordinates: centre, method: 'geocoder', provider: 'test-geocoder', approximate: false });
  });
  proposal.candidates.forEach((c, i) => {
    if (c.name === 'Hidden Bakery') {
      positions.set(c.key, { coordinates: NORTH, method: 'locality', provider: 'test-geocoder', approximate: true });
      return;
    }
    positions.set(c.key, { coordinates: offset(c.locality === 'Northport' ? NORTH : SOUTH, i), method: 'geocoder', provider: 'test-geocoder', approximate: false });
  });
  return positions;
}

const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'];

function assemble(maxBaseChanges = 2) {
  const normalized = normalizeScanProposal(rawProposal());
  if (!normalized.ok) throw new Error(normalized.reason);
  const proposal = normalized.proposal;
  const positions = positionsFor(proposal);
  const plan = planScanPoints(proposal, positions);
  const matrix = estimatedScanMatrix(plan.points, 'car');
  const assembly = assembleScanRegion({
    regionId: 'scan-test-coast',
    destinationName: 'The Test Coast',
    entityType: 'natural_region',
    breadth: 'region',
    center: { lat: 43.5, lng: 8.2 },
    countryCode: 'IT',
    timeZone: 'Europe/Rome',
    dates: DATES,
    carAvailable: true,
    maxBaseChanges,
    proposal,
    positions,
    plan,
    matrix,
    createdAt: '2026-08-01T00:00:00.000Z',
    providers: { proposal: 'test-model', placement: ['test-geocoder'], routing: 'estimate' },
  });
  return { normalized, proposal, plan, assembly };
}

describe('discovery scan — proposal', () => {
  it('drops what cannot be placed, coerces off-vocabulary values and records both', () => {
    const normalized = normalizeScanProposal(rawProposal());
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.dropped.map((d) => d.name)).toEqual(['Nameless Thing']);
    expect(normalized.coerced).toContain(`candidates[${normalized.proposal.candidates.length}].kind`);
    expect(normalized.proposal.candidates.find((c) => c.name === 'Hidden Bakery')?.kind).toBe('landmark');
  });

  it('refuses a proposal with no base or no candidate rather than inventing one', () => {
    expect(normalizeScanProposal({ candidates: [], bases: [{ name: 'X' }] }).ok).toBe(false);
    expect(normalizeScanProposal({ candidates: [{ name: 'A', locality: 'B' }], bases: [] }).ok).toBe(false);
  });
});

describe('discovery scan — region assembly', () => {
  it('produces a region that passes the integrity gate', () => {
    const { assembly } = assemble();
    expect(() => validateCompiledRegion(assembly.region)).not.toThrow();
  });

  it('leaves an approximate point-like place off the map, with a reason', () => {
    const { plan } = assemble();
    expect(plan.unplaced.find((u) => u.name === 'Hidden Bakery')?.reason).toMatch(/town/);
  });

  it('chooses two bases in route order and gives the unneeded third none', () => {
    const { assembly } = assemble();
    const portfolio = assembly.region.basePortfolio!;
    expect(portfolio.bases.map((b) => b.baseName)).toEqual(['Northport', 'Southbay']);
    expect(portfolio.bases.reduce((n, b) => n + b.nights, 0)).toBe(DATES.length - 1);
    expect(portfolio.bases[0]!.nights).toBeGreaterThanOrEqual(portfolio.bases[1]!.nights);
    expect(portfolio.excluded.map((e) => e.name)).toEqual(['Midvale']);
    expect(portfolio.bases[1]!.transferMinutesFromPrevious).toBeGreaterThan(60);
  });

  it('keeps one base when the traveller asked not to move', () => {
    const { assembly } = assemble(0);
    expect(assembly.region.basePortfolio!.bases).toHaveLength(1);
    expect(assembly.region.basePortfolio!.excluded.every((e) => /one place/.test(e.reason))).toBe(true);
  });

  it('marks every soft attribute as an estimate and never claims hours it does not have', () => {
    const { assembly } = assemble();
    for (const place of assembly.region.places) {
      expect(place.estimatedDefaults).toEqual(expect.arrayContaining(['access', 'crowd_level', 'cost_level']));
    }
    const museum = assembly.region.operatingHours.calendars.find((c) => assembly.region.places.find((p) => p.id === c.placeId)?.name === 'Salt Museum');
    expect(museum?.kind).toBe('unknown');
    expect(assembly.region.travelTimes.provenance.kind).toBe('estimated');
  });

  it('feeds the Discovery Board and Auto-pick like any compiled region', () => {
    const { assembly } = assemble();
    const region = assembly.region;
    const context = { travelerNeeds: [], tripDays: DATES.length };
    const answers = defaultAnswers(context);
    const profile = buildTravelerProfile({ ...answers, interests: { ...answers.interests, scenic_viewpoints: 'core', hiking: 'frequent', history_and_culture: 'frequent', museums_and_galleries: 'occasional' } }, context);
    const board = buildDiscoveryBoard({
      region: region.region,
      places: region.places,
      profile,
      months: [9],
      dates: DATES,
      access: region.access,
      hours: region.operatingHours,
      weather: unavailableWeatherDataset({ regionId: region.region.id, locations: region.weatherLocations, dates: DATES, now: new Date('2026-08-01T00:00:00Z'), reason: 'not_configured', message: 'none' }),
      travelerNeeds: [],
      travel: { matrix: region.travelTimes, baseId: region.primaryBaseId, baseIds: region.basePortfolio!.bases.map((b) => b.baseId) },
    });
    expect(board.candidates.length).toBeGreaterThanOrEqual(10);
    const picked = autoSelect({ candidates: board.candidates, profile, tripDays: DATES.length });
    expect(picked.selectedIds.length).toBeGreaterThan(5);
    // Both halves of a two-base trip are reachable: the board measures each place from the base it is visited from.
    const southern = region.places.filter((p) => p.locality === 'Southbay').map((p) => p.id);
    expect(picked.selectedIds.some((id) => southern.includes(id))).toBe(true);
  });
});

describe('discovery scan — base choice', () => {
  it('never allocates more nights than the trip has, nor fewer than one per kept base', () => {
    const bases = ['a', 'b', 'c'].map((id, i) => ({ id, proposal: { key: id, name: id, locality: id, nightsHint: i + 1, why: '' } }));
    const minutes = (x: string, y: string) => (x === y ? 0 : 120);
    for (const nights of [1, 2, 3, 5, 9, 14]) {
      const choice = chooseScanBases({ bases, places: [], minutes, nights, maxBaseChanges: 5 });
      expect(choice.kept.reduce((n, k) => n + k.nights, 0)).toBe(nights);
      expect(choice.kept.every((k) => k.nights >= 1)).toBe(true);
    }
  });
});

describe('discovery scan — car-free geography', () => {
  it('times a long car-free base transfer as public transport, never as a walk', () => {
    const normalized = normalizeScanProposal(rawProposal());
    if (!normalized.ok) throw new Error(normalized.reason);
    const proposal = normalized.proposal;
    const positions = positionsFor(proposal);
    const plan = planScanPoints(proposal, positions);
    const matrix = estimatedScanMatrix(plan.points, 'foot');
    const assembly = assembleScanRegion({
      regionId: 'scan-test-carfree', destinationName: 'The Test Coast', entityType: 'natural_region', breadth: 'region', center: { lat: 43.5, lng: 8.2 }, timeZone: 'Europe/Rome',
      dates: DATES, carAvailable: false, maxBaseChanges: 2, proposal, positions, plan, matrix, createdAt: '2026-08-01T00:00:00.000Z', providers: { proposal: 'test', placement: ['test'], routing: 'estimate' },
    });
    const second = assembly.region.basePortfolio!.bases[1];
    expect(second).toBeDefined();
    // ~115 km apart: hours by train, not a day's walk.
    expect(second!.transferMinutesFromPrevious).toBeLessThan(300);
    expect(assembly.region.travelTimes.mode).toBe('foot');
  });
});

describe('base names', () => {
  it('a trailing bracketed aside is a note about the route, not part of the place name', () => {
    const raw = rawProposal() as { bases: { name: string }[] };
    raw.bases[0]!.name = `${raw.bases[0]!.name} (return)`;
    const normalized = normalizeScanProposal(raw);
    if (!normalized.ok) throw new Error(normalized.reason);
    expect(normalized.proposal.bases[0]!.name).not.toMatch(/\(return\)/);
  });
});

describe('scan sufficiency', () => {
  const place = (kind: string, interests: string[] = []) => ({ kind, interests: interests as never[] });
  it('four places for a six-day trip is thin; the need scales with days and pace, never above what was requested', () => {
    const thin = scanSufficiency({ days: 6, stopsPerDay: 2, requested: 24, placed: [place('museum'), place('temple'), place('market'), place('park')], priorities: [] });
    expect(thin.sufficient).toBe(false);
    expect(thin.reasons).toContain('too_few_places');
    expect(thin.needed).toBe(12);
    const long = scanSufficiency({ days: 14, stopsPerDay: 3, requested: 36, placed: [], priorities: [] });
    expect(long.needed).toBe(36);
    const short = scanSufficiency({ days: 2, stopsPerDay: 2, requested: 18, placed: [], priorities: [] });
    expect(short.needed).toBe(6);
  });

  it('enough places of one kind is still too little variety; an uncovered priority is reported but does not fail the board', () => {
    const same = scanSufficiency({ days: 3, stopsPerDay: 2, requested: 18, placed: Array.from({ length: 10 }, () => place('museum', ['museums_and_galleries'])), priorities: ['hiking'] as never[] });
    expect(same.sufficient).toBe(false);
    expect(same.reasons).toEqual(['too_little_variety', 'priority_uncovered']);
    const varied = scanSufficiency({ days: 3, stopsPerDay: 2, requested: 18, placed: ['museum', 'temple', 'market', 'park', 'viewpoint', 'museum'].map((k) => place(k)), priorities: ['hiking'] as never[] });
    expect(varied.sufficient).toBe(true);
    expect(varied.missingInterests).toEqual(['hiking']);
  });
});

describe('arrival and departure shape the base order (V1)', () => {
  /* G sits by the airport; F is two hours away. */
  const minutes = (a: string, b: string) => (a === b ? 0 : 120);
  const edges = (arrivalUsableMinutes: number, departureUsableMinutes: number): TripEdges => ({
    fromArrival: (id) => (id === 'G' ? 10 : 120),
    toDeparture: (id) => (id === 'G' ? 10 : 120),
    arrivalUsableMinutes,
    departureUsableMinutes,
  });

  it('an early arrival may go straight on: no split stay, the far base can come first', () => {
    const out = orderBasesForEdges(['G', 'F'], minutes, edges(750, 600), 2, 4);
    expect(out.splitStay).toBe(false);
  });

  it('a mid-afternoon arrival with a morning flight out sleeps by the airport at both ends', () => {
    const out = orderBasesForEdges(['F', 'G'], minutes, edges(270, 0), 2, 4);
    expect(out).toEqual({ order: ['G', 'F', 'G'], splitStay: true });
  });

  it('a late-night arrival never starts with the long transfer', () => {
    const out = orderBasesForEdges(['F', 'G'], minutes, edges(0, 600), 2, 4);
    expect(out.order[0]).toBe('G');
  });

  it('a traveller who will move only once never gets the extra move, and too few nights never split', () => {
    expect(orderBasesForEdges(['F', 'G'], minutes, edges(270, 0), 1, 4).splitStay).toBe(false);
    expect(orderBasesForEdges(['F', 'G'], minutes, edges(270, 0), 2, 2).splitStay).toBe(false);
  });

  it('an edge-day transfer costs more the less of the day there is, and nothing when it is short', () => {
    expect(edgeTransferCost(15, 100)).toBe(0);
    expect(edgeTransferCost(120, 750)).toBeLessThan(edgeTransferCost(120, 270));
    expect(edgeTransferCost(120, 270)).toBeGreaterThan(120 + 180 - 1);
  });
});

describe('the same base proposed twice (live Hanoi finding)', () => {
  it('is one base; the second proposal maps onto the first and is recorded as a duplicate', () => {
    const raw = rawProposal() as { bases: { name: string; locality: string }[] };
    raw.bases.push({ ...raw.bases[0]!, name: `${raw.bases[0]!.name} (return)` });
    const normalized = normalizeScanProposal(raw);
    if (!normalized.ok) throw new Error(normalized.reason);
    const proposal = normalized.proposal;
    const positions = positionsFor(proposal);
    const first = proposal.bases[0]!;
    const again = proposal.bases[proposal.bases.length - 1]!;
    positions.set(again.key, positions.get(first.key)!);
    const plan = planScanPoints(proposal, positions);
    expect(plan.baseIdByKey.get(again.key)).toBe(plan.baseIdByKey.get(first.key));
    expect(plan.points.filter((p) => p.kind === 'base')).toHaveLength(proposal.bases.length - 1);
    expect(plan.unplaced.find((u) => u.key === again.key)?.code).toBe('duplicate');
  });
});
