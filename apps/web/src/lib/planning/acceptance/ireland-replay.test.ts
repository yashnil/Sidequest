import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { itinerarySchema, travelerProfileSchema, tripDates, unavailableWeatherDataset, type Itinerary, type TravelIntelligence, type Trip } from '@sidequest/core';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import type { GeocodedLocality, RouteConfirmation, RouteMatrixResult } from '../skeleton-adapter';
import { tripDraftSchema, type TripDraft } from '../trip-draft';
import { auditItinerary } from '../quality-audit';

/**
 * THE REAL IRELAND FOUNDER TRIP, REPLAYED OFFLINE.
 *
 * `draft.json` is the raw draft the one live composition call produced on
 * 2026-09-05 for trip 77b3aa4f (Ireland, 2027-05-11 → 05-20, 2 adults,
 * arrival 16:00, departure 09:00; food, history and scenery core; fast pace;
 * 150-minute driving ceiling). `profile.json` is the traveller's stored
 * profile. `evidence.json` holds the geocoder shapes the live run saw —
 * including the doubled-locality queries that returned Trinity College Dublin
 * and Dingle Distillery — and no routing at all, because the local Valhalla
 * holds Iceland tiles only.
 *
 * This fixture is the acceptance criterion for Product Recovery V1: every
 * downstream failure the founder saw must reproduce here without a model
 * call, and the repaired pipeline must make each count zero while keeping
 * the good parts of the draft.
 */

interface Evidence {
  centre: [number, number];
  geocodes: Record<string, GeocodedLocality[]>;
  confirmations: { from: [number, number]; to: [number, number]; found: boolean; minutes: number | null; km: number | null; geometry: [number, number][] | null }[];
  nearbyLocalities: { point: [number, number]; radiusKm: number; output: GeocodedLocality[] }[];
}

const evidence = JSON.parse(readFileSync(new URL('./fixtures/ireland/evidence.json', import.meta.url), 'utf8')) as Evidence;
const rawDraft = JSON.parse(readFileSync(new URL('./fixtures/ireland/draft.json', import.meta.url), 'utf8')) as unknown;
const rawProfile = JSON.parse(readFileSync(new URL('./fixtures/ireland/profile.json', import.meta.url), 'utf8')) as unknown;

export function irelandDraft(): TripDraft {
  return tripDraftSchema.parse(rawDraft);
}

export const IRELAND_TRIP: Trip = {
  id: 'ireland-replay',
  basics: { mode: 'known_destination', destinationInput: 'Ireland', regionId: 'dynamic', startDate: '2027-05-11', endDate: '2027-05-20', arrivalTime: '16:00', departureTime: '09:00', adults: 2, children: 0, travelerNeeds: [] },
  status: 'planned',
  createdAt: '2026-09-05T19:21:54.714Z',
  updatedAt: '2026-09-05T19:27:18.025Z',
};

const near = (a: { lat: number; lng: number }, b: [number, number]) => Math.abs(a.lat - b[0]) < 0.02 && Math.abs(a.lng - b[1]) < 0.02;

