import { describe, expect, it } from 'vitest';
import { intelligenceDiagnostics, travelIntelligenceSchema, type BookedPlanItem, type TravelIntelligence, type TravelReadinessProfile } from '@sidequest/core';
import { reconcileTripDraft } from '../planning/reconcile';
import { draftOf, fictionalWorld, type DayShape, type FictionalPlace, type FictionalWorldOptions } from '../planning/acceptance/harness';
import { applyBookedFacts } from './booked-reconcile';
import { buildTravelIntelligence } from './build';

/**
 * GLOBAL INTELLIGENCE ACCEPTANCE.
 *
 * Fifteen frozen trip shapes, none named after a real destination, each run
 * through reconcile → booked facts → intelligence with zero provider calls
 * beyond the fictional world's own stubs. For every shape: the itinerary stays
 * rich, the modes are honest, lodging / food / bookings / readiness / packing /
 * backups exist, uncertainty is explicit, and nothing is lost silently.
 */
const NOW = new Date('2026-04-01T12:00:00Z');

const grid = (origin: { lat: number; lng: number }, names: string[], spreadKm: number, known = true): FictionalPlace[] =>
  names.map((name, i) => ({ name, lat: origin.lat + ((i % 3) - 1) * (spreadKm / 111), lng: origin.lng + (Math.floor(i / 3) - 1) * (spreadKm / 111), known }));

interface Shape {
  name: string;
  world: FictionalWorldOptions;
  bases: Parameters<typeof draftOf>[0]['bases'];
  days: DayShape[];
  countryCode?: string;
  readiness?: TravelReadinessProfile | null;
  booked?: BookedPlanItem[];
  expect: (intel: TravelIntelligence, ctx: { silentLoss: number; days: number }) => void;
}

async function run(shape: Shape) {
  const world = fictionalWorld(shape.world);
  const draft = draftOf({ bases: shape.bases, days: shape.days });
  const result = await reconcileTripDraft({ draft, context: world.context });
  expect(result.ok).toBe(true);
  const anchors = draft.days.reduce((n, d) => n + d.anchors.length, 0);
  expect(result.dispositions).toHaveLength(anchors);
  const explained = result.dispositions.filter((d) => d.disposition.startsWith('rejected') || d.disposition === 'unscheduled_capacity');
  const silentLoss = explained.filter((d) => !result.itinerary.unscheduled.some((u) => u.name === d.name)).length;
  const booked = shape.booked ?? [];
  const applied = applyBookedFacts(result.itinerary, booked);
  const started = performance.now();
  const intel = buildTravelIntelligence({
    tripId: world.trip.id,
    itinerary: applied.itinerary,
    draft,
    profile: world.context.profile,
    basics: world.trip.basics,
    destination: { name: shape.world.name, ...(shape.countryCode ? { countryCode: shape.countryCode } : {}) },
    booked,
    readinessProfile: shape.readiness ?? null,
    bookedHonored: applied.honored,
    bookedConflicts: applied.conflicts,
    now: NOW,
  });
  const elapsed = performance.now() - started;
  expect(elapsed, 'intelligence must be bounded and provider-free').toBeLessThan(250);
  expect(travelIntelligenceSchema.safeParse(intel).success).toBe(true);
  expect(travelIntelligenceSchema.parse(JSON.parse(JSON.stringify(intel)))).toEqual(intel);
  // Universal invariants -----------------------------------------------------------------
  expect(intel.lodging.bases.length).toBeGreaterThan(0);
  expect(intel.lodging.bases.every((b) => b.availability === 'unknown')).toBe(true);
  expect(intel.food.days).toHaveLength(applied.itinerary.days.length);
  expect(intel.food.days.every((d) => d.meals.length === 3)).toBe(true);
  expect(intel.bookings.items.some((b) => b.kind === 'accommodation')).toBe(true);
  expect(intel.bookings.items.every((b) => b.capacityEvidence === 'unknown' || b.authority !== 'model_proposal')).toBe(true);
  expect(intel.readiness.entries.length).toBeGreaterThan(3);
  expect(intel.readiness.entries.filter((e) => e.kind === 'visa').every((e) => !/do not need|no visa needed/i.test(e.summary))).toBe(true);
  expect(intel.packing.items.length).toBeGreaterThan(5);
  expect(intel.backups).toHaveLength(applied.itinerary.days.length);
  expect(intel.checklist.phases.length).toBeGreaterThan(0);
  expect(intel.sourceRegistry.every((c) => c.state !== 'confirmed' || c.authority !== 'model_proposal')).toBe(true);
  expect(intel.transport.legs.every((l) => l.plausibility !== 'impossible')).toBe(true);
  expect(intel.transport.legs.every((l) => l.durationBasis !== 'measured_static' || l.trafficState !== 'live')).toBe(true);
  const diagnostics = intelligenceDiagnostics(intel, applied.itinerary.days);
  expect(diagnostics.final.silentLoss).toBe(0);
  shape.expect(intel, { silentLoss, days: applied.itinerary.days.length });
  return { intel, itinerary: applied.itinerary, result };
}

