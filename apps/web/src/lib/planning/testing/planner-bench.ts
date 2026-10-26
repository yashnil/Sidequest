import type { Interest } from '@sidequest/core';
import type { PlannerBase, PlannerCandidate, PlannerDayWeather, StructurePlannerInput } from '../structure-planner';

/**
 * THE PLANNER BENCH — serialised `StructurePlannerInput`s for the greedy vs
 * improved comparison (`structure-improve.test.ts`, `planner-bench.perf.test.ts`).
 *
 * Each trip is a board the way `composeWithPlanner` hands it to the planner:
 * candidates with the traveller's statuses, bases with their nights, the
 * arrival/departure-aware windows, a forecast, and the travel minutes as a
 * matrix over every id. The places are real and their coordinates approximately
 * right, so the geography is a real region's; durations, fits and statuses are
 * the bench's own. Minutes come from straight-line distance through a mode
 * model fixed here (drive ≈ 55 km/h on a 1.25 road factor; car-free walks up
 * to 1.6 km, then transit at a fixed overhead), computed once and stored as a
 * matrix so the planner reads a table, as it does in production.
 *
 * Nothing in the planner may branch on these names (never patch a destination
 * by name); they are test data.
 */

export interface BenchTrip {
  key: string;
  label: string;
  input: StructurePlannerInput;
}

type Seed = [id: string, name: string, lat: number, lng: number, extra?: Partial<PlannerCandidate>];

function candidate([id, name, lat, lng, extra]: Seed, locality: string): PlannerCandidate {
  return {
    id,
    name,
    locality,
    coordinates: { lat, lng },
    durationMinutes: 90,
    intensity: 'easy',
    bestTime: 'any',
    exposure: 'outdoor',
    visibilityDependent: false,
    rainyDayOk: false,
    interests: ['scenic_viewpoints'],
    primaryInterest: 'scenic_viewpoints',
    category: 'viewpoint',
    kindLabel: 'Viewpoint',
    fit: 70,
    significance: 0.5,
    dayTrip: false,
    why: 'Bench candidate.',
    booking: 'none',
    openOnTripDates: true,
    status: 'candidate',
    ...extra,
  };
}

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A serialised matrix: what the planner reads, and what a fixture file would hold. */
export interface MinutesMatrix {
  ids: string[];
  minutes: (number | null)[][];
}

export function buildMatrix(points: ReadonlyMap<string, { lat: number; lng: number }>, carAvailable: boolean, unknownPairs: readonly [string, string][] = []): MinutesMatrix {
  const ids = [...points.keys()].sort();
  const unknown = new Set(unknownPairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const minutes = ids.map((a) =>
    ids.map((b) => {
      if (a === b) return 0;
      if (unknown.has(`${a}|${b}`)) return null;
      const d = km(points.get(a)!, points.get(b)!);
      if (carAvailable) return Math.round(4 + (d * 1.25 * 60) / 55);
      if (d <= 1.6) return Math.round(d * 13);
      return Math.round(12 + d * 2.2);
    }),
  );
  return { ids, minutes };
}

export function matrixMinutes(matrix: MinutesMatrix): StructurePlannerInput['minutes'] {
  const index = new Map(matrix.ids.map((id, i) => [id, i]));
  return (a, b) => {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) return null;
    return matrix.minutes[i]![j] ?? null;
  };
}