/** Replays the recorded geocoder evidence; routing is absent unless `withRouting` is set, exactly as the live run had it. */
export function irelandContext(overrides: { withRouting?: boolean; deadlineAfterCalls?: number } = {}): { context: ReconcileContext; calls: { geocode: number; matrix: number; confirm: number; corridor: number } } {
  const calls = { geocode: 0, matrix: 0, confirm: 0, corridor: 0 };
  const profile = travelerProfileSchema.parse(rawProfile);
  const centre = { lat: evidence.centre[0], lng: evidence.centre[1] };
  const regionId = 'ireland-replay-region';

  const geocodeLocality = async (query: string): Promise<readonly GeocodedLocality[]> => {
    calls.geocode += 1;
    const key = query.toLowerCase().replace(/,\s*ireland\s*$/i, '').trim();
    const recorded = evidence.geocodes[key];
    if (recorded) return recorded;
    // A query with a locality suffix falls back to the bare name, as Nominatim's own search would.
    const [head] = key.split(',');
    return evidence.geocodes[head!.trim()] ?? [];
  };

  const confirmFor = (from: { lat: number; lng: number }, to: { lat: number; lng: number }) =>
    evidence.confirmations.find((c) => near(from, c.from) && near(to, c.to)) ?? evidence.confirmations.find((c) => near(to, c.from) && near(from, c.to));

  const routeMatrix = async (points: readonly { id: string; lat: number; lng: number }[]): Promise<RouteMatrixResult | null> => {
    calls.matrix += 1;
    const ids = points.map((p) => p.id);
    const minutes = points.map((a) => points.map((b) => (a.id === b.id ? 0 : (confirmFor(a, b)?.minutes ?? Number.NaN))));
    const km = points.map((a) => points.map((b) => (a.id === b.id ? 0 : (confirmFor(a, b)?.km ?? Number.NaN))));
    const failedPairs = points.flatMap((a) => points.filter((b) => a.id !== b.id && !confirmFor(a, b)).map((b) => ({ fromId: a.id, toId: b.id, reason: 'insufficient_evidence' as const })));
    return { ids, minutes, km, failedPairs };
  };
  const confirmRoute = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteConfirmation | null> => {
    calls.confirm += 1;
    const c = confirmFor(from, to);
    if (!c) return { found: false, minutes: null, km: null, reason: 'insufficient_evidence', provider: 'replay' };
    return { found: c.found, minutes: c.minutes, km: c.km, provider: 'replay', ...(c.geometry ? { geometry: c.geometry.map(([lat, lng]) => ({ lat, lng })) } : {}) };
  };
  const findNearbyLocalities = async (): Promise<readonly GeocodedLocality[]> => {
    calls.corridor += 1;
    return [];
  };

  const dates = tripDates(IRELAND_TRIP.basics.startDate, IRELAND_TRIP.basics.endDate);
  let lookups = 0;
  const context: ReconcileContext = {
    tripId: IRELAND_TRIP.id,
    basics: IRELAND_TRIP.basics,
    profile,
    region: { id: regionId, name: 'Ireland', baseName: 'Ireland', baseCoordinates: centre, summary: 'Ireland, replayed from the founder trip.', maxRadiusKm: 800, aliases: [], transportSummary: 'Self-drive.', noVehicleSummary: 'Buses and trains between cities.' },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode: 'car', ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'Replay: no compiled matrix.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({ regionId, locations: [{ id: `${regionId}:centre`, label: 'Ireland', coordinates: centre, elevationMetres: 0, timeZone: 'Europe/Dublin', placeIds: [`${regionId}:centre`], limitation: 'One point.' }], dates, now: new Date('2026-09-05T19:25:00Z'), reason: 'not_configured', message: 'No weather in the replay.' }),
    now: new Date('2026-09-05T19:25:00Z'),
    baseId: `${regionId}:centre`,
    compiledBases: [],
    geocodeLocality: async (query) => {
      lookups += 1;
      return geocodeLocality(query);
    },
    ...(overrides.withRouting ? { routeMatrix, confirmRoute, findNearbyLocalities } : {}),
    destinationScope: { countryCode: 'IE', administrativeBounds: { southWest: { lat: 51.4232, lng: -10.7057 }, northEast: { lat: 55.4354, lng: -5.9414 } }, boundaryEvidence: 'published_boundary', reachRadiusKm: 800 },
    subregionGeometries: [],
    deadlineReached: () => (overrides.deadlineAfterCalls !== undefined ? lookups >= overrides.deadlineAfterCalls : false),
  };
  return { context, calls };
}

const WRONG_BASE_NAMES = /trinity college|distillery|urban$/i;
const KERRY = /kerry|killarney|skellig|portmagee|ladies view/i;
const CLARE = /moher|burren|doolin|loop head/i;

/**
 * THE FAILURE MATRIX — every founder-visible Ireland defect as a number.
 * Exported so the private matrix document quotes the same figures the test
 * asserts. Every count must be zero after the recovery.
 */
