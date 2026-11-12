import { describe, expect, it, vi } from 'vitest';
import { SCAN_KIND_PROFILES, tripPackageSchema, chooseScanBases, estimateLegMinutes, haversineKm, normalizeScanProposal, planScanPoints, scanSufficiency, candidatesInReach, type ResolvedPosition, type ScanKind, type ScanProposal } from '@sidequest/core';
import recorded from './fixtures/tanzania/scan-2026-11-10.json';
import { planStructure, type PlannerBase, type PlannerCandidate, type StructurePlannerInput } from '../structure-planner';
import { classifyDayDensity, densityNote, discoveryLossesOf, tripDensityLine } from '../day-density';
import type { AnchorCategory } from '../trip-draft';

/**
 * SPARSE ITINERARIES — THE TANZANIA TRIP, REPLAYED.
 *
 * A live trip, "Arusha and the Serengeti, Tanzania", 2027-07-05 to 07-13 (nine
 * days), came out with seven stops. The recorded stages (rc-live.db, trip
 * 378faf11, trimmed into the fixture):
 *
 *   proposed 38 candidates + 4 places to sleep
 *   placed   29 candidates + 1 place to sleep    (3 bases no_results; 6
 *            approximate_only; 3 not placed)
 *   board    29
 *   auto-picked 3
 *   scheduled 7 across 9 days, all from Arusha
 *
 * The three lost places to sleep — "Karatu (Ngorongoro gateway)", "Serengeti
 * National Park (Seronera)", "Mto wa Mbu / Lake Manyara" — are real places
 * the geocoder knows once the note is taken off the name. With one base left,
 * Ngorongoro and the Serengeti were three hours away and out of reach.
 *
 * What is asserted: the placement ladder now places all three (on the
 * geocoder's own recorded answers, 2026-11-11, no network here); the board's
 * reach coverage is judged and was thin; the planner, given the recovered
 * bases, builds a fuller trip from the same 29 places; and the recorded
 * plan's light days are classified as a discovery gap, not as relaxation.
 */

vi.mock('server-only', () => ({}));
vi.mock('../../providers/registry', () => ({ capability: () => ({ configured: false }) }));
vi.mock('../../providers/nominatim', () => ({
  geocode: vi.fn(async (query: string) => ({ places: (recorded.geocoder as Record<string, unknown[]>)[query] ?? [], calls: 1, cacheHit: false })),
}));

const CATEGORY: Record<string, AnchorCategory> = { viewpoint: 'viewpoint', day_hike: 'hike', easy_walk: 'nature', lake: 'water', scenic_drive: 'scenic_drive', geothermal: 'geothermal', hot_spring: 'relaxation', historic_site: 'historic', museum: 'museum', town_and_food: 'neighbourhood', gondola_or_tram: 'viewpoint', national_monument: 'nature', wildlife_area: 'wildlife' };
const FIT = { classic: 80, hidden_gem: 70, side_quest: 65 } as const;
const trip = recorded.trip;
const dates = trip.windows.map((w) => w.date);

function proposalOf(): ScanProposal {
  const normalized = normalizeScanProposal({
    bases: recorded.bases.map((b) => ({ name: b.name, locality: b.locality, nightsHint: 2, why: 'Recorded.' })),
    candidates: recorded.candidates.map((c) => ({ name: c.name, locality: c.locality, kind: c.kind, tier: c.tier, durationMinutes: c.durationMinutes, intensity: c.intensity, interests: c.interests, bestTime: c.bestTime, why: 'Recorded.' })),
  });
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.proposal;
}

/** The positions the live scan recorded: every placed candidate where it was placed, Arusha as the only base. */
function recordedPositions(proposal: ScanProposal): Map<string, ResolvedPosition | null> {
  const positions = new Map<string, ResolvedPosition | null>();
  proposal.bases.forEach((b, i) => {
    const at = recorded.bases[i]!.recorded;
    positions.set(b.key, at ? { coordinates: at, method: 'geocoder', provider: 'recorded', approximate: false } : null);
  });
  proposal.candidates.forEach((c, i) => {
    const at = recorded.candidates[i]!.recorded;
    positions.set(c.key, at ? { coordinates: at, method: 'places', provider: 'recorded', approximate: false } : null);
  });
  return positions;
}

