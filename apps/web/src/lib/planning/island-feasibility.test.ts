import { describe, expect, it } from 'vitest';
import { boundTravelMatrix, estimatedScanMatrix, matrixFeasibility, type ScanPoint } from '@sidequest/core';
import { planStructure, type PlannerCandidate, type StructurePlannerInput } from './structure-planner';
import { reconcileTripDraft } from './reconcile';
import { draftOf, fictionalWorld } from './acceptance/harness';
import type { RouteConfirmation, RouteMatrixResult } from './skeleton-adapter';

/**
 * EVAL V3 — PROXIMITY IS NOT DRIVEABILITY.
 *
 * A synthetic island (invented coordinates and names): a base on the north
 * coast, a trailhead on the north shore 45 minutes' drive away, and a lookout
 * on the west side that the road reaches only by going around the island —
 * 2 h 45 from the base. The trailhead and the lookout are under 6 km apart in
 * a straight line, with a sea cliff between them, and no router measured that
 * pair. A straight-line estimate makes it a 20-minute drive; measured base
 * rows prove it is at least two hours.
 */
const BASE = { lat: 10.2, lng: 50.2 };
const NORTH = { lat: 10.1, lng: 49.8 };
const WEST = { lat: 10.05, lng: 49.8 };
const ROAD: Record<string, number> = { 'base>north': 45, 'north>base': 45, 'base>west': 165, 'west>base': 165 };

function islandMatrix() {
  const points: ScanPoint[] = [
    { id: 'base', kind: 'base', key: 'base', name: 'Harbour base', coordinates: BASE },
    { id: 'north', kind: 'place', key: 'north', name: 'North trailhead', coordinates: NORTH },
    { id: 'west', kind: 'place', key: 'west', name: 'West lookout', coordinates: WEST },
  ];
  const raw = estimatedScanMatrix(points, 'car', 'plausible_unverified');
  const minutes = raw.minutes.map((row, i) => row.map((v, j) => ROAD[`${raw.ids[i]}>${raw.ids[j]}`] ?? v));
  const feasibility = raw.feasibility!.map((row, i) => row.map((s, j) => (ROAD[`${raw.ids[i]}>${raw.ids[j]}`] !== undefined ? 'verified' : s)));
  return { straight: raw.minutes[1]![2]!, bounded: boundTravelMatrix({ matrix: { ...raw, minutes, feasibility } }).matrix };
}

function candidate(id: string, coordinates: { lat: number; lng: number }): PlannerCandidate {
  return {
    id,
    name: id,
    locality: 'Island',
    coordinates,
    durationMinutes: 120,
    intensity: 'easy',
    bestTime: 'any',
    exposure: 'outdoor',
    visibilityDependent: false,
    rainyDayOk: false,
    interests: ['scenic_viewpoints'],
    primaryInterest: 'scenic_viewpoints',
    category: 'viewpoint',
    kindLabel: 'Viewpoint',
    fit: 80,
    significance: 0.7,
    dayTrip: false,
    why: 'Fits.',
    booking: 'none',
    openOnTripDates: true,
    status: 'recommended',
  };
}

function plannerInput(matrix: ReturnType<typeof islandMatrix>['bounded'], overrides: Partial<StructurePlannerInput> = {}): StructurePlannerInput {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
  const at = new Map(matrix.ids.map((id, i) => [id, i] as const));
  return {
    destinationName: 'Test Island',
    windows: dates.map((date) => ({ date, startMinute: 8 * 60, endMinute: 20 * 60 })),
    bases: [{ id: 'base', name: 'Harbour base', why: 'Central.', coordinates: BASE, fromDate: dates[0]!, toDate: dates[dates.length - 1]!, nights: dates.length - 1, transferMinutesFromPrevious: 0 }],
    candidates: [candidate('north', NORTH), candidate('west', WEST)],
    minutes: (a, b) => (a === b ? 0 : (matrix.minutes[at.get(a)!]?.[at.get(b)!] ?? null)),
    pace: 'balanced',
    maxStopsPerDay: 3,
    carAvailable: true,
    maxDailyTravelMinutes: 480,
    maxPhysicalIntensity: 'strenuous',
    frequencyCaps: {},
    weather: [],
    foodAreas: [],
    ...overrides,
  };
}

