import { assembleScanRegion, estimatedScanMatrix, planScanPoints, type AssembleScanRegionInput, type ResolvedPosition, type ScanAssembly } from './assemble';
import { normalizeScanProposal, type ScanProposal } from './proposal';
import type { TrailParty } from './trail-stages';

/**
 * A PILGRIMAGE TRAIL THE PROPOSAL NAMES ONLY IN PIECES, FOR THE PROGRESSION TESTS.
 *
 * Shaped on the recorded live "Kumano Kodo, Japan" scans (final pass,
 * `docs/final-completion/eval/live*` — scenario `kumano-kodo`): the stage names
 * and rough positions those boards carried, the same gaps — the trail's first
 * stage, then nothing until a stage two villages on, a run of joined stages
 * into the shrine town and the hot-spring village, then a final section far to
 * the south-east, plus a short walk that ends where that final section ends.
 * Coordinates are approximate and stand for the shape, not for the places;
 * the code under test never sees a name it could match. Options vary the
 * proposal the way live runs varied: with or without stage numbers, in another
 * order, with fewer places to sleep, the middle named as one stage or two, the
 * usual bus round the steep final section. Test support only.
 */

type Point = { lat: number; lng: number };

export const GAPPED_POINTS = {
  takijiri: { lat: 33.7944, lng: 135.5592 },
  takahara: { lat: 33.8022, lng: 135.5822 },
  chikatsuyu: { lat: 33.844, lng: 135.653 },
  tsugizakura: { lat: 33.848, lng: 135.688 },
  hosshinmon: { lat: 33.865, lng: 135.756 },
  hongu: { lat: 33.8403, lng: 135.7733 },
  yunomine: { lat: 33.8185, lng: 135.7625 },
  koguchi: { lat: 33.78, lng: 135.848 },
  nachi: { lat: 33.6686, lng: 135.8903 },
  daimonzaka: { lat: 33.664, lng: 135.9 },
} as const satisfies Record<string, Point>;
type Spot = keyof typeof GAPPED_POINTS;

const NAMES: Record<Spot, string> = {
  takijiri: 'Takijiri',
  takahara: 'Takahara',
  chikatsuyu: 'Chikatsuyu',
  tsugizakura: 'Tsugizakura',
  hosshinmon: 'Hosshinmon',
  hongu: 'Hongu',
  yunomine: 'Yunomine Onsen',
  koguchi: 'Koguchi',
  nachi: 'Nachisan',
  daimonzaka: 'Daimonzaka',
};

export const GAPPED_DATES = ['2027-03-19', '2027-03-20', '2027-03-21', '2027-03-22', '2027-03-23', '2027-03-24', '2027-03-25', '2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29'];
export const GAPPED_ARRIVAL = { lat: 33.735, lng: 135.384 };
export const GAPPED_DEPARTURE = { lat: 33.628, lng: 135.943 };

export interface GappedTrailOptions {
  /** Which places to sleep the proposal named: the two hot-spring villages (live pass 2), one of them, or every stage end. */
  beds?: 'stay_villages' | 'one' | 'stage_ends';
  /** Whether the proposal numbered its stages (live runs did, and did not). */
  stageMarks?: boolean;
  /** Propose the stages in a scrambled order. */
  shuffled?: boolean;
  /** Name the middle as two stages through the cedar grove (live pass 1) rather than one long one (pass 2). */
  middleInTwo?: boolean;
  /** Give the steep final section the usual bus round it. */
  finalBus?: boolean;
  /** Leave the short walk that ends where the final section ends off the proposal. */
  noOverlap?: boolean;
  party?: Partial<TrailParty>;
  follow?: boolean;
  moveTolerance?: 'stay_put' | 'move_freely';
}

interface StageSpec {
  name: string;
  from: Spot;
  to: Spot;
  km: number;
  ascentM: number;
  stage: number;
  alternative?: { mode: 'bus'; note: string };
}

