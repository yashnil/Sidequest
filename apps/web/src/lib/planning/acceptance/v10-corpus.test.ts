import { describe, expect, it } from 'vitest';
import {
  buildTravelerProfile,
  defaultAnswers,
  placementBlocksReady,
  routeCriticalRate,
  type AccessConstraint,
  type Trip,
} from '@sidequest/core';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import { compileQuality } from '../quality-compiler';
import { deriveExperienceGraph } from '../experience-graph';
import { fictionalWorld, draftOf, type FictionalPlace } from './harness';
import { tripDraftSchema, type TripDraft } from '../trip-draft';

/**
 * V10 §18 — THE ACCEPTANCE CORPUS, ACROSS THE TRIP SHAPES THE BRIEF NAMES.
 *
 * Ten shapes — a city, a whole country, two countries, a natural region, a coast,
 * an island chain, a safari circuit, a mountain road trip, a rail trip and remote
 * wilderness — each a synthetic draft reconciled against a fictional world with
 * no provider network, and each held to the V10 invariants:
 *
 *   every base and gateway on the map, or named as unplaced (§5)
 *   every base transfer measured where the router can answer (§6)
 *   no day doubling back, or an honest "could not be judged" (§7)
 *   no closed stop, no required mode shown as a drive (§9 §22)
 *   one connected experience counted once (§4 §22)
 *   nothing in the traveller's own text that reads like a field name (§19)
 *
 * The worlds are fictional on purpose: the point is that the invariants hold on
 * *shapes*, independent of any destination, which is what "generic" means here.
 * The real-geography regressions live in `founder-v10.test.ts` and
 * `spatial-order.test.ts`.
 */

const NOW = new Date('2026-09-12T12:00:00Z');

interface Shape {
  /** The kind of trip, for the failure message. */
  label: string;
  places: readonly FictionalPlace[];
  bases: { id: string; name: string; nights: number }[];
  days: Parameters<typeof draftOf>[0]['days'];
  countryCode?: string;
  basics?: Partial<Trip['basics']>;
  accessConstraints?: readonly AccessConstraint[];
  /** Names the world's router affirmatively refuses, so an episode leg is plausible rather than impossible. */
  noRoadBetween?: readonly [string, string][];
  /** True where the shape deliberately has an unplaceable day (a vessel base, an unplaced name). */
  expectUnplaceableDays?: boolean;
}

const place = (name: string, lat: number, lng: number, extra: Partial<FictionalPlace> = {}): FictionalPlace => ({ name, lat, lng, ...extra });

