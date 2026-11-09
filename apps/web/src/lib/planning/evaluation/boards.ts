import type { Interest, PhysicalIntensity, TimeOfDay } from '@sidequest/core';
import type { ScanKind, ScanTier } from '@sidequest/core';
import recorded from '../../../../../../packages/core/src/scan/fixtures/live-scans-2026-11.json';
import { benchTrips, largeBenchTrip } from '../testing/planner-bench';
import type { PlannerCandidate } from '../structure-planner';
import { fixtureScanProposal } from '../../discovery-scan/fixture';

/**
 * RELEASE CANDIDATE — THE BOARDS THE ITINERARY EVALUATION RUNS ON.
 *
 * Every board the repository can supply without a provider or a model, in one
 * shape: proposed places to sleep and candidate places, each with a coordinate
 * and the soft attributes a scan proposal carries. The evaluation
 * (`run.ts`) turns each into a real `CompiledRegion` through the production
 * assembler, builds the real Discovery Board, asks the real planner for its
 * picks and then for the trip.
 *
 * Four sources, labelled on every result:
 *
 *  - `recorded_scan` — the six live scans recorded on 2026-11-08
 *    (`packages/core/src/scan/fixtures/live-scans-2026-11.json`). They hold
 *    names, coordinates, durations and popularity only, so the kind, effort and
 *    exposure of each place are read here from its name with one small word
 *    table. That is fixture enrichment, said plainly: it makes the recorded
 *    geography plannable, it is not what the model proposed, and nothing in the
 *    planner reads a name.
 *  - `bench` — the planner bench's hand-built boards (`testing/planner-bench.ts`),
 *    whose places already carry every attribute.
 *  - `fixture_proposal` — the browser suite's fixture proposer
 *    (`discovery-scan/fixture.ts`), placed on a deterministic ring.
 *  - `synthetic` — five geometries built to separate one structural question
 *    each: a compact cluster, a long linear coast, two clusters three hours
 *    apart, a hub and its spokes, and an island reached by a ferry.
 *
 * Test data only. Nothing in the planner may branch on any name here.
 */

export interface BoardPlace {
  name: string;
  locality: string;
  coordinates: { lat: number; lng: number };
  kind: ScanKind;
  tier: ScanTier;
  durationMinutes: number;
  intensity: PhysicalIntensity;
  exposure: 'indoor' | 'mixed' | 'outdoor';
  bestTime: TimeOfDay;
  rainyDayOk: boolean;
  booking: 'none' | 'recommended' | 'required';
  interests?: Interest[];
  zone?: string;
  /** The traveller's own include, on every profile: what "dropped must-dos" is measured against. */
  must?: boolean;
}

export interface BoardBase {
  name: string;
  coordinates: { lat: number; lng: number };
  nightsHint: number;
}

export interface BoardFixture {
  key: string;
  label: string;
  source: 'recorded_scan' | 'bench' | 'fixture_proposal' | 'synthetic';
  destinationName: string;
  entityType: 'city' | 'natural_region' | 'island' | 'country';
  center: { lat: number; lng: number };
  /** Nights the board was recorded or built for; a profile may override it. */
  nights: number;
  bases: BoardBase[];
  places: BoardPlace[];
  /** Where the traveller arrives and leaves, when the fixture says. Absent: unknown edges, exactly as a regional scan has them. */
  gateway?: { lat: number; lng: number };
  /**
   * Extra door-to-door minutes for a pair of points, added to the estimate —
   * the ferry of an island fixture. Null means no adjustment.
   */
  crossing?: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number | null;
}

/* ---------------------------------------------------------------------------------------------
 * Recorded live scans
 * ------------------------------------------------------------------------------------------- */

interface KindGuess {
  kind: ScanKind;
  intensity?: PhysicalIntensity;
  exposure?: 'indoor' | 'mixed' | 'outdoor';
  bestTime?: TimeOfDay;
}

