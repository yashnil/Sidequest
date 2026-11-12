import { describe, expect, it } from 'vitest';
import iceland from './fixtures/iceland-ring-road-2026-11.json';
import { assembleScanRegion, planScanPoints, type ResolvedPosition } from './assemble';
import { normalizeScanProposal } from './proposal';
import { routeCoverage } from './route-coverage';
import { chooseStays, DEFAULT_STAY_TRAVELLER, type MustCoverPart, type StayObjectiveInput, type StayTraveller } from './stay-objective';
import type { TravelTimeMatrixData } from '../schemas/compiled-region';
import { estimateLegMinutes } from '../travel/estimate';

/**
 * ROUTE-SHAPED TRIPS — WHERE TO SLEEP ON A RING ROAD.
 *
 * The Iceland case is the recorded live scan (`fixtures/iceland-ring-road-2026-11.json`):
 * the model's south-coast proposal as placed and timed, and the traveller's own
 * answers. It chose eight nights in Selfoss. The synthetic cases each separate
 * one question: a Highlands loop, a linear rail journey, a compact island.
 */

const DATES = ['2027-06-14', '2027-06-15', '2027-06-16', '2027-06-17', '2027-06-18', '2027-06-19', '2027-06-20', '2027-06-21', '2027-06-22'];
/* The planner's own windows for this trip row (arrival 15:00 + an hour to settle, a normal 09:00 start, a balanced 19:00 end, departure 11:00 less 90 minutes). */
const DAY_MINUTES = [180, 600, 600, 600, 600, 600, 600, 600, 30];

function icelandRegion(options: { route?: boolean; maxBaseChanges?: number; traveller?: Partial<StayTraveller> } = {}) {
  const raw = {
    bases: iceland.bases.map((b) => ({ name: b.name, locality: b.name, nightsHint: b.nightsHint, why: 'A place to sleep on the route.' })),
    candidates: iceland.places.map((p) => ({ name: p.name, locality: 'Iceland', kind: p.kind, tier: p.tier, durationMinutes: p.durationMinutes, intensity: 'easy', costLevel: 1, exposure: 'outdoor', bestTime: 'any', crowd: 'moderate', booking: 'none', rainyDayOk: false, interests: ['scenic_viewpoints'], why: `${p.name} suits the trip.` })),
    foodAreas: [],
    skipped: [],
    package: { transportSummary: 'A hire car.', transportNotes: [], beforeYouGo: [], packing: [], foodStrategy: [], bookingPriorities: [] },
  };
  const normalized = normalizeScanProposal(raw);
  if (!normalized.ok) throw new Error(normalized.reason);
  const proposal = normalized.proposal;
  const recordedIdByName = new Map<string, string>([...iceland.bases.map((b) => [`base:${b.name}`, b.id] as const), ...iceland.places.map((p) => [`place:${p.name}`, p.id] as const)]);
  const coordinatesOf = new Map<string, { lat: number; lng: number }>([...iceland.bases.map((b) => [`base:${b.name}`, b.coordinates] as const), ...iceland.places.map((p) => [`place:${p.name}`, p.coordinates] as const)]);
  const positions = new Map<string, ResolvedPosition | null>();
  for (const b of proposal.bases) positions.set(b.key, { coordinates: coordinatesOf.get(`base:${b.name}`)!, method: 'geocoder', provider: 'test-geocoder', approximate: false });
  for (const c of proposal.candidates) positions.set(c.key, { coordinates: coordinatesOf.get(`place:${c.name}`)!, method: 'places', provider: 'test-places', approximate: false });
  const plan = planScanPoints(proposal, positions);
  /* The recorded matrix, re-indexed by the ids this plan gave the same points. */
  const recordedIndex = new Map(iceland.matrix.ids.map((id, i) => [id, i]));
  const rowOf = (point: (typeof plan.points)[number]) => recordedIndex.get(recordedIdByName.get(`${point.kind}:${point.name}`)!)!;
  const matrix: TravelTimeMatrixData = {
    mode: 'car',
    ids: plan.points.map((p) => p.id),
    minutes: plan.points.map((a) => plan.points.map((b) => iceland.matrix.minutes[rowOf(a)]![rowOf(b)]!)),
    km: plan.points.map((a) => plan.points.map((b) => (a.id === b.id ? 0 : 1))),
    provenance: { kind: 'estimated', note: 'Recorded: 598 of 1190 journeys measured by valhalla; the rest estimated from distance.', source: 'valhalla' },
  };
  return assembleScanRegion({
    regionId: 'scan-iceland-ring-road',
    destinationName: 'Iceland Ring Road',
    entityType: 'natural_region',
    breadth: 'region',
    center: { lat: 64.15, lng: -21.94 },
    countryCode: 'IS',
    timeZone: 'Atlantic/Reykjavik',
    dates: DATES,
    carAvailable: true,
    maxBaseChanges: options.maxBaseChanges ?? 3,
    traveller: { ...(iceland.traveller as Partial<StayTraveller>), ...options.traveller },
    dayMinutes: DAY_MINUTES,
    ...(options.route === false ? {} : { route: { kind: 'loop' as const } }),
    proposal,
    positions,
    plan,
    matrix,
    createdAt: '2026-11-10T19:36:00.000Z',
    providers: { proposal: 'recorded-model', placement: ['test-places'], routing: 'valhalla' },
  }).region;
}