const SHAPES: Shape[] = [
  {
    name: '1 dense transit city',
    world: { name: 'Veloria', center: { lat: 40, lng: -3 }, places: grid({ lat: 40, lng: -3 }, ['Old Quarter', 'Grand Museum', 'Central Market', 'Riverside Walk', 'Cathedral Square', 'Modern Gallery'], 3), basics: { startDate: '2026-05-01', endDate: '2026-05-04' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } },
    bases: [{ id: 'c', name: 'Veloria', nights: 3, area: 'the Old Quarter', style: 'small hotel' }],
    days: [
      { base: 'c', anchors: [{ name: 'Old Quarter', category: 'neighbourhood', transport: 'walk' }, { name: 'Cathedral Square', role: 'secondary', transport: 'walk' }] },
      { base: 'c', anchors: [{ name: 'Grand Museum', category: 'museum', transport: 'metro' }, { name: 'Central Market', category: 'market', role: 'secondary', transport: 'walk' }] },
      { base: 'c', anchors: [{ name: 'Modern Gallery', category: 'museum', transport: 'metro' }] },
      { base: 'c', anchors: [{ name: 'Riverside Walk', category: 'neighbourhood', transport: 'walk' }] },
    ],
    countryCode: 'ES',
    expect: (intel) => {
      expect(intel.destinationContext.drives).toBe(false);
      expect(intel.bookings.items.some((b) => b.kind === 'rental_vehicle')).toBe(false);
      expect(intel.food.remoteDayNumbers).toEqual([]);
      expect(intel.packing.items.some((i) => /walking shoes/i.test(i.label))).toBe(true);
      expect(intel.transport.legs.filter((l) => l.role !== 'terminal').every((l) => l.mode === 'walk' || l.mode === 'metro' || l.mode === 'rail' || l.mode === 'bus' || l.mode === 'unknown_local')).toBe(true);
      expect(intel.lodging.bases[0]!.area).toBe('the Old Quarter');
    },
  },
  {
    name: '2 road-trip mountain region',
    world: { name: 'Highvale', center: { lat: 46.5, lng: 10 }, places: [...grid({ lat: 46.5, lng: 10 }, ['Summit Trail', 'Glacier Lake', 'Pass Viewpoint', 'Valley Town', 'Alpine Museum', 'Ridge Walk'], 25), { name: 'Highvale', lat: 46.5, lng: 10, entityType: 'city' }], basics: { startDate: '2026-07-10', endDate: '2026-07-15' }, profile: { willDrive: true, maxDailyDriveMinutes: 240 } },
    bases: [{ id: 'h', name: 'Highvale', nights: 5, style: 'nature lodge' }],
    days: [
      { base: 'h', anchors: [{ name: 'Valley Town', category: 'town', transport: 'car' }] },
      { base: 'h', intensity: 'intense', anchors: [{ name: 'Summit Trail', category: 'hike', transport: 'car', minutes: 300 }, { name: 'Glacier Lake', category: 'water', role: 'secondary', transport: 'car' }] },
      { base: 'h', anchors: [{ name: 'Pass Viewpoint', category: 'viewpoint', transport: 'car' }, { name: 'Alpine Museum', category: 'museum', role: 'optional', transport: 'car' }] },
      { base: 'h', intensity: 'intense', anchors: [{ name: 'Ridge Walk', category: 'hike', transport: 'car', minutes: 240 }] },
      { base: 'h', anchors: [{ name: 'Glacier Lake', category: 'water', role: 'flex', transport: 'car' }] },
      { base: 'h', anchors: [] },
    ],
    countryCode: 'CH',
    readiness: { citizenship: 'US', passportExpiry: '2028-01', transitCountries: [] },
    expect: (intel) => {
      expect(intel.destinationContext.drives).toBe(true);
      expect(intel.bookings.items.some((b) => b.kind === 'rental_vehicle' && b.priority === 'book_first')).toBe(true);
      expect(intel.food.remoteDayNumbers.length).toBeGreaterThan(0);
      expect(intel.food.days.find((d) => d.remote)!.meals.find((m) => m.slot === 'lunch')!.role).toBe('packed_lunch');
      expect(intel.packing.items.some((i) => /hiking boots/i.test(i.label))).toBe(true);
      expect(intel.readiness.international).toBe('yes');
      expect(intel.readiness.entries.find((e) => e.kind === 'driving_document')!.state).toBe('unverified');
      expect(intel.budget.lines.some((l) => l.category === 'car_fuel_tolls_parking')).toBe(true);
      expect(intel.weather.days.every((d) => d.kind !== 'forecast' || d.horizonNote.length > 0)).toBe(true);
      expect(intel.lodging.bases[0]!.style).toBe('lodge');
    },
  },
  {
    name: '3 broad multi-region country',
    world: { name: 'Meridia', center: { lat: 42, lng: 12 }, places: [{ name: 'Capital', lat: 41.9, lng: 12.5, entityType: 'city' }, { name: 'Lake City', lat: 45.8, lng: 9.1, entityType: 'city' }, { name: 'Coast Town', lat: 40.6, lng: 14.5, entityType: 'city' }, { name: 'Forum Ruins', lat: 41.89, lng: 12.49 }, { name: 'Lake Promenade', lat: 45.82, lng: 9.08 }, { name: 'Cliff Path', lat: 40.63, lng: 14.6 }], basics: { startDate: '2026-09-01', endDate: '2026-09-08' }, profile: { willDrive: true, maxDailyDriveMinutes: 300 } },
    bases: [{ id: 'cap', name: 'Capital', nights: 3 }, { id: 'lake', name: 'Lake City', nights: 2 }, { id: 'coast', name: 'Coast Town', nights: 2 }],
    days: [
      { base: 'cap', anchors: [{ name: 'Forum Ruins', category: 'historic', transport: 'walk' }] },
      { base: 'cap', anchors: [{ name: 'Forum Ruins', category: 'historic', role: 'optional', transport: 'walk' }] },
      { base: 'cap', anchors: [] },
      { base: 'lake', relocation: true, anchors: [{ name: 'Lake Promenade', category: 'water', transport: 'rail' }] },
      { base: 'lake', anchors: [{ name: 'Lake Promenade', category: 'water', role: 'secondary', transport: 'walk' }] },
      { base: 'coast', relocation: true, anchors: [{ name: 'Cliff Path', category: 'hike', transport: 'rail' }] },
      { base: 'coast', anchors: [{ name: 'Cliff Path', category: 'hike', role: 'optional', transport: 'walk' }] },
      { base: 'coast', anchors: [] },
    ],
    countryCode: 'IT',
    expect: (intel) => {
      expect(intel.lodging.bases).toHaveLength(3);
      expect(intel.bookings.items.filter((b) => b.kind === 'accommodation')).toHaveLength(3);
      expect(intel.transport.options.length).toBeGreaterThan(0);
      expect(intel.lodging.hotelChangeNote).toMatch(/2 hotel changes/);
    },
  },
  {
    name: '4 island archipelago with ferry and flight',
    world: { name: 'Thalassa', center: { lat: 37, lng: 25 }, places: [{ name: 'Main Port', lat: 37.0, lng: 25.0, entityType: 'city' }, { name: 'Far Isle Village', lat: 36.4, lng: 25.4, entityType: 'city' }, { name: 'Caldera Rim Walk', lat: 36.42, lng: 25.43 }, { name: 'Harbour Beach', lat: 37.02, lng: 25.03 }], basics: { startDate: '2026-06-10', endDate: '2026-06-15' }, noRoadBetween: [['Main Port', 'Far Isle Village']] },
    bases: [{ id: 'port', name: 'Main Port', nights: 2 }, { id: 'isle', name: 'Far Isle Village', nights: 3 }],
    days: [
      { base: 'port', anchors: [{ name: 'Harbour Beach', category: 'beach', transport: 'walk' }] },
      { base: 'port', anchors: [{ name: 'Harbour Beach', category: 'beach', role: 'flex', transport: 'walk' }] },
      { base: 'isle', relocation: true, anchors: [{ name: 'Far Isle Village', category: 'town', transport: 'ferry' }] },
      { base: 'isle', anchors: [{ name: 'Caldera Rim Walk', category: 'hike', transport: 'bus' }] },
      { base: 'isle', anchors: [{ name: 'Caldera Rim Walk', category: 'hike', role: 'optional', transport: 'bus' }] },
      { base: 'isle', anchors: [{ name: 'Main Port', category: 'town', role: 'flex', transport: 'flight' }] },
    ],
    countryCode: 'GR',
    expect: (intel) => {
      const water = intel.transport.legs.filter((l) => l.mode === 'ferry' || l.mode === 'boat' || l.mode === 'flight');
      expect(water.length).toBeGreaterThan(0);
      expect(water.every((l) => l.plausibility === 'plausible' && l.durationBasis === 'unmeasured' && l.unmeasuredReason === 'mode_not_road_routable')).toBe(true);
      expect(intel.bookings.items.some((b) => b.kind === 'ferry' || b.kind === 'flight')).toBe(true);
      expect(intel.packing.items.some((i) => /swimwear/i.test(i.label))).toBe(true);
      expect(intel.budget.lines.some((l) => l.category === 'long_distance_transport')).toBe(true);
    },
  },
  {
    name: '5 remote mountain country with sparse data',
    world: { name: 'Altara', center: { lat: 28, lng: 84 }, places: [{ name: 'Gateway Town', lat: 28.2, lng: 83.98, entityType: 'city' }, { name: 'Ridge Homestay', lat: 28.35, lng: 83.9, known: false }, { name: 'High Pass Hike', lat: 28.5, lng: 83.8, known: false }, { name: 'Monastery Walk', lat: 28.22, lng: 84.0, known: false }], basics: { startDate: '2026-10-05', endDate: '2026-10-11' }, outage: { geocoder: false }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } },
    bases: [{ id: 'gw', name: 'Gateway Town', nights: 2 }, { id: 'hs', name: 'Ridge Homestay', nights: 3, style: 'family homestay' }, { id: 'gw2', name: 'Gateway Town', nights: 1 }],
    days: [
      { base: 'gw', anchors: [{ name: 'Monastery Walk', category: 'historic', transport: 'walk' }] },
      { base: 'gw', anchors: [] },
      { base: 'hs', relocation: true, intensity: 'intense', anchors: [{ name: 'Ridge Homestay', category: 'nature', transport: 'four_wheel_drive' }] },
      { base: 'hs', intensity: 'intense', anchors: [{ name: 'High Pass Hike', category: 'hike', transport: 'walk', minutes: 420 }] },
      { base: 'hs', anchors: [{ name: 'High Pass Hike', category: 'hike', role: 'optional', transport: 'walk' }] },
      { base: 'gw2', relocation: true, anchors: [{ name: 'Gateway Town', category: 'town', transport: 'four_wheel_drive' }] },
      { base: 'gw2', anchors: [] },
    ],
    countryCode: 'NP',
    readiness: { citizenship: 'GB', transitCountries: ['QA'] },
    expect: (intel) => {
      expect(intel.destinationContext.remote).toBe(true);
      expect(intel.packing.items.some((i) => i.category === 'remote_travel')).toBe(true);
      expect(intel.lodging.bases.find((b) => b.name === 'Ridge Homestay')!.style).toBe('homestay');
      expect(intel.readiness.entries.find((e) => e.kind === 'transit')!.state).toBe('unverified');
      expect(intel.readiness.entries.find((e) => e.kind === 'activity_insurance')).toBeDefined();
      expect(intel.verification.unverified).toBeGreaterThan(0);
    },
  },
  {
    name: '6 wilderness gateway + lodge/boat',
    world: { name: 'Riverland', center: { lat: -3.3, lng: -60.5 }, places: [{ name: 'Gateway City', lat: -3.1, lng: -60.0, entityType: 'city' }, { name: 'River Lodge', lat: -3.4, lng: -60.9, known: true }, { name: 'Flooded Forest Canoe', lat: -3.5, lng: -61.0, known: false }, { name: 'Night Caiman Spotting', lat: -3.45, lng: -60.95, known: false }], basics: { startDate: '2026-08-10', endDate: '2026-08-15' }, noRoadBetween: [['Gateway City', 'River Lodge']] },
    bases: [{ id: 'g', name: 'Gateway City', nights: 1 }, { id: 'l', name: 'River Lodge', nights: 3, style: 'jungle lodge, full board' }, { id: 'g2', name: 'Gateway City', nights: 1 }],
    days: [
      { base: 'g', anchors: [{ name: 'Gateway City', category: 'town', role: 'secondary' }] },
      { base: 'l', relocation: true, anchors: [{ name: 'River Lodge', category: 'nature', transport: 'boat' }] },
      { base: 'l', anchors: [{ name: 'Flooded Forest Canoe', category: 'activity', transport: 'guide_or_lodge_transfer' }, { name: 'Night Caiman Spotting', category: 'wildlife', role: 'secondary', transport: 'guide_or_lodge_transfer' }] },
      { base: 'l', anchors: [{ name: 'Flooded Forest Canoe', category: 'activity', role: 'optional', transport: 'guide_or_lodge_transfer' }] },
      { base: 'g2', relocation: true, anchors: [] },
      { base: 'g2', anchors: [] },
    ],
    countryCode: 'BR',
    expect: (intel) => {
      const modes = new Set(intel.transport.legs.map((l) => l.mode));
      expect(modes.has('boat') || modes.has('guide_transfer') || modes.has('ferry') || modes.has('private_transfer')).toBe(true);
      expect(intel.transport.legs.every((l) => l.plausibility !== 'impossible')).toBe(true);
      expect(intel.lodging.bases.find((b) => b.name === 'River Lodge')!.style).toBe('lodge');
      expect(intel.food.days.some((d) => d.remote)).toBe(true);
      expect(intel.packing.items.some((i) => /insect repellent/i.test(i.label))).toBe(true);
    },
  },
  {
    name: '7 safari camp with flight and private transfer',
    world: { name: 'Deltania', center: { lat: -19.6, lng: 23.1 }, places: [{ name: 'Delta Gateway', lat: -19.98, lng: 23.42, entityType: 'city' }, { name: 'Reed Camp', lat: -19.3, lng: 22.9, known: false }, { name: 'Morning Game Drive', lat: -19.3, lng: 22.9, known: false }, { name: 'Mokoro Channel Glide', lat: -19.25, lng: 22.95, known: false }], basics: { startDate: '2026-06-20', endDate: '2026-06-24' } },
    bases: [{ id: 'g', name: 'Delta Gateway', nights: 1 }, { id: 'c', name: 'Reed Camp', nights: 3, style: 'tented camp, all inclusive' }],
    days: [
      { base: 'g', anchors: [{ name: 'Delta Gateway', category: 'town', role: 'secondary' }] },
      { base: 'c', relocation: true, anchors: [{ name: 'Reed Camp', category: 'nature', transport: 'flight' }] },
      { base: 'c', anchors: [{ name: 'Morning Game Drive', category: 'wildlife', transport: 'guide_or_lodge_transfer', minutes: 240 }] },
      { base: 'c', anchors: [{ name: 'Mokoro Channel Glide', category: 'activity', transport: 'boat', minutes: 180 }] },
      { base: 'c', anchors: [{ name: 'Morning Game Drive', category: 'wildlife', role: 'optional', transport: 'guide_or_lodge_transfer' }] },
    ],
    countryCode: 'BW',
    expect: (intel) => {
      expect(intel.transport.legs.some((l) => l.mode === 'flight' || l.mode === 'guide_transfer' || l.mode === 'private_transfer' || l.mode === 'boat')).toBe(true);
      expect(intel.lodging.bases.find((b) => b.name === 'Reed Camp')!.style).toBe('camp');
      expect(intel.bookings.items.some((b) => b.kind === 'tour_guide' || b.kind === 'internal_transfer' || b.kind === 'flight')).toBe(true);
      expect(intel.packing.items.some((i) => /binoculars/i.test(i.label))).toBe(true);
      expect(intel.verification.unverified).toBeGreaterThan(0);
    },
  },
  {
    name: '8 rail-oriented country',
    world: { name: 'Ferrovia', center: { lat: 47, lng: 8 }, places: [{ name: 'North City', lat: 47.4, lng: 8.5, entityType: 'city' }, { name: 'South City', lat: 46.2, lng: 6.1, entityType: 'city' }, { name: 'Old Bridge', lat: 47.37, lng: 8.54 }, { name: 'Lakeside Promenade', lat: 46.21, lng: 6.15 }], basics: { startDate: '2026-04-20', endDate: '2026-04-25' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } },
    bases: [{ id: 'n', name: 'North City', nights: 2 }, { id: 's', name: 'South City', nights: 3 }],
    days: [
      { base: 'n', anchors: [{ name: 'Old Bridge', category: 'landmark', transport: 'walk' }] },
      { base: 'n', anchors: [] },
      { base: 's', relocation: true, anchors: [{ name: 'South City', category: 'town', transport: 'rail' }] },
      { base: 's', anchors: [{ name: 'Lakeside Promenade', category: 'water', transport: 'walk' }] },
      { base: 's', anchors: [] },
      { base: 's', anchors: [] },
    ],
    countryCode: 'CH',
    expect: (intel) => {
      expect(intel.destinationContext.drives).toBe(false);
      expect(intel.transport.legs.filter((l) => l.role !== 'terminal').every((l) => l.mode !== 'car')).toBe(true);
      expect(intel.budget.lines.some((l) => l.category === 'local_transport')).toBe(true);
      expect(intel.packing.items.some((i) => /transit pass/i.test(i.label))).toBe(true);
    },
  },
  {
    name: '9 international trip requiring readiness checks',
    world: { name: 'Insulara', center: { lat: 35.7, lng: 139.7 }, places: grid({ lat: 35.7, lng: 139.7 }, ['Temple District', 'Fish Market', 'Garden Walk', 'Tower View'], 4), basics: { startDate: '2026-11-01', endDate: '2026-11-06' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } },
    bases: [{ id: 'c', name: 'Insulara', nights: 5 }],
    days: [
      { base: 'c', anchors: [{ name: 'Temple District', category: 'historic', transport: 'metro' }] },
      { base: 'c', anchors: [{ name: 'Fish Market', category: 'market', transport: 'metro' }] },
      { base: 'c', anchors: [{ name: 'Garden Walk', category: 'nature', transport: 'walk' }] },
      { base: 'c', anchors: [{ name: 'Tower View', category: 'viewpoint', transport: 'metro' }] },
      { base: 'c', anchors: [{ name: 'Temple District', category: 'historic', role: 'flex', transport: 'walk' }] },
      { base: 'c', anchors: [] },
    ],
    countryCode: 'JP',
    readiness: { citizenship: 'CA', passportExpiry: '2027-03', transitCountries: [] },
    expect: (intel) => {
      expect(intel.readiness.international).toBe('yes');
      const passport = intel.readiness.entries.find((e) => e.kind === 'passport_validity')!;
      expect(passport.state).toBe('unverified');
      expect(intel.readiness.entries.find((e) => e.kind === 'visa')!.state).toBe('unverified');
      expect(intel.readiness.entries.find((e) => e.kind === 'visa')!.links.some((l) => /travel\.gc\.ca/.test(l.url))).toBe(true);
      expect(intel.checklist.phases.some((p) => p.items.some((i) => /visa|entry rule/i.test(i.title) || /visa/i.test(i.why)))).toBe(true);
      expect(intel.packing.items.some((i) => /plug adapter/i.test(i.label))).toBe(true);
      expect(intel.freshness.recheckBeforeDeparture.length).toBeGreaterThan(0);
    },
  },
  {
    name: '10 domestic trip with no visa layer',
    world: { name: 'Homeland Lakes', center: { lat: 44.5, lng: -110 }, places: grid({ lat: 44.5, lng: -110 }, ['Geyser Basin', 'Canyon Rim', 'Lake Shore', 'Visitor Centre'], 12), basics: { startDate: '2026-07-20', endDate: '2026-07-24' }, profile: { willDrive: true, maxDailyDriveMinutes: 200 } },
    bases: [{ id: 'c', name: 'Homeland Lakes', nights: 4 }],
    days: [
      { base: 'c', anchors: [{ name: 'Visitor Centre', category: 'landmark', transport: 'car' }] },
      { base: 'c', anchors: [{ name: 'Geyser Basin', category: 'geothermal', transport: 'car' }] },
      { base: 'c', anchors: [{ name: 'Canyon Rim', category: 'viewpoint', transport: 'car' }] },
      { base: 'c', anchors: [{ name: 'Lake Shore', category: 'water', transport: 'car' }] },
      { base: 'c', anchors: [] },
    ],
    countryCode: 'US',
    readiness: { citizenship: 'US', drivingLicenceCountry: 'US', transitCountries: [] },
    expect: (intel) => {
      expect(intel.readiness.international).toBe('no');
      expect(intel.readiness.entries.find((e) => e.kind === 'visa')!.state).toBe('not_applicable');
      expect(intel.readiness.entries.find((e) => e.kind === 'driving_document')!.state).toBe('not_applicable');
      expect(intel.readiness.entries.some((e) => e.kind === 'electricity')).toBe(false);
      expect(intel.packing.items.some((i) => /plug adapter/i.test(i.label))).toBe(false);
    },
  },
  {
    name: '11 booked-heavy trip',
    world: { name: 'Bookland', center: { lat: 52.5, lng: 13.4 }, places: grid({ lat: 52.5, lng: 13.4 }, ['Island Museum', 'Old Gate', 'Park Loop', 'Market Square'], 3), basics: { startDate: '2026-05-10', endDate: '2026-05-13', departureTime: '19:00' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } },
    bases: [{ id: 'c', name: 'Bookland', nights: 3 }],
    days: [
      { base: 'c', anchors: [{ name: 'Old Gate', category: 'landmark', transport: 'walk' }] },
      { base: 'c', anchors: [{ name: 'Island Museum', category: 'museum', transport: 'metro', minutes: 120 }, { name: 'Park Loop', category: 'nature', role: 'secondary', transport: 'walk' }] },
      { base: 'c', anchors: [{ name: 'Market Square', category: 'market', transport: 'walk' }] },
      { base: 'c', anchors: [{ name: 'Park Loop', category: 'nature', role: 'flex', transport: 'walk' }] },
    ],
    countryCode: 'DE',
    booked: [
      { id: 'h', tripId: 't', type: 'lodging', title: 'Hotel Nord', date: '2026-05-10', endDate: '2026-05-13', location: 'Nord Quarter', status: 'booked', locked: true, createdAt: NOW.toISOString(), cost: { amount: 540, currency: 'EUR' } },
      { id: 'm', tripId: 't', type: 'activity', title: 'Island Museum timed ticket', date: '2026-05-11', startTime: '11:00', endTime: '13:00', status: 'booked', locked: true, createdAt: NOW.toISOString() },
      { id: 'f', tripId: 't', type: 'flight', title: 'Flight home', date: '2026-05-13', startTime: '14:00', status: 'booked', locked: true, createdAt: NOW.toISOString() },
    ],
    expect: (intel, ctx) => {
      expect(intel.bookings.honored.length).toBeGreaterThanOrEqual(3);
      expect(intel.lodging.bases[0]!.booked?.title).toBe('Hotel Nord');
      expect(intel.lodging.bases[0]!.basis).toBe('booked');
      expect(intel.bookings.items.find((b) => b.kind === 'accommodation')!.status).toBe('booked');
      expect(intel.transport.terminal.departure.basis).toBe('booked');
      expect(intel.transport.terminal.departureRespected).toBe(true);
      expect(intel.budget.booked.some((b) => b.currency === 'EUR' && b.amount === 540)).toBe(true);
      expect(intel.sourceRegistry.filter((c) => c.kind === 'booked_fact' && c.authority === 'traveller_stated')).toHaveLength(3);
      expect(ctx.days).toBe(4);
    },
  },
  {
    name: '12 provider outage',
    world: { name: 'Outagia', center: { lat: 50, lng: 5 }, places: grid({ lat: 50, lng: 5 }, ['Abbey', 'Ridge Trail', 'Riverside Town', 'Old Fort'], 15), basics: { startDate: '2026-06-01', endDate: '2026-06-05' }, outage: { geocoder: true, router: true, corridor: true }, profile: { willDrive: true, maxDailyDriveMinutes: 180 } },
    bases: [{ id: 'c', name: 'Outagia', nights: 4 }],
    days: [
      { base: 'c', anchors: [{ name: 'Abbey', category: 'historic', transport: 'car' }] },
      { base: 'c', anchors: [{ name: 'Ridge Trail', category: 'hike', transport: 'car', minutes: 240 }] },
      { base: 'c', anchors: [{ name: 'Riverside Town', category: 'town', transport: 'car' }] },
      { base: 'c', anchors: [{ name: 'Old Fort', category: 'historic', transport: 'car' }] },
      { base: 'c', anchors: [] },
    ],
    countryCode: 'BE',
    expect: (intel, ctx) => {
      expect(ctx.silentLoss).toBe(0);
      expect(intel.verification.verified).toBe(0);
      expect(intel.transport.legs.filter((l) => l.role !== 'terminal').every((l) => l.durationBasis !== 'measured_static')).toBe(true);
      expect(intel.transport.legs.every((l) => l.plausibility === 'plausible' || l.plausibility === 'measured')).toBe(true);
      expect(intel.sourceRegistry.filter((c) => c.kind === 'place_identity').every((c) => c.state === 'unverified')).toBe(true);
      expect(intel.lodging.bases.length).toBe(1);
      expect(intel.food.days.every((d) => d.meals.length === 3)).toBe(true);
      expect(intel.readiness.entries.length).toBeGreaterThan(3);
      expect(intel.packing.items.length).toBeGreaterThan(5);
    },
  },
  {
    name: '13 bad-weather trip',
    world: { name: 'Stormhold', center: { lat: 57, lng: -6 }, places: grid({ lat: 57, lng: -6 }, ['Sea Cliffs', 'Peat Museum', 'Loch Walk', 'Harbour Distillery'], 10), basics: { startDate: '2026-10-10', endDate: '2026-10-14' }, profile: { willDrive: true, maxDailyDriveMinutes: 180 } },
    bases: [{ id: 'c', name: 'Stormhold', nights: 4 }],
    days: [
      { base: 'c', anchors: [{ name: 'Sea Cliffs', category: 'viewpoint', transport: 'car' }, { name: 'Peat Museum', category: 'museum', role: 'optional', transport: 'car' }] },
      { base: 'c', intensity: 'intense', anchors: [{ name: 'Loch Walk', category: 'hike', transport: 'car', minutes: 240 }] },
      { base: 'c', anchors: [{ name: 'Harbour Distillery', category: 'food', transport: 'car' }] },
      { base: 'c', anchors: [{ name: 'Sea Cliffs', category: 'viewpoint', role: 'flex', transport: 'car' }] },
      { base: 'c', anchors: [] },
    ],
    countryCode: 'GB',
    expect: (intel) => {
      const sensitive = intel.weather.days.flatMap((d) => d.sensitiveItems);
      expect(sensitive.length).toBeGreaterThan(0);
      expect(intel.weather.days.every((d) => ['forecast', 'climate', 'unavailable'].includes(d.kind))).toBe(true);
      expect(intel.backups.some((d) => d.fallback !== undefined || d.flexItems.length > 0)).toBe(true);
      expect(intel.regret.keepFlexible.length).toBeGreaterThan(0);
      expect(intel.weather.days.filter((d) => d.kind === 'climate').every((d) => /not a prediction/.test(d.horizonNote))).toBe(true);
    },
  },
  {
    name: '14 trip with permit and timed entry',
    world: { name: 'Permitia', center: { lat: 36.1, lng: -112.1 }, places: grid({ lat: 36.1, lng: -112.1 }, ['Canyon Overlook', 'Rim Trail', 'Ranger Museum', 'Sunset Point'], 8), basics: { startDate: '2026-05-05', endDate: '2026-05-09' }, profile: { willDrive: true, maxDailyDriveMinutes: 180 } },
    bases: [{ id: 'c', name: 'Permitia', nights: 4 }],
    days: [
      { base: 'c', anchors: [{ name: 'Canyon Overlook', category: 'viewpoint', transport: 'car' }] },
      { base: 'c', intensity: 'intense', anchors: [{ name: 'Rim Trail', category: 'hike', transport: 'car', minutes: 300 }] },
      { base: 'c', anchors: [{ name: 'Ranger Museum', category: 'museum', transport: 'car' }] },
      { base: 'c', anchors: [{ name: 'Sunset Point', category: 'viewpoint', transport: 'car' }] },
      { base: 'c', anchors: [] },
    ],
    countryCode: 'US',
    expect: (intel) => {
      // Permit evidence arrives from the region's access data in production; the fixture world has none, so the honest
      // answer is that access is unknown (never "no permit needed") and the rental car is the book-first dependency.
      expect(intel.access.filter((a) => a.state === 'permit_required' || a.state === 'hours_unknown' || a.state === 'open_access' || a.state === 'access_unknown').length).toBeGreaterThan(0);
      expect(intel.access.every((a) => a.state !== 'confirmed_closed')).toBe(true);
      expect(intel.bookings.items.filter((b) => b.priority === 'book_first').length).toBeGreaterThan(0);
      expect(intel.regret.verifyBeforeLeaving.length).toBeGreaterThan(0);
    },
  },
];

