import { describe, expect, it } from 'vitest';
import { tripDates, unavailableWeatherDataset, type Itinerary } from '@sidequest/core';
import { daySkyFor, skyIntentOf, skyIntentOfTitle, skyStartFor, trustedZone } from './sky-timing';
import { reconcileTripDraft } from './reconcile';
import { auditItinerary } from './quality-audit';
import { draftOf, fictionalWorld, type DayShape, type FictionalWorldOptions } from './acceptance/harness';

/*
 * The coordinates below are real latitudes and longitudes chosen for their
 * sky (a southern European coast in May, an alpine July, a subarctic June, a
 * subtropical Pacific September); the place names are fictional, as in every
 * acceptance world. The expected minutes come from the published NOAA
 * almanac for those points and dates, to within a few minutes.
 */
const COAST_MAY = { point: { lat: 38.72, lng: -9.14 }, zone: 'Europe/Lisbon', date: '2027-05-15' };
const ALPS_JULY = { point: { lat: 46.55, lng: 11.85 }, zone: 'Europe/Rome', date: '2027-07-15' };
const SUBARCTIC_JUNE = { point: { lat: 64.15, lng: -21.94 }, zone: 'Atlantic/Reykjavik', date: '2027-06-25' };
const PACIFIC_SEPT = { point: { lat: 22.05, lng: -159.5 }, zone: 'Pacific/Honolulu', date: '2027-09-15' };

const hhmm = (h: number, m: number) => h * 60 + m;

describe('sky timing — the real sun, not a table', () => {
  it('a mid-May sunset on a southern European coast is about 20:40 local summer time, and the visit starts about 50 minutes before it', () => {
    const sky = daySkyFor(COAST_MAY.point, COAST_MAY.date, COAST_MAY.zone)!;
    expect(sky.sunsetMinute).toBeGreaterThanOrEqual(hhmm(20, 33));
    expect(sky.sunsetMinute).toBeLessThanOrEqual(hhmm(20, 47));
    const timing = skyStartFor('sunset', sky);
    expect(timing.kind).toBe('start');
    if (timing.kind === 'start') expect(sky.sunsetMinute! - timing.minute).toBe(50);
  });

  it('an alpine July night is not dark enough for stargazing before about 22:30', () => {
    const sky = daySkyFor(ALPS_JULY.point, ALPS_JULY.date, ALPS_JULY.zone)!;
    const timing = skyStartFor('darkness', sky);
    expect(timing.kind).toBe('start');
    if (timing.kind === 'start') {
      expect(timing.minute).toBeGreaterThanOrEqual(hhmm(22, 30));
      expect(timing.minute).toBeLessThan(hhmm(23, 30));
    }
  });

  it('a subarctic late-June night never gets dark enough: stargazing has no honest hour', () => {
    const sky = daySkyFor(SUBARCTIC_JUNE.point, SUBARCTIC_JUNE.date, SUBARCTIC_JUNE.zone)!;
    expect(sky.darkness.kind).toBe('never');
    expect(skyStartFor('darkness', sky).kind).toBe('impossible');
  });

  it('a September sunset in the Pacific is about 18:45 local standard time', () => {
    const sky = daySkyFor(PACIFIC_SEPT.point, PACIFIC_SEPT.date, PACIFIC_SEPT.zone)!;
    expect(sky.sunsetMinute).toBeGreaterThanOrEqual(hhmm(18, 38));
    expect(sky.sunsetMinute).toBeLessThanOrEqual(hhmm(18, 52));
    expect(sky.sunriseMinute).toBeGreaterThanOrEqual(hhmm(6, 5));
    expect(sky.sunriseMinute).toBeLessThanOrEqual(hhmm(6, 25));
  });

  it('unknown ≠ false: no point, a null-island point or an untrusted UTC fallback far from Greenwich gives no sky at all', () => {
    expect(daySkyFor(null, COAST_MAY.date, COAST_MAY.zone)).toBeNull();
    expect(daySkyFor({ lat: 0, lng: 0 }, COAST_MAY.date, 'UTC')).toBeNull();
    expect(daySkyFor(PACIFIC_SEPT.point, PACIFIC_SEPT.date, 'UTC')).toBeNull();
    expect(trustedZone('UTC', -9)).toBe('UTC');
    expect(skyStartFor('sunset', null).kind).toBe('unknown');
  });

  it('reads the sky a stop is for from its stated intent and its own words, never a time-of-day it does not have', () => {
    expect(skyIntentOf({ name: 'Ridge walk', timeOfDay: 'sunset' })).toBe('sunset');
    expect(skyIntentOf({ name: 'Meadow stargazing', timeOfDay: 'night' })).toBe('darkness');
    expect(skyIntentOf({ name: 'Dark-sky reserve', timeOfDay: 'evening' })).toBe('darkness');
    expect(skyIntentOf({ name: 'Night market', timeOfDay: 'night' })).toBeNull();
    expect(skyIntentOf({ name: 'Planetarium and stargazing exhibit', timeOfDay: 'morning' })).toBeNull();
    expect(skyIntentOfTitle('Headland at sunset')).toBe('sunset');
  });
});

