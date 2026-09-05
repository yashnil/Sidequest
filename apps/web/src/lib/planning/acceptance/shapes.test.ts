import { describe, expect, it } from 'vitest';
import { itinerarySchema } from '@sidequest/core';
import { reconcileTripDraft } from '../reconcile';
import { anchorCount, boardWorld, draftOf, fictionalWorld, type FictionalPlace } from './harness';

/**
 * TEN DESTINATION SHAPES, ONE ARCHITECTURAL CONTRACT.
 *
 * Every fixture here is fictional geography. What each proves is a property
 * of the reconciler, never a fact about a real place:
 *
 *   - every anchor the draft proposed ends in exactly one disposition
 *     (silent loss = 0), and every non-scheduled one is explained;
 *   - missing evidence (no geocoder hit, no route, no hours, a provider that
 *     is down) lowers confidence and never removes content;
 *   - affirmative evidence (a router that answered "no road", measured driving
 *     over the traveller's own ceiling) corrects with the smallest change;
 *   - the finished itinerary always validates against the core schema and
 *     survives a JSON round trip unchanged.
 */

function invariants(draft: ReturnType<typeof draftOf>, result: Awaited<ReturnType<typeof reconcileTripDraft>>) {
  expect(result.ok).toBe(true);
  expect(result.dispositions).toHaveLength(anchorCount(draft));
  const explained = result.dispositions.filter((d) => d.disposition.startsWith('rejected') || d.disposition === 'unscheduled_capacity');
  for (const d of explained) {
    expect(result.itinerary.unscheduled.some((u) => u.name === d.name), `${d.name} must be explained on unscheduled`).toBe(true);
  }
  expect(itinerarySchema.safeParse(result.itinerary).success).toBe(true);
  expect(itinerarySchema.parse(JSON.parse(JSON.stringify(result.itinerary)))).toEqual(result.itinerary);
  expect(result.itinerary.package?.anchors).toHaveLength(anchorCount(draft));
  // Total nights are the trip's own nights, whatever the bases say.
  const nights = result.itinerary.package!.bases.reduce((s, b) => s + b.nights, 0);
  expect(nights).toBe(result.itinerary.days.length - 1);
}

function scheduled(result: Awaited<ReturnType<typeof reconcileTripDraft>>) {
  return result.dispositions.filter((d) => !d.disposition.startsWith('rejected') && d.disposition !== 'unscheduled_capacity');
}

function daysWithActivity(result: Awaited<ReturnType<typeof reconcileTripDraft>>) {
  return result.itinerary.days.filter((d) => d.items.some((i) => i.kind === 'activity')).length;
}

const grid = (origin: { lat: number; lng: number }, names: string[], spreadKm: number, known = true): FictionalPlace[] =>
  names.map((name, i) => ({ name, lat: origin.lat + ((i % 3) - 1) * (spreadKm / 111), lng: origin.lng + (Math.floor(i / 3) - 1) * (spreadKm / 111), known }));

