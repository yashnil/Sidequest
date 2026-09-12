import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { buildScenario } from '../../../../../packages/planner/src/testing/scenario';
import { EASTERN_SIERRA, EASTERN_SIERRA_PLACES } from '../../../../../packages/core/src/data/index';
import {
  buildFeasibilityReport,
  buildLedger,
  buildNextActions,
  buildPreflight,
  buildTodayView,
  buildTripStateGraph,
  deriveDecisions,
  travelDurationStateOf,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type TravelSegment,
} from '@sidequest/core';
import { ItineraryView } from '@/components/ItineraryView';
import { calendarEventsFor } from './calendar-events';

/**
 * V9.1 §6 — ROUTING RESILIENCE: THE FOUR STATES A LEG CAN BE IN.
 *
 * One small trip with one leg in each state — measured, estimated,
 * operator-timed, unmeasured — read by every deterministic surface: the
 * feasibility report, the state graph, the next actions, Preflight, Today
 * and the calendar. What is proved: a measurement stays a measurement; an
 * estimate is labelled as one and never rendered as a road figure; a leg an
 * operator runs is a caution, not a dependency; a leg nobody could time is
 * a dependency and never a leave-by; no leg ever reads as zero minutes; and
 * nothing throws when every leg is unmeasured — including the hub itself.
 */
vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({ EaseDayButton: () => null, PrintExpand: () => null, StopEditMenu: () => null, RegenerateButton: () => null }));
vi.mock('@/app/(product)/trips/[id]/itinerary/share-controls', () => ({ ShareControl: () => null }));
vi.mock('@/components/PrintButton', () => ({ PrintButton: () => null }));

const NOW = new Date('2026-09-01T09:00:00Z');

function item(overrides: Partial<ItineraryItem> & { id: string; title: string; startMinute: number; endMinute: number }): ItineraryItem {
  return { kind: 'activity', durationMinutes: overrides.endMinute - overrides.startMinute, reason: 'Worth the stop.', weatherSensitive: false, ...overrides } as ItineraryItem;
}

const stop = (id: string, title: string, start: number, placeId: string) => item({ id, title, startMinute: start, endMinute: start + 90, placeId });

function leg(id: string, title: string, start: number, durationMinutes: number, travel: TravelSegment): ItineraryItem {
  return item({ id, kind: 'travel', title, startMinute: start, endMinute: start + durationMinutes, travel });
}

const MEASURED: TravelSegment = { fromId: 'p-a', toId: 'p-b', fromName: 'A', toName: 'B', minutes: 30, km: 20, mode: 'drive', role: 'approach', provenance: 'measured', basis: 'static', provider: 'valhalla', measuredAt: '2026-08-20T00:00:00.000Z' };
const ESTIMATED: TravelSegment = { fromId: 'p-c', toId: 'p-d', fromName: 'C', toName: 'D', minutes: 45, km: null, mode: 'drive', role: 'approach', provenance: 'estimated', basis: 'estimated', provider: 'sidequest-geo-estimate', measuredAt: '2026-08-20T00:00:00.000Z', estimateKind: 'geo', estimate: { straightLineKm: 30, approxKm: 39, kmh: 48 } };
const OPERATOR: TravelSegment = { fromId: 'b1', toId: 'b2', fromName: 'Banff', toName: 'Island', minutes: null, km: null, mode: 'ferry', role: 'transfer', provenance: 'unmeasured', unmeasuredReason: 'operator_unpublished', hint: 'ferry', episode: 'Island crossing', episodeMode: 'boat' };
const UNMEASURED: TravelSegment = { fromId: 'b2', toId: 'b3', fromName: 'Island', toName: 'Jasper', minutes: null, km: null, mode: 'drive', role: 'transfer', provenance: 'unmeasured', unmeasuredReason: 'provider_unavailable' };

function totals(overrides: Partial<ItineraryDay['totals']> = {}): ItineraryDay['totals'] {
  return { activityMinutes: 180, travelMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, estimatedMinutes: 0, allowanceMinutes: 0, travelKm: 0, freeMinutes: 120, strenuousCount: 0, unmeasuredLegCount: 0, ...overrides } as ItineraryDay['totals'];
}