/** The word table that makes a recorded name plannable. First match wins. */
const NAME_KINDS: [RegExp, KindGuess][] = [
  [/\b(museum|museo|gallery|railway museum|teamlab|visitor centre)\b/i, { kind: 'museum', exposure: 'indoor' }],
  [/\b(distillery|sake)\b/i, { kind: 'cultural_experience', exposure: 'indoor' }],
  [/\b(market|mercado)\b/i, { kind: 'market', exposure: 'mixed' }],
  [/\b(boat trip|cruise)\b/i, { kind: 'boat_trip', exposure: 'outdoor' }],
  [/\b(cable car|gondola|tram)\b/i, { kind: 'observation_deck', exposure: 'mixed' }],
  [/\b(castle|palace)\b/i, { kind: 'castle_or_palace', exposure: 'mixed' }],
  [/\b(shrine|temple|jingu|-ji|-dera|taisha|basilica|cathedral|cairns)\b/i, { kind: 'temple_or_shrine', exposure: 'mixed' }],
  [/\b(national park|natural park|rural park)\b/i, { kind: 'national_park', intensity: 'moderate', exposure: 'outdoor' }],
  [/\b(falls|waterfall)\b/i, { kind: 'waterfall', exposure: 'outdoor' }],
  [/\b(playa|beach|pools?)\b/i, { kind: 'beach', exposure: 'outdoor' }],
  [/\b(mirador|viewpoint|vista|point|punta|bridge|viaduct|crossing|monument|auditorio|staircase)\b/i, { kind: 'viewpoint', exposure: 'outdoor' }],
  [/\b(old man|pass|peak|ben |torridon|roques|trail|path|steall|barranco|pools walk|fairy pools)\b/i, { kind: 'day_hike', intensity: 'moderate', exposure: 'outdoor' }],
  [/\b(walk|forest|garden|gardens|jard[ií]n|gyoen|grove|park|drago)\b/i, { kind: 'easy_walk', exposure: 'outdoor' }],
  [/\b(loch|lake|lago)\b/i, { kind: 'lake_or_river', exposure: 'outdoor' }],
  [/\b(drive)\b/i, { kind: 'scenic_drive', exposure: 'outdoor' }],
  [/\b(isle of|island)\b/i, { kind: 'island', exposure: 'outdoor' }],
  [/\b(siam park|loro parque|theme park)\b/i, { kind: 'theme_park', exposure: 'outdoor' }],
  [/\b(golden gai)\b/i, { kind: 'nightlife', exposure: 'mixed', bestTime: 'night' }],
  [/\b(old town|town|waterfront|quarter|district|gion|ginza|yanaka|shimokitazawa)\b/i, { kind: 'neighbourhood', exposure: 'mixed' }],
];

function guessKind(name: string, minutes: number): Required<Pick<KindGuess, 'kind' | 'intensity' | 'exposure' | 'bestTime'>> {
  for (const [pattern, guess] of NAME_KINDS) {
    if (!pattern.test(name)) continue;
    const longHike = guess.kind === 'day_hike' && minutes >= 180;
    return { kind: guess.kind, intensity: longHike ? 'strenuous' : guess.intensity ?? (guess.exposure === 'indoor' ? 'none' : 'easy'), exposure: guess.exposure ?? 'mixed', bestTime: guess.bestTime ?? 'any' };
  }
  /* A place of four hours or more nobody could classify is a small town or an area visit. */
  return minutes >= 200 ? { kind: 'small_town', intensity: 'easy', exposure: 'mixed', bestTime: 'any' } : { kind: 'landmark', intensity: 'easy', exposure: 'mixed', bestTime: 'any' };
}

const tierOf = (popularity: number): ScanTier => (popularity >= 0.7 ? 'classic' : popularity >= 0.35 ? 'side_quest' : 'hidden_gem');

function centroid(points: readonly { lat: number; lng: number }[]): { lat: number; lng: number } {
  return { lat: points.reduce((n, p) => n + p.lat, 0) / points.length, lng: points.reduce((n, p) => n + p.lng, 0) / points.length };
}