const SHAPES: Shape[] = [
  {
    label: 'a city, five nights, no car',
    places: [place('Metro City', 50, 10, { entityType: 'city' }), place('Old Quarter', 50.01, 10.01), place('River Museum', 50.02, 10.015), place('Hill Viewpoint', 50.03, 10.02)],
    bases: [{ id: 'metro', name: 'Metro City', nights: 4 }],
    days: [
      { base: 'metro', anchors: [{ name: 'Old Quarter', category: 'neighbourhood', minutes: 120 }] },
      { base: 'metro', anchors: [{ name: 'River Museum', category: 'museum', minutes: 90 }, { name: 'Hill Viewpoint', category: 'viewpoint', minutes: 45, timeOfDay: 'sunset' }] },
      { base: 'metro', anchors: [{ name: 'Old Quarter', category: 'neighbourhood', minutes: 60 }] },
      { base: 'metro', anchors: [{ name: 'River Museum', category: 'museum', minutes: 60 }] },
      { base: 'metro', anchors: [] },
    ],
  },
  {
    label: 'a whole country, four bases in one direction',
    places: [place('Capital', 50, 10, { entityType: 'city' }), place('Midland Town', 50.6, 10.6, { entityType: 'city' }), place('Far Town', 51.3, 11.3, { entityType: 'city' }), place('North Town', 52, 12, { entityType: 'city' }), place('Roadside Falls', 50.3, 10.3), place('Midland Ruin', 50.8, 10.8), place('Far Lake', 51.5, 11.5)],
    bases: [
      { id: 'capital', name: 'Capital', nights: 1 },
      { id: 'midland', name: 'Midland Town', nights: 1 },
      { id: 'far', name: 'Far Town', nights: 1 },
      { id: 'north', name: 'North Town', nights: 1 },
    ],
    days: [
      { base: 'capital', anchors: [] },
      { base: 'midland', relocation: true, anchors: [{ name: 'Roadside Falls', category: 'water', minutes: 45 }] },
      { base: 'far', relocation: true, anchors: [{ name: 'Midland Ruin', category: 'historic', minutes: 60 }] },
      { base: 'north', relocation: true, anchors: [{ name: 'Far Lake', category: 'water', minutes: 60 }] },
      { base: 'north', anchors: [] },
    ],
  },
  {
    label: 'two countries, one crossing',
    countryCode: 'xx',
    places: [place('West City', 50, 10, { entityType: 'city' }), place('Border Town', 50.5, 10.9, { entityType: 'city' }), place('East City', 51, 11.8, { entityType: 'city' }), place('Frontier Museum', 50.5, 10.95)],
    bases: [
      { id: 'west', name: 'West City', nights: 2 },
      { id: 'east', name: 'East City', nights: 2 },
    ],
    days: [
      { base: 'west', anchors: [] },
      { base: 'west', anchors: [{ name: 'Border Town', category: 'town', minutes: 90 }] },
      { base: 'east', relocation: true, anchors: [{ name: 'Frontier Museum', category: 'museum', minutes: 60 }] },
      { base: 'east', anchors: [] },
      { base: 'east', anchors: [] },
    ],
  },
  {
    label: 'a natural region, one base and long days out',
    places: [place('Valley Village', 50, 10, { entityType: 'city' }), place('Upper Lake', 50.25, 10.1), place('Upper Lake Tea House', 50.26, 10.11), place('Glacier Tongue', 50.35, 10.2), place('Canyon Rim', 50.15, 10.4)],
    bases: [{ id: 'valley', name: 'Valley Village', nights: 3 }],
    days: [
      { base: 'valley', anchors: [] },
      { base: 'valley', anchors: [{ name: 'Upper Lake', category: 'water', minutes: 150 }, { name: 'Upper Lake Tea House', category: 'food', role: 'optional', minutes: 40, locality: 'Upper Lake' }] },
      { base: 'valley', anchors: [{ name: 'Glacier Tongue', category: 'nature', minutes: 120 }] },
      { base: 'valley', anchors: [{ name: 'Canyon Rim', category: 'viewpoint', minutes: 60 }] },
    ],
    accessConstraints: [
      {
        id: 'upper-lake-shuttle',
        placeName: 'Upper Lake',
        status: 'restricted',
        requiredMode: 'shuttle',
        reservationRequired: true,
        authority: 'official_current',
        sourceName: 'The park authority access notice',
        checkedAt: '2026-09-12',
        travellerNote: 'Private vehicles are not admitted on the lake road; the way in is the park shuttle, booked ahead.',
      },
    ],
  },
  {
    label: 'a coast, three bases along one shore',
    places: [place('West Harbour', 50, 10, { entityType: 'city' }), place('Mid Cove', 50.05, 10.5, { entityType: 'city' }), place('East Point', 50.1, 11, { entityType: 'city' }), place('Cliff Path', 50.02, 10.25), place('Sea Arch', 50.07, 10.75)],
    bases: [
      { id: 'west', name: 'West Harbour', nights: 1 },
      { id: 'mid', name: 'Mid Cove', nights: 1 },
      { id: 'east', name: 'East Point', nights: 2 },
    ],
    days: [
      { base: 'west', anchors: [] },
      { base: 'mid', relocation: true, anchors: [{ name: 'Cliff Path', category: 'hike', minutes: 90 }] },
      { base: 'east', relocation: true, anchors: [{ name: 'Sea Arch', category: 'viewpoint', minutes: 45 }] },
      { base: 'east', anchors: [] },
      { base: 'east', anchors: [] },
    ],
  },
  {
    label: 'an island chain reached by ferry',
    places: [place('Mainland Port', 50, 10, { entityType: 'city' }), place('First Island Town', 50.4, 10.1, { entityType: 'city' }), place('Crater Walk', 50.42, 10.12), place('Second Island Town', 50.8, 10.2, { entityType: 'city' })],
    bases: [
      { id: 'port', name: 'Mainland Port', nights: 1 },
      { id: 'first', name: 'First Island Town', nights: 2 },
    ],
    days: [
      { base: 'port', anchors: [] },
      { base: 'first', relocation: true, anchors: [{ name: 'Crater Walk', category: 'hike', minutes: 120, transport: 'ferry' }] },
      { base: 'first', anchors: [{ name: 'Second Island Town', category: 'town', minutes: 90, transport: 'boat' }] },
      { base: 'first', anchors: [] },
    ],
    noRoadBetween: [['Mainland Port', 'First Island Town']],
  },
  {
    label: 'a safari circuit of lodges',
    places: [place('Gateway Town', 50, 10, { entityType: 'city' }), place('First Camp', 50.5, 10.5, { entityType: 'city' }), place('Plains Crossing', 50.55, 10.55), place('Second Camp', 51, 11, { entityType: 'city' }), place('Waterhole', 51.05, 11.05)],
    bases: [
      { id: 'first-camp', name: 'First Camp', nights: 2 },
      { id: 'second-camp', name: 'Second Camp', nights: 2 },
    ],
    days: [
      { base: 'first-camp', anchors: [{ name: 'Plains Crossing', category: 'wildlife', minutes: 240, timeOfDay: 'sunrise' }], partOf: 'Safari circuit' },
      { base: 'first-camp', anchors: [{ name: 'Plains Crossing', category: 'wildlife', minutes: 180 }], partOf: 'Safari circuit' },
      { base: 'second-camp', relocation: true, anchors: [{ name: 'Waterhole', category: 'wildlife', minutes: 180 }], partOf: 'Safari circuit' },
      { base: 'second-camp', anchors: [{ name: 'Waterhole', category: 'wildlife', minutes: 180 }], partOf: 'Safari circuit' },
      { base: 'second-camp', anchors: [] },
    ],
  },
  {
    label: 'a mountain road trip with a pass',
    places: [place('South Valley', 50, 10, { entityType: 'city' }), place('Pass Viewpoint', 50.4, 10.2), place('Alpine Lake', 50.45, 10.25), place('North Valley', 50.9, 10.4, { entityType: 'city' })],
    bases: [
      { id: 'south', name: 'South Valley', nights: 2 },
      { id: 'north', name: 'North Valley', nights: 2 },
    ],
    days: [
      { base: 'south', anchors: [] },
      { base: 'south', anchors: [{ name: 'Alpine Lake', category: 'water', minutes: 120 }] },
      { base: 'north', relocation: true, anchors: [{ name: 'Pass Viewpoint', category: 'viewpoint', minutes: 45 }] },
      { base: 'north', anchors: [] },
      { base: 'north', anchors: [] },
    ],
  },
  {
    label: 'a rail trip between four towns',
    places: [place('Rail Start', 50, 10, { entityType: 'city' }), place('Second Stop', 50.5, 10.3, { entityType: 'city' }), place('Third Stop', 51, 10.6, { entityType: 'city' }), place('Terminus', 51.5, 10.9, { entityType: 'city' }), place('Station Market', 50.51, 10.31)],
    bases: [
      { id: 'start', name: 'Rail Start', nights: 1 },
      { id: 'second', name: 'Second Stop', nights: 1 },
      { id: 'terminus', name: 'Terminus', nights: 2 },
    ],
    days: [
      { base: 'start', anchors: [] },
      { base: 'second', relocation: true, anchors: [{ name: 'Station Market', category: 'market', minutes: 60, transport: 'rail' }] },
      { base: 'terminus', relocation: true, anchors: [{ name: 'Third Stop', category: 'town', minutes: 90, transport: 'rail' }] },
      { base: 'terminus', anchors: [] },
      { base: 'terminus', anchors: [] },
    ],
  },
  {
    label: 'remote wilderness with one gateway',
    places: [place('Bush Gateway', 50, 10, { entityType: 'city' }), place('Wilderness Lodge', 51, 11, { entityType: 'city' }), place('Ridge Walk', 51.05, 11.05)],
    bases: [
      { id: 'gateway', name: 'Bush Gateway', nights: 1 },
      { id: 'lodge', name: 'Wilderness Lodge', nights: 3 },
    ],
    days: [
      { base: 'gateway', anchors: [] },
      { base: 'lodge', relocation: true, anchors: [{ name: 'Ridge Walk', category: 'hike', minutes: 180, transport: 'flight' }] },
      { base: 'lodge', anchors: [{ name: 'Ridge Walk', category: 'hike', minutes: 240 }] },
      { base: 'lodge', anchors: [] },
      { base: 'lodge', anchors: [] },
    ],
    noRoadBetween: [['Bush Gateway', 'Wilderness Lodge']],
  },
];