function dates(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) {
    out.push(new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function assemble(args: {
  name: string;
  days: string[];
  bases: { id: string; name: string; lat: number; lng: number; nights: number; transfer?: number }[];
  candidates: PlannerCandidate[];
  carAvailable: boolean;
  pace?: StructurePlannerInput['pace'];
  maxStopsPerDay?: number;
  maxDailyTravelMinutes?: number;
  maxPhysicalIntensity?: StructurePlannerInput['maxPhysicalIntensity'];
  frequencyCaps?: StructurePlannerInput['frequencyCaps'];
  weather?: PlannerDayWeather[];
  arrival?: number;
  departure?: number;
  unknownPairs?: [string, string][];
  edgeTransfers?: StructurePlannerInput['edgeTransfers'];
}): StructurePlannerInput {
  let cursor = 0;
  const bases: PlannerBase[] = args.bases.map((b) => {
    const fromDate = args.days[cursor]!;
    cursor += b.nights;
    const toDate = args.days[Math.min(cursor, args.days.length - 1)]!;
    return { id: b.id, name: b.name, why: 'Bench base.', coordinates: { lat: b.lat, lng: b.lng }, fromDate, toDate, nights: b.nights, transferMinutesFromPrevious: b.transfer ?? 0 };
  });
  const points = new Map<string, { lat: number; lng: number }>([...bases.map((b) => [b.id, b.coordinates] as const), ...args.candidates.map((c) => [c.id, c.coordinates] as const)]);
  const matrix = buildMatrix(points, args.carAvailable, args.unknownPairs);
  return {
    destinationName: args.name,
    windows: args.days.map((date, i) => ({ date, startMinute: i === 0 ? args.arrival ?? 13 * 60 : 9 * 60, endMinute: i === args.days.length - 1 ? args.departure ?? 12 * 60 : 19 * 60 })),
    bases,
    candidates: args.candidates,
    minutes: matrixMinutes(matrix),
    pace: args.pace ?? 'balanced',
    maxStopsPerDay: args.maxStopsPerDay ?? 3,
    carAvailable: args.carAvailable,
    maxDailyTravelMinutes: args.maxDailyTravelMinutes ?? 240,
    maxPhysicalIntensity: args.maxPhysicalIntensity ?? 'strenuous',
    frequencyCaps: args.frequencyCaps ?? {},
    weather: args.weather ?? [],
    foodAreas: [],
    ...(args.edgeTransfers ? { edgeTransfers: args.edgeTransfers } : {}),
  };
}

const kind = (interest: Interest, category: PlannerCandidate['category'], extra: Partial<PlannerCandidate> = {}): Partial<PlannerCandidate> => ({ interests: [interest], primaryInterest: interest, category, kindLabel: category, ...extra });
const indoor = (interest: Interest, category: PlannerCandidate['category'], extra: Partial<PlannerCandidate> = {}) => kind(interest, category, { exposure: 'indoor', rainyDayOk: true, ...extra });
const rain = (date: string, severity: 1 | 2 | 3 = 2): PlannerDayWeather => ({ date, severity, wet: true, windy: severity >= 2, poorVisibility: severity >= 2, label: severity >= 2 ? 'rain forecast' : 'showers possible' });

/** Lisbon without a car: districts a tram ride apart, Sintra and Cascais as day trips, one wet day. */
function lisbon(): BenchTrip {
  const days = dates('2026-10-06', 6);
  const seeds: [Seed, string][] = [
    [['lx-castelo', 'Castelo de São Jorge', 38.7139, -9.1335, kind('architecture_and_landmarks', 'landmark', { status: 'must', fit: 88, significance: 0.85, zone: 'Alfama' })], 'Alfama'],
    [['lx-alfama', 'Alfama lanes', 38.7114, -9.1299, kind('neighbourhoods_and_local_life', 'neighbourhood', { status: 'recommended', fit: 84, zone: 'Alfama' })], 'Alfama'],
    [['lx-se', 'Lisbon Cathedral', 38.7098, -9.1336, indoor('history_and_culture', 'historic', { fit: 66, zone: 'Alfama', durationMinutes: 45 })], 'Alfama'],
    [['lx-tile', 'National Tile Museum', 38.7247, -9.1135, indoor('museums_and_galleries', 'museum', { status: 'recommended', fit: 82, zone: 'Xabregas' })], 'Xabregas'],
    [['lx-baixa', 'Baixa and Praça do Comércio', 38.7075, -9.1364, kind('neighbourhoods_and_local_life', 'neighbourhood', { fit: 72, zone: 'Baixa', durationMinutes: 75 })], 'Baixa'],
    [['lx-santa-justa', 'Santa Justa Lift', 38.7121, -9.1394, kind('scenic_viewpoints', 'viewpoint', { fit: 61, zone: 'Baixa', durationMinutes: 40 })], 'Baixa'],
    [['lx-bairro', 'Bairro Alto evening', 38.7136, -9.1446, kind('neighbourhoods_and_local_life', 'neighbourhood', { fit: 71, zone: 'Bairro Alto', bestTime: 'night', durationMinutes: 120 })], 'Bairro Alto'],
    [['lx-senhora', 'Miradouro da Senhora do Monte', 38.7192, -9.1328, kind('photography_golden_hour', 'viewpoint', { status: 'recommended', fit: 80, bestTime: 'sunset', durationMinutes: 45, zone: 'Graça' })], 'Graça'],
    [['lx-jeronimos', 'Jerónimos Monastery', 38.6979, -9.2068, indoor('history_and_culture', 'historic', { status: 'must', fit: 90, significance: 0.9, zone: 'Belém', durationMinutes: 120, booking: 'recommended' })], 'Belém'],
    [['lx-torre', 'Belém Tower', 38.6916, -9.216, kind('architecture_and_landmarks', 'landmark', { fit: 74, significance: 0.8, zone: 'Belém', durationMinutes: 60 })], 'Belém'],
    [['lx-maat', 'MAAT', 38.6958, -9.1945, indoor('museums_and_galleries', 'museum', { fit: 68, zone: 'Belém' })], 'Belém'],
    [['lx-gulbenkian', 'Gulbenkian Museum', 38.7372, -9.1545, indoor('museums_and_galleries', 'museum', { status: 'maybe', fit: 78, zone: 'Avenidas Novas', durationMinutes: 150 })], 'Avenidas Novas'],
    [['lx-lx-factory', 'LX Factory', 38.7036, -9.1786, kind('markets_and_street_food', 'neighbourhood', { fit: 70, zone: 'Alcântara', durationMinutes: 90 })], 'Alcântara'],
    [['lx-timeout', 'Time Out Market', 38.7069, -9.1459, indoor('markets_and_street_food', 'food', { status: 'recommended', fit: 79, zone: 'Cais do Sodré', durationMinutes: 75 })], 'Cais do Sodré'],
    [['lx-oceanario', 'Oceanário', 38.7635, -9.0937, indoor('wildlife', 'wildlife', { fit: 73, zone: 'Parque das Nações', durationMinutes: 150 })], 'Parque das Nações'],
    [['lx-sintra', 'Sintra palaces', 38.7876, -9.3906, kind('architecture_and_landmarks', 'landmark', { status: 'recommended', fit: 92, significance: 0.9, dayTrip: true, durationMinutes: 300, zone: 'Sintra' })], 'Sintra'],
    [['lx-cascais', 'Cascais and the coast', 38.6979, -9.4215, kind('beaches_and_swimming', 'water', { fit: 76, dayTrip: true, durationMinutes: 240, zone: 'Cascais' })], 'Cascais'],
    [['lx-fado', 'Fado in Mouraria', 38.7155, -9.1352, indoor('neighbourhoods_and_local_life', 'neighbourhood', { status: 'maybe', fit: 77, bestTime: 'night', durationMinutes: 120, zone: 'Mouraria' })], 'Mouraria'],
  ];
  const candidates = seeds.map(([s, loc]) => candidate(s, loc));
  return {
    key: 'lisbon-car-free',
    label: 'Lisbon, car-free city, 6 days',
    input: assemble({ name: 'Lisbon', days, bases: [{ id: 'lx-base', name: 'Chiado', lat: 38.7107, lng: -9.1421, nights: 5 }], candidates, carAvailable: false, maxDailyTravelMinutes: 180, weather: [rain(days[2]!)] }),
  };
}

/** Ireland by car: Dublin → Galway → Killarney, the founder-trip shape, with day trips and hard hikes. */
function ireland(): BenchTrip {
  const days = dates('2026-09-14', 8);
  const seeds: [Seed, string][] = [
    [['ie-trinity', 'Trinity College and the Book of Kells', 53.3438, -6.2546, indoor('history_and_culture', 'historic', { status: 'must', fit: 86, significance: 0.85, durationMinutes: 90 })], 'Dublin'],
    [['ie-guinness', 'Guinness Storehouse', 53.3419, -6.2867, indoor('food_and_towns', 'food', { fit: 70, durationMinutes: 120 })], 'Dublin'],
    [['ie-howth', 'Howth cliff walk', 53.3786, -6.0657, kind('hiking', 'hike', { status: 'recommended', fit: 83, intensity: 'moderate', durationMinutes: 180 })], 'Howth'],
    [['ie-glendalough', 'Glendalough', 53.0104, -6.3298, kind('hiking', 'hike', { status: 'recommended', fit: 89, significance: 0.8, intensity: 'moderate', dayTrip: true, durationMinutes: 240 })], 'Wicklow'],
    [['ie-moher', 'Cliffs of Moher', 52.9715, -9.4309, kind('scenic_viewpoints', 'viewpoint', { status: 'must', fit: 93, significance: 0.95, durationMinutes: 120, visibilityDependent: true })], 'Clare'],
    [['ie-burren', 'The Burren', 53.0076, -9.0026, kind('easy_nature_walks', 'nature', { fit: 74, durationMinutes: 120 })], 'Clare'],
    [['ie-connemara', 'Connemara National Park, Diamond Hill', 53.5503, -9.9466, kind('hiking', 'hike', { status: 'recommended', fit: 85, intensity: 'strenuous', durationMinutes: 210 })], 'Connemara'],
    [['ie-kylemore', 'Kylemore Abbey', 53.5615, -9.8892, indoor('architecture_and_landmarks', 'historic', { fit: 72, durationMinutes: 120 })], 'Connemara'],
    [['ie-galway', 'Galway Latin Quarter', 53.2719, -9.0533, kind('neighbourhoods_and_local_life', 'neighbourhood', { fit: 76, durationMinutes: 120, bestTime: 'night' })], 'Galway'],
    [['ie-aran', 'Inis Mór', 53.1219, -9.7164, kind('scenic_viewpoints', 'water', { status: 'maybe', fit: 81, dayTrip: true, durationMinutes: 360 })], 'Aran Islands'],
    [['ie-kerry', 'Ring of Kerry', 51.9441, -10.2202, kind('scenic_drives', 'scenic_drive', { status: 'recommended', fit: 88, significance: 0.85, durationMinutes: 300 })], 'Kerry'],
    [['ie-dunloe', 'Gap of Dunloe', 52.0167, -9.6333, kind('hiking', 'hike', { status: 'recommended', fit: 87, intensity: 'strenuous', durationMinutes: 240 })], 'Killarney'],
    [['ie-muckross', 'Muckross House and gardens', 52.0187, -9.5045, indoor('history_and_culture', 'historic', { fit: 73, durationMinutes: 120 })], 'Killarney'],
    [['ie-torc', 'Torc Waterfall', 52.0047, -9.5076, kind('lakes_and_rivers', 'nature', { fit: 69, durationMinutes: 60 })], 'Killarney'],
    [['ie-carrauntoohil', 'Carrauntoohil', 51.9994, -9.7425, kind('hiking', 'hike', { fit: 80, intensity: 'strenuous', durationMinutes: 420 })], 'Killarney'],
    [['ie-dingle', 'Slea Head Drive', 52.1132, -10.4562, kind('scenic_drives', 'scenic_drive', { fit: 84, dayTrip: true, durationMinutes: 300 })], 'Dingle'],
    [['ie-ladies', "Ladies' View", 51.9686, -9.6044, kind('photography_golden_hour', 'viewpoint', { fit: 75, bestTime: 'sunset', durationMinutes: 40 })], 'Killarney'],
  ];
  const candidates = seeds.map(([s, loc]) => candidate(s, loc));
  return {
    key: 'ireland-road-trip',
    label: 'Ireland road trip, 3 bases, 8 days',
    input: assemble({
      name: 'Ireland',
      days,
      bases: [
        { id: 'ie-dublin', name: 'Dublin', lat: 53.3498, lng: -6.2603, nights: 2 },
        { id: 'ie-galway-base', name: 'Galway', lat: 53.2707, lng: -9.0568, nights: 2, transfer: 150 },
        { id: 'ie-killarney', name: 'Killarney', lat: 52.0599, lng: -9.5044, nights: 3, transfer: 150 },
      ],
      candidates,
      carAvailable: true,
      maxDailyTravelMinutes: 300,
      weather: [rain(days[3]!), rain(days[5]!, 1)],
      edgeTransfers: { arrivalMinutes: 25, departureMinutes: 30 },
    }),
  };
}

/** New Zealand's southern lakes by car: Queenstown then Te Anau, hard tracks, a night for the stars, Milford Sound as the far day, wet days. */
function southernLakes(): BenchTrip {
  const days = dates('2026-11-23', 7);
  const seeds: [Seed, string][] = [
    [['nz-skyline', 'Skyline Gondola', -45.0303, 168.6496, kind('scenic_viewpoints', 'viewpoint', { status: 'recommended', fit: 80, durationMinutes: 90 })], 'Queenstown'],
    [['nz-ben-lomond', 'Ben Lomond Track', -45.0059, 168.6229, kind('hiking', 'hike', { status: 'recommended', fit: 86, intensity: 'strenuous', durationMinutes: 360 })], 'Queenstown'],
    [['nz-arrowtown', 'Arrowtown', -44.9387, 168.8333, kind('history_and_culture', 'historic', { status: 'must', fit: 84, significance: 0.8, durationMinutes: 120 })], 'Arrowtown'],
    [['nz-gibbston', 'Gibbston Valley wineries', -45.0236, 168.9489, indoor('food_and_towns', 'food', { fit: 74, durationMinutes: 150 })], 'Gibbston'],
    [['nz-glenorchy', 'Glenorchy road', -44.8508, 168.3887, kind('scenic_drives', 'scenic_drive', { status: 'recommended', fit: 85, significance: 0.8, durationMinutes: 180 })], 'Glenorchy'],
    [['nz-roys-peak', "Roy's Peak", -44.6545, 169.0465, kind('hiking', 'hike', { fit: 83, intensity: 'strenuous', durationMinutes: 360, bestTime: 'sunrise' })], 'Wānaka'],
    [['nz-wanaka-tree', 'Lake Wānaka shore', -44.6993, 169.1324, kind('lakes_and_rivers', 'water', { fit: 72, durationMinutes: 60, bestTime: 'sunset' })], 'Wānaka'],
    [['nz-onsen', 'Onsen hot pools', -44.9885, 168.6902, indoor('hot_springs', 'relaxation', { fit: 70, durationMinutes: 90 })], 'Queenstown'],
    [['nz-stars', 'Stargazing above the lake', -45.0312, 168.6626, kind('stargazing', 'viewpoint', { status: 'maybe', fit: 81, bestTime: 'night', durationMinutes: 90 })], 'Queenstown'],
    [['nz-milford', 'Milford Sound cruise', -44.6414, 167.8974, kind('lakes_and_rivers', 'water', { status: 'must', fit: 93, significance: 0.95, durationMinutes: 150, visibilityDependent: true })], 'Fiordland'],
    [['nz-key-summit', 'Key Summit', -44.8331, 168.1219, kind('hiking', 'hike', { status: 'recommended', fit: 87, intensity: 'moderate', durationMinutes: 180 })], 'Fiordland'],
    [['nz-kepler', 'Kepler Track day section', -45.4374, 167.6869, kind('hiking', 'hike', { status: 'recommended', fit: 85, intensity: 'strenuous', durationMinutes: 420 })], 'Te Anau'],
    [['nz-glowworm', 'Te Anau glowworm caves', -45.4141, 167.7189, indoor('wildlife', 'wildlife', { status: 'recommended', fit: 84, durationMinutes: 150, booking: 'required' })], 'Te Anau'],
    [['nz-mirror', 'Mirror Lakes', -45.0359, 168.0129, kind('scenic_viewpoints', 'viewpoint', { fit: 78, durationMinutes: 30, bestTime: 'sunrise' })], 'Fiordland'],
    [['nz-lake-te-anau', 'Lake Te Anau foreshore', -45.4167, 167.7167, kind('easy_nature_walks', 'nature', { fit: 69, durationMinutes: 60, bestTime: 'sunset' })], 'Te Anau'],
    [['nz-manapouri', 'Doubtful Sound', -45.5169, 167.2714, kind('wildlife', 'water', { fit: 90, significance: 0.9, dayTrip: true, durationMinutes: 420 })], 'Manapōuri'],
    [['nz-museum', 'Fiordland heritage centre', -45.4145, 167.7181, indoor('museums_and_galleries', 'museum', { fit: 63, durationMinutes: 60 })], 'Te Anau'],
  ];
  const candidates = seeds.map(([s, loc]) => candidate(s, loc));
  return {
    key: 'southern-lakes',
    label: 'NZ southern lakes, 2 bases, 7 days',
    input: assemble({
      name: 'Southern Lakes',
      days,
      bases: [
        { id: 'nz-queenstown', name: 'Queenstown', lat: -45.0312, lng: 168.6626, nights: 3 },
        { id: 'nz-te-anau', name: 'Te Anau', lat: -45.4145, lng: 167.7181, nights: 3, transfer: 150 },
      ],
      candidates,
      carAvailable: true,
      maxDailyTravelMinutes: 300,
      weather: [rain(days[1]!, 3), rain(days[4]!), rain(days[5]!, 1)],
      edgeTransfers: { arrivalMinutes: 20, departureMinutes: 20 },
      unknownPairs: [['nz-mirror', 'nz-te-anau'], ['nz-gibbston', 'nz-arrowtown']],
    }),
  };
}

/** Mammoth Lakes as a hub: hard hikes that need spacing, a sunrise at Mono Lake, Bodie as the far day trip. */
function mammoth(): BenchTrip {
  const days = dates('2026-08-17', 6);
  const seeds: [Seed, string][] = [
    [['ml-duck', 'Duck Pass', 37.5889, -118.9877, kind('hiking', 'hike', { status: 'recommended', fit: 90, intensity: 'strenuous', durationMinutes: 300 })], 'Lakes Basin'],
    [['ml-crest', 'Mammoth Crest', 37.6005, -119.0076, kind('hiking', 'hike', { status: 'recommended', fit: 88, intensity: 'strenuous', durationMinutes: 270 })], 'Lakes Basin'],
    [['ml-morrison', 'Convict Lake loop', 37.5932, -118.8506, kind('lakes_and_rivers', 'water', { status: 'recommended', fit: 84, durationMinutes: 90 })], 'Convict Lake'],
    [['ml-postpile', 'Devils Postpile', 37.6251, -119.0849, kind('easy_nature_walks', 'nature', { status: 'must', fit: 87, significance: 0.85, durationMinutes: 90 })], 'Reds Meadow'],
    [['ml-rainbow', 'Rainbow Falls', 37.6033, -119.0827, kind('lakes_and_rivers', 'nature', { status: 'recommended', fit: 86, intensity: 'moderate', durationMinutes: 120 })], 'Reds Meadow'],
    [['ml-minaret', 'Minaret Vista', 37.6553, -119.0651, kind('photography_golden_hour', 'viewpoint', { fit: 82, bestTime: 'sunset', durationMinutes: 45 })], 'Minaret Vista'],
    [['ml-mono', 'Mono Lake South Tufa', 37.9389, -119.0272, kind('scenic_viewpoints', 'viewpoint', { status: 'recommended', fit: 85, bestTime: 'sunrise', durationMinutes: 75 })], 'Mono Lake'],
    [['ml-june', 'June Lake Loop', 37.7829, -119.0743, kind('scenic_drives', 'scenic_drive', { fit: 80, durationMinutes: 150 })], 'June Lake'],
    [['ml-hotcreek', 'Hot Creek Geological Site', 37.6606, -118.8279, kind('geology_and_geothermal', 'geothermal', { fit: 76, durationMinutes: 45 })], 'Hot Creek'],
    [['ml-bodie', 'Bodie State Historic Park', 38.2122, -119.0112, kind('history_and_culture', 'historic', { status: 'recommended', fit: 83, dayTrip: true, durationMinutes: 180 })], 'Bodie'],
    [['ml-bishop', 'Bishop and the Owens Valley', 37.3635, -118.3951, kind('food_and_towns', 'neighbourhood', { fit: 70, dayTrip: true, durationMinutes: 180 })], 'Bishop'],
    [['ml-gondola', 'Panorama Gondola', 37.6304, -119.0326, kind('scenic_viewpoints', 'viewpoint', { fit: 78, durationMinutes: 120 })], 'Mammoth Mountain'],
    [['ml-mcgee', 'McGee Creek', 37.5568, -118.7848, kind('hiking', 'hike', { fit: 77, intensity: 'strenuous', durationMinutes: 240 })], 'McGee Creek'],
    [['ml-village', 'The Village', 37.6505, -118.9777, kind('food_and_towns', 'food', { fit: 65, durationMinutes: 90, bestTime: 'night' })], 'Mammoth Lakes'],
    [['ml-obsidian', 'Obsidian Dome', 37.7558, -119.0247, kind('easy_nature_walks', 'nature', { fit: 69, durationMinutes: 60 })], 'Inyo Craters'],
  ];
  const candidates = seeds.map(([s, loc]) => candidate(s, loc));
  return {
    key: 'mammoth-hub',
    label: 'Mammoth Lakes hub, 6 days, hard hikes',
    input: assemble({ name: 'Mammoth Lakes', days, bases: [{ id: 'ml-base', name: 'Mammoth Lakes', lat: 37.6485, lng: -118.9721, nights: 5 }], candidates, carAvailable: true, maxDailyTravelMinutes: 240, weather: [rain(days[3]!)] }),
  };
}

/** Kyoto without a car, a day-trip-heavy board: Nara, Osaka, Himeji and Kobe all compete for whole days. */
function kyoto(): BenchTrip {
  const days = dates('2026-11-09', 6);
  const seeds: [Seed, string][] = [
    [['ky-kiyomizu', 'Kiyomizu-dera', 34.9949, 135.785, kind('architecture_and_landmarks', 'landmark', { status: 'must', fit: 90, significance: 0.9, durationMinutes: 90, zone: 'Higashiyama' })], 'Higashiyama'],
    [['ky-gion', 'Gion and Hanamikoji', 35.0037, 135.7751, kind('neighbourhoods_and_local_life', 'neighbourhood', { status: 'recommended', fit: 85, bestTime: 'sunset', durationMinutes: 90, zone: 'Higashiyama' })], 'Higashiyama'],
    [['ky-sannenzaka', 'Sannenzaka', 34.9968, 135.7809, kind('markets_and_street_food', 'neighbourhood', { fit: 73, durationMinutes: 60, zone: 'Higashiyama' })], 'Higashiyama'],
    [['ky-fushimi', 'Fushimi Inari', 34.9671, 135.7727, kind('hiking', 'hike', { status: 'recommended', fit: 88, significance: 0.9, intensity: 'moderate', durationMinutes: 150, zone: 'Fushimi', bestTime: 'morning' })], 'Fushimi'],
    [['ky-arashiyama', 'Arashiyama bamboo grove', 35.0094, 135.6668, kind('easy_nature_walks', 'nature', { status: 'recommended', fit: 86, durationMinutes: 120, zone: 'Arashiyama', bestTime: 'morning' })], 'Arashiyama'],
    [['ky-tenryuji', 'Tenryū-ji', 35.0156, 135.6738, indoor('history_and_culture', 'historic', { fit: 76, durationMinutes: 60, zone: 'Arashiyama' })], 'Arashiyama'],
    [['ky-kinkakuji', 'Kinkaku-ji', 35.0394, 135.7292, kind('architecture_and_landmarks', 'landmark', { fit: 84, significance: 0.85, durationMinutes: 60, zone: 'Kitayama' })], 'Kitayama'],
    [['ky-ryoanji', 'Ryōan-ji', 35.0345, 135.7182, kind('history_and_culture', 'historic', { fit: 74, durationMinutes: 45, zone: 'Kitayama' })], 'Kitayama'],
    [['ky-nishiki', 'Nishiki Market', 35.005, 135.7649, indoor('markets_and_street_food', 'food', { status: 'recommended', fit: 82, durationMinutes: 75, zone: 'Downtown' })], 'Downtown'],
    [['ky-philosopher', "Philosopher's Path", 35.0269, 135.7948, kind('easy_nature_walks', 'nature', { fit: 78, durationMinutes: 90, zone: 'Higashiyama North' })], 'Higashiyama North'],
    [['ky-ginkakuji', 'Ginkaku-ji', 35.027, 135.7982, kind('architecture_and_landmarks', 'landmark', { fit: 77, durationMinutes: 60, zone: 'Higashiyama North' })], 'Higashiyama North'],
    [['ky-nijo', 'Nijō Castle', 35.0142, 135.7481, indoor('history_and_culture', 'historic', { status: 'maybe', fit: 79, durationMinutes: 90, zone: 'Nijō' })], 'Nijō'],
    [['ky-nara', 'Nara Park and Tōdai-ji', 34.689, 135.8398, kind('history_and_culture', 'historic', { status: 'recommended', fit: 89, significance: 0.85, dayTrip: true, durationMinutes: 300, zone: 'Nara' })], 'Nara'],
    [['ky-osaka', 'Osaka food streets', 34.6687, 135.5013, kind('food_and_towns', 'food', { fit: 80, dayTrip: true, durationMinutes: 300, zone: 'Osaka' })], 'Osaka'],
    [['ky-himeji', 'Himeji Castle', 34.8394, 134.6939, kind('architecture_and_landmarks', 'landmark', { fit: 83, significance: 0.85, dayTrip: true, durationMinutes: 240, zone: 'Himeji' })], 'Himeji'],
    [['ky-uji', 'Uji and Byōdō-in', 34.8893, 135.8077, kind('history_and_culture', 'historic', { fit: 75, dayTrip: true, durationMinutes: 180, zone: 'Uji' })], 'Uji'],
  ];
  const candidates = seeds.map(([s, loc]) => candidate(s, loc));
  return {
    key: 'kyoto-day-trips',
    label: 'Kyoto car-free, day-trip-heavy, 6 days',
    input: assemble({ name: 'Kyoto', days, bases: [{ id: 'ky-base', name: 'Kyoto Station', lat: 34.9858, lng: 135.7588, nights: 5 }], candidates, carAvailable: false, maxDailyTravelMinutes: 240, maxStopsPerDay: 3 }),
  };
}

export function benchTrips(): BenchTrip[] {
  return [lisbon(), ireland(), southernLakes(), mammoth(), kyoto()];
}

/**
 * The size the planner must stay fast at: sixty candidates over fourteen days
 * and three bases, generated deterministically (a fixed linear-congruential
 * sequence, no Math.random) around three real bases in Norway's fjords.
 */
export function largeBenchTrip(): BenchTrip {
  const days = dates('2026-06-08', 14);
  const bases = [
    { id: 'no-bergen', name: 'Bergen', lat: 60.3913, lng: 5.3221, nights: 4 },
    { id: 'no-flam', name: 'Flåm', lat: 60.8628, lng: 7.1137, nights: 5, transfer: 180 },
    { id: 'no-geiranger', name: 'Geiranger', lat: 62.1008, lng: 7.2059, nights: 4, transfer: 240 },
  ];
  let seed = 20260608;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const interests: Interest[] = ['hiking', 'scenic_viewpoints', 'lakes_and_rivers', 'history_and_culture', 'museums_and_galleries', 'food_and_towns', 'lakes_and_rivers', 'scenic_drives'];
  const statuses: PlannerCandidate['status'][] = ['must', 'recommended', 'recommended', 'maybe', 'candidate', 'candidate', 'candidate', 'candidate'];
  const candidates: PlannerCandidate[] = [];
  for (let i = 0; i < 60; i += 1) {
    const base = bases[i % 3]!;
    const interest = interests[Math.floor(next() * interests.length)]!;
    const roll = next();
    const status = i < 3 ? 'must' : statuses[Math.floor(roll * statuses.length)]!;
    const far = next() < 0.12;
    const spread = far ? 0.9 : 0.35;
    candidates.push(
      candidate(
        [
          `no-${String(i).padStart(2, '0')}`,
          `${base.name} place ${i}`,
          base.lat + (next() - 0.5) * spread,
          base.lng + (next() - 0.5) * spread * 1.8,
          {
            ...kind(interest, interest === 'hiking' ? 'hike' : interest === 'museums_and_galleries' ? 'museum' : 'nature'),
            status: status === 'must' && i >= 3 ? 'recommended' : status,
            fit: Math.round(55 + next() * 40),
            significance: Math.round(next() * 100) / 100,
            durationMinutes: [45, 60, 90, 120, 180, 240][Math.floor(next() * 6)]!,
            intensity: interest === 'hiking' ? (next() < 0.5 ? 'strenuous' : 'moderate') : 'easy',
            exposure: interest === 'museums_and_galleries' ? 'indoor' : 'outdoor',
            rainyDayOk: interest === 'museums_and_galleries',
            bestTime: next() < 0.06 ? 'sunset' : next() < 0.04 ? 'sunrise' : 'any',
            dayTrip: far,
            ...(i === 1 ? { pinnedDay: 7 } : {}),
          },
        ],
        base.name,
      ),
    );
  }
  return {
    key: 'norway-large',
    label: 'Norway fjords, 60 candidates × 14 days, 3 bases',
    input: assemble({ name: 'Western Norway', days, bases, candidates, carAvailable: true, maxDailyTravelMinutes: 300, maxStopsPerDay: 4, weather: [rain(days[2]!), rain(days[6]!, 3), rain(days[9]!)] }),
  };
}