function recordedBoards(): BoardFixture[] {
  return recorded.scans.map((scan) => {
    const places: BoardPlace[] = scan.places.map((p, i) => {
      const guess = guessKind(p.name, p.minutes);
      return {
        name: p.name,
        locality: scan.destination,
        coordinates: p.coordinates,
        kind: guess.kind,
        tier: tierOf(p.popularity),
        durationMinutes: p.minutes,
        intensity: guess.intensity,
        exposure: guess.exposure,
        bestTime: guess.bestTime,
        rainyDayOk: guess.exposure === 'indoor',
        booking: 'none',
        /* The two best-known places of every recorded scan are the traveller's own picks. */
        ...(i < 2 ? { must: true } : {}),
      };
    });
    return {
      key: `recorded:${scan.label}`,
      label: `${scan.destination} (recorded live scan, ${scan.mode === 'car' ? 'car' : 'car-free'})`,
      source: 'recorded_scan' as const,
      destinationName: scan.destination,
      entityType: /tokyo/i.test(scan.label) ? ('country' as const) : /tenerife/i.test(scan.label) ? ('island' as const) : ('natural_region' as const),
      center: centroid(scan.places.map((p) => p.coordinates)),
      nights: scan.nights,
      bases: scan.bases.map((b) => ({ name: b.name, coordinates: b.coordinates, nightsHint: b.nightsHint })),
      places,
    };
  });
}

/* ---------------------------------------------------------------------------------------------
 * The planner bench's boards
 * ------------------------------------------------------------------------------------------- */

const KIND_FOR_CATEGORY: Record<string, ScanKind> = {
  viewpoint: 'viewpoint',
  hike: 'day_hike',
  nature: 'easy_walk',
  water: 'lake_or_river',
  scenic_drive: 'scenic_drive',
  geothermal: 'geothermal',
  relaxation: 'hot_spring',
  historic: 'historic_site',
  museum: 'museum',
  neighbourhood: 'neighbourhood',
  food: 'market',
  wildlife: 'wildlife',
  landmark: 'landmark',
};

function placeFromBench(c: PlannerCandidate): BoardPlace {
  return {
    name: c.name,
    locality: c.locality,
    coordinates: c.coordinates,
    kind: c.dayTrip && c.category !== 'hike' && c.category !== 'scenic_drive' ? 'small_town' : KIND_FOR_CATEGORY[c.category] ?? 'landmark',
    tier: c.significance >= 0.75 ? 'classic' : c.fit >= 78 ? 'side_quest' : 'hidden_gem',
    durationMinutes: c.durationMinutes,
    intensity: c.intensity,
    exposure: c.exposure,
    bestTime: c.bestTime,
    rainyDayOk: c.rainyDayOk,
    booking: c.booking,
    interests: [...c.interests],
    ...(c.zone ? { zone: c.zone } : {}),
    ...(c.status === 'must' ? { must: true } : {}),
  };
}

function benchBoards(): BoardFixture[] {
  return [...benchTrips(), largeBenchTrip()].map((trip) => ({
    key: `bench:${trip.key}`,
    label: trip.label,
    source: 'bench' as const,
    destinationName: trip.input.destinationName,
    entityType: trip.input.bases.length === 1 && !trip.input.carAvailable ? ('city' as const) : ('natural_region' as const),
    center: centroid(trip.input.candidates.map((c) => c.coordinates)),
    nights: trip.input.windows.length - 1,
    bases: trip.input.bases.map((b) => ({ name: b.name, coordinates: b.coordinates, nightsHint: b.nights })),
    places: trip.input.candidates.map(placeFromBench),
    ...(trip.input.bases.length === 1 && !trip.input.carAvailable ? { gateway: trip.input.bases[0]!.coordinates } : {}),
  }));
}

/* ---------------------------------------------------------------------------------------------
 * The fixture proposer, placed on a ring
 * ------------------------------------------------------------------------------------------- */

function offset(origin: { lat: number; lng: number }, kmNorth: number, kmEast: number): { lat: number; lng: number } {
  return { lat: origin.lat + kmNorth / 111, lng: origin.lng + kmEast / (111 * Math.cos((origin.lat * Math.PI) / 180)) };
}

