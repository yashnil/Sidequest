import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { intelligenceDiagnostics, travelIntelligenceSchema } from '@sidequest/core';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { itinerarySchema, tripDates, unavailableWeatherDataset, type Trip } from '@sidequest/core';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import { defaultProfileFor } from '../production-plan';
import type { GeocodedLocality, RouteConfirmation, RouteMatrixResult } from '../skeleton-adapter';
import { tripDraftSchema, type TripDraft } from '../trip-draft';

/**
 * THE SAVED ICELAND DRAFT, REPLAYED OFFLINE AGAINST FROZEN REAL EVIDENCE.
 *
 * `run2-skeleton-draft.json` is the raw draft the one successful live
 * composition call produced on 2026-09-01: a clockwise loop, six bases
 * summing to twelve nights, 13/13 substantive days, 32 anchors — the draft
 * that was then thinned to 16 scheduled stops by the legacy candidate
 * competition. `evidence.json` is real recorded provider evidence from the
 * same and earlier live rounds (Nominatim base identities, local-Valhalla
 * route confirmations with geometry, the corridor settlements found along
 * Akureyri → Reykjavík), replayed here by a fixture that answers only what
 * was recorded and honestly says "nothing" for everything else.
 *
 * This is the permanent regression for the failure this whole pass exists to
 * end: the rich draft must come out rich. No model call, no provider call.
 */

interface Evidence {
  reykjavikCentre: [number, number];
  geocodes: Record<string, GeocodedLocality[]>;
  confirmations: { from: [number, number]; to: [number, number]; found: boolean; minutes: number | null; km: number | null; geometry: [number, number][] | null }[];
  nearbyLocalities: { point: [number, number]; radiusKm: number; output: GeocodedLocality[] }[];
  evidencePlaces: { index: number; name: string; kind: string; lat: number; lng: number; duration: number | null }[];
}

const evidence = JSON.parse(readFileSync(new URL('./fixtures/iceland/evidence.json', import.meta.url), 'utf8')) as Evidence;
const skeleton = JSON.parse(readFileSync(new URL('./fixtures/iceland/run2-skeleton-draft.json', import.meta.url), 'utf8')) as {
  archetype: TripDraft['archetype'];
  purpose: string;
  bases: { id: string; name: string; nights: number; why: string }[];
  days: { dayNumber: number; baseId: string; theme: string; intensity: 'light' | 'moderate' | 'intense'; anchors: { name: string; locality?: string; estimatedDurationMinutes?: number; role: 'primary' | 'secondary'; why: string }[] }[];
  majorOmissions: { reason: string }[];
  unresolved: string[];
};

/** The saved skeleton, lifted into the canonical draft shape — names only, exactly what the model wrote; nothing added. */
export function icelandDraft(): TripDraft {
  return tripDraftSchema.parse({
    archetype: skeleton.archetype,
    purpose: skeleton.purpose,
    routeRationale: 'A clockwise ring keeps every relocation moving in one direction.',
    assumptions: [],
    tradeoffs: [],
    bases: skeleton.bases.map((b) => ({ id: b.id, name: b.name, nights: b.nights, why: b.why })),
    days: skeleton.days.map((d) => ({
      dayNumber: d.dayNumber,
      baseId: d.baseId,
      theme: d.theme,
      intensity: d.intensity,
      anchors: d.anchors.map((a) => ({
        name: a.name,
        ...(a.locality ? { locality: a.locality } : {}),
        category: /foss|Selfoss/.test(a.name) ? 'water' : /hraun|fjall|hver|Gunnuhver/.test(a.name) ? 'geothermal' : /Museum/.test(a.name) ? 'museum' : /kirkja/.test(a.name) ? 'historic' : 'nature',
        role: a.role === 'primary' ? 'core' : 'secondary',
        ...(a.estimatedDurationMinutes ? { estimatedDurationMinutes: a.estimatedDurationMinutes } : {}),
        transport: 'car',
        why: a.why,
      })),
    })),
    omissions: [
      { name: 'Gullfoss', reason: skeleton.majorOmissions[0]?.reason ?? 'Left out.' },
      { name: 'Jökulsárlón', reason: skeleton.majorOmissions[1]?.reason ?? 'Left out.' },
    ],
    unresolved: skeleton.unresolved,
    package: {
      foodStrategy: ['Self-cater breakfasts; one fish dinner per base.'],
      transport: { summary: 'A hire car for the whole loop.', notes: ['Check road conditions daily.'] },
      beforeYouGo: ['Verify official entry requirements.'],
      packing: ['Waterproof layers', 'Hiking boots'],
      backups: [{ trigger: 'A storm day', alternative: 'Swap in a museum or a pool.' }],
    },
  });
}

