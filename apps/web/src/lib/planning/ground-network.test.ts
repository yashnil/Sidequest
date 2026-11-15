import { describe, expect, it, vi } from 'vitest';
import { assembleScanRegion, estimatedScanMatrix, normalizeScanProposal, planScanPoints, type DiscoveryCandidate, type ResolvedPosition, type Trip } from '@sidequest/core';
import { carFreeMoveFor, composeWithPlanner } from './planner-composer';
import { defaultProfileFor } from './default-profile';
import type { RegionContext } from '../region';
import { reconcileTripDraft } from './reconcile';
import { draftOf, fictionalWorld } from './acceptance/harness';

/**
 * TRANSPORT INFRASTRUCTURE APPLIES PER PIECE OF GROUND, NOT PER COUNTRY.
 *
 * Live "levada hiking" on an Atlantic island region of a country whose
 * mainland runs intercity trains printed "≈50 min train · ~13 km" and
 * "Public transport first". These boards are synthetic — invented names on
 * real coordinates, because the network rows are keyed by land — and every
 * case runs the scan assembler and then the planner, car-free. Nothing in
 * the code under test names a place; the ISO code and the coordinates decide.
 */

vi.mock('server-only', () => ({}));

type Spot = { name: string; at: { lat: number; lng: number }; kind?: string; minutes?: number };

const DATES = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];

function board(input: { countryCode: string; timeZone: string; regionCode?: string; bases: Spot[]; places: Spot[] }) {
  const raw = {
    bases: input.bases.map((b) => ({ name: b.name, locality: b.name, nightsHint: 3, why: 'A town to sleep in.' })),
    candidates: input.places.map((p, i) => ({
      name: p.name,
      locality: input.bases[i % input.bases.length]!.name,
      kind: p.kind ?? 'viewpoint',
      tier: i % 3 === 0 ? 'classic' : 'side_quest',
      durationMinutes: p.minutes ?? 120,
      intensity: 'moderate',
      costLevel: 0,
      exposure: 'outdoor',
      bestTime: 'any',
      crowd: 'quiet',
      booking: 'none',
      rainyDayOk: false,
      interests: [(['hiking', 'history_and_culture', 'scenic_viewpoints', 'food_and_towns', 'easy_nature_walks'] as const)[i % 5]],
      why: 'A good walk.',
    })),
    foodAreas: [],
    skipped: [],
    package: { transportSummary: '', transportNotes: [], beforeYouGo: [], packing: [], foodStrategy: [], bookingPriorities: [] },
  };
  const normalized = normalizeScanProposal(raw);
  if (!normalized.ok) throw new Error(normalized.reason);
  const proposal = normalized.proposal;
  const positions = new Map<string, ResolvedPosition | null>();
  for (const b of proposal.bases) positions.set(b.key, { coordinates: input.bases.find((x) => x.name === b.name)!.at, method: 'geocoder', provider: 'test-geocoder', approximate: false });
  proposal.candidates.forEach((c, i) => positions.set(c.key, { coordinates: input.places[i]!.at, method: 'places', provider: 'test-places', approximate: false }));
  const plan = planScanPoints(proposal, positions);
  const assembled = assembleScanRegion({
    regionId: 'scan-ground-network',
    destinationName: 'A test region',
    entityType: 'state_or_province',
    breadth: 'region',
    center: input.bases[0]!.at,
    countryCode: input.countryCode,
    ...(input.regionCode ? { regionCode: input.regionCode } : {}),
    timeZone: input.timeZone,
    dates: DATES,
    carAvailable: false,
    maxBaseChanges: 2,
    traveller: { carAvailable: false, pace: 'balanced', maxDailyTravelMinutes: 240, stopsPerDay: 3, moveTolerance: 'move_if_it_saves_time' },
    proposal,
    positions,
    plan,
    matrix: estimatedScanMatrix(plan.points, 'foot'),
    createdAt: '2026-09-01T00:00:00.000Z',
    providers: { proposal: 'test-model', placement: ['test-places'], routing: 'estimate' },
  });
  const compiled = assembled.region;
  const trip = {
    id: 'ground-network-trip',
    basics: { mode: 'known_destination', destinationInput: 'A test region', regionId: 'dynamic', startDate: DATES[0]!, endDate: DATES[DATES.length - 1]!, arrivalTime: '10:00', departureTime: '17:00', adults: 2, children: 0, travelerNeeds: [] },
    status: 'draft',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  } as unknown as Trip;
  const region = { region: compiled.region, places: compiled.places, access: compiled.access, hours: compiled.operatingHours, weather: null, food: null, matrix: compiled.travelTimes, transit: undefined, scheduledNetwork: null, baseId: compiled.bases.find((b) => b.id === compiled.primaryBaseId)!.routingId, basePortfolio: compiled.basePortfolio, months: [10], dates: [...DATES], compiled } as unknown as RegionContext;
  const candidates = compiled.places.map((place) => ({ place, fit: { score: 80, blockers: [] } }) as unknown as DiscoveryCandidate);
  const composed = composeWithPlanner({ trip, profile: defaultProfileFor(trip, null), region, candidates, selections: [], extras: null, destinationName: 'A test region', carAvailable: false, maxDailyTravelMinutes: 240 });
  const draft = composed.draft;
  const words = [...draft.days.flatMap((d) => d.anchors.map((a) => a.transport)), ...draft.days.flatMap((d) => (d.move ? [d.move.how] : []))];
  return { draft, words, composed, compiled };
}