const staysOf = (region: ReturnType<typeof icelandRegion>) => region.basePortfolio!.bases.map((b) => `${b.baseName} ${b.nights}`);

describe('a ring road, from the recorded Iceland scan', () => {
  it('without the route reading it is still the defect: eight nights in one town', () => {
    expect(staysOf(icelandRegion({ route: false }))).toEqual(['Selfoss area 8']);
  });

  it('read as a loop, it sleeps along the coast out to Höfn and back, with every route base within a day of a stay', () => {
    const region = icelandRegion();
    const portfolio = region.basePortfolio!;
    const names = new Set(portfolio.bases.map((b) => b.baseName));
    expect(names.size).toBeGreaterThanOrEqual(3);
    expect(names.has('Hofn / Jokulsarlon area')).toBe(true);
    expect(names.has('Vik i Myrdal')).toBe(true);
    expect(portfolio.bases.reduce((n, b) => n + b.nights, 0)).toBe(8);
    expect(portfolio.decision?.route?.shape).toBe('loop');
    expect(portfolio.decision?.route?.uncovered).toEqual([]);
    /* A loop ends where it began: the last night is back near where the route started, not five hours from the airport road. */
    expect(['Reykjavik', 'Selfoss area']).toContain(portfolio.bases[portfolio.bases.length - 1]!.baseName);
  });

  it('“one base” still wins, and the decision says what it cost the route', () => {
    const region = icelandRegion({ maxBaseChanges: 0 });
    const portfolio = region.basePortfolio!;
    expect(portfolio.bases).toHaveLength(1);
    expect(portfolio.decision?.sentence).toMatch(/as you asked/);
    expect(portfolio.decision?.sentence).toMatch(/cannot follow the whole route: .*Hofn/);
    expect(portfolio.decision?.route?.uncovered).toContain('Hofn / Jokulsarlon area');
  });

  it('the coverage check sees one coast of a loop, not the loop', () => {
    const coverage = routeCoverage({ kind: 'loop', points: [...iceland.bases, ...iceland.places], reachKm: 500 });
    expect(coverage.checked).toBe(true);
    expect(coverage.covered).toBe(false);
    expect(coverage.uncovered).toContain('north');
  });
});

/* ---------------------------------------------------------------------------------------------
 * Synthetic routes: coordinates are real so the estimator's minutes are country-sized
 * ------------------------------------------------------------------------------------------- */

type LL = { lat: number; lng: number };
function routeInput(bases: Record<string, LL>, places: Record<string, LL>, options: { nights: number; mode?: 'drive' | 'rail'; traveller?: Partial<StayTraveller>; maxBaseChanges?: number; route?: 'loop' | 'linear' | 'touring' | null; start?: string; end?: string }): StayObjectiveInput {
  const at = (id: string) => bases[id] ?? places[id]!;
  const mode = options.mode ?? 'drive';
  const minutes = (a: string, b: string) => (a === b ? 0 : Math.round(estimateLegMinutes({ from: at(a), to: at(b), mode })!.minutes));
  const ids = Object.keys(bases);
  const route = options.route === undefined ? 'loop' : options.route;
  const mustCover: MustCoverPart[] = route ? ids.map((id) => ({ name: id, baseIds: [id], anchorId: id })) : [];
  const start = options.start ?? ids[0]!;
  const end = options.end ?? (route === 'linear' ? ids[ids.length - 1]! : start);
  return {
    bases: ids.map((id) => ({ id, name: id })),
    places: Object.keys(places).map((id) => ({ id, durationMinutes: 90, weight: 1 })),
    minutes,
    nights: options.nights,
    maxBaseChanges: options.maxBaseChanges ?? 4,
    traveller: { ...DEFAULT_STAY_TRAVELLER, ...(mode === 'rail' ? { carAvailable: false } : {}), ...options.traveller },
    edges: { fromArrival: (id) => minutes(start, id), toDeparture: (id) => minutes(id, end) },
    ...(route ? { route, mustCover } : {}),
  };
}

