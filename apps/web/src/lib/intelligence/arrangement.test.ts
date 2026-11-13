import { describe, expect, it } from 'vitest';
import type { TravelerProfile } from '@sidequest/core';
import { draftOf, fictionalWorld } from '@/lib/planning/acceptance/harness';
import { auditItinerary } from '@/lib/planning/quality-audit';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import type { TripDraft } from '@/lib/planning/trip-draft';
import { buildTravelIntelligence } from './build';

/**
 * ONE TRANSPORT ARRANGEMENT, EVERY SURFACE AGREEING WITH IT.
 *
 * A blind evaluation of a generated safari found the plan's own summary saying
 * "a single operator driver-guide runs the overland legs in a 4x4, with one
 * internal flight", while the bookings asked for a rental car for the whole
 * trip, a day titled "Fly to the plains" carried a 309 km road leg, and the
 * in-trip legs alternated between drive, 4x4, shuttle and walk. A train trip
 * had booked a rental car the same way. Fictional places throughout.
 */

const PLACES = [
  { name: 'Gatetown', lat: -3.0, lng: 36.0, entityType: 'city' as const },
  { name: 'Gatetown old market', lat: -3.005, lng: 36.004 },
  { name: 'Flats Lodge', lat: -3.6, lng: 35.9, entityType: 'city' as const },
  { name: 'Baobab Flats park', lat: -3.65, lng: 35.95 },
  { name: 'Flats river circuit', lat: -3.7, lng: 35.97 },
  { name: 'Plains Camp', lat: -2.4, lng: 34.8, entityType: 'city' as const },
  { name: 'Grass Plains centre', lat: -2.35, lng: 34.85 },
  { name: 'Northern kopjes', lat: -2.2, lng: 34.9 },
  { name: 'Hilltown', lat: -3.3, lng: 36.6, entityType: 'city' as const },
  { name: 'Hilltown abbey', lat: -3.31, lng: 36.61 },
];

function world(profile: Partial<TravelerProfile['transport']>) {
  return fictionalWorld({
    name: 'Fictional savanna',
    countryCode: 'XS',
    center: { lat: -3.0, lng: 36.0 },
    places: PLACES,
    basics: { startDate: '2027-07-05', endDate: '2027-07-10', arrivalTime: '14:00', departureTime: '18:00', adults: 2, children: 0 },
    profile,
  });
}

async function build(draft: TripDraft, profile: Partial<TravelerProfile['transport']>) {
  const { context, trip } = world(profile);
  const result = await reconcileTripDraft({ draft, context });
  const intel = buildTravelIntelligence({
    tripId: context.tripId,
    itinerary: result.itinerary,
    draft: {
      days: draft.days.map((d) => ({ anchors: d.anchors.map((a) => ({ name: a.name, ...(a.transport ? { transport: a.transport } : {}) })) })),
      bases: draft.bases.map((b) => ({ id: b.id })),
      ...(draft.driving ? { driving: draft.driving } : {}),
    },
    profile: context.profile,
    basics: context.basics,
    destination: { name: 'Fictional savanna', countryCode: 'XS' },
    composer: null,
    booked: [],
    readinessProfile: { citizenship: 'GB', residence: 'GB', transitCountries: [] },
    sourcedAreas: [],
    worthSkipping: [],
    userPlaces: [],
    bookedHonored: [],
    bookedConflicts: [],
    now: new Date('2027-01-10T00:00:00.000Z'),
    fx: null,
  });
  const audit = auditItinerary({ draft, itinerary: result.itinerary, profile: context.profile, trip });
  return { itinerary: result.itinerary, intel, audit };
}

/* The safari as the evaluated plan had it: no `driving` word, an operator in the prose, 4x4 hints, two safari runs. */
const safari = () =>
  draftOf({
    bases: [
      { id: 'gate', name: 'Gatetown', nights: 1 },
      { id: 'flats', name: 'Flats Lodge', nights: 2, overnight: 'lodge' },
      { id: 'plains', name: 'Plains Camp', nights: 2, overnight: 'camp' },
    ],
    days: [
      { base: 'gate', theme: 'Arrival and settling in', anchors: [{ name: 'Gatetown old market', category: 'market' }] },
      { base: 'flats', theme: 'Into baobab country', relocation: true, partOf: 'Flats safari', anchors: [{ name: 'Baobab Flats park', category: 'wildlife', transport: 'four_wheel_drive' }] },
      { base: 'flats', theme: 'Full day on the flats', partOf: 'Flats safari', anchors: [{ name: 'Flats river circuit', category: 'wildlife', transport: 'four_wheel_drive' }] },
      { base: 'plains', theme: 'Fly to the plains', relocation: true, partOf: 'Plains safari', anchors: [{ name: 'Grass Plains centre', category: 'wildlife', transport: 'four_wheel_drive' }] },
      { base: 'plains', theme: 'Final game drive, fly back to Gatetown', partOf: 'Plains safari', anchors: [{ name: 'Northern kopjes', category: 'wildlife' }] },
      { base: 'plains', theme: 'Departure', anchors: [] },
    ],
    package: { transport: { summary: 'A single operator driver-guide runs the overland legs in a 4x4, with one internal flight from the plains back to Gatetown to save a day of driving.', notes: [] }, beforeYouGo: ['Verify official entry requirements.'], packing: ['Layers'] },
  });