const RAIL = ['rail', 'metro', 'high_speed_rail'];

/* An Atlantic island region: two towns and places spread across the island, 5–30 km apart. */
const islandBases: Spot[] = [
  { name: 'Harbour Town', at: { lat: 32.648, lng: -16.908 } },
  { name: 'West Cove', at: { lat: 32.72, lng: -17.18 } },
];
const islandPlaces: Spot[] = [
  { name: 'High Peak Viewpoint', at: { lat: 32.735, lng: -16.928 } },
  { name: 'Laurel Levada', at: { lat: 32.76, lng: -16.98 }, kind: 'day_hike', minutes: 240 },
  { name: 'Eastern Cape Walk', at: { lat: 32.745, lng: -16.7 }, kind: 'day_hike', minutes: 210 },
  { name: 'Cliff Village', at: { lat: 32.67, lng: -17.0 } },
  { name: 'Waterfall Valley', at: { lat: 32.79, lng: -17.06 }, kind: 'waterfall' },
  { name: 'Lava Pools', at: { lat: 32.865, lng: -17.17 }, kind: 'beach' },
  { name: 'Plateau Moor', at: { lat: 32.75, lng: -17.12 }, kind: 'day_hike', minutes: 180 },
  { name: 'North Gorge', at: { lat: 32.82, lng: -16.89 } },
];

describe('an island region off its country\'s railway', () => {
  for (const variant of [{ label: 'with its ISO 3166-2 code', regionCode: 'PT-30' }, { label: 'with no code (inferred from coordinates)' }]) {
    it(`never names a train or a metro, and moves by taxi and transfer where the row says buses are thin — ${variant.label}`, () => {
      const { draft, words } = board({ countryCode: 'PT', timeZone: 'Atlantic/Madeira', ...('regionCode' in variant ? { regionCode: variant.regionCode } : {}), bases: islandBases, places: islandPlaces });
      expect(words.length).toBeGreaterThan(0);
      for (const r of RAIL) expect(words).not.toContain(r);
      expect(words).not.toContain('bus');
      expect(words).toContain('taxi');
      expect(draft.driving).toBe('taxi_rideshare');
      expect(draft.archetype).not.toBe('rail_route');
      expect(draft.package.transport.summary).not.toMatch(/^Public transport first/);
      expect(draft.package.transport.summary).toMatch(/^Taxis and arranged transfers/);
    });
  }
});