const ring = (label: string, c: LL, n: number, km = 12): Record<string, LL> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${label}${i}`, { lat: c.lat + (Math.sin(i * 2.4) * km * (0.4 + (i % 3) * 0.3)) / 111, lng: c.lng + (Math.cos(i * 2.4) * km * (0.4 + (i % 3) * 0.3)) / (111 * Math.cos((c.lat * Math.PI) / 180)) }]));

describe('route-shaped stays on synthetic geometry', () => {
  /* A Highlands loop: from Inverness up the west coast to the far north and back; Skye a detour south-west. */
  const highlands = {
    bases: { inverness: { lat: 57.477, lng: -4.224 }, portree: { lat: 57.413, lng: -6.196 }, ullapool: { lat: 57.895, lng: -5.16 }, durness: { lat: 58.567, lng: -4.745 }, wick: { lat: 58.438, lng: -3.093 } },
  };
  const highlandPlaces = { ...ring('inv', highlands.bases.inverness, 4), ...ring('sky', highlands.bases.portree, 5), ...ring('ull', highlands.bases.ullapool, 4), ...ring('dur', highlands.bases.durness, 3), ...ring('wic', highlands.bases.wick, 3) };

  it('a Highlands loop sleeps along it for somebody who moves with the route', () => {
    const choice = chooseStays(routeInput(highlands.bases, highlandPlaces, { nights: 7, traveller: { moveTolerance: 'move_freely' } }));
    const names = new Set(choice.stays.map((s) => s.baseId));
    expect(names.size).toBeGreaterThanOrEqual(4);
    expect(choice.decision.route?.uncovered).toEqual([]);
  });

  it('the same loop on fewer nights than it has stretches says which stretch it could not sleep along', () => {
    const choice = chooseStays(routeInput(highlands.bases, highlandPlaces, { nights: 3, traveller: { moveTolerance: 'move_if_it_saves_time' } }));
    expect(choice.decision.route?.uncovered.length).toBeGreaterThan(0);
    expect(choice.decision.sentence).toMatch(/cannot follow the whole route/);
  });

  /* A rail journey from one end to the other: Tokyo, Kyoto, Hiroshima. */
  const japan = { tokyo: { lat: 35.69, lng: 139.7 }, kyoto: { lat: 35.0, lng: 135.77 }, hiroshima: { lat: 34.39, lng: 132.46 } };
  const japanPlaces = { ...ring('tky', japan.tokyo, 8, 8), ...ring('kyo', japan.kyoto, 8, 8), ...ring('hir', japan.hiroshima, 4, 10) };

  it('a linear journey by rail sleeps at each end and in the middle, in order', () => {
    const choice = chooseStays(routeInput(japan, japanPlaces, { nights: 9, mode: 'rail', route: 'linear' }));
    expect(choice.stays.map((s) => s.baseId)).toEqual(['tokyo', 'kyoto', 'hiroshima']);
    expect(choice.decision.route?.shape).toBe('linear');
  });

  /* A compact island road trip: three towns half an hour apart. */
  const island = { north: { lat: 28.414, lng: -16.548 }, south: { lat: 28.052, lng: -16.716 }, west: { lat: 28.244, lng: -16.84 } };
  const islandPlaces = { ...ring('n', island.north, 6, 10), ...ring('s', island.south, 5, 10), ...ring('w', island.west, 5, 10) };

  it('a road trip on a compact island still keeps one base: every proposed town is within a day of it', () => {
    const choice = chooseStays(routeInput(island, islandPlaces, { nights: 6, route: 'touring' }));
    expect(choice.stays).toHaveLength(1);
    expect(choice.decision.route?.uncovered).toEqual([]);
  });
});