/** Anything that reads like a field name, an enum value or a provider. §19. */
const MACHINERY = /access_constraint|required_mode|placement|centerBasis|center_basis|provenance|unmeasured|no_acceptable_candidate|geocoder|nominatim|valhalla|openrouteservice|route_critical|day_order|reason_code|dispositionCode|verdict=|=shuttle/i;

async function runShape(shape: Shape) {
  const nights = shape.bases.reduce((n, b) => n + b.nights, 0);
  const startDate = '2026-09-21';
  const endDate = new Date(Date.parse(`${startDate}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10);
  const world = fictionalWorld({
    name: shape.label,
    center: shape.places[0]!,
    places: shape.places,
    ...(shape.countryCode ? { countryCode: shape.countryCode } : {}),
    ...(shape.noRoadBetween ? { noRoadBetween: shape.noRoadBetween } : {}),
    basics: { startDate, endDate, arrivalTime: '15:00', departureTime: '11:00', ...shape.basics },
  });
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: shape.days.length });
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: shape.days.length });
  const context: ReconcileContext = { ...world.context, profile, destinationCountryName: 'Fictionland' };
  const draft: TripDraft = tripDraftSchema.parse(draftOf({ bases: shape.bases, days: shape.days }));
  const result = await reconcileTripDraft({ draft, context });
  const trip: Trip = { id: `v10-${shape.label.replace(/\W+/g, '-')}`, basics: context.basics, status: 'planned', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  const experiences = deriveExperienceGraph({
    draft,
    datesByDay: new Map(result.itinerary.days.map((d) => [d.dayNumber, d.date])),
    accessConstraints: shape.accessConstraints ?? [],
    placeIdByAnchor: new Map((result.itinerary.package?.anchors ?? []).filter((a) => a.placeId).map((a) => [a.id, a.placeId!])),
  });
  const compiled = compileQuality({
    itinerary: result.itinerary,
    draft,
    trip,
    profile,
    placement: result.placement,
    dayOrders: result.dayOrders,
    gateway: result.gateway,
    accessConstraints: shape.accessConstraints ?? [],
    experiences,
  });
  return { result, compiled, experiences, draft, trip, profile };
}

describe('V10 acceptance corpus', () => {
  for (const shape of SHAPES) {
    describe(shape.label, () => {
      it('places every base, and the placement rate says so', async () => {
        const { result } = await runShape(shape);
        const unplacedBases = result.placement.placements.filter((p) => p.kind === 'base' && p.outcome !== 'placed');
        expect(unplacedBases.map((p) => `${p.name}/${p.outcome}`)).toEqual([]);
        expect(routeCriticalRate(result.placement)).toBe(1);
        expect(placementBlocksReady(result.placement)).toBe(false);
      });

      it('leaves no day doubling back, and judges every day it can', async () => {
        const { result } = await runShape(shape);
        const uncorrected = result.dayOrders.filter((o) => o.report.verdict === 'violation' && !o.corrected);
        expect(uncorrected.map((o) => `day ${o.dayNumber}: ${o.report.violations[0]?.detail}`)).toEqual([]);
        for (const order of result.dayOrders.filter((o) => o.report.verdict === 'unplaceable')) {
          /* An unjudgeable day always names what is missing. Silence is the defect. */
          expect(order.report.unplaced.length).toBeGreaterThan(0);
        }
      });

      it('measures the base transfers the router can answer for', async () => {
        const { result } = await runShape(shape);
        const refused = new Set((shape.noRoadBetween ?? []).flat().map((n) => n.toLowerCase()));
        for (const day of result.itinerary.days) {
          for (const item of day.items) {
            const travel = item.travel;
            if (!travel || travel.role !== 'transfer' || travel.provenance === 'measured') continue;
            /* Unmeasured is allowed only where the world refuses the pair or the mode is not a road question. */
            const endpoints = `${travel.fromName} ${travel.toName}`.toLowerCase();
            /* A rail, ferry, flight or operator leg is timed by a timetable, not by a road router: honest, not missing. */
            const excused = [...refused].some((n) => endpoints.includes(n)) || travel.unmeasuredReason === 'mode_not_routed' || travel.unmeasuredReason === 'operator_unpublished' || travel.unmeasuredReason === 'no_route_found';
            expect(excused, `day ${day.dayNumber}: ${travel.fromName} → ${travel.toName} unmeasured (${travel.unmeasuredReason})`).toBe(true);
          }
        }
      });

      it('passes the quality compiler, and every check it skipped says why', async () => {
        const { compiled } = await runShape(shape);
        expect(compiled.report.issues.filter((i) => i.severity === 'blocker').map((i) => `${i.check}: ${i.detail}`)).toEqual([]);
        expect(compiled.report.passed).toBe(true);
        for (const skip of compiled.report.skipped) expect(skip.reason.length, `${skip.check} skipped with no reason`).toBeGreaterThan(0);
      });

      it("says nothing in the traveller's own words that reads like machinery", async () => {
        const { compiled, result } = await runShape(shape);
        const travellerText = [
          ...compiled.report.issues.map((i) => i.travellerNote).filter((n): n is string => typeof n === 'string'),
          ...result.placement.placements.map((p) => p.travellerNote).filter((n): n is string => typeof n === 'string'),
          ...(result.gateway?.notes ?? []),
          ...result.itinerary.days.flatMap((d) => d.warnings ?? []),
          ...result.itinerary.unscheduled.map((u) => u.reason),
        ];
        for (const sentence of travellerText) expect(sentence, `machinery in "${sentence}"`).not.toMatch(MACHINERY);
      });
    });
  }

  it('a required mode is an access dependency on the experience, never a parking note', async () => {
    const natural = SHAPES.find((s) => s.label.startsWith('a natural region'))!;
    const { experiences, compiled } = await runShape(natural);
    const withAccess = experiences.experiences.filter((e) => e.access.some((a) => a.required));
    expect(withAccess.map((e) => e.name)).toEqual(['Upper Lake']);
    expect(withAccess[0]!.access[0]!.mode).toBe('shuttle');
    /* And the traveller is told in words, with no vocabulary in them. */
    const said = compiled.report.issues.filter((i) => i.check === 'access_requirements_represented').map((i) => i.travellerNote);
    expect(said.some((note) => typeof note === 'string' && /shuttle/i.test(note) && !MACHINERY.test(note))).toBe(true);
  });

  it('counts a stated sub-place once, not twice', async () => {
    const natural = SHAPES.find((s) => s.label.startsWith('a natural region'))!;
    const { experiences, compiled } = await runShape(natural);
    /* The tea house is a component of the lake, so the graph holds one experience for the two names. */
    const lake = experiences.experiences.find((e) => e.name === 'Upper Lake')!;
    expect(lake.components.map((c) => c.name)).toEqual(['Upper Lake Tea House']);
    expect(compiled.report.issues.filter((i) => i.check === 'no_duplicate_experience').map((i) => i.detail)).toEqual([]);
  });

  it('§19 — an operator diagnostic never lands on the traveller\'s readiness list', async () => {
    const { compiled } = await runShape(SHAPES.find((s) => s.label.startsWith('a natural region'))!);
    /*
     * Every compiler issue carries a precise `detail` for an operator; only some
     * carry a sentence written for a traveller. The readiness list takes the
     * second kind — and every blocker, because a plan that cannot be carried out
     * has to say so whether or not anybody wrote a sentence for it.
     */
    for (const issue of compiled.report.issues) {
      if (issue.travellerNote) expect(issue.travellerNote).not.toMatch(MACHINERY);
      expect(issue.detail.length).toBeGreaterThan(0);
    }
    const operatorOnly = compiled.report.issues.filter((i) => !i.travellerNote && i.severity !== 'blocker');
    for (const issue of operatorOnly) expect(issue.severity).not.toBe('blocker');
  });

  it('refuses to call a closed stop an ordinary one', async () => {
    const city = SHAPES.find((s) => s.label.startsWith('a city'))!;
    const closed: AccessConstraint = {
      id: 'museum-closed',
      placeName: 'River Museum',
      status: 'seasonal_closure',
      reservationRequired: false,
      validFrom: '2026-04-01',
      validUntil: '2026-11-30',
      authority: 'official_current',
      sourceName: 'The city culture department notice',
      checkedAt: '2026-09-12',
      travellerNote: 'The River Museum is closed for the season while its roof is replaced.',
      alternative: 'The Hill Viewpoint and the Old Quarter are open.',
    };
    const { compiled } = await runShape({ ...city, accessConstraints: [closed] });
    const blockers = compiled.report.issues.filter((i) => i.check === 'no_closed_stop' && i.severity === 'blocker');
    expect(blockers.length).toBeGreaterThan(0);
    expect(compiled.report.passed).toBe(false);
    expect(blockers[0]!.travellerNote).toContain('closed');
    expect(blockers[0]!.travellerNote).not.toMatch(MACHINERY);
  });
});