describe('an operator-run safari', () => {
  it('asks for the operator, not a rental car, and no driving permit or rental budget', async () => {
    /* The traveller said they would drive; the plan says somebody else does, and the plan decides. */
    const { intel } = await build(safari(), { willDrive: true });
    expect(intel.destinationContext.arrangement?.primary).toBe('operator');
    expect(intel.destinationContext.drives).toBe(false);
    expect(intel.bookings.items.filter((b) => b.kind === 'rental_vehicle')).toEqual([]);
    expect(intel.bookings.items.find((b) => b.id === 'booking:ground')).toMatchObject({ kind: 'programme', title: expect.stringMatching(/operator and driver-guide/i) });
    expect(intel.readiness.entries.map((e) => e.kind)).not.toContain('driving_document');
    expect(intel.budget.lines.map((l) => l.category)).not.toContain('car_fuel_tolls_parking');
    expect(JSON.stringify(intel)).not.toMatch(/Rental car for the whole trip|Rental desk|IDP rules/i);
    expect(intel.destinationContext.arrangement?.disagreements).toEqual([]);
  });

  it('never says "fly" over a road leg, and books the stated flight on the day it happens', async () => {
    const { itinerary, intel } = await build(safari(), { willDrive: true });
    const day4 = itinerary.days.find((d) => d.dayNumber === 4)!;
    expect(day4.items.some((i) => i.kind === 'travel' && i.travel?.role === 'transfer')).toBe(true);
    expect(day4.theme).not.toMatch(/\bfl(y|ight)/i);
    expect(day4.theme).toBe('Drive to the plains');
    /* Day 5 carries no road move and the prose states the flight: it stays said, and the seat is a booking. */
    expect(intel.bookings.items.find((b) => b.kind === 'flight' && b.dayNumber === 5)).toBeTruthy();
  });

  it('words every road leg as the operator’s 4x4 — no drive, shuttle or bus by turns', async () => {
    const { itinerary, audit } = await build(safari(), { willDrive: false });
    const roadLegs = itinerary.days.flatMap((d) => d.items.filter((i) => i.kind === 'travel' && i.travel && (i.travel.mode === 'drive' || i.travel.mode === 'shuttle' || i.travel.mode === 'public_bus' || i.travel.mode === 'rideshare')));
    expect(roadLegs.length).toBeGreaterThan(0);
    for (const leg of roadLegs) {
      expect(leg.travel!.hint, leg.title).toBe('four_wheel_drive');
      expect(leg.title, leg.title).not.toMatch(/^(Drive|Shuttle|Bus) to/);
    }
    expect(audit.checks.find((c) => c.id === 'arrangement_surfaces_agree')).toMatchObject({ ok: true });
  });
});

describe('a self-drive road trip', () => {
  it('still gets its rental car, its rental budget and its driving check', async () => {
    const draft = draftOf({
      bases: [{ id: 'gate', name: 'Gatetown', nights: 2 }, { id: 'hill', name: 'Hilltown', nights: 3 }],
      days: [
        { base: 'gate', anchors: [{ name: 'Gatetown old market', transport: 'car' }] },
        { base: 'gate', anchors: [{ name: 'Baobab Flats park', transport: 'car' }] },
        { base: 'hill', relocation: true, anchors: [{ name: 'Hilltown abbey', transport: 'car' }] },
        { base: 'hill', anchors: [{ name: 'Flats river circuit', transport: 'car' }] },
        { base: 'hill', anchors: [{ name: 'Hilltown abbey', transport: 'car' }] },
        { base: 'hill', anchors: [] },
      ],
      package: { transport: { summary: 'Self-drive loop in a rental car.', notes: [] } },
    });
    const { intel } = await build(draft, { willDrive: true });
    expect(intel.destinationContext.arrangement?.primary).toBe('self_drive');
    expect(intel.bookings.items.find((b) => b.kind === 'rental_vehicle')?.title).toBe('Rental car for the whole trip');
    expect(intel.budget.lines.map((l) => l.category)).toContain('car_fuel_tolls_parking');
    expect(intel.readiness.entries.map((e) => e.kind)).toContain('driving_document');
    expect(intel.bookings.items.find((b) => b.id === 'booking:ground')).toBeUndefined();
  });
});

describe('a trip by train and bus', () => {
  it('books no rental car even for a traveller who would drive', async () => {
    const draft = draftOf({
      bases: [{ id: 'gate', name: 'Gatetown', nights: 2 }, { id: 'hill', name: 'Hilltown', nights: 3 }],
      days: [
        { base: 'gate', anchors: [{ name: 'Gatetown old market', transport: 'walk' }] },
        { base: 'gate', anchors: [{ name: 'Baobab Flats park', transport: 'bus' }] },
        { base: 'hill', relocation: true, move: { how: 'rail' }, anchors: [{ name: 'Hilltown abbey', transport: 'walk' }] },
        { base: 'hill', anchors: [{ name: 'Flats river circuit', transport: 'bus' }] },
        { base: 'hill', anchors: [{ name: 'Hilltown abbey', transport: 'walk' }] },
        { base: 'hill', anchors: [] },
      ],
      package: { transport: { summary: 'By train between the two towns, buses for the day trips.', notes: [] }, beforeYouGo: ['Verify official entry requirements.'] },
    });
    const { intel } = await build(draft, { willDrive: true });
    expect(intel.destinationContext.arrangement?.primary).toBe('public_transport');
    expect(intel.bookings.items.filter((b) => b.kind === 'rental_vehicle')).toEqual([]);
    expect(intel.readiness.entries.map((e) => e.kind)).not.toContain('driving_document');
    expect(intel.budget.lines.map((l) => l.category)).not.toContain('car_fuel_tolls_parking');
  });
});
