import { assembleScanRegion, estimatedScanMatrix, planScanPoints, type AssembleScanRegionInput, type ResolvedPosition, type ScanAssembly } from './assemble';
import { normalizeScanProposal, type ScanProposal } from './proposal';
import type { TrailParty } from './trail-stages';

/**
 * A FICTIONAL TRAIL WALKED IN STAGES, FOR THE POINT-TO-POINT TESTS.
 *
 * Five villages along a valley, a stage between each pair, a hot spring by the
 * fourth, a shrine and a waterfall off the path, and a station where the
 * traveller leaves. Every name and coordinate is invented (the zone is a real
 * IANA zone so dusk is arithmetic). Options make one stage too long — with or
 * without an intermediate village to split it at, with or without the usual
 * bus round it — or take the stages away altogether. Test support only.
 */

export const TRAIL_VILLAGES = {
  alder: { name: 'Alder Gate', at: { lat: 34.0, lng: 135.5 } },
  bracken: { name: 'Brackenford', at: { lat: 34.01, lng: 135.58 } },
  corrie: { name: 'Corrie Mill', at: { lat: 34.02, lng: 135.66 } },
  dunmere: { name: 'Dunmere', at: { lat: 34.03, lng: 135.74 } },
  esk: { name: 'Eskwater', at: { lat: 34.04, lng: 135.82 } },
  fern: { name: 'Fernhollow', at: { lat: 34.025, lng: 135.7 } },
} as const;
type Village = keyof typeof TRAIL_VILLAGES;

export const TRAIL_STATION = { lat: 34.2, lng: 135.95 };
export const TRAIL_DATES = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];

export interface FictionalTrailOptions {
  /** Make the third stage 30 km and 1,600 m of climbing. */
  longThirdStage?: boolean;
  /** Propose Fernhollow, between Corrie Mill and Dunmere, as a place to sleep. */
  intermediateVillage?: boolean;
  /** Give the third stage the usual bus round it. */
  busAlternative?: boolean;
  /** Propose no stages at all: the walks come back as ordinary loops. */
  noStages?: boolean;
  party?: Partial<TrailParty>;
  follow?: boolean;
  moveTolerance?: 'stay_put' | 'move_if_it_saves_time';
  dates?: readonly string[];
}

const STAGES: { from: Village; to: Village; km: number; ascentM: number }[] = [
  { from: 'alder', to: 'bracken', km: 12, ascentM: 500 },
  { from: 'bracken', to: 'corrie', km: 13, ascentM: 600 },
  { from: 'corrie', to: 'dunmere', km: 14, ascentM: 700 },
  { from: 'dunmere', to: 'esk', km: 11, ascentM: 400 },
];