export function gappedStages(options: GappedTrailOptions = {}): StageSpec[] {
  const middle: StageSpec[] = options.middleInTwo
    ? [
        { name: 'Chikatsuyu to Tsugizakura-oji', from: 'chikatsuyu', to: 'tsugizakura', km: 4, ascentM: 250, stage: 2 },
        { name: 'Tsugizakura-oji to Hosshinmon-oji', from: 'tsugizakura', to: 'hosshinmon', km: 13, ascentM: 650, stage: 3 },
      ]
    : [{ name: 'Chikatsuyu to Hosshinmon-oji', from: 'chikatsuyu', to: 'hosshinmon', km: 17, ascentM: 900, stage: 2 }];
  const after = middle.length + 2;
  return [
    { name: 'Takijiri-oji to Takahara', from: 'takijiri', to: 'takahara', km: 3.7, ascentM: 450, stage: 1 },
    ...middle,
    { name: 'Hosshinmon-oji to Kumano Hongu Taisha', from: 'hosshinmon', to: 'hongu', km: 7, ascentM: 250, stage: after },
    { name: 'Hongu to Yunomine Onsen via Dainichi-goe', from: 'hongu', to: 'yunomine', km: 3.5, ascentM: 300, stage: after + 1 },
    {
      name: 'Koguchi to Nachisan via Ogumotori-goe',
      from: 'koguchi',
      to: 'nachi',
      km: 14.5,
      ascentM: 1000,
      stage: after + 2,
      ...(options.finalBus ? { alternative: { mode: 'bus' as const, note: 'Most walkers who skip the climb take the bus from Hongu to Nachi by way of Shingu.' } } : {}),
    },
    ...(options.noOverlap ? [] : [{ name: 'Daimonzaka to Nachi Taisha and Nachi Falls', from: 'daimonzaka' as Spot, to: 'nachi' as Spot, km: 1.5, ascentM: 150, stage: after + 3 }]),
  ];
}

const EXTRAS: { name: string; locality: string; kind: string; at: Point; durationMinutes: number }[] = [
  { name: 'Kumano Hongu Taisha', locality: 'Hongu', kind: 'temple_or_shrine', at: { lat: 33.8407, lng: 135.7737 }, durationMinutes: 60 },
  { name: 'Kawayu Onsen riverbed bath', locality: 'Kawayu', kind: 'hot_spring', at: { lat: 33.8222, lng: 135.7756 }, durationMinutes: 60 },
  { name: 'Yunomine village bath', locality: 'Yunomine Onsen', kind: 'hot_spring', at: { lat: 33.8188, lng: 135.7628 }, durationMinutes: 60 },
  { name: 'Nachi Falls', locality: 'Nachikatsuura', kind: 'waterfall', at: { lat: 33.6747, lng: 135.8878 }, durationMinutes: 60 },
  { name: 'Kumano Hayatama Taisha', locality: 'Shingu', kind: 'temple_or_shrine', at: { lat: 33.7305, lng: 135.9905 }, durationMinutes: 45 },
  { name: 'Kii-Katsuura harbour walk', locality: 'Katsuura', kind: 'easy_walk', at: { lat: 33.627, lng: 135.945 }, durationMinutes: 60 },
];