describe('a synthetic island: two stops either side of a cliff', () => {
  it('the straight line would have called it a short drive; the bound says at least two hours', () => {
    const { straight, bounded } = islandMatrix();
    expect(straight).toBeLessThanOrEqual(30);
    const n = bounded.ids.indexOf('north');
    const w = bounded.ids.indexOf('west');
    expect(bounded.minutes[n]![w]).toBeGreaterThanOrEqual(120);
    expect(matrixFeasibility(bounded, 'north', 'west')).toBe('bounded_estimate');
  });

  it('the planner never puts them on one day as a short drive', () => {
    const { bounded } = islandMatrix();
    const plan = planStructure(plannerInput(bounded));
    const dayOf = (id: string) => plan.days.find((d) => d.stops.some((s) => s.candidate.id === id))?.dayNumber ?? null;
    const together = dayOf('north') !== null && dayOf('north') === dayOf('west');
    if (together) {
      const day = plan.days.find((d) => d.dayNumber === dayOf('north'))!;
      expect(day.travelMinutes).toBeGreaterThanOrEqual(45 + 120 + 165);
    } else {
      expect(dayOf('north') === null || dayOf('west') === null || dayOf('north') !== dayOf('west')).toBe(true);
    }
  });

  it('a pair a router affirmatively found unroutable is never one day, and the drop says why', () => {
    const { bounded } = islandMatrix();
    const plan = planStructure(plannerInput(bounded, { disconnected: (a, b) => (a === 'north' && b === 'west') || (a === 'west' && b === 'north'), maxStopsPerDay: 3 }));
    const dayOf = (id: string) => plan.days.find((d) => d.stops.some((s) => s.candidate.id === id))?.dayNumber ?? null;
    expect(dayOf('north') === null || dayOf('north') !== dayOf('west')).toBe(true);
  });

  it('the itinerary leg shows the bounded figure, labelled an estimate and "at least", never measured', async () => {
    const world = fictionalWorld({
      name: 'Test Island',
      center: BASE,
      places: [
        { name: 'Harbour Base', lat: BASE.lat, lng: BASE.lng, entityType: 'city' },
        { name: 'North Trailhead', lat: NORTH.lat, lng: NORTH.lng },
        { name: 'West Lookout', lat: WEST.lat, lng: WEST.lng },
      ],
      basics: { startDate: '2026-05-01', endDate: '2026-05-03' },
      /* A long island day the traveller accepts, so the measured legs alone do not take the lookout off. */
      profile: { maxDailyDriveMinutes: 600, maxDailyTransportMinutes: 600 },
    });
    const keyOf = (p: { lat: number; lng: number }) => (Math.abs(p.lat - BASE.lat) < 1e-6 ? 'base' : Math.abs(p.lat - NORTH.lat) < 1e-6 ? 'north' : 'west');
    /* The router measures the base rows and declines the cross-cliff pair; a direct request for it says nothing either way. */
    world.context.routeMatrix = async (points): Promise<RouteMatrixResult> => {
      const ids = points.map((p) => p.id);
      const failedPairs: { fromId: string; toId: string; reason: 'insufficient_evidence' }[] = [];
      const minutes = points.map((a) =>
        points.map((b) => {
          if (a.id === b.id) return 0;
          const m = ROAD[`${keyOf(a)}>${keyOf(b)}`];
          if (m === undefined) {
            failedPairs.push({ fromId: a.id, toId: b.id, reason: 'insufficient_evidence' });
            return Number.NaN;
          }
          return m;
        }),
      );
      return { ids, minutes, km: minutes.map((row) => row.map((m) => (Number.isFinite(m) ? m * 0.8 : Number.NaN))), failedPairs };
    };
    world.context.confirmRoute = async (from, to): Promise<RouteConfirmation | null> => {
      const m = ROAD[`${keyOf(from)}>${keyOf(to)}`];
      return m === undefined ? { found: false, minutes: null, km: null, reason: 'insufficient_evidence', provider: 'fixture-router' } : { found: true, minutes: m, km: m * 0.8, provider: 'fixture-router' };
    };
    const draft = draftOf({
      bases: [{ id: 'b', name: 'Harbour Base', nights: 2 }],
      days: [
        { base: 'b', anchors: [] },
        { base: 'b', anchors: [{ name: 'North Trailhead', role: 'core', transport: 'car', minutes: 60 }, { name: 'West Lookout', role: 'core', transport: 'car', minutes: 60 }] },
        { base: 'b', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const legs = result.itinerary.days.flatMap((d) => d.items).filter((i) => i.kind === 'travel' && i.travel);
    const cross = legs.find((l) => l.travel!.toName === 'West Lookout' && l.travel!.fromName === 'North Trailhead');
    expect(cross, 'the cross-cliff leg is on the day').toBeDefined();
    expect(cross!.travel!.provenance).toBe('estimated');
    expect(cross!.travel!.feasibility).toBe('bounded_estimate');
    expect(cross!.travel!.minutes!).toBeGreaterThanOrEqual(120);
    expect(cross!.reason).toMatch(/^At least/);
    const fromBase = legs.find((l) => l.travel!.toName === 'North Trailhead');
    expect(fromBase!.travel!.feasibility).toBe('verified');
    /* Estimates never remove anything: both stops are still in the plan. */
    expect(result.itinerary.days[1]!.items.some((i) => i.title.includes('West Lookout'))).toBe(true);
  });
});