function day(dayNumber: number, date: string, baseId: string, baseName: string, items: ItineraryItem[], extra: Partial<ItineraryDay> = {}): ItineraryDay {
  return {
    dayNumber,
    date,
    baseId,
    baseName,
    theme: `Day ${dayNumber} theme`,
    window: { startMinute: 8 * 60, endMinute: 20 * 60, usableMinutes: 12 * 60 },
    items,
    totals: totals(),
    transport: { primaryMode: 'drive', modes: ['drive'], serviceIds: [], parkingNotes: [], accessNotes: [], verifyBeforeTravel: [] },
    availability: { flexiblePlaceIds: [], cautions: [], verifyBeforeTravel: [], bookings: [] },
    weather: { evidence: 'historical_pattern', summary: 'Mild', decisions: [], cautions: [], backups: [], provider: 'fixture', attribution: 'fixture' },
    food: { summary: 'n/a', slots: [], remote: false, notes: [], reservations: [] },
    intensity: 'moderate',
    warnings: [],
    ...extra,
  } as unknown as ItineraryDay;
}

/** Day 1 measured, day 2 estimated, day 3 an operator-timed base move, day 4 an unmeasured base move. */
function fourStates(): Itinerary {
  const days = [
    day(1, '2026-09-10', 'b1', 'Banff', [stop('d1-a', 'Stop A', 9 * 60, 'p-a'), leg('d1-leg', 'Drive to Stop B', 10 * 60 + 30, 30, MEASURED), stop('d1-b', 'Stop B', 11 * 60 + 30, 'p-b')], { totals: totals({ travelMinutes: 30, driveMinutes: 30, travelKm: 20 }) }),
    day(2, '2026-09-11', 'b1', 'Banff', [stop('d2-c', 'Stop C', 9 * 60, 'p-c'), leg('d2-leg', 'Drive to Stop D', 10 * 60 + 30, 45, ESTIMATED), stop('d2-d', 'Stop D', 11 * 60 + 30, 'p-d')], { totals: totals({ estimatedMinutes: 45 }), timing: { precision: 'estimated', estimatedLegs: 1, unknownLegs: 0 } }),
    day(3, '2026-09-12', 'b2', 'Island', [leg('d3-leg', 'Ferry to the island', 8 * 60, 45, OPERATOR), stop('d3-e', 'Stop E', 14 * 60, 'p-e')], { totals: totals({ allowanceMinutes: 45, unmeasuredLegCount: 1, unmeasuredMajorTransfer: true }), timing: { precision: 'band', estimatedLegs: 0, unknownLegs: 1 } }),
    day(4, '2026-09-13', 'b3', 'Jasper', [leg('d4-leg', 'Drive to Jasper', 8 * 60, 120, UNMEASURED), stop('d4-f', 'Stop F', 14 * 60, 'p-f')], { totals: totals({ allowanceMinutes: 120, unmeasuredLegCount: 1, unmeasuredMajorTransfer: true }), timing: { precision: 'band', estimatedLegs: 0, unknownLegs: 1 } }),
  ];
  const anchor = (id: string, dayNumber: number, name: string, placeId: string) => ({ id, dayNumber, name, role: 'core', category: 'nature', disposition: 'preserved', verification: 'verified', anchorKind: 'named_place', placeId });
  const itinerary = {
    tripId: 'trip-legs',
    version: 9,
    regionId: 'dynamic',
    baseId: 'b1',
    baseName: 'Rockies',
    startDate: '2026-09-10',
    endDate: '2026-09-13',
    status: 'needs_decision',
    summary: 'Four days, four kinds of leg.',
    days,
    transportStrategy: { primaryMode: 'drive', secondaryMode: 'ferry', headline: 'A car and one ferry', rationale: [], tradeoffs: [], convenience: 'high', stress: 'moderate', parkingSummary: 'n/a', transitSummary: 'n/a', seasonalWarnings: [], verifyBeforeTravel: [], totals: { driveMinutes: 30, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, driveKm: 20 }, dataDisclosure: 'fixture' },
    foodPlan: { summary: 'n/a', days: [] },
    issues: [],
    unscheduled: [],
    diagnostics: { revisions: [] },
    package: {
      source: 'model_draft',
      draftVersion: 1,
      archetype: 'road_trip',
      purpose: 'Legs.',
      routeRationale: 'One of each.',
      assumptions: [],
      tradeoffs: [],
      bases: [
        { id: 'b1', name: 'Banff', nights: 2, why: 'Lakes', verification: 'verified' },
        { id: 'b2', name: 'Island', nights: 1, why: 'Crossing', verification: 'verified' },
        { id: 'b3', name: 'Jasper', nights: 1, why: 'Canyon', verification: 'verified' },
      ],
      foodStrategy: [],
      transport: { summary: 'Drive', notes: [] },
      beforeYouGo: [],
      packing: [],
      backups: [],
      omissions: [],
      unresolved: [],
      anchors: [anchor('d1-a', 1, 'Stop A', 'p-a'), anchor('d1-b', 1, 'Stop B', 'p-b'), anchor('d2-c', 2, 'Stop C', 'p-c'), anchor('d2-d', 2, 'Stop D', 'p-d'), anchor('d3-e', 3, 'Stop E', 'p-e'), anchor('d4-f', 4, 'Stop F', 'p-f')],
      verification: { anchors: 6, verified: 6, partiallyVerified: 0, unverified: 0, legsMeasured: 1, legsEstimated: 1, legsUnmeasured: 2, deadlineReached: false },
      bookingPriorities: [],
      episodes: [],
      metrics: { hotelChurn: 2, travelBurdenMinutesPerDay: 60, freeMinutesPerDay: 120, unmeasuredMajorTransfers: 2 },
    },
  } as unknown as Itinerary;
  /* The report is read from the plan itself, so the graph sees exactly what the feasibility engine says. */
  itinerary.package!.feasibility = buildFeasibilityReport({ itinerary });
  return itinerary;
}

