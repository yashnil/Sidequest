import { describe, expect, it } from 'vitest';
import {
  answerQuestion,
  buildTravelerProfile,
  defaultAnswers,
  interestOfferFromEntityType,
  parseMinuteOfDay,
  questionById,
  screenDestination,
  withScreening,
  type InterviewContext,
  type QuestionnaireAnswers,
  type Trip,
} from '@sidequest/core';
import { buildCompositionTask, type CompositionContext } from './composition';
import { buildHybridTripRequest } from './hybrid-request';
import { travelerBriefFor } from './production-plan';
import { reconcileTripDraft } from './reconcile';
import { draftOf, fictionalWorld } from './acceptance/harness';

/**
 * THE INVARIANTS THE FOUNDER'S FIXTURE PDF SHOWED WERE MISSING.
 *
 * A departure at 09:00 must make scheduling anything meaningful after 09:00
 * impossible. A window ending at 20:00 must not quietly place a four-hour
 * stop at 17:00. A hard "back by" hour closes every day. And every answer
 * the interview records must reach the composition input, so a beautiful
 * questionnaire cannot be a placebo.
 */

const NOW = new Date('2026-09-04T10:00:00Z');
const PLACES = [
  { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' as const },
  { name: 'Morning Ridge', lat: 50.05, lng: 10.05 },
  { name: 'Evening Falls', lat: 50.06, lng: 10.02 },
];

function endOfLastDay(items: readonly { endMinute: number; kind: string }[]): number {
  return Math.max(0, ...items.filter((i) => i.kind !== 'free_time').map((i) => i.endMinute));
}

describe('edge days are hard', () => {
  it('a 09:00 departure leaves the last day with nothing scheduled, and says why', async () => {
    const world = fictionalWorld({ name: 'Earlyland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-03', departureTime: '09:00' } });
    const draft = draftOf({
      bases: [{ id: 'b', name: 'Base Town', nights: 2 }],
      days: [
        { base: 'b', anchors: [{ name: 'Morning Ridge', role: 'core' }] },
        { base: 'b', anchors: [{ name: 'Evening Falls', role: 'core' }] },
        { base: 'b', anchors: [{ name: 'Morning Ridge', role: 'core', minutes: 180 }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const last = result.itinerary.days[2]!;
    expect(last.items.filter((i) => i.kind === 'activity')).toHaveLength(0);
    // QUALITY V1 — no meal either: a window that closed at 09:00 has no room for one.
    expect(last.items.filter((i) => i.kind === 'meal')).toHaveLength(0);
    expect(endOfLastDay(last.items)).toBeLessThanOrEqual(parseMinuteOfDay('09:00'));
    // And a meal the draft calls "none, in transit" is not content on any day.
    const transit = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 2 }], days: draft.days.map((d, i) => ({ base: 'b', anchors: [{ name: i === 0 ? 'Morning Ridge' : 'Evening Falls', role: 'core' as const }], meals: { breakfast: 'none, in transit', lunch: 'packed lunch' } })) });
    const transitResult = await reconcileTripDraft({ draft: transit, context: world.context });
    expect(transitResult.itinerary.days[0]!.items.some((i) => i.kind === 'meal' && /Breakfast/.test(i.title))).toBe(false);
    const dropped = result.itinerary.unscheduled.find((u) => u.name === 'Morning Ridge');
    expect(dropped?.reason).toMatch(/departure at 09:00/);
    // Silent loss: none — the anchor has a disposition and an explanation.
    expect(result.dispositions.filter((d) => d.name === 'Morning Ridge').map((d) => d.disposition)).toContain('unscheduled_capacity');
  });

  it('a 14:00 departure lets the last day hold only what ends before the lead, even an essential stop comes off', async () => {
    const world = fictionalWorld({ name: 'Noonland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-02', departureTime: '14:00' } });
    const draft = draftOf({
      bases: [{ id: 'b', name: 'Base Town', nights: 1 }],
      days: [
        { base: 'b', anchors: [] },
        { base: 'b', anchors: [{ name: 'Morning Ridge', role: 'core', minutes: 90 }, { name: 'Evening Falls', role: 'core', minutes: 240 }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const last = result.itinerary.days[1]!;
    expect(endOfLastDay(last.items)).toBeLessThanOrEqual(parseMinuteOfDay('14:00'));
    expect(last.items.some((i) => i.title === 'Morning Ridge')).toBe(true);
    expect(last.items.some((i) => i.title === 'Evening Falls')).toBe(false);
    expect(last.warnings.join(' ')).not.toMatch(/nothing was taken off/);
  });

  it('a late arrival schedules nothing before the traveller has landed and settled', async () => {
    const world = fictionalWorld({ name: 'Lateland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-02', arrivalTime: '20:00' } });
    const draft = draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors: [{ name: 'Morning Ridge', role: 'core' }] }, { base: 'b', anchors: [] }] });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const first = result.itinerary.days[0]!;
    for (const item of first.items.filter((i) => i.kind !== 'free_time')) {
      expect(item.startMinute).toBeGreaterThanOrEqual(parseMinuteOfDay('21:00'));
    }
  });

  it('a hard back-by hour closes every day, and a stop that would overrun it comes off with the reason', async () => {
    const world = fictionalWorld({ name: 'Curfewland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-02' } });
    world.context.profile.interview.mustBeBackByMinute = 18 * 60;
    const draft = draftOf({
      bases: [{ id: 'b', name: 'Base Town', nights: 1 }],
      days: [{ base: 'b', anchors: [{ name: 'Morning Ridge', role: 'core', minutes: 240 }, { name: 'Evening Falls', role: 'secondary', minutes: 240 }] }, { base: 'b', anchors: [] }],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    for (const day of result.itinerary.days) {
      expect(day.window.endMinute).toBeLessThanOrEqual(18 * 60);
      expect(endOfLastDay(day.items)).toBeLessThanOrEqual(18 * 60);
    }
    expect(result.itinerary.unscheduled.find((u) => u.name === 'Evening Falls')?.reason).toMatch(/back at base by 18:00/);
  });

  it('an ordinary day never quietly runs an hour past its end', async () => {
    const world = fictionalWorld({ name: 'Overland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-03' } });
    const draft = draftOf({
      bases: [{ id: 'b', name: 'Base Town', nights: 2 }],
      days: [
        { base: 'b', anchors: [{ name: 'Morning Ridge', role: 'core', minutes: 300 }, { name: 'Evening Falls', role: 'secondary', minutes: 300 }] },
        { base: 'b', anchors: [] },
        { base: 'b', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const day = result.itinerary.days[0]!;
    const overrun = endOfLastDay(day.items) - day.window.endMinute;
    // Either the day fits (a stop came off, with a disposition), or it says out loud that it runs long.
    if (overrun > 0) expect(day.warnings.join(' ')).toMatch(/past your usual end/);
    expect(overrun).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Every answer reaches the composition input
// ---------------------------------------------------------------------------

const TRIP: Trip = {
  id: 'trip-1',
  basics: { mode: 'known_destination', destinationInput: 'Green Isle', regionId: 'dynamic', startDate: '2026-05-10', endDate: '2026-05-17', arrivalTime: '11:00', departureTime: '09:00', adults: 2, children: 0, travelerNeeds: [] },
  status: 'draft',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function contextFor(): InterviewContext {
  return {
    destination: screenDestination({ name: 'Green Isle', tripDays: 8, entityType: 'country', breadth: 'country', bounds: { southWest: { lat: 51.4, lng: -10.5 }, northEast: { lat: 55.4, lng: -5.4 } }, center: { lat: 53.4, lng: -8 }, startDate: '2026-05-10', scopeTransport: { primaryMode: 'drive', allowedModes: ['drive', 'rail', 'ferry'] } }),
    traveller: { travelerNeeds: [], tripDays: 8, adults: 2, children: 0, offeredInterests: interestOfferFromEntityType('country').interests, carried: [] },
  };
}

function taskFor(answers: QuestionnaireAnswers): string {
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 8 });
  const request = buildHybridTripRequest({ trip: TRIP, composer: null, profile, now: NOW });
  const context: CompositionContext = { request, envelope: { name: 'Green Isle', center: { lat: 53.4, lng: -8 } }, brief: travelerBriefFor({ profile, trip: TRIP, request, envelope: { name: 'Green Isle', center: { lat: 53.4, lng: -8 } } }), mode: 'full' };
  return buildCompositionTask(context);
}

function answered(ctx: InterviewContext, base: QuestionnaireAnswers, id: string, value: unknown): QuestionnaireAnswers {
  const question = questionById(ctx, base, id);
  if (!question) throw new Error(`no question ${id}`);
  return answerQuestion({ answers: base, ctx, question, value, now: NOW });
}

describe('every answer reaches the composition input', () => {
  const ctx = contextFor();
  const base = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: 8 }), ctx.destination);
  const baseline = taskFor(base);

  it('states arrival and departure, and the hard day-window rule', () => {
    expect(baseline).toMatch(/Arrival: .*11:00|Arrival: /);
    expect(baseline).toMatch(/DAY WINDOWS \(hard\)/);
    expect(baseline).toMatch(/after the departure on the last day/);
  });

  const cases: { id: string; value: unknown; expect: RegExp; label: string }[] = [
    { label: 'no car', id: 'transport_mode', value: 'transit_walk', expect: /no car|car available: false/ },
    { label: 'max daily driving', id: 'daily_driving', value: '90', expect: /at most 90 min driving|Daily driving ceiling: 90/ },
    { label: 'no boats', id: 'boats_ferries', value: 'cannot', expect: /No boats/ },
    { label: 'day start', id: 'day_start', value: 'early', expect: /Starts early|Early mornings: happily/ },
    { label: 'hotel switching', id: 'base_moves', value: 'stay_put', expect: /One base for the whole trip|moving at most 0 time/ },
    { label: 'effort', id: 'effort', value: 'intense', expect: /Effort: intense|Daily intensity: intense/ },
    { label: 'hiking frequency', id: 'priorities', value: ['hiking'], expect: /hiking: a few times|hiking \(a few times\)/ },
    { label: 'crowd preference', id: 'iconic_crowds', value: 'quieter_alternative', expect: /quieter alternative/ },
    { label: 'budget and convenience', id: 'convenience_spend', value: 'pay_to_reduce_hassle', expect: /Pays to reduce hassle|Reservations: happy_to_book_ahead/ },
    { label: 'regional expansion', id: 'scenic_reach', value: 'nearby_30', expect: /nearby 30/ },
    { label: 'explicit must include', id: 'names', value: { include: ['Cliffs of the Ninth'], avoid: [] }, expect: /Must include: Cliffs of the Ninth/ },
    { label: 'explicit reject', id: 'names', value: { include: [], avoid: ['Tourist Trap Tower'] }, expect: /Must avoid: Tourist Trap Tower/ },
    { label: 'a typed hard constraint', id: 'hard_constraints', value: { constraints: [{ code: 'cannot_drive' }], notes: '', notesAreHard: false }, expect: /<hard_constraints>\n- Nobody will be driving/ },
    { label: 'a hard back-by hour', id: 'hard_constraints', value: { constraints: [{ code: 'must_be_back_by', value: 20 * 60 }], notes: '', notesAreHard: false }, expect: /Back at base by 20:00/ },
    { label: 'guided travel', id: 'transport_mode', value: 'guided', expect: /Guided tours: prefer|guided, with arranged transfers/ },
  ];

  for (const entry of cases) {
    it(`${entry.label} changes the composition input`, () => {
      const scenicCtx = entry.id === 'scenic_reach' ? { ...ctx, destination: { ...ctx.destination, traits: ctx.destination.traits.filter((t) => t !== 'broad_geography').concat(['road_trip_region']) } } : ctx;
      const task = taskFor(answered(scenicCtx, base, entry.id, entry.value));
      expect(task).not.toEqual(baseline);
      expect(task).toMatch(entry.expect);
    });
  }

  it('assumptions are tagged and explicit answers are not', () => {
    const task = taskFor(answered(ctx, base, 'day_shape', 'cover'));
    expect(task).toMatch(/Days: cover a lot, happy to be on the move\n/);
    expect(task).toMatch(/\[assumed\]/);
    expect(task).toMatch(/<assumptions>/);
  });
});