export function gappedTrailProposal(options: GappedTrailOptions = {}): { proposal: ScanProposal; positions: Map<string, ResolvedPosition | null> } {
  const specs = gappedStages(options);
  const ordered = options.shuffled ? [...specs.slice(3).reverse(), specs[1]!, specs[0]!, specs[2]!] : specs;
  const bedSpots: Spot[] = options.beds === 'one' ? ['yunomine'] : options.beds === 'stage_ends' ? ['takijiri', 'takahara', 'chikatsuyu', 'hosshinmon', 'hongu', 'yunomine', 'koguchi', 'nachi'] : ['yunomine', 'hongu'];
  const raw = {
    bases: bedSpots.map((spot) => ({ name: NAMES[spot], locality: NAMES[spot], nightsHint: 2, why: 'An inn on the trail.' })),
    candidates: [
      ...ordered.map((s) => ({
        name: s.name,
        locality: NAMES[s.from],
        kind: 'day_hike',
        tier: 'classic',
        durationMinutes: 240,
        intensity: 'moderate',
        costLevel: 0,
        exposure: 'outdoor',
        bestTime: 'morning',
        crowd: 'quiet',
        booking: 'none',
        rainyDayOk: false,
        interests: ['hiking'],
        why: 'A stage of the pilgrimage trail.',
        walk: {
          shape: 'point_to_point',
          endName: NAMES[s.to],
          endLocality: NAMES[s.to],
          km: s.km,
          ascentM: s.ascentM,
          ...(options.stageMarks === false ? {} : { stage: s.stage }),
          ...(s.alternative ? { alternative: s.alternative } : {}),
        },
      })),
      ...EXTRAS.map((e) => ({ name: e.name, locality: e.locality, kind: e.kind, tier: 'classic', durationMinutes: e.durationMinutes, intensity: 'easy', costLevel: 1, exposure: 'outdoor', bestTime: 'any', crowd: 'quiet', booking: 'none', rainyDayOk: e.kind === 'hot_spring', interests: e.kind === 'hot_spring' ? ['hot_springs'] : ['history_and_culture'], why: 'Near the trail.' })),
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
    const spot = (Object.keys(NAMES) as Spot[]).find((k) => NAMES[k] === b.name)!;
    positions.set(b.key, { coordinates: GAPPED_POINTS[spot], method: 'geocoder', provider: 'test-geocoder', approximate: false, locality: b.name });
  }
  proposal.candidates.forEach((c, i) => {
    if (i < ordered.length) {
      const s = ordered[i]!;
      const from = GAPPED_POINTS[s.from];
      positions.set(c.key, { coordinates: { lat: from.lat + 0.002, lng: from.lng + 0.002 }, method: 'places', provider: 'test-places', approximate: false, locality: NAMES[s.from] });
      positions.set(`${c.key}#end`, { coordinates: { lat: GAPPED_POINTS[s.to].lat + 0.001, lng: GAPPED_POINTS[s.to].lng }, method: 'geocoder', provider: 'test-geocoder', approximate: false, locality: NAMES[s.to] });
      return;
    }
    const e = EXTRAS[i - ordered.length]!;
    positions.set(c.key, { coordinates: e.at, method: 'places', provider: 'test-places', approximate: false });
  });
  return { proposal, positions };
}

export function gappedTrailRegion(options: GappedTrailOptions = {}, overrides: Partial<AssembleScanRegionInput> = {}): ScanAssembly & { proposal: ScanProposal } {
  const { proposal, positions } = gappedTrailProposal(options);
  const plan = planScanPoints(proposal, positions);
  const dates = GAPPED_DATES;
  const stayPut = options.moveTolerance === 'stay_put';
  const assembled = assembleScanRegion({
    regionId: 'scan-gapped-trail',
    destinationName: 'The Pilgrimage Trail',
    entityType: 'route_or_corridor',
    breadth: 'region',
    center: { lat: 33.8, lng: 135.75 },
    countryCode: 'JP',
    timeZone: 'Asia/Tokyo',
    dates,
    edges: { arrival: GAPPED_ARRIVAL, departure: GAPPED_DEPARTURE, arrivalUsableMinutes: 240, departureUsableMinutes: 240 },
    carAvailable: true,
    maxBaseChanges: stayPut ? 0 : dates.length - 2,
    traveller: { carAvailable: true, pace: 'balanced', maxDailyTravelMinutes: 150, stopsPerDay: 3, moveTolerance: options.moveTolerance ?? 'move_freely', ...(options.party?.children ? { children: options.party.children } : {}) },
    trail: {
      follow: options.follow ?? true,
      party: { intensity: 'moderate', children: 0, youngChildren: false, reducedMobility: false, pace: 'balanced', ...options.party },
      dayStartMinutes: dates.map(() => 9 * 60),
    },
    proposal,
    positions,
    plan,
    matrix: estimatedScanMatrix(plan.points, 'car'),
    createdAt: '2026-11-15T00:00:00.000Z',
    providers: { proposal: 'test-model', placement: ['test-places'], routing: 'estimate' },
    ...overrides,
  });
  return { ...assembled, proposal };
}