function fixtureProposalBoard(days: number): BoardFixture {
  const name = 'Testmouth';
  const raw = fixtureScanProposal(name, name, days) as {
    bases: { name: string; nightsHint: number }[];
    candidates: { name: string; locality: string; kind: ScanKind; tier: ScanTier; durationMinutes: number; intensity: PhysicalIntensity; exposure: 'indoor' | 'mixed' | 'outdoor'; bestTime: TimeOfDay; rainyDayOk: boolean; booking: 'none' | 'recommended' | 'required'; interests: Interest[] }[];
  };
  const town = { lat: 46.2, lng: 7.3 };
  const hills = offset(town, 22, 30);
  const at = (locality: string, i: number) => {
    const origin = locality === name ? town : hills;
    const angle = (i * 137.5 * Math.PI) / 180;
    const radius = locality === name ? 0.6 + (i % 5) * 0.9 : 3 + (i % 4) * 3;
    return offset(origin, Math.cos(angle) * radius, Math.sin(angle) * radius);
  };
  return {
    key: `fixture:proposal-${days}d`,
    label: `Fixture proposer, ${days} days (town and a hill base)`,
    source: 'fixture_proposal',
    destinationName: name,
    entityType: 'natural_region',
    center: town,
    nights: days - 1,
    bases: raw.bases.map((b) => ({ name: b.name, coordinates: b.name === name ? town : hills, nightsHint: b.nightsHint })),
    places: raw.candidates.map((c, i) => ({ name: c.name, locality: c.locality, coordinates: at(c.locality, i), kind: c.kind, tier: c.tier, durationMinutes: c.durationMinutes, intensity: c.intensity, exposure: c.exposure, bestTime: c.bestTime, rainyDayOk: c.rainyDayOk, booking: c.booking, interests: c.interests, ...(i < 2 ? { must: true } : {}) })),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Synthetic geometries
 * ------------------------------------------------------------------------------------------- */

const SYNTH_KINDS: { kind: ScanKind; minutes: number; intensity: PhysicalIntensity; exposure: 'indoor' | 'mixed' | 'outdoor'; tier: ScanTier; bestTime?: TimeOfDay }[] = [
  { kind: 'viewpoint', minutes: 60, intensity: 'easy', exposure: 'outdoor', tier: 'classic' },
  { kind: 'museum', minutes: 120, intensity: 'none', exposure: 'indoor', tier: 'classic' },
  { kind: 'day_hike', minutes: 240, intensity: 'strenuous', exposure: 'outdoor', tier: 'side_quest' },
  { kind: 'historic_site', minutes: 90, intensity: 'easy', exposure: 'mixed', tier: 'classic' },
  { kind: 'easy_walk', minutes: 90, intensity: 'easy', exposure: 'outdoor', tier: 'hidden_gem' },
  { kind: 'market', minutes: 75, intensity: 'easy', exposure: 'mixed', tier: 'classic' },
  { kind: 'beach', minutes: 150, intensity: 'easy', exposure: 'outdoor', tier: 'side_quest' },
  { kind: 'day_hike', minutes: 180, intensity: 'moderate', exposure: 'outdoor', tier: 'hidden_gem' },
  { kind: 'viewpoint', minutes: 45, intensity: 'easy', exposure: 'outdoor', tier: 'classic', bestTime: 'sunset' },
  { kind: 'castle_or_palace', minutes: 120, intensity: 'easy', exposure: 'mixed', tier: 'classic' },
];

/** `count` places scattered deterministically within `spreadKm` of `origin`, cycling the kind table from `seed`. */
function cluster(label: string, origin: { lat: number; lng: number }, count: number, spreadKm: number, seed: number): BoardPlace[] {
  return Array.from({ length: count }, (_, i) => {
    const spec = SYNTH_KINDS[(seed + i) % SYNTH_KINDS.length]!;
    const angle = ((seed * 53 + i * 137.5) * Math.PI) / 180;
    const radius = spreadKm * (0.25 + 0.75 * (((i * 7 + seed * 3) % 10) / 10));
    return {
      name: `${label} ${spec.kind.replace(/_/g, ' ')} ${i + 1}`,
      locality: label,
      coordinates: offset(origin, Math.cos(angle) * radius, Math.sin(angle) * radius),
      kind: spec.kind,
      tier: spec.tier,
      durationMinutes: spec.minutes,
      intensity: spec.intensity,
      exposure: spec.exposure,
      bestTime: spec.bestTime ?? 'any',
      rainyDayOk: spec.exposure === 'indoor',
      booking: 'none' as const,
      zone: label,
      ...(i === 0 ? { must: true } : {}),
    };
  });
}

function syntheticBoards(): BoardFixture[] {
  const origin = { lat: 44.0, lng: 4.0 };

  /* 1. Everything within a dozen kilometres of one town; a second town proposed ten kilometres off. */
  const compact: BoardFixture = {
    key: 'synthetic:compact-cluster',
    label: 'Compact cluster: everything within 12 km, two towns proposed',
    source: 'synthetic',
    destinationName: 'Compactia',
    entityType: 'natural_region',
    center: origin,
    nights: 6,
    bases: [
      { name: 'Compactia Town', coordinates: origin, nightsHint: 4 },
      { name: 'Compactia Harbour', coordinates: offset(origin, 6, 8), nightsHint: 2 },
    ],
    places: [...cluster('Compactia Town', origin, 12, 7, 1), ...cluster('Compactia Harbour', offset(origin, 6, 8), 8, 5, 4)],
  };

  /* 2. A coast 260 km long with four towns along it and sights strung between them. */
  const coastTowns = [0, 85, 170, 260].map((km, i) => ({ name: `Coast Town ${String.fromCharCode(65 + i)}`, coordinates: offset(origin, km * 0.25, km * 0.95), nightsHint: 2 }));
  const linear: BoardFixture = {
    key: 'synthetic:linear-coast',
    label: 'Long linear coast: 260 km, four towns, sights strung along it',
    source: 'synthetic',
    destinationName: 'Longshore',
    entityType: 'natural_region',
    center: coastTowns[1]!.coordinates,
    nights: 8,
    bases: coastTowns,
    places: coastTowns.flatMap((t, i) => cluster(t.name, t.coordinates, 7, 14, i * 3 + 2)),
  };

  /* 3. Two clusters about three hours' drive apart. */
  const east = offset(origin, 40, 210);
  const twin: BoardFixture = {
    key: 'synthetic:two-clusters',
    label: 'Two clusters about three hours apart',
    source: 'synthetic',
    destinationName: 'Twinlands',
    entityType: 'natural_region',
    center: offset(origin, 20, 105),
    nights: 7,
    bases: [
      { name: 'West City', coordinates: origin, nightsHint: 4 },
      { name: 'East City', coordinates: east, nightsHint: 3 },
    ],
    places: [...cluster('West City', origin, 12, 12, 0), ...cluster('East City', east, 10, 12, 5)],
  };

  /* 4. One hub; five spokes 35–70 km out, each with a town someone might sleep in. */
  const spokes = [0, 72, 144, 216, 288].map((deg, i) => {
    const km = 35 + i * 9;
    return { name: `Spoke ${i + 1}`, coordinates: offset(origin, Math.cos((deg * Math.PI) / 180) * km, Math.sin((deg * Math.PI) / 180) * km) };
  });
  const hub: BoardFixture = {
    key: 'synthetic:hub-and-spoke',
    label: 'Hub and spoke: a hub with five spokes 35–70 km out',
    source: 'synthetic',
    destinationName: 'Hubshire',
    entityType: 'natural_region',
    center: origin,
    nights: 7,
    bases: [{ name: 'Hub City', coordinates: origin, nightsHint: 5 }, ...spokes.slice(0, 3).map((s) => ({ name: `${s.name} Village`, coordinates: s.coordinates, nightsHint: 1 }))],
    places: [...cluster('Hub City', origin, 8, 5, 2), ...spokes.flatMap((s, i) => cluster(s.name, s.coordinates, 4, 6, i + 6))],
  };

  /* 5. A mainland town and an island 25 km offshore: every crossing is a ferry (75 minutes on top of the road either side). */
  const island = offset(origin, -5, 45);
  const isIsland = (p: { lat: number; lng: number }) => p.lng > origin.lng + 0.35;
  const ferry: BoardFixture = {
    key: 'synthetic:island-ferry',
    label: 'Mainland and an island reached by a 75-minute ferry',
    source: 'synthetic',
    destinationName: 'Ferryland',
    entityType: 'natural_region',
    center: offset(origin, -2, 22),
    nights: 6,
    bases: [
      { name: 'Mainland Port', coordinates: origin, nightsHint: 4 },
      { name: 'Island Town', coordinates: island, nightsHint: 2 },
    ],
    places: [...cluster('Mainland Port', origin, 10, 10, 3), ...cluster('Island Town', island, 8, 7, 7)],
    crossing: (a, b) => (isIsland(a) !== isIsland(b) ? 75 : null),
  };

  return [compact, linear, twin, hub, ferry];
}

export function evaluationBoards(): BoardFixture[] {
  return [...recordedBoards(), ...benchBoards(), fixtureProposalBoard(6), fixtureProposalBoard(12), ...syntheticBoards()];
}