describe('the mainland keeps its trains', () => {
  it('a car-free Lisbon–Porto move is a train', () => {
    expect(carFreeMoveFor({ lat: 38.72, lng: -9.14 }, { lat: 41.15, lng: -8.61 }, 'PT')?.how).toBe('rail');
    expect(carFreeMoveFor({ lat: 32.648, lng: -16.908 }, { lat: 32.72, lng: -17.18 }, 'PT')?.how).toBe('bus');
    expect(carFreeMoveFor({ lat: 38.72, lng: -9.14 }, { lat: 41.15, lng: -8.61 }, 'PT', [], 'PT-30')?.how).toBe('bus');
  });

  it('a mainland board rides the country\'s trains for its longer car-free hops', () => {
    const { draft, words } = board({
      countryCode: 'PT',
      timeZone: 'Europe/Lisbon',
      bases: [
        { name: 'Capital', at: { lat: 38.72, lng: -9.14 } },
        { name: 'Northern City', at: { lat: 41.15, lng: -8.61 } },
      ],
      places: [
        { name: 'Old Quarter', at: { lat: 38.713, lng: -9.13 }, kind: 'neighbourhood' },
        { name: 'River Palace', at: { lat: 38.697, lng: -9.206 }, kind: 'castle_or_palace' },
        { name: 'Hill Gardens', at: { lat: 38.79, lng: -9.39 }, kind: 'park_or_garden' },
        { name: 'Wine Quay', at: { lat: 41.138, lng: -8.613 }, kind: 'market' },
        { name: 'Ocean Fort', at: { lat: 41.15, lng: -8.68 }, kind: 'historic_site' },
        { name: 'Bridge Walk', at: { lat: 41.14, lng: -8.61 }, kind: 'easy_walk' },
        { name: 'Art Museum', at: { lat: 38.705, lng: -9.16 }, kind: 'museum' },
        { name: 'Tile Station', at: { lat: 41.146, lng: -8.61 }, kind: 'landmark' },
        { name: 'Coast Town', at: { lat: 39.11, lng: -9.28 }, kind: 'small_town' },
        { name: 'Walled Town', at: { lat: 38.57, lng: -7.91 }, kind: 'small_town' },
      ],
    });
    /* The coast town ~45 km out is a train from the capital; the same board on the island would never be. */
    expect(words).toContain('rail');
    expect(draft.driving).toBe('none');
  });

  it('Tokyo–Kyoto keeps the high-speed backbone', () => {
    expect(carFreeMoveFor({ lat: 35.68, lng: 139.76 }, { lat: 35.01, lng: 135.77 }, 'JP')?.how).toBe('high_speed_rail');
    /* Hokkaido has trains, not that backbone. */
    expect(carFreeMoveFor({ lat: 43.06, lng: 141.35 }, { lat: 43.77, lng: 142.36 }, 'JP')?.how).toBe('rail');
    /* Okinawa has no railway. */
    expect(carFreeMoveFor({ lat: 26.21, lng: 127.68 }, { lat: 26.59, lng: 127.98 }, 'JP')?.how).toBe('bus');
  });
});

describe('the reconciler screens every leg against the ground under it', () => {
  async function legOf(points: { name: string; lat: number; lng: number; entityType?: 'city' }[]) {
    const world = fictionalWorld({ name: 'Groundland', center: { lat: points[0]!.lat, lng: points[0]!.lng }, countryCode: 'PT', places: points, basics: { startDate: '2026-05-01', endDate: '2026-05-02' } });
    const draft = draftOf({ bases: [{ id: 'b', name: points[0]!.name, nights: 1 }], days: [{ base: 'b', anchors: [{ name: points[1]!.name, category: 'viewpoint', transport: 'rail' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    return result.itinerary.days[0]!.items.find((i) => i.kind === 'travel' && i.travel?.toName === points[1]!.name)!.travel!;
  }

  it('a train hint between two island points is refused: never a rail leg, the hint dropped, the correction recorded', async () => {
    const travel = await legOf([
      { name: 'Harbour Town', lat: 32.648, lng: -16.908, entityType: 'city' },
      { name: 'High Peak Viewpoint', lat: 32.735, lng: -16.928 },
    ]);
    expect(travel.mode).not.toBe('rail');
    expect(travel.hint).toBeUndefined();
    expect(travel.modeCorrectedFrom).toBe('rail');
  });

  it('the same hint on the mainland stands', async () => {
    const travel = await legOf([
      { name: 'Capital', lat: 38.72, lng: -9.14, entityType: 'city' },
      { name: 'Coast Town', lat: 39.11, lng: -9.28 },
    ]);
    expect(travel.mode).toBe('rail');
    expect(travel.hint).toBe('rail');
  });
});