/** Every leg of a plan, made into a leg nobody could time. */
function allUnmeasured(itinerary: Itinerary): Itinerary {
  return {
    ...itinerary,
    days: itinerary.days.map((d) => {
      const items = d.items.map((i) => {
        if (i.kind !== 'travel' || !i.travel) return i;
        const { basis: _basis, provider: _provider, measuredAt: _measuredAt, geometry: _geometry, estimate: _estimate, estimateKind: _estimateKind, staticMinutes: _static, effectiveDepartAt: _depart, viaBases: _via, transitSummary: _transit, hint: _hint, episode: _episode, episodeMode: _episodeMode, ...rest } = i.travel;
        const travel: TravelSegment = { ...rest, minutes: null, km: null, provenance: 'unmeasured', unmeasuredReason: 'provider_unavailable' };
        const { timing: _timing, ...itemRest } = i;
        return { ...itemRest, durationMinutes: Math.max(i.durationMinutes, 20), endMinute: Math.max(i.endMinute, i.startMinute + 20), travel } as ItineraryItem;
      });
      const legs = items.filter((i) => i.kind === 'travel');
      return { ...d, items, totals: { ...d.totals, travelMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, estimatedMinutes: 0, travelKm: 0, unmeasuredLegCount: legs.length, allowanceMinutes: legs.reduce((sum, i) => sum + i.durationMinutes, 0) }, timing: { precision: 'band', estimatedLegs: 0, unknownLegs: legs.length } } as ItineraryDay;
    }),
  };
}

const ZERO_MINUTES = /\b0 min\b|"minutes":0\b|\b0 minutes\b/;

const legs = (itinerary: Itinerary) => itinerary.days.flatMap((d) => d.items.filter((i) => i.kind === 'travel' && i.travel).map((i) => i.travel!));