/* ------------------------------------------------------------------ *
 * Through the reconciler, on a fictional world at real coordinates
 * ------------------------------------------------------------------ */

function skyWorld(input: { centre: { lat: number; lng: number }; zone: string; startDate: string; endDate: string; pace?: 'slow' | 'balanced'; mustIncludeNames?: string[]; places: string[] }) {
  const options: FictionalWorldOptions = {
    name: 'Skyhaven',
    center: input.centre,
    places: [{ name: 'Skyhaven', lat: input.centre.lat, lng: input.centre.lng, known: true, entityType: 'city' }, ...input.places.map((name, i) => ({ name, lat: input.centre.lat + 0.01 * (i + 1), lng: input.centre.lng + 0.01, known: true }))],
    basics: { startDate: input.startDate, endDate: input.endDate },
    ...(input.pace ? { profile: { pace: input.pace } } : {}),
    ...(input.mustIncludeNames ? { mustIncludeNames: input.mustIncludeNames } : {}),
  };
  const world = fictionalWorld(options);
  const regionId = world.context.weather.regionId;
  world.context.weather = unavailableWeatherDataset({
    regionId,
    locations: [{ id: `${regionId}:sky`, label: 'Skyhaven', coordinates: input.centre, elevationMetres: 0, timeZone: input.zone, placeIds: [`${regionId}:sky`], limitation: 'One point.' }],
    dates: tripDates(input.startDate, input.endDate),
    now: new Date('2026-06-01T00:00:00Z'),
    reason: 'not_configured',
    message: 'No weather in the fixture.',
  });
  return world;
}

function fourDays(day2: DayShape['anchors']): DayShape[] {
  return [
    { base: 'b', anchors: [{ name: 'Old Quarter', category: 'neighbourhood' }] },
    { base: 'b', anchors: day2 },
    { base: 'b', anchors: [{ name: 'Harbour Museum', category: 'museum' }] },
    { base: 'b', anchors: [{ name: 'Market Hall', category: 'market', minutes: 60 }] },
  ];
}

async function build(world: ReturnType<typeof skyWorld>, day2: DayShape['anchors']) {
  const draft = draftOf({ bases: [{ id: 'b', name: 'Skyhaven', nights: 3 }], days: fourDays(day2) });
  const result = await reconcileTripDraft({ draft, context: world.context });
  return { draft, result, world };
}

const itemOn = (itinerary: Itinerary, day: number, title: string) => itinerary.days[day - 1]!.items.find((i) => i.kind === 'activity' && i.title === title);