export function irelandFailureMatrix(itinerary: Itinerary, intel: TravelIntelligence) {
  const legs = itinerary.days.flatMap((day) => day.items.filter((i) => i.kind === 'travel'));
  const zeroMinuteNonColocatedLegs = legs.filter((leg) => leg.durationMinutes === 0 && leg.travel && leg.travel.fromId !== leg.travel.toId).length;
  const walkLegsOverThreeKm = legs.filter((leg) => leg.travel?.mode === 'walk' && (leg.travel.km ?? 0) > 3).length;
  // A walk between two different localities is wrong even when nobody measured the distance.
  const crossLocalityWalkLegs = legs.filter((leg) => leg.travel?.mode === 'walk' && /cashel|cork|dingle|clare|burren|galway|clonmacnoise|kilkenny/i.test(leg.travel.fromName) && !new RegExp(leg.travel.fromName.split(/\s|,/)[0]!, 'i').test(leg.travel.toName) && /cork|galway|dublin|kinsale|killarney|dingle|kilkenny/i.test(leg.travel.toName) && !/walk|stroll|quarter|town|area/i.test(leg.travel.fromName));
  const crossLocalityWalks = crossLocalityWalkLegs.length;
  const mealsScheduledAsMorningActivities = itinerary.days.flatMap((day) => day.items.filter((i) => i.kind === 'activity' && /dinner|lunch|breakfast/i.test(i.title) && i.startMinute < 17 * 60)).length;
  const duplicateDinners = itinerary.days.filter((day) => day.items.filter((i) => /dinner/i.test(i.title)).length > 1).length;
  const wrongBaseNames = (itinerary.package?.bases ?? []).filter((b) => WRONG_BASE_NAMES.test(b.name)).length + itinerary.days.filter((d) => WRONG_BASE_NAMES.test(d.baseName)).length;
  const misplacedBackups = intel.backups.filter((b) => {
    const day = itinerary.days.find((d) => d.dayNumber === b.dayNumber)!;
    const dayText = `${day.baseName} ${day.theme} ${day.items.map((i) => i.title).join(' ')}`;
    if (!b.fallback) return false;
    const text = `${b.fallback.trigger} ${b.fallback.name}`;
    // A backup is misplaced when it names regions and none of them is where the day is.
    const regions: [RegExp, RegExp][] = [
      [KERRY, KERRY],
      [CLARE, CLARE],
      [/kilkenny/i, /kilkenny/i],
      [/kylemore|connemara/i, /connemara|kylemore|galway/i],
    ];
    const named = regions.filter(([inText]) => inText.test(text));
    return named.length > 0 && !named.some(([, onDay]) => onDay.test(dayText));
  }).length;
  const zeroKmFuelLines = intel.budget.lines.filter((l) => /about 0 km/.test(l.basis)).length;
  const separateBookFirstStays = intel.bookings.items.filter((b) => b.kind === 'accommodation' && b.priority === 'book_first').length;
  const readinessPrimaryEntries = intel.readiness.entries.filter((e) => e.state !== 'not_applicable' && (e as { tier?: string }).tier !== 'more').length;
  const languagePackShown = intel.readiness.entries.some((e) => e.kind === 'language' && (e as { tier?: string }).tier !== 'more');
  const repeatedClimateParagraphs = new Set(itinerary.days.map((d) => d.weather.summary)).size === 1 && itinerary.days.length > 1 ? itinerary.days.length : 0;
  const unverifiedGenericExperiences = (itinerary.package?.anchors ?? []).filter((a) => a.verification === 'unverified' && /walk|stroll|pub with|café and|food stop/i.test(a.name) && (a as { anchorKind?: string }).anchorKind === undefined).length;
  return {
    zeroMinuteNonColocatedLegs,
    walkLegsOverThreeKm,
    crossLocalityWalks,
    mealsScheduledAsMorningActivities,
    duplicateDinners,
    wrongBaseNames,
    misplacedBackups,
    zeroKmFuelLines,
    separateBookFirstStays,
    readinessPrimaryEntries,
    languagePackShown,
    repeatedClimateParagraphs,
    unverifiedGenericExperiences,
    sourceRegistrySize: intel.sourceRegistry.length,
  };
}

async function replay(overrides: Parameters<typeof irelandContext>[0] = {}) {
  const draft = irelandDraft();
  const { context, calls } = irelandContext(overrides);
  const result = await reconcileTripDraft({ draft, context });
  const intel = buildTravelIntelligence({
    tripId: context.tripId,
    itinerary: result.itinerary,
    draft,
    profile: context.profile,
    basics: context.basics,
    destination: { name: 'Ireland', countryCode: 'IE', timeZone: 'Europe/Dublin' },
    booked: [],
    readinessProfile: null,
    now: new Date('2026-09-05T19:25:00Z'),
  });
  return { draft, context, calls, result, intel };
}

