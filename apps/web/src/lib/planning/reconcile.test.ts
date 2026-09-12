import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA_HOURS } from '@sidequest/core/data';
import { reconcileTripDraft } from './reconcile';
import { anchorCount, boardWorld, draftOf, fictionalWorld } from './acceptance/harness';

/**
 * THE RECONCILER'S OWN CONTRACT, ONE PROPERTY PER TEST.
 *
 * Unknown never deletes; affirmative evidence corrects with the smallest
 * change; every anchor ends in one disposition; the day the model chose is
 * the day the stop lands on unless a calendar says otherwise.
 */

describe('missing evidence never removes content', () => {
  it('a stop nothing can verify is scheduled on its day as retained_unverified with an honest note', async () => {
    const world = fictionalWorld({ name: 'Quietland', center: { lat: 50, lng: 10 }, places: [{ name: 'Base Town', lat: 50, lng: 10, entityType: 'city' }], basics: { startDate: '2026-05-01', endDate: '2026-05-02' } });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'A Place Nobody Mapped', role: 'core' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const anchor = result.dispositions[0]!;
    expect(anchor.disposition).toBe('retained_unverified');
    expect(anchor.verification).toBe('unverified');
    const item = result.itinerary.days[0]!.items.find((i) => i.kind === 'activity');
    expect(item?.title).toBe('A Place Nobody Mapped');
    expect(item?.placeId).toBeUndefined();
    expect(item?.accessWarning).toMatch(/could not be independently confirmed/);
    expect(result.itinerary.status).toBe('ready_with_cautions');
  });

  it('a routable base with an unmeasured anchor leg keeps the anchor and marks the leg unmeasured, never "no route"', async () => {
    const world = fictionalWorld({
      name: 'Gapland',
      center: { lat: 50, lng: 10 },
      places: [
        { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' },
        { name: 'Far Ridge', lat: 50.3, lng: 10.3 },
      ],
      basics: { startDate: '2026-05-01', endDate: '2026-05-02' },
      outage: { router: true },
    });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'Far Ridge', category: 'hike' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    expect(result.dispositions[0]!.disposition).toBe('preserved');
    const leg = result.itinerary.days[0]!.items.find((i) => i.kind === 'travel');
    // PRODUCT RECOVERY V1 — both ends have a position, so the leg carries Sidequest's own estimate: never "no route", never a measurement, never zero.
    expect(leg?.travel?.provenance).toBe('estimated');
    expect(leg?.travel?.estimateKind).toBe('geo');
    expect(leg?.travel?.unmeasuredReason).toBeUndefined();
    expect(leg?.durationMinutes).toBeGreaterThan(0);
    expect(result.itinerary.package?.verification.legsUnmeasured).toBeGreaterThan(0);
    expect(result.itinerary.package?.verification.legsEstimated).toBeGreaterThan(0);
  });

  it('a base the geocoder cannot resolve stays in the trip by name with unmeasured legs', async () => {
    const world = fictionalWorld({ name: 'Nameland', center: { lat: 50, lng: 10 }, places: [{ name: 'Known Town', lat: 50, lng: 10, entityType: 'city' }, { name: 'Mystery Camp', lat: 50.5, lng: 10.5, known: false }], basics: { startDate: '2026-05-01', endDate: '2026-05-03' } });
    const draft = draftOf({ bases: [{ id: 'a', name: 'Known Town', nights: 1 }, { id: 'b', name: 'Mystery Camp', nights: 1 }], days: [{ base: 'a', anchors: [] }, { base: 'b', relocation: true, anchors: [] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    expect(result.itinerary.package?.bases.map((b) => [b.name, b.verification])).toEqual([
      ['Known Town', 'partially_verified'],
      ['Mystery Camp', 'unverified'],
    ]);
    expect(result.itinerary.days[1]!.baseName).toBe('Mystery Camp');
    expect(result.deviations.some((d) => d.kind === 'base_unresolved')).toBe(true);
  });
});

describe('affirmative evidence corrects with the smallest change', () => {
  it('a router that answers "no route" for an anchor while its base is routable rejects only that anchor, with a reason', async () => {
    const world = fictionalWorld({
      name: 'Cutland',
      center: { lat: 50, lng: 10 },
      places: [
        { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' },
        { name: 'Reachable Falls', lat: 50.1, lng: 10.1 },
        { name: 'Cut-off Cove', lat: 50.2, lng: 9.8 },
      ],
      basics: { startDate: '2026-05-01', endDate: '2026-05-02' },
      noRoadBetween: [['Base Town', 'Cut-off Cove']],
    });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'Reachable Falls', category: 'water' }, { name: 'Cut-off Cove', category: 'beach', role: 'secondary' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    expect(result.dispositions.map((d) => [d.name, d.disposition])).toEqual([
      ['Reachable Falls', 'preserved'],
      ['Cut-off Cove', 'rejected_contradiction'],
    ]);
    expect(result.itinerary.unscheduled[0]?.reasonCode).toBe('route_contradicted');
    expect(result.itinerary.days[0]!.items.some((i) => i.title === 'Reachable Falls')).toBe(true);
  });

  /*
   * V9.1 — A MATRIX THAT DECLINES A PAIR IS NOT A ROUTER THAT SAID NO.
   *
   * The live defect: after a structural merge moved a day's base, Valhalla's
   * `costmatrix` declined the longer leg and returned a null cell. That was
   * classified as the authoritative no-route, and a 56-minute drive — a named
   * component of the trip's own signature experience — was removed with the
   * words "a real answer, not a gap". `V9.1-ROUTING-CONTRADICTION.md` has the
   * reproduction against the running router.
   */
  it('a pair the matrix declines to answer for keeps its stop, whatever its role', async () => {
    const world = fictionalWorld({
      name: 'Quietland',
      center: { lat: 50, lng: 10 },
      places: [
        { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' },
        { name: 'Reachable Falls', lat: 50.1, lng: 10.1 },
        { name: 'Far Cove', lat: 50.2, lng: 9.8 },
      ],
      basics: { startDate: '2026-05-01', endDate: '2026-05-02' },
      unmeasuredBetween: [['Base Town', 'Far Cove']],
    });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'Reachable Falls', category: 'water' }, { name: 'Far Cove', category: 'beach', role: 'secondary' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    /* Nothing is contradicted, and nothing is deleted: the leg is simply not measured. */
    expect(result.dispositions.find((d) => d.name === 'Far Cove')?.disposition).not.toBe('rejected_contradiction');
    expect(result.itinerary.unscheduled.some((u) => u.reasonCode === 'route_contradicted')).toBe(false);
    expect(result.itinerary.days[0]!.items.some((i) => i.title === 'Far Cove')).toBe(true);
  });

  it('keeps a defining stop when the leg is unmeasured, and still removes one the router evaluated and refused', async () => {
    const where = (noRoad: boolean) =>
      fictionalWorld({
        name: 'Coreland',
        center: { lat: 50, lng: 10 },
        places: [
          { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' },
          { name: 'Near Falls', lat: 50.1, lng: 10.1 },
          { name: 'The Whole Point', lat: 50.2, lng: 9.8 },
        ],
        basics: { startDate: '2026-05-01', endDate: '2026-05-02' },
        ...(noRoad ? { noRoadBetween: [['Base Town', 'The Whole Point']] as const } : { unmeasuredBetween: [['Base Town', 'The Whole Point']] as const }),
      });
    const draft = draftOf({
      bases: [{ id: 'b', name: 'Base Town', nights: 1 }],
      days: [{ base: 'b', anchors: [{ name: 'Near Falls', category: 'water' }, { name: 'The Whole Point', category: 'landmark', role: 'core' }] }, { base: 'b', anchors: [] }],
    });

    /* Uncertain routing: the reason the traveller is going survives it. */
    const unmeasured = await reconcileTripDraft({ draft, context: where(false).context });
    expect(unmeasured.dispositions.find((d) => d.name === 'The Whole Point')?.disposition).not.toBe('rejected_contradiction');
    expect(unmeasured.itinerary.days[0]!.items.some((i) => i.title === 'The Whole Point')).toBe(true);

    /* Affirmative evidence: the router evaluated the leg and reported no route, and that still counts. */
    const refused = await reconcileTripDraft({ draft, context: where(true).context });
    expect(refused.dispositions.find((d) => d.name === 'The Whole Point')?.disposition).toBe('rejected_contradiction');
    expect(refused.itinerary.unscheduled.some((u) => u.reasonCode === 'route_contradicted')).toBe(true);
  });

  it('measured driving over the ceiling drops the lowest role first and never a core stop', async () => {
    const world = fictionalWorld({
      name: 'Longland',
      center: { lat: 50, lng: 10 },
      places: [
        { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' },
        { name: 'Near Lake', lat: 50.2, lng: 10.2 },
        { name: 'Far Gorge', lat: 51.6, lng: 11.6 },
      ],
      basics: { startDate: '2026-05-01', endDate: '2026-05-02' },
      profile: { maxDailyDriveMinutes: 180, maxDailyTransportMinutes: 240 },
    });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'Near Lake', category: 'water', role: 'core' }, { name: 'Far Gorge', category: 'nature', role: 'optional' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    expect(result.dispositions.map((d) => [d.name, d.disposition])).toEqual([
      ['Near Lake', 'preserved'],
      ['Far Gorge', 'rejected_hard_constraint'],
    ]);
    expect(result.itinerary.days[0]!.totals.driveMinutes).toBeLessThanOrEqual(180);
    expect(result.itinerary.unscheduled[0]?.reasonCode).toBe('exceeds_daily_travel');
    expect(result.itinerary.issues.some((i) => i.code === 'daily_drive_exceeded' && i.wasResolvedByRemoval)).toBe(true);
  });

  it('a day that cannot hold everything leaves the last optional stop off for room, and says so', async () => {
    const world = fictionalWorld({ name: 'Fullland', center: { lat: 50, lng: 10 }, places: [{ name: 'Base Town', lat: 50, lng: 10, entityType: 'city' }, { name: 'One', lat: 50.01, lng: 10.01 }, { name: 'Two', lat: 50.02, lng: 10.02 }, { name: 'Three', lat: 50.03, lng: 10.03 }], basics: { startDate: '2026-05-01', endDate: '2026-05-02' } });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'One', minutes: 300 }, { name: 'Two', minutes: 300, role: 'secondary' }, { name: 'Three', minutes: 300, role: 'optional' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    expect(result.dispositions.find((d) => d.name === 'Three')?.disposition).toBe('unscheduled_capacity');
    expect(result.dispositions.find((d) => d.name === 'One')?.disposition).toBe('preserved');
    expect(result.itinerary.unscheduled.find((u) => u.name === 'Three')?.reasonCode).toBe('no_time_left');
  });

  it('a must-include the traveller asked for that has to come off turns the status into a decision, not a caution', async () => {
    const world = fictionalWorld({
      name: 'Askland',
      center: { lat: 50, lng: 10 },
      places: [{ name: 'Base Town', lat: 50, lng: 10, entityType: 'city' }, { name: 'Wanted Cove', lat: 50.2, lng: 9.8 }],
      basics: { startDate: '2026-05-01', endDate: '2026-05-02' },
      noRoadBetween: [['Base Town', 'Wanted Cove']],
      mustIncludeNames: ['Wanted Cove'],
    });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'Wanted Cove' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    expect(result.itinerary.unscheduled[0]?.wasManual).toBe(true);
    expect(result.itinerary.status).toBe('needs_decision');
  });
});

describe('published hours on verified places', () => {
  it('a place closed on every trip date by its own calendar is taken off as a contradiction; one closed only on its day is moved to a same-base day it is open', async () => {
    // Manzanar's visitor centre opens Fri–Mon. 2026-08-11 is a Tuesday: closed Tue–Thu, open Fri.
    const context = boardWorld({ basics: { startDate: '2026-08-11', endDate: '2026-08-14', arrivalTime: '08:00' } });
    const calendar = EASTERN_SIERRA_HOURS.calendars.find((c) => c.placeId === 'manzanar-visitor-center');
    expect(calendar?.kind).toBe('scheduled');
    const draft = draftOf({
      bases: [{ id: 'basin', name: 'Mammoth Lakes Basin', nights: 3 }],
      days: [
        { base: 'basin', anchors: [{ name: 'Manzanar Visitor Center', category: 'museum' }] },
        { base: 'basin', anchors: [{ name: 'Convict Lake', category: 'water' }] },
        { base: 'basin', anchors: [{ name: 'Hot Creek Geologic Site', category: 'geothermal' }] },
        { base: 'basin', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context });
    const manzanar = result.dispositions.find((d) => /Manzanar/.test(d.name));
    expect(manzanar?.verification).toBe('verified');
    expect(manzanar?.disposition).toBe('moved_other_day');
    expect(manzanar?.scheduledDayNumber).toBe(4);
    expect(result.itinerary.days[3]!.items.some((i) => /Manzanar/.test(i.title))).toBe(true);
    expect(result.itinerary.days[0]!.items.some((i) => /Manzanar/.test(i.title))).toBe(false);

    // Closed on every trip date: the gondola runs June–September only.
    const winter = boardWorld({ basics: { startDate: '2027-01-12', endDate: '2027-01-14' } });
    const winterDraft = draftOf({ bases: [{ id: 'basin', name: 'Mammoth Lakes Basin', nights: 2 }], days: [{ base: 'basin', anchors: [{ name: 'Panorama Gondola', category: 'viewpoint' }] }, { base: 'basin', anchors: [] }, { base: 'basin', anchors: [] }] });
    const winterResult = await reconcileTripDraft({ draft: winterDraft, context: winter });
    expect(winterResult.dispositions[0]!.disposition).toBe('rejected_contradiction');
    expect(winterResult.itinerary.unscheduled[0]?.reasonCode).toBe('closed_on_trip_dates');
  });

  it('an open window is attached to the stop and a too-early arrival waits for the gate', async () => {
    const context = boardWorld({ basics: { startDate: '2026-08-12', endDate: '2026-08-13', arrivalTime: '06:00' } });
    const draft = draftOf({ bases: [{ id: 'basin', name: 'Mammoth Lakes Basin', nights: 1 }], days: [{ base: 'basin', anchors: [{ name: 'Panorama Gondola', category: 'viewpoint' }] }, { base: 'basin', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context });
    const gondola = result.itinerary.days[0]!.items.find((i) => i.kind === 'activity');
    expect(gondola?.hours?.openMinute).toBe(9 * 60);
    expect(gondola!.startMinute).toBeGreaterThanOrEqual(9 * 60);
  });
});

describe('the day itself', () => {
  it('keeps the draft order, places meals at their hours, fills free time, and totals agree with the items', async () => {
    const world = fictionalWorld({ name: 'Orderland', center: { lat: 50, lng: 10 }, places: [{ name: 'Base Town', lat: 50, lng: 10, entityType: 'city' }, { name: 'Alpha', lat: 50.05, lng: 10.05 }, { name: 'Beta', lat: 50.1, lng: 10.1 }, { name: 'Gamma', lat: 50.15, lng: 10.15 }], basics: { startDate: '2026-05-01', endDate: '2026-05-03' } });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 2 }], days: [{ base: 'b', anchors: [] }, { base: 'b', anchors: [{ name: 'Gamma', minutes: 60 }, { name: 'Alpha', minutes: 60, role: 'secondary' }, { name: 'Beta', minutes: 60, role: 'optional' }], meals: { breakfast: 'at the hotel', lunch: 'in Alpha', dinner: 'back in town' } }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const day = result.itinerary.days[1]!;
    const activities = day.items.filter((i) => i.kind === 'activity').map((i) => i.title);
    expect(activities).toEqual(['Gamma', 'Alpha', 'Beta']);
    const meals = day.items.filter((i) => i.kind === 'meal');
    expect(meals.map((m) => m.title)).toEqual(['Breakfast — at the hotel', 'Lunch — in Alpha', 'Dinner — back in town']);
    expect(meals[1]!.startMinute).toBeGreaterThanOrEqual(11 * 60 + 30);
    expect(meals[2]!.startMinute).toBeGreaterThanOrEqual(18 * 60);
    expect(meals[2]!.endMinute).toBeLessThanOrEqual(day.window.endMinute);
    for (let i = 1; i < day.items.length; i += 1) expect(day.items[i]!.startMinute).toBeGreaterThanOrEqual(day.items[i - 1]!.endMinute);
    expect(day.totals.activityMinutes).toBe(180);
    expect(day.totals.freeMinutes).toBe(day.items.filter((i) => i.kind === 'free_time').reduce((s, i) => s + i.durationMinutes, 0));
    expect(anchorCount(draft)).toBe(result.dispositions.length);
  });

  it('a relocation day carries the transfer as a real leg to the new base and says so', async () => {
    const world = fictionalWorld({ name: 'Moveland', center: { lat: 50, lng: 10 }, places: [{ name: 'Town A', lat: 50, lng: 10, entityType: 'city' }, { name: 'Town B', lat: 50.8, lng: 10.8, entityType: 'city' }, { name: 'Halfway Falls', lat: 50.4, lng: 10.4 }], basics: { startDate: '2026-05-01', endDate: '2026-05-03' } });
    const draft = draftOf({ bases: [{ id: 'a', name: 'Town A', nights: 1 }, { id: 'b', name: 'Town B', nights: 1 }], days: [{ base: 'a', anchors: [] }, { base: 'b', relocation: true, anchors: [{ name: 'Halfway Falls', category: 'water' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const day = result.itinerary.days[1]!;
    const legs = day.items.filter((i) => i.kind === 'travel');
    expect(legs.map((l) => l.travel?.toName)).toEqual(['Halfway Falls', 'Town B']);
    expect(legs[1]!.travel?.role).toBe('transfer');
    expect(day.baseName).toBe('Town B');
    expect(day.warnings.some((w) => /move from Town A to Town B/.test(w))).toBe(true);
  });
});