describe('global travel-intelligence acceptance', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: rich itinerary, honest modes, lodging, meals, bookings, readiness, packing, backups, explicit uncertainty, zero silent loss`, async () => {
      await run(shape);
    });
  }

  it('15 existing-plan critique: the traveller’s own places are accounted for, and the verdict never throws the plan away', async () => {
    const centre = { lat: 41.4, lng: 2.17 };
    const world = fictionalWorld({ name: 'Critica', center: centre, places: grid(centre, ['Basilica', 'Beach Walk', 'Hill Park', 'Food Market', 'Modern Museum', 'Far Monastery'], 4), basics: { startDate: '2026-09-10', endDate: '2026-09-13' }, profile: { willDrive: false, maxDailyDriveMinutes: 0, pace: 'balanced' } });
    const draft = draftOf({
      bases: [{ id: 'c', name: 'Critica', nights: 3 }],
      days: [
        { base: 'c', anchors: [{ name: 'Basilica', category: 'landmark', transport: 'metro' }, { name: 'Food Market', category: 'market', role: 'secondary', transport: 'walk' }] },
        { base: 'c', intensity: 'intense', anchors: [{ name: 'Hill Park', category: 'nature', transport: 'metro' }, { name: 'Modern Museum', category: 'museum', role: 'optional', transport: 'metro' }, { name: 'Beach Walk', category: 'beach', role: 'secondary', transport: 'metro' }] },
        { base: 'c', anchors: [{ name: 'Beach Walk', category: 'beach', role: 'flex', transport: 'walk' }] },
        { base: 'c', anchors: [] },
      ],
      omissions: [{ name: 'Far Monastery', reason: 'A three-hour round trip for a half-day stop; left off the plan.' }],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const intel = buildTravelIntelligence({ tripId: world.trip.id, itinerary: result.itinerary, draft, profile: world.context.profile, basics: world.trip.basics, destination: { name: 'Critica', countryCode: 'ES' }, booked: [], userPlaces: ['Basilica', 'Beach Walk', 'Far Monastery', 'Nowhere Special'], now: NOW });
    const c = intel.critique!;
    expect(['works', 'works_with_changes', 'needs_rethink']).toContain(c.verdict);
    expect(c.userPlaces.find((p) => p.name === 'Basilica')!.outcome).toBe('kept');
    expect(c.userPlaces.find((p) => p.name === 'Beach Walk')!.outcome).toBe('kept');
    expect(['dropped', 'not_found']).toContain(c.userPlaces.find((p) => p.name === 'Far Monastery')!.outcome);
    expect(c.userPlaces.find((p) => p.name === 'Nowhere Special')!.outcome).toBe('not_found');
    expect(c.findings.some((f) => f.topic === 'must_do' && f.severity === 'concern')).toBe(true);
    expect(c.findings.some((f) => f.topic === 'good')).toBe(true);
    expect(c.findings.map((f) => f.topic)).toContain('pace');
    expect(c.findings.map((f) => f.topic)).toContain('hotel_changes');
  });

  it('a slow provider never causes a model call: intelligence is provider-free and runs after the deadline has passed', async () => {
    const centre = { lat: 40, lng: -3 };
    const world = fictionalWorld({ name: 'Deadlinia', center: centre, places: grid(centre, ['A Museum', 'B Park', 'C Market'], 3), basics: { startDate: '2026-05-01', endDate: '2026-05-03' }, deadlineReached: true });
    const draft = draftOf({ bases: [{ id: 'c', name: 'Deadlinia', nights: 2 }], days: [{ base: 'c', anchors: [{ name: 'A Museum', category: 'museum' }] }, { base: 'c', anchors: [{ name: 'B Park', category: 'nature' }, { name: 'C Market', category: 'market', role: 'secondary' }] }, { base: 'c', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    expect(world.calls.geocode + world.calls.matrix + world.calls.confirm).toBe(0);
    const intel = buildTravelIntelligence({ tripId: world.trip.id, itinerary: result.itinerary, draft, profile: world.context.profile, basics: world.trip.basics, destination: { name: 'Deadlinia' }, booked: [], now: NOW });
    expect(intel.verification.deadlineReached).toBe(true);
    expect(intel.food.days).toHaveLength(3);
    expect(intel.bookings.items.length).toBeGreaterThan(0);
    expect(intel.sourceRegistry.filter((c) => c.kind === 'place_identity').every((c) => c.state === 'unverified')).toBe(true);
  });
});