describe('the four states, as the schema and the estimator read them', () => {
  const plan = fourStates();
  it('measured → measured; estimated → geo_estimate; operator-timed and unmeasured → unknown', () => {
    expect(legs(plan).map(travelDurationStateOf)).toEqual(['measured', 'geo_estimate', 'unknown', 'unknown']);
  });
  it('no leg carries zero minutes, and an estimate carries no road km', () => {
    for (const l of legs(plan)) expect(l.minutes).not.toBe(0);
    expect(ESTIMATED.km).toBeNull();
    expect(ESTIMATED.estimate?.approxKm).toBe(39);
  });
});

describe('the feasibility report', () => {
  const report = buildFeasibilityReport({ itinerary: fourStates() });
  it('an operator-timed base move is a caution to confirm; an unmeasured one is a dependency; measured and estimated days raise nothing', () => {
    const forDay = (n: number) => report.items.filter((i) => i.dayNumber === n).map((i) => i.severity);
    expect(forDay(1)).toEqual([]);
    expect(forDay(2)).toEqual([]);
    expect(forDay(3)).toEqual(['caution']);
    expect(report.items.find((i) => i.dayNumber === 3)?.detail).toMatch(/moves base by ferry; the operator sets the hours/);
    expect(forDay(4)).toEqual(['dependency']);
    expect(report.items.find((i) => i.dayNumber === 4)?.detail).toMatch(/has not been measured, so the day cannot be timed yet/);
    expect(report.verdict).toBe('unresolved_major_dependency');
    expect(JSON.stringify(report)).not.toMatch(ZERO_MINUTES);
  });
});

describe('the state graph', () => {
  const plan = fourStates();
  const graph = buildTripStateGraph({ itinerary: plan, intelligence: null, booked: [], now: NOW });
  const node = (id: string) => graph.nodes.find((n) => n.id === id)!;

  it('a measured day is left alone; an estimated day is medium confidence; operator-timed needs checking; unmeasured needs a decision', () => {
    expect(node('day:1').state).toBe('suggested');
    expect(node('day:1').confidence).toBe('high');
    expect(node('day:2').state).toBe('suggested');
    expect(node('day:2').confidence).toBe('medium');
    expect(node('day:3').state).toBe('needs_verification');
    expect(node('day:3').detail).toBe('The main transfer into this day has not been timed.');
    expect(node('day:4').state).toBe('needs_decision');
    expect(node('day:4').detail).toMatch(/has not been measured/);
    expect(graph.nodes.filter((n) => n.kind === 'dependency')).toHaveLength(1);
    expect(JSON.stringify(graph)).not.toMatch(ZERO_MINUTES);
  });
});

describe('next actions and Preflight', () => {
  const plan = fourStates();
  const graph = buildTripStateGraph({ itinerary: plan, intelligence: null, booked: [], now: NOW });

  it('lead with the unmeasured transfer as a decision, never a figure, never a due date', () => {
    const next = buildNextActions({ graph, lifecycle: 'planning', daysUntilTrip: 9, now: NOW });
    expect(next.actions[0]?.kind).toBe('decide');
    expect(next.actions[0]?.title).toMatch(/Day 4 moves base and the main transfer has not been measured/);
    expect(next.actions.every((a) => a.due === undefined)).toBe(true);
    expect(JSON.stringify(next)).not.toMatch(ZERO_MINUTES);
  });

  it('Preflight lists the dependency under transport and reads no zero', () => {
    const preflight = buildPreflight({ graph, intelligence: null, booked: [], checks: { preflight: [], packing: [], checklist: [] }, daysUntilTrip: 9 });
    expect(preflight.attention.some((i) => i.category === 'transport' && /Day 4/.test(i.title))).toBe(true);
    expect(preflight.attention.some((i) => /Day 3/.test(i.title))).toBe(false);
    expect(JSON.stringify(preflight)).not.toMatch(ZERO_MINUTES);
  });
});