export function fictionalTrailProposal(options: FictionalTrailOptions = {}): { proposal: ScanProposal; positions: Map<string, ResolvedPosition | null> } {
  const villages: Village[] = ['alder', 'bracken', 'corrie', ...(options.intermediateVillage ? (['fern'] as Village[]) : []), 'dunmere', 'esk'];
  const stageCandidates = STAGES.map((s, i) => {
    const long = i === 2 && options.longThirdStage;
    return {
      name: `${TRAIL_VILLAGES[s.from].name} to ${TRAIL_VILLAGES[s.to].name}`,
      locality: TRAIL_VILLAGES[s.from].name,
      kind: 'day_hike',
      tier: 'classic',
      durationMinutes: 300,
      intensity: 'moderate',
      costLevel: 0,
      exposure: 'outdoor',
      bestTime: 'morning',
      crowd: 'quiet',
      booking: 'none',
      rainyDayOk: false,
      interests: ['hiking'],
      why: 'The trail itself.',
      ...(i === 0 ? { defining: true } : {}),
      walk: options.noStages
        ? { shape: 'loop' }
        : {
            shape: 'point_to_point',
            endName: TRAIL_VILLAGES[s.to].name,
            endLocality: TRAIL_VILLAGES[s.to].name,
            km: long ? 30 : s.km,
            ascentM: long ? 1600 : s.ascentM,
            stage: i + 1,
            ...(long && options.busAlternative ? { alternative: { mode: 'bus', note: 'The valley bus runs from Corrie Mill to Dunmere several times a day.' } } : {}),
          },
    };
  });
  const extras = [
    { name: 'Dunmere Hot Spring', locality: 'Dunmere', kind: 'hot_spring', at: { lat: 34.034, lng: 135.746 }, durationMinutes: 90 },
    { name: 'Brackenford Shrine', locality: 'Brackenford', kind: 'temple_or_shrine', at: { lat: 34.016, lng: 135.59 }, durationMinutes: 60 },
    { name: 'Corrie Falls', locality: 'Corrie Mill', kind: 'waterfall', at: { lat: 34.028, lng: 135.672 }, durationMinutes: 60 },
    { name: 'Eskwater Museum', locality: 'Eskwater', kind: 'museum', at: { lat: 34.046, lng: 135.828 }, durationMinutes: 75 },
  ];
  const raw = {
    bases: villages.map((v) => ({ name: TRAIL_VILLAGES[v].name, locality: TRAIL_VILLAGES[v].name, nightsHint: 1, why: 'An inn at the end of a stage.' })),
    candidates: [
      ...stageCandidates,
      ...extras.map((e) => ({ name: e.name, locality: e.locality, kind: e.kind, tier: 'hidden_gem', durationMinutes: e.durationMinutes, intensity: 'easy', costLevel: 1, exposure: e.kind === 'museum' ? 'indoor' : 'outdoor', bestTime: 'any', crowd: 'quiet', booking: 'none', rainyDayOk: e.kind === 'museum', interests: e.kind === 'hot_spring' ? ['hot_springs'] : ['history_and_culture'], why: 'Close to the trail.' })),
    ],
    foodAreas: [],
    skipped: [],
    package: { transportSummary: 'On foot, with the bags sent ahead.', transportNotes: [], beforeYouGo: [], packing: [], foodStrategy: [], bookingPriorities: [] },
  };
  const normalized = normalizeScanProposal(raw);
  if (!normalized.ok) throw new Error(normalized.reason);
  const proposal = normalized.proposal;
  const positions = new Map<string, ResolvedPosition | null>();
  for (const b of proposal.bases) {
    const v = Object.values(TRAIL_VILLAGES).find((x) => x.name === b.name)!;
    positions.set(b.key, { coordinates: v.at, method: 'geocoder', provider: 'test-geocoder', approximate: false });
  }
  proposal.candidates.forEach((c, i) => {
    if (i < STAGES.length) {
      const s = STAGES[i]!;
      positions.set(c.key, { coordinates: { lat: TRAIL_VILLAGES[s.from].at.lat + 0.002, lng: TRAIL_VILLAGES[s.from].at.lng + 0.002 }, method: 'places', provider: 'test-places', approximate: false });
      if (!options.noStages) positions.set(`${c.key}#end`, { coordinates: { lat: TRAIL_VILLAGES[s.to].at.lat + 0.001, lng: TRAIL_VILLAGES[s.to].at.lng }, method: 'geocoder', provider: 'test-geocoder', approximate: false });
      return;
    }
    const e = extras[i - STAGES.length]!;
    positions.set(c.key, { coordinates: e.at, method: 'places', provider: 'test-places', approximate: false });
  });
  return { proposal, positions };
}

export function fictionalTrailRegion(options: FictionalTrailOptions = {}, overrides: Partial<AssembleScanRegionInput> = {}): ScanAssembly & { proposal: ScanProposal } {
  const { proposal, positions } = fictionalTrailProposal(options);
  const plan = planScanPoints(proposal, positions);
  const dates = options.dates ?? TRAIL_DATES;
  const assembled = assembleScanRegion({
    regionId: 'scan-fictional-trail',
    destinationName: 'The Valley Trail',
    entityType: 'route_or_corridor',
    breadth: 'region',
    center: { lat: 34.02, lng: 135.66 },
    countryCode: 'JP',
    timeZone: 'Asia/Tokyo',
    dates,
    edges: { arrival: TRAIL_STATION, departure: TRAIL_STATION, arrivalUsableMinutes: 300, departureUsableMinutes: 240 },
    carAvailable: true,
    maxBaseChanges: 1,
    traveller: { carAvailable: true, pace: 'balanced', maxDailyTravelMinutes: 180, stopsPerDay: 3, moveTolerance: options.moveTolerance ?? 'move_if_it_saves_time' },
    trail: {
      follow: options.follow ?? true,
      party: { intensity: 'moderate', children: 0, youngChildren: false, reducedMobility: false, pace: 'balanced', ...options.party },
      dayStartMinutes: dates.map(() => 8 * 60 + 30),
    },
    proposal,
    positions,
    plan,
    matrix: estimatedScanMatrix(plan.points, 'car'),
    createdAt: '2026-09-01T00:00:00.000Z',
    providers: { proposal: 'test-model', placement: ['test-places'], routing: 'estimate' },
    ...overrides,
  });
  return { ...assembled, proposal };
}