describe('sky timing — through the reconciler', () => {
  it('a mid-May coastal sunset is scheduled to span the real sunset (~20:40), not at 16:30, and the audit agrees', async () => {
    const world = skyWorld({ centre: COAST_MAY.point, zone: COAST_MAY.zone, startDate: '2027-05-14', endDate: '2027-05-17', places: ['Castle Hill Viewpoint', 'Tile Museum', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { draft, result } = await build(world, [{ name: 'Tile Museum', category: 'museum' }, { name: 'Castle Hill Viewpoint', category: 'viewpoint', minutes: 75, timeOfDay: 'sunset' }]);
    const sunset = itemOn(result.itinerary, 2, 'Castle Hill Viewpoint')!;
    expect(sunset).toBeDefined();
    expect(sunset.startMinute).toBeGreaterThanOrEqual(hhmm(19, 40));
    expect(sunset.startMinute).toBeLessThanOrEqual(hhmm(20, 0));
    expect(sunset.endMinute).toBeGreaterThan(result.itinerary.days[1]!.weather.sunsetMinute!);
    expect(sunset.note).toMatch(/sunset is at 20:/);
    /* Dinner still happens: before the sky has its turn. */
    expect(result.itinerary.days[1]!.items.some((i) => i.kind === 'meal' && i.id.endsWith('dinner'))).toBe(true);
    const audit = auditItinerary({ draft, itinerary: result.itinerary, profile: world.context.profile, trip: world.trip });
    expect(audit.checks.find((c) => c.id === 'sky_timing_respected')?.ok).toBe(true);
  });

  it('the audit flags a sunset stop scheduled at the old 16:30 floor, and reports without removing it', async () => {
    const world = skyWorld({ centre: COAST_MAY.point, zone: COAST_MAY.zone, startDate: '2027-05-14', endDate: '2027-05-17', places: ['Castle Hill Viewpoint', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { draft, result } = await build(world, [{ name: 'Castle Hill Viewpoint', category: 'viewpoint', minutes: 60, timeOfDay: 'sunset' }]);
    const day2 = result.itinerary.days[1]!;
    const early: Itinerary = { ...result.itinerary, days: result.itinerary.days.map((d) => (d.dayNumber !== 2 ? d : { ...d, items: d.items.map((i) => (i.title === 'Castle Hill Viewpoint' ? { ...i, startMinute: hhmm(16, 30), endMinute: hhmm(17, 30) } : i)) })) };
    const audit = auditItinerary({ draft, itinerary: early, profile: world.context.profile, trip: world.trip });
    const check = audit.checks.find((c) => c.id === 'sky_timing_respected')!;
    expect(check.ok).toBe(false);
    expect(check.severity).toBe('warning');
    expect(check.detail).toMatch(/Castle Hill Viewpoint runs 16:30/);
    expect(early.days[1]!.items.some((i) => i.title === 'Castle Hill Viewpoint')).toBe(true);
    expect(day2.items.some((i) => i.title === 'Castle Hill Viewpoint')).toBe(true);
  });

  it('the audit flags stargazing scheduled before dark', async () => {
    const world = skyWorld({ centre: ALPS_JULY.point, zone: ALPS_JULY.zone, startDate: '2027-07-14', endDate: '2027-07-17', places: ['Meadow Stargazing', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { draft, result } = await build(world, [{ name: 'Meadow Stargazing', category: 'nature', minutes: 90, timeOfDay: 'night' }]);
    const early: Itinerary = { ...result.itinerary, days: result.itinerary.days.map((d) => (d.dayNumber !== 2 ? d : { ...d, items: d.items.map((i) => (i.title === 'Meadow Stargazing' ? { ...i, startMinute: hhmm(18, 0), endMinute: hhmm(19, 30) } : i)) })) };
    const check = auditItinerary({ draft, itinerary: early, profile: world.context.profile, trip: world.trip }).checks.find((c) => c.id === 'sky_timing_respected')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/before dark/);
  });

  it('alpine July stargazing waits for darkness (not before ~22:30) and the day runs on to hold it', async () => {
    const world = skyWorld({ centre: ALPS_JULY.point, zone: ALPS_JULY.zone, startDate: '2027-07-14', endDate: '2027-07-17', places: ['Meadow Stargazing', 'Lake Walk', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { draft, result } = await build(world, [{ name: 'Lake Walk', category: 'nature' }, { name: 'Meadow Stargazing', category: 'nature', minutes: 90, timeOfDay: 'night' }]);
    const stars = itemOn(result.itinerary, 2, 'Meadow Stargazing')!;
    expect(stars).toBeDefined();
    expect(stars.startMinute).toBeGreaterThanOrEqual(hhmm(22, 30));
    expect(result.itinerary.days[1]!.window.endMinute).toBeGreaterThanOrEqual(stars.endMinute);
    const audit = auditItinerary({ draft, itinerary: result.itinerary, profile: world.context.profile, trip: world.trip });
    expect(audit.checks.find((c) => c.id === 'sky_timing_respected')?.ok).toBe(true);
  });

  /* Live eval v2 (2026-11-13): a long stargazing tour stretched the day's window past 24:00 and the build failed validation. */
  it('a dark-sky stop that would run past midnight keeps the darkness before 24:00, and no window passes it', async () => {
    const world = skyWorld({ centre: ALPS_JULY.point, zone: ALPS_JULY.zone, startDate: '2027-07-14', endDate: '2027-07-17', places: ['Summit Stargazing Tour', 'Lake Walk', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { result } = await build(world, [{ name: 'Lake Walk', category: 'nature' }, { name: 'Summit Stargazing Tour', category: 'nature', minutes: 120, timeOfDay: 'night' }]);
    expect(result.itinerary.days.every((d) => d.window.endMinute <= 24 * 60)).toBe(true);
    const tour = itemOn(result.itinerary, 2, 'Summit Stargazing Tour')!;
    expect(tour.startMinute).toBeGreaterThanOrEqual(hhmm(22, 30));
    expect(tour.endMinute).toBeLessThanOrEqual(24 * 60);
    expect(tour.endMinute - tour.startMinute).toBeGreaterThanOrEqual(45);
  });

  it('a subarctic midsummer sunset (around midnight) never stretches a day past 24:00', async () => {
    const world = skyWorld({ centre: SUBARCTIC_JUNE.point, zone: SUBARCTIC_JUNE.zone, startDate: '2027-06-20', endDate: '2027-06-23', places: ['Headland Sunset Lookout', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { result } = await build(world, [{ name: 'Headland Sunset Lookout', category: 'viewpoint', minutes: 90, timeOfDay: 'sunset' }]);
    expect(result.itinerary.days.every((d) => d.window.endMinute <= 24 * 60)).toBe(true);
    const stop = itemOn(result.itinerary, 2, 'Headland Sunset Lookout');
    if (stop) expect(stop.endMinute).toBeLessThanOrEqual(24 * 60);
  });

  it('subarctic late-June stargazing is left unscheduled with a reason, never placed in daylight', async () => {
    const world = skyWorld({ centre: SUBARCTIC_JUNE.point, zone: SUBARCTIC_JUNE.zone, startDate: '2027-06-24', endDate: '2027-06-27', places: ['Lava Field Stargazing', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { result } = await build(world, [{ name: 'Lava Field Stargazing', category: 'nature', minutes: 90, timeOfDay: 'night' }]);
    expect(result.itinerary.days.some((d) => d.items.some((i) => i.title === 'Lava Field Stargazing'))).toBe(false);
    const explained = result.itinerary.unscheduled.find((u) => u.name === 'Lava Field Stargazing')!;
    expect(explained.reasonCode).toBe('not_feasible');
    expect(explained.reason).toMatch(/dark/);
    expect(result.itinerary.package?.anchors.find((a) => a.name === 'Lava Field Stargazing')?.disposition).toBe('rejected_contradiction');
  });

  it('a September Pacific sunset is scheduled about 50 minutes before ~18:45', async () => {
    const world = skyWorld({ centre: PACIFIC_SEPT.point, zone: PACIFIC_SEPT.zone, startDate: '2027-09-14', endDate: '2027-09-17', places: ['Canyon Rim Lookout', 'Old Quarter', 'Harbour Museum', 'Market Hall'] });
    const { result } = await build(world, [{ name: 'Canyon Rim Lookout', category: 'viewpoint', minutes: 75, timeOfDay: 'sunset' }]);
    const sunset = itemOn(result.itinerary, 2, 'Canyon Rim Lookout')!;
    expect(sunset.startMinute).toBeGreaterThanOrEqual(hhmm(17, 45));
    expect(sunset.startMinute).toBeLessThanOrEqual(hhmm(18, 5));
  });

  it('a slow trip refuses a composed sunrise stop with a reason, but keeps one the traveller asked for, timed to the real sunrise', async () => {
    const places = ['Ridge Sunrise', 'Old Quarter', 'Harbour Museum', 'Market Hall', 'Tile Museum'];
    const day2: DayShape['anchors'] = [{ name: 'Ridge Sunrise', category: 'viewpoint', minutes: 60, timeOfDay: 'sunrise', role: 'secondary' }, { name: 'Tile Museum', category: 'museum' }];
    const slow = await build(skyWorld({ centre: COAST_MAY.point, zone: COAST_MAY.zone, startDate: '2027-05-14', endDate: '2027-05-17', pace: 'slow', places }), day2);
    expect(slow.result.itinerary.days.some((d) => d.items.some((i) => i.title === 'Ridge Sunrise'))).toBe(false);
    const refused = slow.result.itinerary.unscheduled.find((u) => u.name === 'Ridge Sunrise')!;
    expect(refused.reason).toMatch(/pre-dawn start is more than a restful trip asked for/);
    expect(slow.result.itinerary.days[1]!.window.startMinute).toBeGreaterThanOrEqual(hhmm(8, 0));

    const asked = await build(skyWorld({ centre: COAST_MAY.point, zone: COAST_MAY.zone, startDate: '2027-05-14', endDate: '2027-05-17', pace: 'slow', mustIncludeNames: ['Ridge Sunrise'], places }), day2);
    const dawn = itemOn(asked.result.itinerary, 2, 'Ridge Sunrise')!;
    expect(dawn).toBeDefined();
    const sunrise = asked.result.itinerary.days[1]!.weather.sunriseMinute!;
    expect(dawn.startMinute).toBeLessThanOrEqual(sunrise);
    expect(sunrise - dawn.startMinute).toBeLessThanOrEqual(30);
  });
});