describe('Today', () => {
  const plan = fourStates();
  const at = (date: string, minute: number) => buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date(`${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00Z`), timeZone: 'UTC' });

  it('a measured leg gives a leave-by on the static basis', () => {
    const today = at('2026-09-10', 10 * 60 + 15);
    expect(today.next?.title).toBe('Stop B');
    expect(today.leaveBy).toMatchObject({ time: '11:00', basis: 'static', legMinutes: 30 });
    expect(today.leaveBy?.basisNote).toMatch(/measured without traffic/);
    expect(today.nextTransport).toMatchObject({ minutes: 30, basis: 'static' });
  });

  it('an estimated leg gives a leave-by labelled as Sidequest’s own estimate, never a road figure', () => {
    const today = at('2026-09-11', 10 * 60 + 15);
    expect(today.leaveBy).toMatchObject({ time: '10:45', basis: 'estimated', legMinutes: 45 });
    expect(today.leaveBy?.basisNote).toMatch(/Sidequest’s own estimate/);
    expect(today.leaveBy?.basisNote).not.toMatch(/by road|km/);
    expect(today.nextTransport).toMatchObject({ minutes: 45, basis: 'estimated' });
  });

  it('an operator-timed leg and an unmeasured leg give no leave-by and never zero minutes', () => {
    for (const date of ['2026-09-12', '2026-09-13']) {
      const today = at(date, 7 * 60 + 30);
      expect(today.active).toBe(true);
      expect(today.next?.title).toMatch(/Stop [EF]/);
      expect(today.leaveBy).toBeUndefined();
      expect(today.nextTransport?.minutes).toBeNull();
      expect(today.nextTransport?.basis).toBe('unmeasured');
      expect(JSON.stringify(today)).not.toMatch(ZERO_MINUTES);
    }
  });

  it('while travelling on an untimed day the top action is the next thing, not a leave-by', () => {
    const today = at('2026-09-13', 7 * 60 + 30);
    const graph = buildTripStateGraph({ itinerary: plan, intelligence: null, booked: [], now: NOW });
    const next = buildNextActions({ graph, lifecycle: 'traveling', daysUntilTrip: 0, now: NOW, today });
    expect(next.actions[0]?.kind).toBe('travel');
    expect(next.actions[0]?.title).toBe('Next: Stop F');
    expect(next.actions[0]?.title).not.toMatch(/Leave by/);
  });
});

describe('the calendar', () => {
  it('exports legs long enough to matter with their own span, and never a zero-length or road-figure event', () => {
    const plan = fourStates();
    const derived = calendarEventsFor({ tripId: 'trip-legs', itinerary: plan, booked: [], zonesByBaseId: {}, primaryTimeZone: 'America/Edmonton', coordinates: {}, sequence: 1 });
    const uids = derived.events.map((e) => e.uid);
    /* The measured 30-minute hop is noise; the 45-minute estimate, the ferry allowance and the two-hour allowance are appointments. */
    expect(uids).not.toContain('trip-legs-day-1-d1-leg@sidequest');
    expect(uids).toEqual(expect.arrayContaining(['trip-legs-day-2-d2-leg@sidequest', 'trip-legs-day-3-d3-leg@sidequest', 'trip-legs-day-4-d4-leg@sidequest']));
    for (const event of derived.events) {
      expect(event.endMinute).toBeGreaterThan(event.startMinute);
      expect(event.description ?? '').not.toMatch(/\bkm\b/);
    }
    expect(JSON.stringify(derived)).not.toMatch(ZERO_MINUTES);
  });
});

