import type { CompiledRegion } from '../schemas/compiled-region';
import { assembleScanRegion, estimatedScanMatrix, planScanPoints, type ResolvedPosition } from './assemble';
import { normalizeScanProposal } from './proposal';

/**
 * A STORED SCAN SHAPED LIKE THE PRODUCTION TENERIFE TRIP THAT GOT THREE HOTELS.
 *
 * No local database holds a traveller's trip, so the regression is a fixture
 * with the same shape: one small island, three proposed bases (north, south,
 * west coast towns), sights clustered round each, an estimated drive matrix —
 * and a stored base portfolio of all three, which is what the previous base
 * rule wrote. Coordinates are real so the estimated minutes are island-sized.
 * Test support only; never a rule about the place.
 */
export const TENERIFE_BASES = {
  north: { name: 'Puerto de la Cruz', at: { lat: 28.414, lng: -16.548 } },
  south: { name: 'Los Cristianos', at: { lat: 28.052, lng: -16.716 } },
  west: { name: 'Los Gigantes', at: { lat: 28.244, lng: -16.84 } },
} as const;

const SIGHTS: { name: string; near: keyof typeof TENERIFE_BASES; dLat: number; dLng: number; minutes: number }[] = [
  { name: 'Lago Martianez', near: 'north', dLat: 0.003, dLng: 0.01, minutes: 120 },
  { name: 'Botanical Garden', near: 'north', dLat: -0.004, dLng: 0.006, minutes: 90 },
  { name: 'La Orotava Old Town', near: 'north', dLat: -0.024, dLng: 0.03, minutes: 120 },
  { name: 'Anaga Rural Park', near: 'north', dLat: 0.12, dLng: 0.3, minutes: 240 },
  { name: 'Playa de las Vistas', near: 'south', dLat: 0.0, dLng: 0.005, minutes: 150 },
  { name: 'Montana Roja', near: 'south', dLat: -0.015, dLng: 0.12, minutes: 120 },
  { name: 'Barranco del Infierno', near: 'south', dLat: 0.07, dLng: -0.0, minutes: 180 },
  { name: 'Acantilados de Los Gigantes', near: 'west', dLat: 0.004, dLng: -0.002, minutes: 90 },
  { name: 'Masca Village', near: 'west', dLat: 0.05, dLng: -0.0, minutes: 150 },
  { name: 'Teide National Park', near: 'west', dLat: 0.0, dLng: 0.18, minutes: 300 },
];

export const TENERIFE_DATES = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08', '2026-12-09'];

export function tenerifeStoredScan(regionId = 'scan-tenerife-fixture'): CompiledRegion {
  const raw = {
    bases: (['north', 'south', 'west'] as const).map((k) => ({ name: TENERIFE_BASES[k].name, locality: TENERIFE_BASES[k].name, nightsHint: 3, why: 'A coast town.' })),
    candidates: SIGHTS.map((s, i) => ({ name: s.name, locality: TENERIFE_BASES[s.near].name, kind: 'viewpoint', tier: i % 3 === 0 ? 'hidden_gem' : 'classic', durationMinutes: s.minutes, intensity: 'easy', costLevel: 1, exposure: 'outdoor', bestTime: 'any', crowd: 'moderate', booking: 'none', rainyDayOk: false, interests: ['scenic_viewpoints'], why: `${s.name} suits the trip.` })),
    foodAreas: [],
    skipped: [],
    package: { transportSummary: 'A hire car.', transportNotes: [], beforeYouGo: [], packing: [], foodStrategy: [], bookingPriorities: [] },
  };
  const normalized = normalizeScanProposal(raw);
  if (!normalized.ok) throw new Error(normalized.reason);
  const proposal = normalized.proposal;
  const positions = new Map<string, ResolvedPosition | null>();
  for (const b of proposal.bases) {
    const base = Object.values(TENERIFE_BASES).find((x) => x.name === b.name)!;
    positions.set(b.key, { coordinates: base.at, method: 'geocoder', provider: 'test-geocoder', approximate: false });
  }
  for (const c of proposal.candidates) {
    const sight = SIGHTS.find((s) => s.name === c.name)!;
    const at = TENERIFE_BASES[sight.near].at;
    positions.set(c.key, { coordinates: { lat: at.lat + sight.dLat, lng: at.lng + sight.dLng }, method: 'places', provider: 'test-places', approximate: false });
  }
  const plan = planScanPoints(proposal, positions);
  const matrix = estimatedScanMatrix(plan.points, 'car');
  const assembled = assembleScanRegion({
    regionId,
    destinationName: 'Tenerife',
    entityType: 'island',
    breadth: 'region',
    center: { lat: 28.29, lng: -16.63 },
    countryCode: 'ES',
    timeZone: 'Atlantic/Canary',
    dates: TENERIFE_DATES,
    carAvailable: true,
    maxBaseChanges: 3,
    proposal,
    positions,
    plan,
    matrix,
    createdAt: '2026-11-01T00:00:00.000Z',
    providers: { proposal: 'test-model', placement: ['test-places'], routing: 'estimate' },
  }).region;

  /* What the previous rule stored: all three towns, three nights each. */
  const idOf = (name: string) => assembled.bases.find((b) => b.name === name)!.id;
  const stays: [string, string, string][] = [
    [idOf(TENERIFE_BASES.north.name), '2026-12-01', '2026-12-04'],
    [idOf(TENERIFE_BASES.west.name), '2026-12-04', '2026-12-07'],
    [idOf(TENERIFE_BASES.south.name), '2026-12-07', '2026-12-09'],
  ];
  return {
    ...assembled,
    bases: assembled.bases.map((b, i) => ({ ...b, role: i === 0 ? 'primary_base' : 'secondary_base' })),
    basePortfolio: {
      bases: stays.map(([baseId, fromDate, toDate], order) => ({
        clusterId: `cluster-${baseId}`,
        baseId,
        baseName: assembled.bases.find((b) => b.id === baseId)!.name,
        order,
        nights: Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000),
        fromDate,
        toDate,
        transferMinutesFromPrevious: order === 0 ? 0 : 60,
        transferIsWholeDay: false,
      })),
      excluded: [],
      transferDays: 0,
      rationale: '3 bases in the order that keeps the moves between them shortest, nights in proportion to what is near each.',
    },
  };
}