describe('shape 1 — dense single-base city', () => {
  it('walks between neighbourhoods and museums, keeps every stop, and measures nothing it should not', async () => {
    const centre = { lat: 40.0, lng: -3.0 };
    const names = ['Old Quarter', 'Grand Museum', 'Central Market', 'Riverside Walk', 'Cathedral Square', 'Modern Gallery', 'Botanic Garden', 'Night Food Street'];
    const world = fictionalWorld({ name: 'Veloria', center: centre, places: grid(centre, names, 3), basics: { startDate: '2026-05-01', endDate: '2026-05-04' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } });
    const draft = draftOf({
      bases: [{ id: 'centre', name: 'Veloria', nights: 3, area: 'the Old Quarter', style: 'small hotel' }],
      days: [
        { base: 'centre', anchors: [{ name: 'Old Quarter', category: 'neighbourhood', transport: 'walk' }, { name: 'Cathedral Square', role: 'secondary', transport: 'walk' }] },
        { base: 'centre', anchors: [{ name: 'Grand Museum', category: 'museum', transport: 'metro' }, { name: 'Central Market', category: 'market', role: 'secondary', transport: 'walk' }, { name: 'Night Food Street', category: 'food', role: 'optional', transport: 'metro' }] },
        { base: 'centre', anchors: [{ name: 'Botanic Garden', category: 'nature', transport: 'metro' }, { name: 'Modern Gallery', category: 'museum', role: 'secondary', transport: 'walk' }] },
        { base: 'centre', anchors: [{ name: 'Riverside Walk', category: 'neighbourhood', transport: 'walk' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(scheduled(result)).toHaveLength(8);
    expect(daysWithActivity(result)).toBe(4);
    expect(result.itinerary.package?.bases[0]?.area).toBe('the Old Quarter');
    expect(result.itinerary.days.every((d) => d.totals.driveMinutes === 0)).toBe(true);
  });
});

describe('shape 2 — city-state', () => {
  it('a compact destination with everything reachable keeps all anchors verified-as-places and measured', async () => {
    const centre = { lat: 1.3, lng: 103.8 };
    const names = ['Harbour Front', 'Heritage District', 'Island Resort', 'Sky Garden', 'Hawker Centre', 'Night Zoo'];
    const world = fictionalWorld({ name: 'Portmarin', center: centre, places: grid(centre, names, 6), basics: { startDate: '2026-11-10', endDate: '2026-11-13' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } });
    const draft = draftOf({
      bases: [{ id: 'city', name: 'Portmarin', nights: 3 }],
      days: [
        { base: 'city', anchors: [{ name: 'Harbour Front', transport: 'metro' }, { name: 'Hawker Centre', category: 'food', role: 'secondary', transport: 'walk' }] },
        { base: 'city', anchors: [{ name: 'Heritage District', category: 'neighbourhood', transport: 'metro' }, { name: 'Sky Garden', category: 'viewpoint', role: 'secondary', transport: 'metro' }, { name: 'Night Zoo', category: 'wildlife', role: 'optional', transport: 'bus' }] },
        { base: 'city', anchors: [{ name: 'Island Resort', category: 'beach', transport: 'ferry' }] },
        { base: 'city', anchors: [{ name: 'Hawker Centre', category: 'food', role: 'flex', transport: 'walk' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(result.itinerary.package?.verification.partiallyVerified).toBe(anchorCount(draft));
    const ferryLeg = result.itinerary.days[2]!.items.find((i) => i.travel?.mode === 'ferry');
    expect(ferryLeg?.travel?.provenance).toBe('unmeasured');
    expect(ferryLeg?.travel?.unmeasuredReason).toBe('mode_not_routed');
  });
});

describe('shape 3 — remote multi-base mountain trip with sparse evidence', () => {
  it('keeps hikes and homestays the geocoder never heard of, measures the base legs it can, and marks the rest unmeasured', async () => {
    const places: FictionalPlace[] = [
      { name: 'Karakol Town', lat: 42.49, lng: 78.39, known: true, entityType: 'city' },
      { name: 'Kochkor Village', lat: 42.21, lng: 75.75, known: true, entityType: 'city' },
      { name: 'Song-Kol Yurt Camp', lat: 41.83, lng: 75.13, known: false },
      { name: 'Altyn Arashan Hot Springs Hike', lat: 42.6, lng: 78.6, known: false },
      { name: 'Jeti-Oguz Red Rocks', lat: 42.32, lng: 78.24, known: true },
      { name: 'Local Eagle Hunter Visit', lat: 42.5, lng: 78.0, known: false },
      { name: 'Kol-Ukok Lake Hike', lat: 42.05, lng: 75.8, known: false },
    ];
    const world = fictionalWorld({ name: 'Highlandia', center: { lat: 42.3, lng: 77.0 }, places, basics: { startDate: '2026-07-01', endDate: '2026-07-07' }, profile: { maxDailyDriveMinutes: 360, maxDailyTransportMinutes: 420 }, roadKmh: 50 });
    const draft = draftOf({
      bases: [
        { id: 'karakol', name: 'Karakol Town', nights: 3, style: 'guesthouse' },
        { id: 'kochkor', name: 'Kochkor Village', nights: 2, style: 'homestay' },
        { id: 'songkol', name: 'Song-Kol Yurt Camp', nights: 1, style: 'yurt camp' },
      ],
      days: [
        { base: 'karakol', anchors: [{ name: 'Karakol Town', category: 'town' }] },
        { base: 'karakol', anchors: [{ name: 'Altyn Arashan Hot Springs Hike', category: 'hike', transport: 'four_wheel_drive', minutes: 360 }], intensity: 'intense' },
        { base: 'karakol', anchors: [{ name: 'Jeti-Oguz Red Rocks', category: 'nature' }, { name: 'Local Eagle Hunter Visit', category: 'activity', role: 'secondary', transport: 'guide_or_lodge_transfer' }] },
        { base: 'kochkor', relocation: true, anchors: [{ name: 'Kochkor Village', category: 'town', role: 'secondary' }] },
        { base: 'kochkor', anchors: [{ name: 'Kol-Ukok Lake Hike', category: 'hike', minutes: 300, transport: 'four_wheel_drive' }], intensity: 'intense' },
        { base: 'songkol', relocation: true, anchors: [{ name: 'Song-Kol Yurt Camp', category: 'nature', transport: 'four_wheel_drive' }] },
        { base: 'songkol', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(scheduled(result)).toHaveLength(anchorCount(draft));
    expect(result.itinerary.package?.verification.unverified).toBeGreaterThanOrEqual(3);
    // The unresolved base is kept by name, its legs unmeasured, and the plan says so.
    expect(result.itinerary.package?.bases.find((b) => b.name === 'Song-Kol Yurt Camp')?.verification).toBe('unverified');
    expect(result.itinerary.transportStrategy.totals.driveMinutes).toBeGreaterThan(0);
    expect(result.itinerary.package?.verification.legsUnmeasured).toBeGreaterThan(0);
    expect(daysWithActivity(result)).toBe(6);
  });
});

describe('shape 4 — huge country scoped to a coherent subset', () => {
  it('keeps the model\'s regional subset and its explicit omissions, and never adds regions on its own', async () => {
    const places = grid({ lat: -2.0, lng: 115.0 }, ['Capital Old Town', 'Temple Terraces', 'Volcano Sunrise Point', 'Rice Valley', 'Reef Island', 'Craft Village', 'Waterfall Gorge', 'Coastal Cliffs', 'Night Market'], 20);
    const world = fictionalWorld({ name: 'Archipelagia', center: { lat: -2.0, lng: 115.0 }, places, basics: { startDate: '2026-09-01', endDate: '2026-09-09' }, profile: { maxDailyDriveMinutes: 240 } });
    const draft = draftOf({
      bases: [{ id: 'capital', name: 'Capital Old Town', nights: 3 }, { id: 'valley', name: 'Rice Valley', nights: 3 }, { id: 'island', name: 'Reef Island', nights: 2 }],
      days: [
        { base: 'capital', anchors: [{ name: 'Capital Old Town', category: 'town' }] },
        { base: 'capital', anchors: [{ name: 'Temple Terraces', category: 'historic' }, { name: 'Night Market', category: 'market', role: 'secondary' }] },
        { base: 'capital', anchors: [{ name: 'Craft Village', category: 'town' }] },
        { base: 'valley', relocation: true, anchors: [{ name: 'Rice Valley', category: 'nature' }] },
        { base: 'valley', anchors: [{ name: 'Volcano Sunrise Point', category: 'viewpoint', minutes: 240 }], intensity: 'intense' },
        { base: 'valley', anchors: [{ name: 'Waterfall Gorge', category: 'water' }] },
        { base: 'island', relocation: true, anchors: [{ name: 'Reef Island', category: 'beach', transport: 'boat' }] },
        { base: 'island', anchors: [{ name: 'Coastal Cliffs', category: 'viewpoint', role: 'secondary', transport: 'walk' }] },
        { base: 'island', anchors: [] },
      ],
      omissions: [{ name: 'The far eastern highlands', reason: 'Two extra flights; not worth it in nine days.' }, { name: 'The northern jungle', reason: 'Wrong season.' }],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(result.itinerary.package?.omissions).toHaveLength(2);
    expect(result.itinerary.package?.bases.map((b) => b.name)).toEqual(['Capital Old Town', 'Rice Valley', 'Reef Island']);
    expect(scheduled(result)).toHaveLength(anchorCount(draft));
  });
});

describe('shape 5 — island road trip', () => {
  it('runs a loop, measures every base leg, and corrects the one leg over the driving cap by inserting a corridor settlement without changing total nights', async () => {
    // A ring of four bases; the last leg home is ~330 km, over a 240-minute cap at 60 km/h × 1.25, with a settlement roughly on the way.
    const places: FictionalPlace[] = [
      { name: 'Port Town', lat: 64.1, lng: -21.9, entityType: 'city' },
      { name: 'South Village', lat: 63.5, lng: -19.0, entityType: 'city' },
      { name: 'East Fjord', lat: 64.25, lng: -15.6, entityType: 'city' },
      { name: 'North City', lat: 65.6, lng: -17.6, entityType: 'city' },
      { name: 'Black Beach', lat: 63.4, lng: -19.1 },
      { name: 'Glacier Lagoon', lat: 64.05, lng: -16.2 },
      { name: 'Whale Bay', lat: 66.0, lng: -17.3 },
      { name: 'Lava Field Walk', lat: 65.6, lng: -16.9 },
    ];
    // Every ring leg fits the cap except the ~325-minute leg home; a settlement sits ~70% of the way along that chord.
    const settlements: FictionalPlace[] = [{ name: 'Halfway Town', lat: 64.55, lng: -20.61, entityType: 'city' }];
    const world = fictionalWorld({ name: 'Ringland', center: { lat: 64.9, lng: -18.5 }, places, settlements, basics: { startDate: '2026-07-05', endDate: '2026-07-13' }, profile: { maxDailyDriveMinutes: 240, maxDailyTransportMinutes: 300 }, roadKmh: 60 });
    const draft = draftOf({
      archetype: 'loop',
      bases: [
        { id: 'port', name: 'Port Town', nights: 2 },
        { id: 'south', name: 'South Village', nights: 2 },
        { id: 'east', name: 'East Fjord', nights: 1 },
        { id: 'north', name: 'North City', nights: 2 },
        { id: 'port2', name: 'Port Town', nights: 1 },
      ],
      days: [
        { base: 'port', anchors: [{ name: 'Port Town', category: 'town' }] },
        { base: 'port', anchors: [{ name: 'Port Town', category: 'town', role: 'secondary' }] },
        { base: 'south', relocation: true, anchors: [{ name: 'Black Beach', category: 'beach' }] },
        { base: 'south', anchors: [{ name: 'Glacier Lagoon', category: 'water', minutes: 120 }] },
        { base: 'east', relocation: true, anchors: [{ name: 'East Fjord', category: 'town', role: 'secondary' }] },
        { base: 'north', relocation: true, anchors: [{ name: 'Lava Field Walk', category: 'nature' }] },
        { base: 'north', anchors: [{ name: 'Whale Bay', category: 'wildlife' }] },
        { base: 'port2', relocation: true, anchors: [] },
        { base: 'port2', anchors: [{ name: 'Port Town', category: 'town', role: 'flex' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    const corridor = result.deviations.find((d) => d.kind === 'relocation_resolved_with_corridor_locality');
    expect(corridor, 'the over-cap leg home is remediated with a real corridor settlement').toBeDefined();
    expect(result.itinerary.package?.bases.some((b) => b.name === 'Halfway Town' && b.insertedBySidequest)).toBe(true);
    expect(result.itinerary.package?.bases.reduce((s, b) => s + b.nights, 0)).toBe(8);
    expect(result.unresolvedRelocations).toHaveLength(0);
    expect(scheduled(result)).toHaveLength(anchorCount(draft));
  });
});

describe('shape 6 — wilderness lodge and boat destination', () => {
  it('treats boat and lodge transfers as real but unmeasured movement, and never asks the road router about them', async () => {
    const places: FictionalPlace[] = [
      { name: 'Gateway City', lat: -3.1, lng: -60.0, entityType: 'city' },
      { name: 'River Lodge', lat: -3.4, lng: -60.9, known: true },
      { name: 'Flooded Forest Canoe', lat: -3.5, lng: -61.0, known: false },
      { name: 'Night Caiman Spotting', lat: -3.45, lng: -60.95, known: false },
      { name: 'Meeting of the Waters', lat: -3.13, lng: -59.9, known: true },
    ];
    const world = fictionalWorld({ name: 'Riverland', center: { lat: -3.3, lng: -60.5 }, places, basics: { startDate: '2026-08-10', endDate: '2026-08-15' }, noRoadBetween: [['Gateway City', 'River Lodge']] });
    const draft = draftOf({
      bases: [{ id: 'gateway', name: 'Gateway City', nights: 1 }, { id: 'lodge', name: 'River Lodge', nights: 3, style: 'jungle lodge, full board' }, { id: 'gateway2', name: 'Gateway City', nights: 1 }],
      days: [
        { base: 'gateway', anchors: [{ name: 'Meeting of the Waters', category: 'water', transport: 'boat' }] },
        { base: 'lodge', relocation: true, anchors: [{ name: 'River Lodge', category: 'nature', transport: 'boat' }] },
        { base: 'lodge', anchors: [{ name: 'Flooded Forest Canoe', category: 'activity', transport: 'guide_or_lodge_transfer' }, { name: 'Night Caiman Spotting', category: 'wildlife', role: 'secondary', transport: 'guide_or_lodge_transfer' }] },
        { base: 'lodge', anchors: [{ name: 'Flooded Forest Canoe', category: 'activity', role: 'optional', transport: 'guide_or_lodge_transfer' }] },
        { base: 'gateway2', relocation: true, anchors: [] },
        { base: 'gateway2', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(scheduled(result)).toHaveLength(anchorCount(draft));
    // The router said "no road" between the gateway and the lodge: an honest note, never a rejection of the trip.
    expect(result.unresolvedRelocations.some((r) => r.kind === 'no_road_route')).toBe(true);
    expect(result.itinerary.status).not.toBe('needs_decision');
    const boatLegs = result.itinerary.days.flatMap((d) => d.items).filter((i) => i.travel?.mode === 'ferry' || i.travel?.mode === 'private_transfer');
    expect(boatLegs.length).toBeGreaterThan(0);
    expect(boatLegs.every((leg) => leg.travel?.provenance === 'unmeasured' && leg.travel.unmeasuredReason === 'mode_not_routed')).toBe(true);
  });
});

describe('shape 7 — safari and remote camp', () => {
  it('keeps game drives and camp transfers with no POI or road data, and a flight leg is honestly unsupported rather than measured', async () => {
    const places: FictionalPlace[] = [
      { name: 'Delta Gateway', lat: -19.98, lng: 23.42, entityType: 'city' },
      { name: 'Reed Camp', lat: -19.3, lng: 22.9, known: false },
      { name: 'Morning Game Drive', lat: -19.3, lng: 22.9, known: false },
      { name: 'Mokoro Channel Glide', lat: -19.25, lng: 22.95, known: false },
      { name: 'Sundowner Hippo Pool', lat: -19.28, lng: 22.88, known: false },
    ];
    const world = fictionalWorld({ name: 'Deltania', center: { lat: -19.6, lng: 23.1 }, places, basics: { startDate: '2026-06-20', endDate: '2026-06-24' } });
    const draft = draftOf({
      bases: [{ id: 'gateway', name: 'Delta Gateway', nights: 1 }, { id: 'camp', name: 'Reed Camp', nights: 3, style: 'tented camp, all inclusive' }],
      days: [
        { base: 'gateway', anchors: [{ name: 'Delta Gateway', category: 'town', role: 'secondary' }] },
        { base: 'camp', relocation: true, anchors: [{ name: 'Reed Camp', category: 'nature', transport: 'flight' }] },
        { base: 'camp', anchors: [{ name: 'Morning Game Drive', category: 'wildlife', transport: 'guide_or_lodge_transfer', minutes: 240 }, { name: 'Sundowner Hippo Pool', category: 'wildlife', role: 'secondary', transport: 'guide_or_lodge_transfer' }] },
        { base: 'camp', anchors: [{ name: 'Mokoro Channel Glide', category: 'activity', transport: 'boat', minutes: 180 }] },
        { base: 'camp', anchors: [{ name: 'Morning Game Drive', category: 'wildlife', role: 'optional', transport: 'guide_or_lodge_transfer' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(scheduled(result)).toHaveLength(anchorCount(draft));
    expect(result.itinerary.package?.verification.unverified).toBe(5);
    expect(result.itinerary.days.filter((d) => d.items.some((i) => i.kind === 'activity')).length).toBe(5);
    expect(result.itinerary.package?.bases.find((b) => b.name === 'Reed Camp')?.style).toContain('tented');
  });
});

describe('shape 8 — mixed road and rail country', () => {
  it('rail legs are honest stand-ins and road legs are measured; a rail-first traveller gets a plan with zero driving', async () => {
    const places = grid({ lat: 46.8, lng: 8.2 }, ['Lake City', 'Mountain Village', 'Old Capital', 'Glacier Express Viewpoint', 'Vineyard Terraces', 'Castle Town'], 60);
    const world = fictionalWorld({ name: 'Alpinia', center: { lat: 46.8, lng: 8.2 }, places, basics: { startDate: '2026-06-01', endDate: '2026-06-06' }, profile: { willDrive: false, maxDailyDriveMinutes: 0 } });
    const draft = draftOf({
      bases: [{ id: 'lake', name: 'Lake City', nights: 2 }, { id: 'mountain', name: 'Mountain Village', nights: 2 }, { id: 'capital', name: 'Old Capital', nights: 1 }],
      days: [
        { base: 'lake', anchors: [{ name: 'Lake City', category: 'town', transport: 'walk' }] },
        { base: 'lake', anchors: [{ name: 'Vineyard Terraces', category: 'nature', transport: 'rail' }] },
        { base: 'mountain', relocation: true, anchors: [{ name: 'Glacier Express Viewpoint', category: 'viewpoint', transport: 'rail' }] },
        { base: 'mountain', anchors: [{ name: 'Mountain Village', category: 'hike', transport: 'walk', minutes: 240 }], intensity: 'intense' },
        { base: 'capital', relocation: true, anchors: [{ name: 'Castle Town', category: 'historic', transport: 'rail' }] },
        { base: 'capital', anchors: [{ name: 'Old Capital', category: 'town', transport: 'walk', role: 'secondary' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(result.itinerary.transportStrategy.primaryMode).not.toBe('drive');
    expect(result.itinerary.transportStrategy.totals.driveMinutes).toBe(0);
    expect(scheduled(result)).toHaveLength(anchorCount(draft));
  });
});

describe('shape 9 — compact regional base + satellites, with real board evidence', () => {
  it('verifies board places with hours and typical durations, keeps a beyond-the-board stop as unverified, and the drive cap corrects an over-long day by dropping the lowest role', async () => {
    const context = boardWorld({ basics: { startDate: '2026-08-12', endDate: '2026-08-15' } });
    const draft = draftOf({
      bases: [{ id: 'basin', name: 'Mammoth Lakes Basin', nights: 3 }],
      days: [
        { base: 'basin', anchors: [{ name: 'The Village at Mammoth', category: 'town', role: 'secondary' }] },
        { base: 'basin', anchors: [{ name: 'Panorama Gondola', category: 'viewpoint' }, { name: 'Convict Lake', category: 'water', role: 'secondary' }, { name: 'A Quiet Overlook Nobody Documented', category: 'viewpoint', role: 'optional' }] },
        { base: 'basin', anchors: [{ name: 'Mono Lake South Tufa', category: 'nature' }, { name: 'June Lake Loop', category: 'scenic_drive', role: 'secondary' }, { name: 'Bishop', category: 'town', role: 'flex' }, { name: 'Minaret Vista', category: 'viewpoint', role: 'optional' }] },
        { base: 'basin', anchors: [{ name: 'Minaret Vista', category: 'viewpoint', role: 'secondary' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context });
    invariants(draft, result);
    const pkg = result.itinerary.package!;
    expect(pkg.verification.verified).toBeGreaterThanOrEqual(5);
    expect(pkg.anchors.find((a) => a.name === 'A Quiet Overlook Nobody Documented')?.verification).toBe('unverified');
    expect(pkg.anchors.find((a) => a.name === 'A Quiet Overlook Nobody Documented')?.disposition).toBe('retained_unverified');
    // Day 3 measures more driving than the 150-minute profile allows; the flex stop gives way first, and core stays.
    const day3 = pkg.anchors.filter((a) => a.dayNumber === 3);
    expect(day3.find((a) => a.name === 'Mono Lake South Tufa')?.disposition).not.toMatch(/rejected|unscheduled/);
    const corrected = day3.filter((a) => a.disposition === 'rejected_hard_constraint' || a.disposition === 'unscheduled_capacity');
    if (corrected.length > 0) {
      expect(corrected.every((a) => a.role !== 'core')).toBe(true);
      expect(result.itinerary.diagnostics.revisions.length).toBeGreaterThan(0);
    }
    expect(result.itinerary.days.find((d) => d.dayNumber === 3)!.totals.driveMinutes).toBeLessThanOrEqual(150);
    // Verified stops carry real measured legs from the compiled matrix.
    const measured = result.itinerary.days.flatMap((d) => d.items).filter((i) => i.travel?.provenance === 'measured');
    expect(measured.length).toBeGreaterThan(0);
  });
});

describe('shape 10 — near-total provider outage', () => {
  it('a dead geocoder, a dead router and a dead corridor search lower confidence to zero and change content by nothing', async () => {
    const places = grid({ lat: 51.5, lng: -0.1 }, ['Riverbank', 'Big Museum', 'Market Hall', 'Park Hill', 'Cathedral', 'Harbour'], 8);
    const build = (outage: boolean) =>
      fictionalWorld({ name: 'Outagia', center: { lat: 51.5, lng: -0.1 }, places, basics: { startDate: '2026-03-01', endDate: '2026-03-04' }, outage: outage ? { geocoder: true, router: true, corridor: true } : {} });
    const draft = draftOf({
      bases: [{ id: 'a', name: 'Riverbank', nights: 2 }, { id: 'b', name: 'Harbour', nights: 1 }],
      days: [
        { base: 'a', anchors: [{ name: 'Riverbank', category: 'neighbourhood' }, { name: 'Market Hall', category: 'market', role: 'secondary' }] },
        { base: 'a', anchors: [{ name: 'Big Museum', category: 'museum' }, { name: 'Park Hill', category: 'nature', role: 'secondary' }] },
        { base: 'b', relocation: true, anchors: [{ name: 'Cathedral', category: 'historic' }] },
        { base: 'b', anchors: [{ name: 'Harbour', category: 'neighbourhood', role: 'secondary' }] },
      ],
    });
    const healthy = await reconcileTripDraft({ draft, context: build(false).context });
    const down = await reconcileTripDraft({ draft, context: build(true).context });
    invariants(draft, healthy);
    invariants(draft, down);
    expect(healthy.itinerary.package?.verification.partiallyVerified).toBe(anchorCount(draft));
    expect(down.itinerary.package?.verification.unverified).toBe(anchorCount(draft));
    expect(scheduled(down)).toHaveLength(anchorCount(draft));
    expect(healthy.itinerary.package?.verification.legsMeasured).toBeGreaterThan(0);
    expect(down.itinerary.package?.verification.legsMeasured).toBe(0);
    expect(down.itinerary.days.map((d) => d.items.filter((i) => i.kind === 'activity').map((i) => i.title))).toEqual(
      healthy.itinerary.days.map((d) => d.items.filter((i) => i.kind === 'activity').map((i) => i.title)),
    );
    expect(down.itinerary.status).toBe('ready_with_cautions');
  });

  it('a verification deadline that has already passed skips every lookup and still returns the whole trip', async () => {
    const places = grid({ lat: 51.5, lng: -0.1 }, ['Riverbank', 'Big Museum', 'Market Hall'], 8);
    const world = fictionalWorld({ name: 'Slowland', center: { lat: 51.5, lng: -0.1 }, places, basics: { startDate: '2026-03-01', endDate: '2026-03-03' }, deadlineReached: true });
    const draft = draftOf({ bases: [{ id: 'a', name: 'Riverbank', nights: 2 }], days: [{ base: 'a', anchors: [{ name: 'Riverbank' }, { name: 'Market Hall', role: 'secondary' }] }, { base: 'a', anchors: [{ name: 'Big Museum' }] }, { base: 'a', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    invariants(draft, result);
    expect(world.calls.geocode + world.calls.matrix + world.calls.confirm).toBe(0);
    expect(result.itinerary.package?.verification.deadlineReached).toBe(true);
    expect(scheduled(result)).toHaveLength(anchorCount(draft));
  });
});