describe('when every leg is unmeasured', () => {
  const plan = allUnmeasured(fourStates());
  plan.package!.feasibility = buildFeasibilityReport({ itinerary: plan });

  it('every builder answers, no leg has minutes, and Today never offers a leave-by', () => {
    expect(legs(plan).every((l) => l.minutes === null && l.provenance === 'unmeasured')).toBe(true);
    const graph = buildTripStateGraph({ itinerary: plan, intelligence: null, booked: [], now: NOW });
    const next = buildNextActions({ graph, lifecycle: 'planning', daysUntilTrip: 9, now: NOW });
    const preflight = buildPreflight({ graph, intelligence: null, booked: [], checks: { preflight: [], packing: [], checklist: [] }, daysUntilTrip: 9 });
    const calendar = calendarEventsFor({ tripId: 'trip-legs', itinerary: plan, booked: [], zonesByBaseId: {}, primaryTimeZone: 'UTC', coordinates: {}, sequence: 1 });
    const todays = plan.days.map((d) => buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date(`${d.date}T09:30:00Z`), timeZone: 'UTC' }));
    expect(todays.every((t) => t.active && t.leaveBy === undefined)).toBe(true);
    expect(todays.every((t) => !t.nextTransport || t.nextTransport.minutes === null)).toBe(true);
    const travelling = buildNextActions({ graph, lifecycle: 'traveling', daysUntilTrip: 0, now: NOW, today: todays[0] });
    expect(travelling.actions[0]?.title).not.toMatch(/Leave by/);
    expect(graph.nodes.filter((n) => n.id.startsWith('day:')).map((n) => n.state)).toEqual(['suggested', 'suggested', 'needs_decision', 'needs_decision']);
    for (const surface of [graph, next, preflight, calendar, todays, travelling, plan.package!.feasibility]) expect(JSON.stringify(surface)).not.toMatch(ZERO_MINUTES);
  });
});

describe('the Trip Hub, rendered on an all-unmeasured plan', () => {
  const PLAN: Itinerary = (() => {
    const result = planTrip(buildScenario());
    if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
    return allUnmeasured(result.itinerary);
  })();
  const COORDINATES: Record<string, { lat: number; lng: number }> = Object.fromEntries([...EASTERN_SIERRA_PLACES.map((place) => [place.id, place.coordinates] as const), [EASTERN_SIERRA.id, EASTERN_SIERRA.baseCoordinates] as const]);
  const RENDER_NOW = new Date('2026-07-20T09:00:00.000Z');

  function render(): string {
    const decisions = deriveDecisions({ itinerary: PLAN, intelligence: null, persisted: [] });
    const graph = buildTripStateGraph({ itinerary: PLAN, intelligence: null, booked: [], decisions, now: RENDER_NOW });
    const daysUntilTrip = Math.round((Date.parse(`${PLAN.startDate}T00:00:00Z`) - Date.UTC(RENDER_NOW.getUTCFullYear(), RENDER_NOW.getUTCMonth(), RENDER_NOW.getUTCDate())) / 86_400_000);
    const nextActions = buildNextActions({ graph, lifecycle: 'ready', daysUntilTrip, now: RENDER_NOW });
    const preflight = buildPreflight({ graph, intelligence: null, booked: [], checks: { preflight: [], packing: [], checklist: [] }, daysUntilTrip });
    const ledger = buildLedger({ budget: null, booked: [], openNeeds: [] });
    return renderToStaticMarkup(
      createElement(ItineraryView, {
        itinerary: PLAN,
        preparation: [],
        tripId: 'trip-all-unmeasured',
        savedToAccount: true,
        dateLabel: '12–15 Aug',
        renderedAt: RENDER_NOW.getTime(),
        coordinates: COORDINATES,
        graph,
        nextActions,
        preflight,
        decisions,
        ledger,
        lifecycle: 'ready',
        daysUntilTrip,
        affected: { dayNumbers: [], baseIds: [], baseRenamedDays: [], shiftedItems: [], displaced: [], notRemeasuredDays: [], summary: 'No day changes.' },
      }),
    );
  }

  it('renders every day with no "0 min" anywhere a traveller reads, and no crash', () => {
    expect(legs(PLAN).length).toBeGreaterThan(0);
    expect(legs(PLAN).every((l) => l.minutes === null)).toBe(true);
    const html = render();
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const d of PLAN.days) expect(html).toContain(`data-testid="day-state-${d.dayNumber}"`);
    expect(text).not.toMatch(/\b0 min\b/);
    expect(text).not.toMatch(/\b0 minutes\b/);
    expect(text).not.toMatch(/\b0 km\b/);
  });
});
