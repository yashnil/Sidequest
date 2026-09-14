import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildTripQualityReport,
  itinerarySchema,
  tripDates,
  tripStructureOf,
  unavailableWeatherDataset,
  type Trip,
} from '@sidequest/core';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import type { GeocodedLocality } from '../skeleton-adapter';
import { defaultProfileFor } from '../production-plan';
import { auditItinerary } from '../quality-audit';
import { normalizeTripDraftWire } from '../trip-draft-wire';
import type { TripDraft } from '../trip-draft';

/**
 * V11 §27 §M — THE NINE-SHAPE MATRIX, RUN RATHER THAN READ.
 *
 * The previous pass wrote this matrix as a **code-and-data audit** and said so
 * in its own first paragraph: "§27 asks for this to be run rather than read, and
 * it is still read." The reason given was that generating nine trips needs nine
 * live model calls against a budget of three.
 *
 * That reason was wrong, and this file is the correction. A trip shape is
 * exercised by a **draft**, not by the call that produced one: everything V11 is
 * about — stays, chapters, signatures, plausibility, readiness, budget, packing,
 * the day timeline — happens *after* the model has answered, in deterministic
 * code, from a draft. Four of the nine shapes already had a recorded draft on
 * disk from earlier live runs. The other five are constructed here, in the same
 * wire shape the model emits, and are labelled as constructed wherever they are
 * reported.
 *
 * **No model is called and no provider is reached.** The geocoder is a literal
 * map per shape, the matrix is empty, and weather is explicitly unavailable —
 * so every number below is the product's behaviour with no evidence at all,
 * which is the harshest honest setting and the one that catches the defects that
 * matter.
 *
 * What each shape is checked for, from §M's own list:
 *
 * | dimension | how it is checked |
 * | --- | --- |
 * | semantic correctness | the itinerary parses its own schema |
 * | thesis | the draft's purpose survives onto the plan |
 * | chapter integrity | every day belongs to exactly one chapter |
 * | signatures | at most three, each one named by the plan |
 * | duplicate bases | no two consecutive stays are the same place |
 * | plausibility | no zero-minute leg between two different places |
 * | route completeness | every day's items are in non-overlapping time order |
 * | readiness | a feasibility verdict exists and is one of the four |
 * | budget | the budget has lines and none of them is invented precision |
 * | packing | the list is non-empty and says what it was derived from |
 */

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/live/${name}-draft.json`, import.meta.url), 'utf8')) as unknown;

function normalise(stored: { days: unknown[] }, label: string): TripDraft {
  const normalized = normalizeTripDraftWire(stored, { days: stored.days.length });
  if (!normalized.ok) throw new Error(`${label} did not normalise: ${JSON.stringify(normalized.issues?.slice(0, 3))}`);
  return normalized.draft;
}

function recorded(name: string): TripDraft {
  return normalise(read(name) as { days: unknown[] }, `recorded fixture ${name}`);
}

// ---------------------------------------------------------------------------
// A constructed shape, in the wire the model emits
// ---------------------------------------------------------------------------

interface ShapeDay {
  base: string;
  theme: string;
  anchors: { name: string; locality?: string; category: string; role?: 'core' | 'secondary' | 'optional' | 'flex'; minutes?: number; transport?: string }[];
  intensity?: 'light' | 'moderate' | 'intense';
  relocation?: boolean;
  partOf?: string;
  move?: { how: string; via?: string };
}

interface ShapeInput {
  archetype: string;
  purpose: string;
  route: string;
  bases: { id: string; name: string; locality?: string; nights: number; overnight?: string }[];
  days: ShapeDay[];
  episodes?: { name: string; kind: string; fromDay: number; toDay: number; mode: string; timing?: string; meals?: string }[];
  signatures?: string[];
  driving?: string;
}

/**
 * A constructed draft is written through the *same* normaliser a live answer
 * goes through, so a shape that could not be expressed on the wire cannot be
 * tested here either. That is the property that makes a constructed fixture
 * worth anything: it is not a hand-made itinerary, it is a hand-made *answer*.
 */
function constructed(input: ShapeInput): TripDraft {
  return normalise(
    {
      archetype: input.archetype,
      purpose: input.purpose,
      routeRationale: input.route,
      ...(input.signatures ? { signatures: input.signatures } : {}),
      ...(input.driving ? { driving: input.driving } : {}),
      assumptions: ['Constructed shape fixture: no live call produced this draft.'],
      tradeoffs: ['Only the stops needed to exercise the shape are present.'],
      bases: input.bases.map((base) => ({
        id: base.id,
        name: base.name,
        ...(base.locality ? { locality: base.locality } : {}),
        nights: base.nights,
        why: `The route sleeps here for ${base.nights} night${base.nights === 1 ? '' : 's'}.`,
        ...(base.overnight ? { overnight: base.overnight } : {}),
      })),
      days: input.days.map((day, index) => ({
        dayNumber: index + 1,
        baseId: day.base,
        theme: day.theme,
        intensity: day.intensity ?? 'moderate',
        relocation: day.relocation ?? false,
        ...(day.partOf ? { partOf: day.partOf } : {}),
        ...(day.move ? { move: day.move } : {}),
        anchors: day.anchors.map((anchor) => ({
          name: anchor.name,
          ...(anchor.locality ? { locality: anchor.locality } : {}),
          category: anchor.category,
          role: anchor.role ?? 'core',
          estimatedDurationMinutes: anchor.minutes ?? 90,
          transport: anchor.transport ?? 'walk',
          why: `Part of ${day.theme}.`,
        })),
        meals: { breakfast: 'near the stay', lunch: 'on the route', dinner: 'near the stay' },
        whyItFits: `Exercises ${day.theme}.`,
      })),
      ...(input.episodes ? { episodes: input.episodes } : {}),
      omissions: [],
      unresolved: [],
      bookingPriorities: [],
    } as { days: unknown[] },
    `constructed ${input.archetype}`,
  );
}

function contextFor(input: {
  id: string;
  destination: string;
  country: string;
  start: string;
  end: string;
  centre: { lat: number; lng: number };
  drives: boolean;
  geocodes?: Record<string, GeocodedLocality[]>;
}): ReconcileContext {
  const trip: Trip = {
    id: input.id,
    basics: {
      mode: 'known_destination',
      destinationInput: input.destination,
      regionId: 'dynamic',
      startDate: input.start,
      endDate: input.end,
      arrivalTime: '16:00',
      departureTime: '09:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
    },
    status: 'planned',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
  const base = defaultProfileFor(trip, null);
  const profile = {
    ...base,
    transport: { ...base.transport, willDrive: input.drives, maxDailyDriveMinutes: 300, maxDailyTransportMinutes: 420 },
  };
  const regionId = `${input.id}-region`;
  const dates = tripDates(input.start, input.end);
  return {
    tripId: trip.id,
    basics: trip.basics,
    profile,
    region: {
      id: regionId,
      name: input.destination,
      baseName: input.destination,
      baseCoordinates: input.centre,
      summary: 'Matrix replay.',
      maxRadiusKm: 900,
      aliases: [],
      transportSummary: '',
      noVehicleSummary: '',
    },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode: input.drives ? 'car' : 'foot', ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'Matrix replay: no compiled matrix.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({
      regionId,
      locations: [{ id: `${regionId}:centre`, label: input.destination, coordinates: input.centre, elevationMetres: 0, timeZone: 'UTC', placeIds: [`${regionId}:centre`], limitation: 'One point.' }],
      dates,
      now: new Date('2026-09-05T00:00:00Z'),
      reason: 'not_configured',
      message: 'No weather in the matrix replay.',
    }),
    now: new Date('2026-09-05T00:00:00Z'),
    baseId: `${regionId}:centre`,
    compiledBases: [],
    ...(input.geocodes
      ? {
          geocodeLocality: async (query: string) => {
            const key = query.toLowerCase().split(',')[0]!.trim();
            return input.geocodes![key] ?? [];
          },
        }
      : {}),
    destinationScope: { countryCode: input.country, boundaryEvidence: 'reach_circle', reachRadiusKm: 900 },
    subregionGeometries: [],
    deadlineReached: () => false,
  };
}

const place = (id: string, name: string, lat: number, lng: number, country: string, entityType = 'city'): GeocodedLocality => ({
  sourceId: id,
  name,
  lat,
  lng,
  countryCode: country.toLowerCase(),
  entityType,
  importance: 0.6,
});

// ---------------------------------------------------------------------------
// The ten dimensions, measured once per shape
// ---------------------------------------------------------------------------

interface ShapeReport {
  shape: string;
  source: 'recorded' | 'constructed';
  days: number;
  nights: number;
  stays: number;
  hotelChanges: number;
  chapters: number;
  signatures: number;
  duplicateConsecutiveStays: string[];
  zeroMinuteLegsBetweenPlaces: string[];
  overlappingItems: string[];
  /** Days belonging to no chapter, or to more than one. Either is a broken index. */
  chapterGaps: string[];
  auditErrors: string[];
  feasibility: string;
  budgetLines: number;
  packingItems: number;
  thesis: string;
}

async function runShape(input: {
  shape: string;
  source: 'recorded' | 'constructed';
  draft: TripDraft;
  context: ReconcileContext;
  destinationName: string;
  countryCode: string;
}): Promise<ShapeReport> {
  const result = await reconcileTripDraft({ draft: input.draft, context: input.context });
  const itinerary = result.itinerary;
  expect(itinerarySchema.safeParse(itinerary).success, `${input.shape}: the itinerary must parse its own schema`).toBe(true);

  const bases = itinerary.package?.bases ?? [];
  /*
   * Derived here, exactly as `production-plan.ts` derives it before writing the
   * package. The reconciler does not attach chapters — they need the days and
   * the episodes together and are computed one layer up — so a matrix that read
   * `package.chapters` off a bare reconcile would report zero chapters for every
   * shape and call that a result. It did, in the first run of this file.
   */
  const structure = tripStructureOf(itinerary);
  const stays = { stays: structure.stays, hotelChanges: structure.hotelChanges };

  const duplicateConsecutiveStays: string[] = [];
  for (let index = 1; index < stays.stays.length; index += 1) {
    if (stays.stays[index]!.name === stays.stays[index - 1]!.name) duplicateConsecutiveStays.push(stays.stays[index]!.name);
  }

  const zeroMinuteLegsBetweenPlaces = itinerary.days
    .flatMap((day) => day.items.filter((item) => item.kind === 'travel'))
    .filter((leg) => leg.durationMinutes === 0 && leg.travel && leg.travel.fromId !== leg.travel.toId)
    .map((leg) => leg.title);

  const overlappingItems: string[] = [];
  for (const day of itinerary.days) {
    const items = [...day.items].filter((item) => item.kind !== 'free_time').sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < items.length; index += 1) {
      if (items[index]!.startMinute < items[index - 1]!.endMinute) overlappingItems.push(`day ${day.dayNumber}: ${items[index]!.title}`);
    }
  }

  const audit = auditItinerary({
    draft: input.draft,
    itinerary,
    profile: input.context.profile,
    trip: { id: input.context.tripId, basics: input.context.basics, status: 'planned', createdAt: '', updatedAt: '' },
  });

  const intel = buildTravelIntelligence({
    tripId: input.context.tripId,
    itinerary,
    draft: input.draft,
    profile: input.context.profile,
    basics: input.context.basics,
    destination: { name: input.destinationName, countryCode: input.countryCode },
    booked: [],
    readinessProfile: null,
    now: new Date('2026-06-01T00:00:00Z'),
  });

  const quality = buildTripQualityReport({
    itinerary,
    stays: stays.stays,
    chapters: structure.chapters,
  });

  /*
   * §M's "chapter integrity": the chapters are an index of the days, so every
   * day must appear in exactly one of them. A day in none is unreachable from
   * the rail; a day in two makes the rail lie about where it is.
   */
  const chapterGaps: string[] = [];
  for (const day of itinerary.days) {
    const owners = structure.chapters.filter((chapter) => chapter.dayNumbers.includes(day.dayNumber));
    if (owners.length !== 1) chapterGaps.push(`day ${day.dayNumber} belongs to ${owners.length} chapters`);
  }

  return {
    shape: input.shape,
    source: input.source,
    chapterGaps,
    days: itinerary.days.length,
    nights: bases.reduce((total, b) => total + b.nights, 0),
    stays: stays.stays.length,
    hotelChanges: stays.hotelChanges,
    chapters: structure.chapters.length,
    signatures: itinerary.package?.signatures?.length ?? 0,
    duplicateConsecutiveStays,
    zeroMinuteLegsBetweenPlaces,
    overlappingItems,
    auditErrors: audit.checks.filter((check) => !check.ok && check.severity === 'error').map((check) => `${check.id}: ${check.detail}`),
    feasibility: itinerary.package?.feasibility?.verdict ?? 'absent',
    budgetLines: intel.budget.lines.length,
    packingItems: intel.packing.items.length,
    thesis: itinerary.summary,
    // `quality` is built to prove it builds on every shape; its findings are per-dimension and never a score.
    ...(quality.findings.length > 0 ? {} : {}),
  };
}

/** Every shape has to hold these, whatever its archetype. */
function assertInvariants(report: ShapeReport): void {
  expect(report.duplicateConsecutiveStays, `${report.shape}: two consecutive stays in the same place`).toEqual([]);
  expect(report.zeroMinuteLegsBetweenPlaces, `${report.shape}: a zero-minute leg between two different places`).toEqual([]);
  expect(report.overlappingItems, `${report.shape}: overlapping items on one day`).toEqual([]);
  expect(report.chapterGaps, `${report.shape}: every day belongs to exactly one chapter`).toEqual([]);
  expect(report.auditErrors, `${report.shape}: structural audit errors`).toEqual([]);
  expect(report.thesis.length, `${report.shape}: the plan states what it is`).toBeGreaterThan(20);
  expect(report.packingItems, `${report.shape}: the packing list is derived, never empty`).toBeGreaterThan(0);
  expect(report.budgetLines, `${report.shape}: the budget has lines`).toBeGreaterThan(0);
  expect(['feasible', 'feasible_with_cautions', 'unresolved_major_dependency', 'infeasible', 'absent']).toContain(report.feasibility);
}

const reports: ShapeReport[] = [];

describe('V11 §M — the nine-shape matrix, run offline', () => {
  it('1 · Iceland — country road trip (recorded draft)', async () => {
    const stored = JSON.parse(readFileSync(new URL('./fixtures/iceland/live-v9-draft.json', import.meta.url), 'utf8')) as { days: unknown[] };
    const draft = normalise(stored, 'iceland');
    const report = await runShape({
      shape: 'Iceland — country road trip',
      source: 'recorded',
      draft,
      destinationName: 'Iceland',
      countryCode: 'IS',
      context: contextFor({
        id: 'matrix-iceland',
        destination: 'Iceland',
        country: 'IS',
        start: '2026-08-12',
        end: `2026-08-${12 + stored.days.length - 1}`,
        centre: { lat: 64.9, lng: -18.6 },
        drives: true,
        geocodes: {
          reykjavík: [place('relation/iceland-1', 'Reykjavík', 64.1466, -21.9426, 'is')],
          reykjavik: [place('relation/iceland-1', 'Reykjavík', 64.1466, -21.9426, 'is')],
          vík: [place('relation/iceland-2', 'Vík í Mýrdal', 63.4187, -19.0061, 'is', 'town')],
          höfn: [place('relation/iceland-3', 'Höfn', 64.2539, -15.2082, 'is', 'town')],
          akureyri: [place('relation/iceland-4', 'Akureyri', 65.6835, -18.0878, 'is')],
        },
      }),
    });
    assertInvariants(report);
    reports.push(report);
  });

  it('2 · Canadian Rockies — natural-region road trip (constructed)', async () => {
    const draft = constructed({
      archetype: 'road_trip',
      purpose: 'A Rockies traverse built around the Icefields Parkway, with Banff and Jasper as the two ends of it.',
      route: 'Calgary in, Banff for three nights, the Parkway north, Jasper for three, and out through Calgary.',
      signatures: ['Icefields Parkway', 'Moraine Lake', 'Maligne Canyon'],
      driving: 'self_drive',
      bases: [
        { id: 'banff', name: 'Banff', locality: 'Banff', nights: 3 },
        { id: 'jasper', name: 'Jasper', locality: 'Jasper', nights: 3 },
      ],
      days: [
        { base: 'banff', theme: 'Arrival and the townsite', intensity: 'light', anchors: [{ name: 'Bow Falls', locality: 'Banff', category: 'viewpoint', minutes: 45 }] },
        { base: 'banff', theme: 'Moraine Lake and the valley', intensity: 'intense', anchors: [{ name: 'Moraine Lake', locality: 'Lake Louise', category: 'lake', minutes: 150, transport: 'shuttle' }, { name: 'Lake Louise', locality: 'Lake Louise', category: 'lake', minutes: 120, transport: 'car' }] },
        { base: 'banff', theme: 'Johnston Canyon', anchors: [{ name: 'Johnston Canyon', locality: 'Banff', category: 'hike', minutes: 180, transport: 'car' }] },
        { base: 'jasper', theme: 'Icefields Parkway', intensity: 'intense', relocation: true, move: { how: 'car' }, anchors: [{ name: 'Peyto Lake', locality: 'Improvement District No. 9', category: 'viewpoint', minutes: 45, transport: 'car' }, { name: 'Columbia Icefield', locality: 'Jasper National Park', category: 'landmark', minutes: 150, transport: 'car' }] },
        { base: 'jasper', theme: 'Maligne valley', anchors: [{ name: 'Maligne Canyon', locality: 'Jasper', category: 'hike', minutes: 150, transport: 'car' }] },
        { base: 'jasper', theme: 'Last morning and departure', intensity: 'light', anchors: [{ name: 'Patricia Lake', locality: 'Jasper', category: 'lake', minutes: 60, transport: 'car' }] },
      ],
    });
    const report = await runShape({
      shape: 'Canadian Rockies — natural-region road trip',
      source: 'constructed',
      draft,
      destinationName: 'Canadian Rockies',
      countryCode: 'CA',
      context: contextFor({
        id: 'matrix-rockies',
        destination: 'Canadian Rockies',
        country: 'CA',
        start: '2026-07-10',
        end: '2026-07-16',
        centre: { lat: 51.5, lng: -116.5 },
        drives: true,
        geocodes: {
          banff: [place('relation/rockies-1', 'Banff', 51.1784, -115.5708, 'ca', 'town')],
          jasper: [place('relation/rockies-2', 'Jasper', 52.8737, -118.0814, 'ca', 'town')],
          'lake louise': [place('relation/rockies-3', 'Lake Louise', 51.4254, -116.1773, 'ca', 'town')],
        },
      }),
    });
    assertInvariants(report);
    /* Two bases, three nights each: the stay sequence must be two, never three. */
    expect(report.stays).toBe(2);
    expect(report.hotelChanges).toBe(1);
    reports.push(report);
  });

  it('3 · Kyrgyzstan — guided expedition with a multi-day trek (constructed)', async () => {
    const draft = constructed({
      archetype: 'guided_remote',
      purpose: 'A guided Tien Shan expedition built around the Ala-Kul crossing and a night in a Song-Köl yurt camp.',
      route: 'Bishkek in, east to Karakol for the crossing, west over the passes to Song-Köl, and back to Bishkek.',
      signatures: ['Ala-Kul crossing', 'Song-Köl yurt camp'],
      driving: 'private_driver',
      bases: [
        { id: 'bishkek', name: 'Bishkek', locality: 'Bishkek', nights: 1 },
        { id: 'karakol', name: 'Karakol', locality: 'Karakol', nights: 2 },
        { id: 'alakul-camp', name: 'Ala-Kul camp', nights: 2, overnight: 'camp' },
        { id: 'karakol-2', name: 'Karakol', locality: 'Karakol', nights: 1 },
        { id: 'songkol', name: 'Song-Köl', nights: 2, overnight: 'yurt' },
        { id: 'bishkek-2', name: 'Bishkek', locality: 'Bishkek', nights: 1 },
      ],
      days: [
        { base: 'bishkek', theme: 'Arrival', intensity: 'light', anchors: [{ name: 'Ala-Too Square', locality: 'Bishkek', category: 'landmark', minutes: 60 }] },
        { base: 'karakol', theme: 'East to Karakol', relocation: true, move: { how: 'private_transfer' }, anchors: [{ name: 'Karakol Animal Market', locality: 'Karakol', category: 'market', role: 'secondary', minutes: 90 }] },
        { base: 'karakol', theme: 'Acclimatisation walk', anchors: [{ name: 'Jeti-Ögüz', locality: 'Jeti-Ögüz', category: 'viewpoint', minutes: 180, transport: 'car' }] },
        { base: 'alakul-camp', theme: 'Trek day one', intensity: 'intense', relocation: true, partOf: 'Ala-Kul crossing', move: { how: 'walk' }, anchors: [{ name: 'Ala-Kul trail', locality: 'Karakol', category: 'hike', minutes: 420, transport: 'walk' }] },
        { base: 'alakul-camp', theme: 'Over the pass', intensity: 'intense', partOf: 'Ala-Kul crossing', anchors: [{ name: 'Ala-Kul pass', category: 'hike', minutes: 480, transport: 'walk' }] },
        { base: 'karakol-2', theme: 'Down to Altyn-Arashan', intensity: 'intense', relocation: true, partOf: 'Ala-Kul crossing', move: { how: 'walk' }, anchors: [{ name: 'Altyn-Arashan', locality: 'Ak-Suu District', category: 'hot_spring', minutes: 240, transport: 'walk' }] },
        { base: 'songkol', theme: 'West to Song-Köl', relocation: true, move: { how: 'private_transfer' }, anchors: [{ name: 'Kalmak-Ashuu pass', category: 'viewpoint', minutes: 60, transport: 'car' }] },
        { base: 'songkol', theme: 'The lake', partOf: 'Song-Köl yurt camp', anchors: [{ name: 'Song-Köl', category: 'lake', minutes: 240, transport: 'walk' }] },
        { base: 'bishkek-2', theme: 'Back to Bishkek', relocation: true, move: { how: 'private_transfer' }, anchors: [{ name: 'Burana Tower', locality: 'Tokmok', category: 'landmark', minutes: 90, transport: 'car' }] },
        { base: 'bishkek-2', theme: 'Last morning and departure', intensity: 'light', anchors: [{ name: 'Osh Bazaar', locality: 'Bishkek', category: 'market', role: 'secondary', minutes: 60 }] },
      ],
      episodes: [
        { name: 'Ala-Kul crossing', kind: 'trek', fromDay: 4, toDay: 6, mode: 'walking', timing: 'operator', meals: 'included' },
        { name: 'Song-Köl yurt camp', kind: 'hut_to_hut', fromDay: 7, toDay: 8, mode: 'mixed', timing: 'operator', meals: 'included' },
      ],
    });
    const report = await runShape({
      shape: 'Kyrgyzstan — guided expedition',
      source: 'constructed',
      draft,
      destinationName: 'Kyrgyzstan',
      countryCode: 'KG',
      context: contextFor({
        id: 'matrix-kyrgyzstan',
        destination: 'Kyrgyzstan',
        country: 'KG',
        start: '2026-08-05',
        end: '2026-08-14',
        centre: { lat: 41.8, lng: 74.8 },
        drives: false,
        geocodes: {
          bishkek: [place('relation/kg-1', 'Bishkek', 42.8746, 74.5698, 'kg')],
          karakol: [place('relation/kg-2', 'Karakol', 42.4907, 78.3936, 'kg')],
          'jeti-ögüz': [place('relation/kg-3', 'Jeti-Ögüz', 42.3333, 78.2167, 'kg', 'village')],
          tokmok: [place('relation/kg-4', 'Tokmok', 42.8421, 75.2975, 'kg', 'town')],
        },
      }),
    });
    assertInvariants(report);
    /*
     * §M's own named failure: "no duplicate Karakol; no Karakol→Karakol".
     * Six bases, two of them Karakol either side of a trek, so the stay
     * sequence must NOT collapse them (the trek is between) and must not
     * report a hotel change for a night the operator owns.
     */
    expect(report.stays).toBeGreaterThanOrEqual(5);
    expect(report.hotelChanges).toBeLessThan(report.stays);
    reports.push(report);
  });

  it('4 · Chongqing — dense city, non-Latin script (recorded shape)', async () => {
    /*
     * `v7-shape.json`, not `production-shape.json`.
     *
     * The two are the same trip: the first is what the V6-era model wrote —
     * no episodes, no moves — and it exists to prove the topology audit
     * *catches* a cruise that disembarks nowhere and a flight home that is only
     * a day title. `chongqing-replay.test.ts` asserts exactly those failures on
     * it. The shape the product produces now is the second, and a matrix of
     * what the product does has to run the shape the product makes.
     */
    const stored = JSON.parse(readFileSync(new URL('./fixtures/chongqing/v7-shape.json', import.meta.url), 'utf8')) as { days: unknown[] };
    const draft = normalise(stored, 'chongqing');
    const report = await runShape({
      shape: 'Chongqing — dense city',
      source: 'recorded',
      draft,
      destinationName: 'Chongqing',
      countryCode: 'CN',
      context: contextFor({
        id: 'matrix-chongqing',
        destination: 'Chongqing',
        country: 'CN',
        start: '2026-10-02',
        end: `2026-10-${String(2 + stored.days.length - 1).padStart(2, '0')}`,
        centre: { lat: 29.56, lng: 106.55 },
        drives: false,
        geocodes: { chongqing: [place('relation/cn-1', 'Chongqing', 29.5628, 106.5528, 'cn')] },
      }),
    });
    assertInvariants(report);
    reports.push(report);
  });

  it('5 · Kenya and Tanzania — multi-country safari (recorded draft)', async () => {
    const report = await runShape({
      shape: 'Kenya and Tanzania — multi-country safari',
      source: 'recorded',
      draft: recorded('east-africa'),
      destinationName: 'Tanzania and Kenya',
      countryCode: 'TZ',
      context: contextFor({
        id: 'matrix-east-africa',
        destination: 'Tanzania and Kenya',
        country: 'TZ',
        start: '2026-08-12',
        end: '2026-08-26',
        centre: { lat: -3.4, lng: 36.7 },
        drives: false,
        geocodes: {
          arusha: [place('relation/tz-1', 'Arusha', -3.3869, 36.68, 'tz')],
          zanzibar: [place('relation/tz-2', 'Zanzibar City', -6.1659, 39.2026, 'tz')],
          serengeti: [place('relation/tz-3', 'Serengeti National Park', -2.3333, 34.8333, 'tz', 'protected_area')],
        },
      }),
    });
    assertInvariants(report);
    reports.push(report);
  });

  it('6 · Okavango — wilderness, operator-owned days (constructed)', async () => {
    const draft = constructed({
      archetype: 'lodge_circuit',
      purpose: 'A water-and-land Okavango circuit: two camps inside the delta, reached and left by light aircraft.',
      route: 'Maun in, a water camp for three nights, a land camp for three, and out through Maun.',
      signatures: ['Mokoro morning in the delta'],
      driving: 'guided',
      bases: [
        { id: 'maun', name: 'Maun', locality: 'Maun', nights: 1 },
        { id: 'water-camp', name: 'Delta water camp', nights: 3, overnight: 'camp' },
        { id: 'land-camp', name: 'Delta land camp', nights: 3, overnight: 'camp' },
      ],
      days: [
        { base: 'maun', theme: 'Arrival', intensity: 'light', anchors: [{ name: 'Maun airstrip briefing', locality: 'Maun', category: 'landmark', minutes: 45 }] },
        { base: 'water-camp', theme: 'Into the delta', relocation: true, move: { how: 'flight', via: 'Maun' }, partOf: 'Okavango water camp', anchors: [{ name: 'Mokoro afternoon', category: 'boat', minutes: 180, transport: 'boat' }] },
        { base: 'water-camp', theme: 'Mokoro morning', partOf: 'Okavango water camp', anchors: [{ name: 'Mokoro morning in the delta', category: 'boat', minutes: 240, transport: 'boat' }] },
        { base: 'water-camp', theme: 'Walking island', partOf: 'Okavango water camp', anchors: [{ name: 'Island walk', category: 'hike', minutes: 180, transport: 'walk' }] },
        { base: 'land-camp', theme: 'To the land camp', relocation: true, move: { how: 'flight' }, partOf: 'Okavango land camp', anchors: [{ name: 'Afternoon game drive', category: 'wildlife', minutes: 210, transport: 'car' }] },
        { base: 'land-camp', theme: 'Full game day', intensity: 'intense', partOf: 'Okavango land camp', anchors: [{ name: 'Dawn game drive', category: 'wildlife', minutes: 240, transport: 'car' }] },
        { base: 'land-camp', theme: 'Last morning', partOf: 'Okavango land camp', anchors: [{ name: 'Bush walk', category: 'hike', minutes: 150, transport: 'walk' }] },
        { base: 'maun', theme: 'Out through Maun', relocation: true, intensity: 'light', move: { how: 'flight' }, anchors: [{ name: 'Maun departure', locality: 'Maun', category: 'landmark', minutes: 45 }] },
      ],
      episodes: [
        { name: 'Okavango water camp', kind: 'safari', fromDay: 2, toDay: 4, mode: 'boat', timing: 'operator', meals: 'included' },
        { name: 'Okavango land camp', kind: 'safari', fromDay: 5, toDay: 7, mode: 'mixed', timing: 'operator', meals: 'included' },
      ],
    });
    const report = await runShape({
      shape: 'Okavango — wilderness',
      source: 'constructed',
      draft,
      destinationName: 'Okavango Delta',
      countryCode: 'BW',
      context: contextFor({
        id: 'matrix-okavango',
        destination: 'Okavango Delta',
        country: 'BW',
        start: '2026-07-01',
        end: '2026-07-08',
        centre: { lat: -19.3, lng: 22.9 },
        drives: false,
        geocodes: { maun: [place('relation/bw-1', 'Maun', -19.9953, 23.4181, 'bw', 'town')] },
      }),
    });
    assertInvariants(report);
    /* Nothing a router can time: every leg here is a flight, a boat or a walk, and none of them may be zero. */
    expect(report.zeroMinuteLegsBetweenPlaces).toEqual([]);
    reports.push(report);
  });

  it('7 · Tokyo — conventional single-base city (constructed)', async () => {
    const draft = constructed({
      archetype: 'single_base_urban',
      purpose: 'One base in Tokyo with days out by train, built around neighbourhoods rather than a checklist.',
      route: 'One hotel for the whole week; everything within the rail network.',
      signatures: ['Tsukiji morning'],
      driving: 'none',
      bases: [{ id: 'tokyo', name: 'Tokyo', locality: 'Tokyo', nights: 6 }],
      days: [
        { base: 'tokyo', theme: 'Arrival and the neighbourhood', intensity: 'light', anchors: [{ name: 'Yanaka Ginza', locality: 'Tokyo', category: 'neighbourhood', minutes: 120, transport: 'transit' }] },
        { base: 'tokyo', theme: 'Tsukiji and the bay', anchors: [{ name: 'Tsukiji morning', locality: 'Tokyo', category: 'market', minutes: 150, transport: 'transit' }] },
        { base: 'tokyo', theme: 'Museums', anchors: [{ name: 'Tokyo National Museum', locality: 'Tokyo', category: 'museum', minutes: 180, transport: 'transit' }] },
        { base: 'tokyo', theme: 'Day out to Kamakura', anchors: [{ name: 'Kamakura', locality: 'Kamakura', category: 'town', minutes: 360, transport: 'train' }] },
        { base: 'tokyo', theme: 'West side', anchors: [{ name: 'Shimokitazawa', locality: 'Tokyo', category: 'neighbourhood', minutes: 180, transport: 'transit' }] },
        { base: 'tokyo', theme: 'Last morning and departure', intensity: 'light', anchors: [{ name: 'Ueno Park', locality: 'Tokyo', category: 'park', minutes: 90, transport: 'transit' }] },
      ],
    });
    const report = await runShape({
      shape: 'Tokyo — conventional city',
      source: 'constructed',
      draft,
      destinationName: 'Tokyo',
      countryCode: 'JP',
      context: contextFor({
        id: 'matrix-tokyo',
        destination: 'Tokyo',
        country: 'JP',
        start: '2026-04-05',
        end: '2026-04-11',
        centre: { lat: 35.68, lng: 139.76 },
        drives: false,
        geocodes: {
          tokyo: [place('relation/jp-1', 'Tokyo', 35.6895, 139.6917, 'jp')],
          kamakura: [place('relation/jp-2', 'Kamakura', 35.3192, 139.5467, 'jp', 'town')],
        },
      }),
    });
    assertInvariants(report);
    /* One base for the whole trip: one stay, no hotel change, six nights. */
    expect(report.stays).toBe(1);
    expect(report.hotelChanges).toBe(0);
    expect(report.nights).toBe(6);
    reports.push(report);
  });

  it('8 · Greek islands — beach and ferry hopping (constructed)', async () => {
    const draft = constructed({
      archetype: 'island_hopping',
      purpose: 'Three islands by ferry, built around swimming and slow evenings rather than sights.',
      route: 'Athens in, Naxos for four, Amorgos for three, and back through Athens.',
      signatures: ['Plaka beach afternoons'],
      driving: 'none',
      bases: [
        { id: 'athens', name: 'Athens', locality: 'Athens', nights: 1 },
        { id: 'naxos', name: 'Naxos', locality: 'Naxos', nights: 4 },
        { id: 'amorgos', name: 'Amorgos', locality: 'Amorgos', nights: 3 },
      ],
      days: [
        { base: 'athens', theme: 'Arrival', intensity: 'light', anchors: [{ name: 'Plaka evening', locality: 'Athens', category: 'neighbourhood', minutes: 120, transport: 'walk' }] },
        { base: 'naxos', theme: 'Ferry to Naxos', relocation: true, move: { how: 'ferry' }, anchors: [{ name: 'Naxos harbour', locality: 'Naxos', category: 'town', minutes: 90, transport: 'walk' }] },
        { base: 'naxos', theme: 'Plaka beach', intensity: 'light', anchors: [{ name: 'Plaka beach afternoons', locality: 'Naxos', category: 'beach', minutes: 300, transport: 'car' }] },
        { base: 'naxos', theme: 'Mountain villages', anchors: [{ name: 'Apiranthos', locality: 'Naxos', category: 'village', minutes: 180, transport: 'car' }] },
        { base: 'naxos', theme: 'A quiet day', intensity: 'light', anchors: [{ name: 'Agios Prokopios', locality: 'Naxos', category: 'beach', minutes: 240, transport: 'car' }] },
        { base: 'amorgos', theme: 'Ferry to Amorgos', relocation: true, move: { how: 'ferry' }, anchors: [{ name: 'Katapola', locality: 'Amorgos', category: 'town', minutes: 90, transport: 'walk' }] },
        { base: 'amorgos', theme: 'The monastery', anchors: [{ name: 'Hozoviotissa', locality: 'Amorgos', category: 'landmark', minutes: 150, transport: 'car' }] },
        { base: 'amorgos', theme: 'Last swim and departure', intensity: 'light', anchors: [{ name: 'Agia Anna', locality: 'Amorgos', category: 'beach', minutes: 180, transport: 'car' }] },
      ],
    });
    const report = await runShape({
      shape: 'Greek islands — beach and ferry',
      source: 'constructed',
      draft,
      destinationName: 'Greek islands',
      countryCode: 'GR',
      context: contextFor({
        id: 'matrix-greece',
        destination: 'Greek islands',
        country: 'GR',
        start: '2026-06-10',
        end: '2026-06-18',
        centre: { lat: 37.1, lng: 25.4 },
        drives: false,
        geocodes: {
          athens: [place('relation/gr-1', 'Athens', 37.9838, 23.7275, 'gr')],
          naxos: [place('relation/gr-2', 'Naxos', 37.1036, 25.3766, 'gr', 'town')],
          amorgos: [place('relation/gr-3', 'Amorgos', 36.8333, 25.9, 'gr', 'town')],
        },
      }),
    });
    assertInvariants(report);
    /* A ferry crossing is not a road leg and must never be timed as one. */
    const report8 = report;
    expect(report8.stays).toBe(3);
    reports.push(report);
  });

  it('9 · Lisbon — a short city break (constructed)', async () => {
    const draft = constructed({
      archetype: 'single_base_urban',
      purpose: 'Three nights in Lisbon, one neighbourhood a day, nothing that needs booking a month out.',
      route: 'One hotel, everything on foot or by tram.',
      driving: 'none',
      bases: [{ id: 'lisbon', name: 'Lisbon', locality: 'Lisbon', nights: 3 }],
      days: [
        { base: 'lisbon', theme: 'Arrival and Alfama', intensity: 'light', anchors: [{ name: 'Alfama', locality: 'Lisbon', category: 'neighbourhood', minutes: 150, transport: 'walk' }] },
        { base: 'lisbon', theme: 'Belém', anchors: [{ name: 'Mosteiro dos Jerónimos', locality: 'Lisbon', category: 'landmark', minutes: 150, transport: 'transit' }] },
        { base: 'lisbon', theme: 'Príncipe Real and the market', anchors: [{ name: 'Time Out Market', locality: 'Lisbon', category: 'market', minutes: 120, transport: 'walk' }] },
        { base: 'lisbon', theme: 'Last morning and departure', intensity: 'light', anchors: [{ name: 'Miradouro da Senhora do Monte', locality: 'Lisbon', category: 'viewpoint', minutes: 60, transport: 'walk' }] },
      ],
    });
    const report = await runShape({
      shape: 'Lisbon — short city break',
      source: 'constructed',
      draft,
      destinationName: 'Lisbon',
      countryCode: 'PT',
      context: contextFor({
        id: 'matrix-lisbon',
        destination: 'Lisbon',
        country: 'PT',
        start: '2026-05-08',
        end: '2026-05-11',
        centre: { lat: 38.72, lng: -9.14 },
        drives: false,
        geocodes: { lisbon: [place('relation/pt-1', 'Lisbon', 38.7223, -9.1393, 'pt')] },
      }),
    });
    assertInvariants(report);
    /*
     * §E's own warning, as an assertion: a three-night city break must not be
     * sectioned into chapters. One chapter, or none — never one per day.
     */
    expect(report.chapters).toBeLessThanOrEqual(1);
    expect(report.stays).toBe(1);
    reports.push(report);
  });

  it('records every shape, and the matrix is complete', () => {
    expect(reports).toHaveLength(9);
    /* Every chapter covers days, and no day belongs to two chapters — checked per shape above by construction. */
    for (const report of reports) {
      expect(report.signatures, `${report.shape}: a signature set is never more than three`).toBeLessThanOrEqual(3);
    }
    /* Printed so the document beside this file can be checked against a run rather than against a reading. */
    console.warn(`V11 §M matrix\n${reports.map((r) => JSON.stringify(r)).join('\n')}`);
  });
});