describe('the real Ireland draft, replayed offline', () => {
  it('the raw draft is the founder trip: road trip, seven stays over nine nights, 26 anchors, deliberate Northern Ireland omission', () => {
    const draft = irelandDraft();
    expect(draft.archetype).toBe('road_trip');
    expect(draft.bases.map((b) => b.name)).toEqual(['Dublin', 'Kilkenny', 'Kinsale', 'Killarney', 'Dingle', 'Galway', 'Dublin']);
    expect(draft.bases.reduce((s, b) => s + b.nights, 0)).toBe(9);
    expect(draft.days.reduce((s, d) => s + d.anchors.length, 0)).toBe(26);
    expect(draft.omissions.some((o) => /northern ireland/i.test(o.name))).toBe(true);
  });

  it('every founder-visible defect is zero after the recovery, and the good parts survive', async () => {
    const { draft, result, intel, context } = await replay();
    const itinerary = result.itinerary;
    const parsed = itinerarySchema.safeParse(itinerary);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    const matrix = irelandFailureMatrix(itinerary, intel);
    // eslint-disable-next-line no-console
    console.log('IRELAND FAILURE MATRIX', JSON.stringify(matrix));

    // A. unknown travel is never zero minutes.
    expect(matrix.zeroMinuteNonColocatedLegs).toBe(0);
    // B. bases are the towns the traveller sleeps in, never a landmark the geocoder matched.
    expect(matrix.wrongBaseNames).toBe(0);
    expect(itinerary.package!.bases.map((b) => b.name)).toEqual(['Dublin', 'Kilkenny', 'Kinsale', 'Killarney', 'Dingle', 'Galway', 'Dublin']);
    // C. no cross-city walk survives.
    expect(matrix.walkLegsOverThreeKm).toBe(0);
    expect(matrix.crossLocalityWalks).toBe(0);
    // D. backups sit on days they belong to.
    expect(matrix.misplacedBackups).toBe(0);
    // F. a pub dinner is a meal, not an 11:15 attraction; one dinner per day.
    expect(matrix.mealsScheduledAsMorningActivities).toBe(0);
    expect(matrix.duplicateDinners).toBe(0);
    // J. no fuel estimate for "about 0 km".
    expect(matrix.zeroKmFuelLines).toBe(0);
    // K. stays are one grouped dependency in Book first, not seven blocking items.
    expect(matrix.separateBookFirstStays).toBeLessThanOrEqual(1);
    // L. readiness is compact and personal: 3–7 primary things, no translation pack for an English-speaking destination.
    expect(matrix.readinessPrimaryEntries).toBeGreaterThanOrEqual(3);
    expect(matrix.readinessPrimaryEntries).toBeLessThanOrEqual(7);
    expect(matrix.languagePackShown).toBe(false);
    // Generic experiences are not "not verified" noise.
    expect(matrix.unverifiedGenericExperiences).toBe(0);

    // The temporal audit passes, structurally.
    const audit = auditItinerary({ draft, itinerary, profile: context.profile, trip: IRELAND_TRIP });
    expect(audit.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => `${c.id}: ${c.detail}`)).toEqual([]);

    // The good parts: the south-and-west loop, nine nights, zero silent loss, food on every full day, the special dinner in Dingle.
    expect(itinerary.package!.bases.reduce((s, b) => s + b.nights, 0)).toBe(9);
    expect(result.dispositions).toHaveLength(26);
    const kept = result.dispositions.filter((d) => !d.disposition.startsWith('rejected') && d.disposition !== 'unscheduled_capacity');
    expect(kept.length).toBeGreaterThanOrEqual(23);
    for (const d of result.dispositions.filter((x) => !kept.includes(x))) expect(itinerary.unscheduled.some((u) => u.name === d.name)).toBe(true);
    for (const day of itinerary.days.slice(1, -1)) expect(day.items.filter((i) => i.kind === 'meal').length, `day ${day.dayNumber} meals`).toBeGreaterThanOrEqual(2);
    const dingleDay = itinerary.days.find((d) => /dingle/i.test(d.baseName))!;
    expect(dingleDay.items.some((i) => i.kind === 'meal' && /special seafood/i.test(i.title))).toBe(true);
    expect(itinerary.package!.omissions.some((o) => /northern ireland/i.test(o.name))).toBe(true);

    // E. Food is the #1 priority and the plan shows it: markets, food towns, a named special dinner, specialities, provisioning.
    expect(intel.food.foodPriority).toBe('high');
    expect(intel.food.highlights?.markets.map((m) => m.name)).toEqual(expect.arrayContaining(['English Market']));
    expect(intel.food.highlights?.specialDinner?.baseName).toMatch(/dingle/i);
    expect(intel.food.highlights?.specialDinner?.intent).toMatch(/seafood/i);
    expect(intel.food.highlights?.provisionedDays.length).toBeGreaterThanOrEqual(3);
    expect(intel.food.highlights?.foodTowns.map((t) => t.name)).toEqual(expect.arrayContaining(['Kinsale']));
    expect(intel.food.days.every((d) => d.meals.filter((m) => m.slot !== 'breakfast').every((m) => m.role === 'skip' || m.intent))).toBe(true);
    expect(intel.food.strategy.length).toBeGreaterThanOrEqual(3);
  });

  it('the schedule is temporally coherent without a router: estimated legs carry real minutes, days are labelled approximate, stops follow their transfers', async () => {
    const { result } = await replay();
    for (const day of result.itinerary.days) {
      const items = [...day.items].filter((i) => i.kind !== 'free_time').sort((a, b) => a.startMinute - b.startMinute);
      for (let i = 1; i < items.length; i += 1) expect(items[i]!.startMinute, `day ${day.dayNumber}: ${items[i]!.title} after ${items[i - 1]!.title}`).toBeGreaterThanOrEqual(items[i - 1]!.endMinute);
      for (const leg of day.items.filter((i) => i.kind === 'travel' && i.travel && i.travel.fromId !== i.travel.toId)) {
        expect(leg.durationMinutes, `${leg.title} on day ${day.dayNumber}`).toBeGreaterThan(0);
        expect(leg.travel!.provenance).not.toBe('measured');
      }
      if (day.items.some((i) => i.kind === 'travel' && i.travel?.provenance !== 'measured' && i.travel?.fromId !== i.travel?.toId)) {
        expect(day.timing?.precision).toBeDefined();
        expect(day.timing?.precision).not.toBe('measured');
      }
    }
    // Rock of Cashel → English Market (Cork) is a drive of roughly 90 km, never a walk and never instantaneous.
    const cashelToCork = result.itinerary.days[2]!.items.find((i) => i.kind === 'travel' && /english market/i.test(i.travel?.toName ?? ''))!;
    expect(cashelToCork.travel!.mode).toBe('drive');
    expect(cashelToCork.durationMinutes).toBeGreaterThanOrEqual(60);
    expect(cashelToCork.durationMinutes).toBeLessThanOrEqual(150);
    expect(cashelToCork.travel!.provenance).toBe('estimated');
  });

  it('the Kerry pub dinner is folded into the day’s meal intent with a disposition, not silently lost', async () => {
    const { result } = await replay();
    const folded = result.dispositions.filter((d) => d.disposition === 'folded_into_meal');
    expect(folded.map((d) => d.name)).toEqual(expect.arrayContaining(['Killarney town pub dinner']));
    const kerryDay = result.itinerary.days[4]!;
    expect(kerryDay.items.filter((i) => i.kind === 'activity' && /dinner/i.test(i.title))).toHaveLength(0);
    expect(kerryDay.items.filter((i) => i.kind === 'meal' && /dinner/i.test(i.title))).toHaveLength(1);
  });

  it('verification spends the deadline on bases and named places first, never on generic experiences', async () => {
    // Bases (7 lookups) plus the first named anchors fit inside the budget; generic walks are never looked up at all.
    const { result, calls } = await replay({ deadlineAfterCalls: 14 });
    const anchors = result.itinerary.package!.anchors;
    const named = anchors.filter((a) => /kilkenny castle|rock of cashel|cliffs of moher|kylemore abbey/i.test(a.name));
    for (const a of named) expect(a.verification, a.name).not.toBe('unverified');
    const generic = anchors.filter((a) => /pub with live music|evening stroll|short walk near|local café/i.test(a.name));
    for (const a of generic) expect((a as { anchorKind?: string }).anchorKind, a.name).toMatch(/generic_experience|meal|flex|area_experience/);
    expect(calls.geocode).toBeLessThanOrEqual(14);
  });
});