const near = (a: { lat: number; lng: number }, b: [number, number]) => Math.abs(a.lat - b[0]) < 0.02 && Math.abs(a.lng - b[1]) < 0.02;

/** Replays the recorded evidence; anything unrecorded is honestly absent. */
export function icelandContext(overrides: { outage?: boolean; noRouting?: boolean } = {}): { context: ReconcileContext; calls: { geocode: number; matrix: number; confirm: number; corridor: number } } {
  const calls = { geocode: 0, matrix: 0, confirm: 0, corridor: 0 };
  const trip: Trip = {
    id: 'iceland-replay',
    basics: { mode: 'known_destination', destinationInput: 'Iceland', regionId: 'dynamic', startDate: '2026-07-05', endDate: '2026-07-17', arrivalTime: '10:00', departureTime: '16:00', adults: 2, children: 0, travelerNeeds: [] },
    status: 'draft',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
  const base = defaultProfileFor(trip, null);
  const profile = { ...base, transport: { ...base.transport, willDrive: true, maxDailyDriveMinutes: 240, maxDailyTransportMinutes: 300 } };
  const regionId = 'iceland-replay-region';
  const reykjavik = { lat: evidence.reykjavikCentre[0], lng: evidence.reykjavikCentre[1] };
  const coordsById = new Map<string, { lat: number; lng: number }>();
  const placeIdFor = (p: { index: number; name: string }) => `packet:${p.index}:${p.name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}`;
  for (const place of evidence.evidencePlaces) coordsById.set(placeIdFor(place), place);
  for (const list of Object.values(evidence.geocodes)) for (const g of list) coordsById.set(g.sourceId, g);
  for (const n of evidence.nearbyLocalities) for (const g of n.output) coordsById.set(g.sourceId, g);
  coordsById.set('reykjavik-centre', reykjavik);

  const geocodeLocality = async (query: string): Promise<readonly GeocodedLocality[]> => {
    calls.geocode += 1;
    if (overrides.outage) throw new Error('outage');
    const [name] = query.split(',');
    if (/^reykjav[ií]k/i.test(name!.trim())) return [{ sourceId: 'reykjavik-centre', name: 'Reykjavík', lat: reykjavik.lat, lng: reykjavik.lng, countryCode: 'is', entityType: 'city', importance: 0.7 }];
    const recorded = Object.entries(evidence.geocodes).find(([q]) => q.toLowerCase().startsWith(name!.trim().toLowerCase()));
    if (recorded) return recorded[1];
    const packetPlace = evidence.evidencePlaces.find((p) => p.name.toLowerCase() === name!.trim().toLowerCase());
    if (packetPlace) return [{ sourceId: placeIdFor(packetPlace), name: packetPlace.name, lat: packetPlace.lat, lng: packetPlace.lng, countryCode: 'is', entityType: 'unknown', importance: 0.4 }];
    return [];
  };

  const confirmFor = (from: { lat: number; lng: number }, to: { lat: number; lng: number }) =>
    evidence.confirmations.find((c) => near(from, c.from) && near(to, c.to)) ?? evidence.confirmations.find((c) => near(to, c.from) && near(from, c.to));

  const routeMatrix = async (points: readonly { id: string; lat: number; lng: number }[]): Promise<RouteMatrixResult | null> => {
    calls.matrix += 1;
    if (overrides.outage || overrides.noRouting) throw new Error('outage');
    const ids = points.map((p) => p.id);
    const minutes = points.map((a) => points.map((b) => (a.id === b.id ? 0 : (confirmFor(a, b)?.minutes ?? Number.NaN))));
    const km = points.map((a) => points.map((b) => (a.id === b.id ? 0 : (confirmFor(a, b)?.km ?? Number.NaN))));
    // Unrecorded pairs are reported as unavailable, never as "no route".
    const failedPairs = points.flatMap((a) => points.filter((b) => a.id !== b.id && !confirmFor(a, b)).map((b) => ({ fromId: a.id, toId: b.id, reason: 'insufficient_evidence' as const })));
    return { ids, minutes, km, failedPairs };
  };

  const confirmRoute = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteConfirmation | null> => {
    calls.confirm += 1;
    if (overrides.outage || overrides.noRouting) throw new Error('outage');
    const c = confirmFor(from, to);
    if (!c) return { found: false, minutes: null, km: null, reason: 'insufficient_evidence', provider: 'replay' };
    return { found: c.found, minutes: c.minutes, km: c.km, provider: 'valhalla-replay', ...(c.geometry ? { geometry: c.geometry.map(([lat, lng]) => ({ lat, lng })) } : {}) };
  };

  const findNearbyLocalities = async (point: { lat: number; lng: number }, radiusKm: number): Promise<readonly GeocodedLocality[]> => {
    calls.corridor += 1;
    if (overrides.outage) throw new Error('outage');
    const hit = evidence.nearbyLocalities.find((n) => Math.abs(n.point[0] - point.lat) < 0.15 && Math.abs(n.point[1] - point.lng) < 0.3 && n.radiusKm >= radiusKm - 1);
    return hit?.output ?? [];
  };

  const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
  const context: ReconcileContext = {
    tripId: trip.id,
    basics: trip.basics,
    profile,
    region: { id: regionId, name: 'Iceland', baseName: 'Reykjavík', baseCoordinates: reykjavik, summary: 'Iceland, replayed.', maxRadiusKm: 600, aliases: [], transportSummary: 'Ring road.', noVehicleSummary: 'Buses are sparse.' },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode: 'car', ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'Replay: every leg from recorded routing evidence.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({ regionId, locations: [{ id: 'rvk', label: 'Reykjavík', coordinates: reykjavik, elevationMetres: 0, timeZone: 'Atlantic/Reykjavik', placeIds: ['rvk'], limitation: 'One point.' }], dates, now: new Date('2026-06-01T00:00:00Z'), reason: 'not_configured', message: 'No weather in the replay.' }),
    now: new Date('2026-06-01T00:00:00Z'),
    baseId: 'rvk',
    compiledBases: [],
    geocodeLocality,
    routeMatrix,
    confirmRoute,
    findNearbyLocalities,
    destinationScope: { countryCode: 'IS', boundaryEvidence: 'reach_circle', reachRadiusKm: 600 },
    subregionGeometries: [],
    deadlineReached: () => false,
  };
  return { context, calls };
}

describe('saved Iceland draft, replayed offline', () => {
  it('the raw draft is recognisable: a loop, six bases summing to twelve nights, 13 substantive days, 32 anchors', () => {
    const draft = icelandDraft();
    expect(draft.archetype).toBe('loop');
    expect(draft.bases.map((b) => b.name)).toEqual(['Reykjavik', 'Vik', 'Höfn', 'Egilsstaðir', 'Akureyri', 'Reykjavik']);
    expect(draft.bases.reduce((s, b) => s + b.nights, 0)).toBe(12);
    expect(draft.days).toHaveLength(13);
    expect(draft.days.every((d) => d.anchors.length > 0)).toBe(true);
    expect(draft.days.reduce((s, d) => s + d.anchors.length, 0)).toBe(32);
  });

  it('the final trip stays rich: every anchor disposed, zero silent losses, no unexplained empty day, nights preserved, the 298-minute leg home corrected through Borgarnes', async () => {
    const draft = icelandDraft();
    const { context, calls } = icelandContext();
    const result = await reconcileTripDraft({ draft, context });
    const itinerary = result.itinerary;
    expect(itinerarySchema.safeParse(itinerary).success).toBe(true);

    // Silent loss = 0: every one of the 32 anchors has a disposition, and every one not scheduled is explained.
    expect(result.dispositions).toHaveLength(32);
    const scheduled = result.dispositions.filter((d) => !d.disposition.startsWith('rejected') && d.disposition !== 'unscheduled_capacity');
    const explained = result.dispositions.filter((d) => !scheduled.includes(d));
    for (const d of explained) expect(itinerary.unscheduled.some((u) => u.name === d.name)).toBe(true);
    // The draft came in with 32 anchors and the trip keeps at least 30 of them scheduled; the legacy path kept 16.
    expect(scheduled.length).toBeGreaterThanOrEqual(30);
    // Every day of the trip has real content; the legacy path left two mid-trip days empty.
    for (const day of itinerary.days) {
      expect(day.items.some((i) => i.kind === 'activity'), `day ${day.dayNumber} must carry an activity`).toBe(true);
    }

    // Base structure: the recorded 298-minute Akureyri → Reykjavík leg is over the 240-minute cap and is remediated with a
    // real recorded corridor settlement (the live run chose Borgarnes, 234 + 66; the recorded Varmahlíð split, 73 + 226,
    // is one minute shorter combined and wins the deterministic sort here — either is a real, within-cap answer), with the
    // one night borrowed from the final Reykjavík stay so the trip still holds exactly twelve nights.
    const corridor = result.deviations.find((d) => d.kind === 'relocation_resolved_with_corridor_locality');
    expect(corridor?.detail).toMatch(/Akureyri → Reykjavík measured 298 min/);
    const recordedSettlements = evidence.nearbyLocalities.flatMap((n) => n.output.map((l) => l.name));
    const inserted = itinerary.package!.bases[5]!;
    expect(inserted.insertedBySidequest).toBe(true);
    expect(recordedSettlements).toContain(inserted.name);
    expect(itinerary.package?.bases.map((b) => [b.name, b.nights])).toEqual([
      ['Reykjavík', 2],
      ['Vik', 2],
      ['Höfn', 2],
      ['Egilsstaðir', 2],
      ['Akureyri', 2],
      [inserted.name, 1],
      ['Reykjavík', 1],
    ]);
    expect(itinerary.package?.bases.reduce((s, b) => s + b.nights, 0)).toBe(12);
    expect(result.unresolvedRelocations).toHaveLength(0);

    // Identity is honest: recorded evidence verified some anchors as places, the rest are retained unverified — never deleted.
    expect(itinerary.package?.verification.partiallyVerified).toBeGreaterThanOrEqual(10);
    expect(itinerary.package?.verification.unverified).toBeGreaterThan(0);
    expect(itinerary.package?.omissions.map((o) => o.name)).toEqual(['Gullfoss', 'Jökulsárlón']);

    // Bounded provider use: a handful of base legs and corridor searches, never a global matrix.
    expect(calls.matrix).toBeLessThan(30);
    expect(calls.confirm).toBeLessThan(30);

    // The persisted form is the canonical form.
    expect(itinerarySchema.parse(JSON.parse(JSON.stringify(itinerary)))).toEqual(itinerary);
  });

  it('missing routing alone deletes nothing, and a full provider outage still returns all 32 anchors on all 13 days', async () => {
    const draft = icelandDraft();
    const noRouting = await reconcileTripDraft({ draft, context: icelandContext({ noRouting: true }).context });
    expect(noRouting.dispositions.filter((d) => d.disposition.startsWith('rejected'))).toHaveLength(0);
    expect(noRouting.itinerary.days.every((d) => d.items.some((i) => i.kind === 'activity'))).toBe(true);
    expect(noRouting.itinerary.package?.bases.reduce((s, b) => s + b.nights, 0)).toBe(12);

    const outage = await reconcileTripDraft({ draft, context: icelandContext({ outage: true }).context });
    expect(outage.dispositions).toHaveLength(32);
    expect(outage.dispositions.filter((d) => d.disposition === 'retained_unverified').length).toBeGreaterThanOrEqual(30);
    expect(outage.itinerary.days.every((d) => d.items.some((i) => i.kind === 'activity'))).toBe(true);
    expect(outage.itinerary.status).toBe('ready_with_cautions');
  });
});

describe('saved Iceland draft, through the travel-intelligence pipeline offline', () => {
  it('keeps the model content, adds lodging, meals, book-first, readiness, packing, backups and source states — with no model call, no live call and no legal hallucination', async () => {
    const draft = icelandDraft();
    const { context, calls } = icelandContext();
    const result = await reconcileTripDraft({ draft, context });
    const before = { geocode: calls.geocode, matrix: calls.matrix, confirm: calls.confirm, corridor: calls.corridor };
    const started = performance.now();
    const intel = buildTravelIntelligence({
      tripId: context.tripId,
      itinerary: result.itinerary,
      draft,
      profile: context.profile,
      basics: context.basics,
      destination: { name: 'Iceland', countryCode: 'IS', timeZone: 'Atlantic/Reykjavik' },
      booked: [],
      readinessProfile: { citizenship: 'US', passportExpiry: '2027-12', transitCountries: [] },
      now: new Date('2026-05-01T00:00:00Z'),
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
    // Provider-free: the intelligence made no call the reconciler had not already made.
    expect({ geocode: calls.geocode, matrix: calls.matrix, confirm: calls.confirm, corridor: calls.corridor }).toEqual(before);

    // Canonical content preserved: the same anchors, bases and days the reconciler produced.
    expect(intel.verification.anchors).toBe(32);
    expect(intel.lodging.bases.map((b) => b.name)).toEqual(result.itinerary.package!.bases.map((b) => b.name));
    expect(intel.lodging.bases.reduce((s, b) => s + b.nights, 0)).toBe(12);
    expect(intel.lodging.bases.every((b) => b.availability === 'unknown')).toBe(true);
    expect(intel.lodging.hotelChangeNote).toMatch(/hotel changes/);

    // Food intent survives on every day, including the remote ones.
    expect(intel.food.days).toHaveLength(13);
    expect(intel.food.days.every((d) => d.meals.length === 3)).toBe(true);
    expect(intel.food.remoteDayNumbers.length).toBeGreaterThan(0);

    // BOOK FIRST exists and is honest: rental car and every base, nothing marked limited without evidence.
    expect(intel.bookings.items.some((b) => b.kind === 'rental_vehicle' && b.priority === 'book_first')).toBe(true);
    expect(intel.bookings.items.filter((b) => b.kind === 'accommodation')).toHaveLength(7);
    expect(intel.bookings.items.every((b) => b.capacityEvidence === 'unknown' || b.authority !== 'model_proposal')).toBe(true);

    // Readiness: international, visa unverified with official links, passport arithmetic from the traveller's own month.
    expect(intel.readiness.international).toBe('yes');
    const visa = intel.readiness.entries.find((e) => e.kind === 'visa')!;
    expect(visa.state).toBe('unverified');
    expect(visa.summary).not.toMatch(/do not need|no visa/i);
    expect(visa.links.length).toBeGreaterThan(0);
    expect(intel.readiness.entries.find((e) => e.kind === 'passport_validity')!.state).toBe('unverified');
    expect(intel.readiness.entries.find((e) => e.kind === 'driving_document')!.state).toBe('unverified');
    expect(intel.sourceRegistry.filter((c) => c.kind === 'entry_visa').every((c) => c.state !== 'confirmed')).toBe(true);

    // Packing adapts to a driven, outdoor, geothermal, remote trip.
    expect(intel.packing.items.some((i) => /hiking boots/i.test(i.label))).toBe(true);
    expect(intel.packing.items.some((i) => /swimwear/i.test(i.label))).toBe(true);
    expect(intel.packing.items.some((i) => /offline maps/i.test(i.label))).toBe(true);
    expect(intel.packing.items.some((i) => /driving licence/i.test(i.label))).toBe(true);

    // Weather semantics are honest: nothing is called a forecast unless it is one.
    expect(intel.weather.days.every((d) => d.kind === 'forecast' || d.kind === 'climate' || d.kind === 'unavailable')).toBe(true);
    expect(intel.weather.days.filter((d) => d.kind !== 'forecast').every((d) => /not a prediction|No weather data/.test(d.horizonNote))).toBe(true);

    // Backups on every day, source states on every material claim, freshness marked.
    expect(intel.backups).toHaveLength(13);
    expect(intel.backups.every((d) => d.planA.length > 0)).toBe(true);
    expect(intel.sourceRegistry.length).toBeGreaterThan(40);
    expect(intel.sourceRegistry.every((c) => c.state !== 'confirmed' || c.authority !== 'model_proposal')).toBe(true);
    expect(intel.freshness.recheckBeforeDeparture.length).toBeGreaterThan(0);

    // Multimodal honesty: the plan is driven; no leg is impossible; static routing is never live traffic.
    expect(intel.transport.legs.every((l) => l.plausibility !== 'impossible')).toBe(true);
    // The saved replay's day legs were never matrixed (the recorded evidence holds base-leg confirmations only). LIVE WORLD
    // V1 closes the old gap: every base move is a leg, by car, and carries the base-to-base measurement it was confirmed
    // with — static, never live traffic — flagged `viaBases` because the day's stops sit along the way, with its shape.
    const baseMoves = intel.transport.legs.filter((l) => l.role === 'base_move');
    expect(baseMoves.length).toBeGreaterThanOrEqual(6);
    expect(baseMoves.every((l) => l.mode === 'car')).toBe(true);
    const measuredMoves = baseMoves.filter((l) => l.durationBasis === 'measured_static');
    expect(measuredMoves.length).toBeGreaterThanOrEqual(5);
    expect(measuredMoves.every((l) => l.durationMinutes !== null && l.viaBases === true && l.measuredAt && l.provider === 'valhalla-replay')).toBe(true);
    // The recorded evidence carries a shape for three of the base legs; each one survives as an encoded polyline, none is invented.
    expect(measuredMoves.filter((l) => typeof l.geometry === 'string' && l.geometry.length > 10).length).toBeGreaterThanOrEqual(3);
    expect(intel.transport.legs.every((l) => l.trafficState !== 'live')).toBe(true);

    // Silent loss is still zero and the packet round-trips.
    expect(intelligenceDiagnostics(intel, result.itinerary.days).final.silentLoss).toBe(0);
    expect(travelIntelligenceSchema.parse(JSON.parse(JSON.stringify(intel)))).toEqual(intel);
  });
});