/** Car-free minutes, as the planner composer estimates them: a short walk, otherwise public transport. */
function minutesBetween(at: Map<string, { lat: number; lng: number }>) {
  return (a: string, b: string): number | null => {
    if (a === b) return 0;
    const pa = at.get(a);
    const pb = at.get(b);
    if (!pa || !pb) return null;
    if (haversineKm(pa, pb) <= 1.6) return estimateLegMinutes({ from: pa, to: pb, mode: 'walk' })?.minutes ?? null;
    return estimateLegMinutes({ from: pa, to: pb, mode: 'rail' })?.minutes ?? null;
  };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Bases chosen by the stay objective, then the deterministic planner, over the board those positions make. */
function build(proposal: ScanProposal, positions: Map<string, ResolvedPosition | null>) {
  const plan = planScanPoints(proposal, positions);
  const at = new Map(plan.points.map((p) => [p.id, p.coordinates] as const));
  const minutes = minutesBetween(at);
  const baseEntries = proposal.bases.filter((b) => plan.baseIdByKey.has(b.key) && plan.points.some((p) => p.id === plan.baseIdByKey.get(b.key))).map((b) => ({ id: plan.baseIdByKey.get(b.key)!, proposal: b }));
  const placeEntries = proposal.candidates.filter((c) => plan.placeIdByKey.has(c.key)).map((c) => ({ id: plan.placeIdByKey.get(c.key)!, proposal: c }));
  const choice = chooseScanBases({
    bases: baseEntries,
    places: placeEntries,
    minutes,
    nights: trip.nights,
    maxBaseChanges: 3,
    traveller: { carAvailable: false, pace: 'balanced', maxDailyTravelMinutes: trip.maxDailyTravelMinutes, stopsPerDay: trip.activitySlotsPerDay, moveTolerance: 'move_freely' },
  });
  let cursor = dates[0]!;
  const bases: PlannerBase[] = choice.kept.map((k, order) => {
    const fromDate = cursor;
    const toDate = order === choice.kept.length - 1 ? dates[dates.length - 1]! : addDays(fromDate, k.nights);
    cursor = toDate;
    return { id: k.id, name: baseEntries.find((b) => b.id === k.id)!.proposal.name, why: '', coordinates: at.get(k.id)!, fromDate, toDate, nights: k.nights, transferMinutesFromPrevious: k.transferMinutesFromPrevious };
  });
  const candidates: PlannerCandidate[] = placeEntries.map(({ id, proposal: c }) => ({
    id,
    name: c.name,
    locality: c.locality,
    coordinates: at.get(id)!,
    durationMinutes: c.durationMinutes,
    intensity: c.intensity,
    bestTime: c.bestTime,
    exposure: c.exposure,
    visibilityDependent: SCAN_KIND_PROFILES[c.kind as ScanKind].visibilityDependent,
    rainyDayOk: c.rainyDayOk,
    interests: c.interests,
    primaryInterest: c.interests[0] ?? null,
    category: CATEGORY[SCAN_KIND_PROFILES[c.kind as ScanKind].category] ?? 'landmark',
    kindLabel: SCAN_KIND_PROFILES[c.kind as ScanKind].label,
    fit: FIT[c.tier],
    significance: c.tier === 'classic' ? 0.8 : 0.5,
    dayTrip: false,
    why: '',
    booking: 'none',
    openOnTripDates: true,
    status: 'candidate',
  }));
  const input: StructurePlannerInput = {
    destinationName: 'Arusha and the Serengeti, Tanzania',
    windows: trip.windows,
    bases,
    candidates,
    minutes,
    pace: 'balanced',
    maxStopsPerDay: trip.activitySlotsPerDay,
    carAvailable: false,
    maxDailyTravelMinutes: trip.maxDailyTravelMinutes,
    maxPhysicalIntensity: 'strenuous',
    frequencyCaps: trip.frequencyCaps,
    weather: [],
    foodAreas: [],
    improve: false,
  };
  const structure = planStructure(input);
  const inReach = candidatesInReach({ bases: plan.points.filter((p) => p.kind === 'base').map((p) => p.coordinates), places: plan.points.filter((p) => p.kind === 'place').map((p) => p.coordinates), carAvailable: false, maxDailyTravelMinutes: trip.maxDailyTravelMinutes });
  return { plan, bases, structure, input, inReach, stops: structure.days.reduce((n, d) => n + d.stops.length, 0) };
}

describe('Tanzania sparse itinerary (rc-live 2026-11-10)', () => {
  it('records where the candidates went', () => {
    const s = recorded.recordedStages;
    expect([s.proposed, s.proposedBases, s.placedBases, s.placedCandidates, s.autoPicked, s.scheduled]).toEqual([38, 4, 1, 29, 3, 7]);
    expect(recorded.itineraryDays.length).toBe(9);
  });

  it('places all three lost places to sleep from the recorded geocoder answers, once the note is off the name', async () => {
    const { placeScanProposal } = await import('../../discovery-scan/placement');
    const proposal = proposalOf();
    const lost = { ...proposal, bases: proposal.bases.filter((_, i) => !recorded.bases[i]!.recorded), candidates: proposal.candidates.filter((_, i) => !recorded.candidates[i]!.recorded) };
    const result = await placeScanProposal(lost, { center: trip.center, maxDistanceKm: trip.reachKm, countryCode: trip.countryCode, countryName: trip.countryName, placesBudget: 0, deadline: () => false });
    const byName = new Map(result.diagnostics.map((d) => [d.name, d]));
    for (const base of lost.bases) expect(result.positions.get(base.key), base.name).not.toBeNull();
    /* The town, not the district boundary the geocoder lists first. */
    expect(result.positions.get(lost.bases.find((b) => b.name === 'Karatu lodges')!.key)!.coordinates.lat).toBeCloseTo(-3.3387, 3);
    expect(byName.get('Karatu lodges')!.attempts.map((a) => a.query)).toContain('Karatu, Tanzania');
    expect(byName.get('Lake Manyara area lodge')!.attempts.map((a) => a.query)).toContain('Mto wa Mbu, Tanzania');
    /* A game drive is an area: placed in Central Serengeti, and kept on the board. */
    const drive = lost.candidates.find((c) => c.name === 'Seronera Valley game drive')!;
    expect(result.positions.get(drive.key)?.answerScale).toBe('point');
    expect(planScanPoints(lost, result.positions).placeIdByKey.has(drive.key)).toBe(true);
    /* Nothing invented: a candidate no provider answered for stays unplaced. */
    const shanga = lost.candidates.find((c) => c.name.startsWith('Shanga'))!;
    expect(result.positions.get(shanga.key)).toBeNull();
  });

  it('the recorded board fills the days in count but not in reach; the recovered one does both', async () => {
    const { placeScanProposal } = await import('../../discovery-scan/placement');
    const proposal = proposalOf();
    const before = recordedPositions(proposal);
    const after = new Map(before);
    const recovered = await placeScanProposal({ ...proposal, bases: proposal.bases.filter((_, i) => !recorded.bases[i]!.recorded), candidates: proposal.candidates.filter((_, i) => !recorded.candidates[i]!.recorded) }, { center: trip.center, maxDistanceKm: trip.reachKm, countryCode: trip.countryCode, countryName: trip.countryName, placesBudget: 0, deadline: () => false });
    for (const [key, position] of recovered.positions) if (position) after.set(key, position);

    const old = build(proposal, before);
    const now = build(proposal, after);
    const placedKinds = (plan: ReturnType<typeof planScanPoints>) => proposal.candidates.filter((c) => plan.placeIdByKey.has(c.key)).map((c) => ({ kind: c.kind, interests: c.interests }));
    const sufficiency = (b: typeof old) => scanSufficiency({ days: 9, stopsPerDay: trip.activitySlotsPerDay, requested: 28, placed: placedKinds(b.plan), priorities: [], inReach: b.inReach });

    /* Before: enough places by count, too few a place to sleep can reach — the supplement now fires. */
    expect(sufficiency(old).reasons).toContain('too_little_in_reach');
    expect(sufficiency(old).sufficient).toBe(false);
    expect(old.bases.length).toBe(1);

    /* After: more than one place to sleep, more of the board in reach, more stops from the same places. */
    expect(now.bases.length).toBeGreaterThanOrEqual(2);
    expect(now.inReach).toBeGreaterThan(old.inReach);
    expect(now.stops).toBeGreaterThan(old.stops);
    /* Replayed on estimated car-free minutes: 5 stops from Arusha alone, 8 once Mto wa Mbu can be slept in. (The stay objective keeps Karatu and the Serengeti out under a 2 h 30 min travel limit — see the report; not changed here.) */
    expect(old.stops).toBe(5);
    expect(now.stops).toBeGreaterThanOrEqual(8);
    expect(now.bases.map((b) => b.name)).toContain("Lake Manyara area lodge");
  });

  it('the recorded plan, rebuilt, says its light days are a discovery gap — not a relaxed trip', () => {
    const proposal = proposalOf();
    const old = build(proposal, recordedPositions(proposal));
    const losses = discoveryLossesOf({ placement: { unplaced: recorded.recordedStages.placementUnplaced }, assembly: recorded.recordedStages.assembly });
    expect(losses.bases).toEqual(['Karatu lodges', 'Central Serengeti camps', 'Lake Manyara area lodge']);
    expect(losses.places.length).toBe(9);
    const density = classifyDayDensity({ plan: old.structure, planner: old.input, losses });
    expect(density.complete).toBe(false);
    expect(density.class).toBe('discovery_gap');
    const gapDays = density.days.filter((d) => d.class === 'discovery_gap');
    expect(gapDays.length).toBeGreaterThanOrEqual(3);
    expect(density.days.some((d) => d.class === 'relaxed_by_pace')).toBe(false);
    const note = densityNote(gapDays[0]!, density, { baseName: 'Arusha town lodges', maxDailyTravelMinutes: 150, isEmpty: false })!;
    expect(note).toContain('nothing for you to do');
    expect(note).toContain('Karatu lodges');
    expect(note).not.toMatch(/[a-z]+_[a-z]+/);
    expect(tripDensityLine(density)).toContain('could not put 9 of the places it found and 3 places to sleep');
    /* It persists on the package exactly as classified. */
    const planning = tripPackageSchema.shape.planning.unwrap().shape.density.parse(density);
    expect(planning?.class).toBe('discovery_gap');
  });
});
