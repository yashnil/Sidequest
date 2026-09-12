import { describe, expect, it } from 'vitest';
import type { Itinerary, ItineraryDay, ItineraryItem } from '../schemas/itinerary';
import type { TravelIntelligence } from '../intelligence/model';
import type { BookedPlanItem, BookingItem } from '../intelligence/booking';
import { buildTodayView } from '../intelligence/today';
import { buildTripStateGraph, dayState, openNodes } from './state-graph';
import { buildNextActions, phaseFor } from './next-action';
import { deriveDecisions } from './decisions';
import { buildPreflight } from './preflight';
import { draftDelta, metricsDelta } from './delta';
import { buildLedger } from './ledger';
import { splitPlanFor } from './split';
import { buildCalendar, googleCalendarLink, vtimezoneFor, yearsBetween } from './calendar';
import { extractConfirmation, redactSensitive } from './confirmation-extract';
import { factsDueForRecheck, summariseObservations, volatileFacts } from './freshness';

/**
 * V9 — THE EXECUTION ENGINES, PROVEN ON ONE SMALL TRIP.
 *
 * Three days in two bases, one unmeasured base move, one unverified stop, one
 * required booking, one booked hotel. Every engine reads the same fixture, so
 * the tests also prove there is one truth: what the graph says needs booking
 * is what the next action says to book and what Preflight lists.
 */
const NOW = new Date('2026-09-01T09:00:00Z');

function item(overrides: Partial<ItineraryItem> & { id: string; title: string; startMinute: number; endMinute: number }): ItineraryItem {
  return { kind: 'activity', durationMinutes: overrides.endMinute - overrides.startMinute, reason: 'r', weatherSensitive: false, ...overrides } as ItineraryItem;
}

function day(dayNumber: number, date: string, baseId: string, items: ItineraryItem[], extra: Partial<ItineraryDay> = {}): ItineraryDay {
  return {
    dayNumber,
    date,
    baseId,
    baseName: baseId === 'b1' ? 'Banff' : 'Jasper',
    theme: `Day ${dayNumber} theme`,
    window: { startMinute: 8 * 60, endMinute: 20 * 60, usableMinutes: 12 * 60 },
    items,
    totals: { activityMinutes: 0, travelMinutes: 60, driveMinutes: 60, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, estimatedMinutes: 0, allowanceMinutes: 0, travelKm: 0, freeMinutes: 120, strenuousCount: 0, unmeasuredLegCount: 0 },
    transport: { primaryMode: 'drive', modes: ['drive'], serviceIds: [], parkingNotes: [], accessNotes: [], verifyBeforeTravel: [] },
    availability: { flexiblePlaceIds: [], cautions: [], verifyBeforeTravel: [], bookings: [] },
    weather: { evidence: 'forecast', summary: 'Clear, 18 °C', precipitationProbabilityPercent: 10, decisions: [], cautions: [], backups: [], provider: 'fixture', attribution: 'fixture', fetchedAt: '2026-08-25T00:00:00Z', staleAfterMinutes: 360 },
    food: { summary: 'n/a', slots: [], remote: false, notes: [], reservations: [] },
    intensity: 'moderate',
    warnings: [],
    ...extra,
  } as ItineraryDay;
}

const stop = (id: string, title: string, start: number, placeId?: string, extra: Partial<ItineraryItem> = {}) => item({ id, title, startMinute: start, endMinute: start + 90, ...(placeId ? { placeId } : {}), ...extra });
const leg = (id: string, from: string, to: string, start: number, minutes: number | null) =>
  item({ id, kind: 'travel', title: `${from} → ${to}`, startMinute: start, endMinute: start + (minutes ?? 60), travel: { fromId: from, toId: to, fromName: from, toName: to, minutes, km: minutes === null ? null : 40, mode: 'drive', role: 'approach', provenance: minutes === null ? 'unmeasured' : 'measured', ...(minutes === null ? { unmeasuredReason: 'no_route_found' } : { basis: 'static' }) } as ItineraryItem['travel'] });

function itinerary(): Itinerary {
  const days = [
    day(1, '2026-09-10', 'b1', [stop('d1-a0-lake-louise', 'Lake Louise', 9 * 60, 'p-louise'), leg('t1', 'p-louise', 'p-moraine', 11 * 60, 25), stop('d1-a1-moraine-lake', 'Moraine Lake', 12 * 60, 'p-moraine')]),
    day(2, '2026-09-11', 'b1', [stop('d2-a0-sentinel-pass', 'Sentinel Pass hike', 8 * 60 + 30, 'p-sentinel', { operational: { provider: 'fixture', checkedAt: '2026-08-01T00:00:00Z', outcome: 'open_at_time', basis: 'regular', recheck: true, attribution: 'fixture', note: 'Open on the day.' } }), stop('d2-a1-a-quiet-overlook', 'A Quiet Overlook Nobody Documented', 15 * 60)]),
    day(3, '2026-09-12', 'b2', [leg('t3', 'b1', 'b2', 8 * 60, null), stop('d3-a0-maligne-canyon', 'Maligne Canyon', 14 * 60, 'p-maligne')], { totals: { activityMinutes: 0, travelMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, estimatedMinutes: 0, allowanceMinutes: 240, travelKm: 0, freeMinutes: 60, strenuousCount: 0, unmeasuredLegCount: 1, unmeasuredMajorTransfer: true } as ItineraryDay['totals'] }),
  ];
  return {
    tripId: 'trip-1',
    version: 8,
    regionId: 'dynamic',
    baseId: 'b1',
    baseName: 'Canadian Rockies',
    startDate: '2026-09-10',
    endDate: '2026-09-12',
    status: 'needs_decision',
    summary: 'Three days in the Rockies.',
    days,
    transportStrategy: { primaryMode: 'drive', secondaryMode: 'transit', headline: 'A car for the whole trip', rationale: ['The trailheads are beyond transit.'], tradeoffs: ['Parking at Moraine Lake is a shuttle.'], convenience: 'high', stress: 'moderate', parkingSummary: 'n/a', transitSummary: 'n/a', seasonalWarnings: [], verifyBeforeTravel: [], totals: { driveMinutes: 180, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, driveKm: 320 }, dataDisclosure: 'fixture' },
    foodPlan: { summary: 'n/a', days: [] } as unknown as Itinerary['foodPlan'],
    issues: [],
    unscheduled: [],
    diagnostics: { revisions: [] } as unknown as Itinerary['diagnostics'],
    package: {
      source: 'model_draft',
      draftVersion: 1,
      archetype: 'road_trip',
      purpose: 'Mountains and lakes.',
      routeRationale: 'Banff first for the lakes, Jasper second for the canyon.',
      timingRationale: 'Larch season.',
      assumptions: [],
      tradeoffs: [],
      bases: [
        { id: 'b1', name: 'Banff', nights: 2, why: 'Lakes', verification: 'verified' },
        { id: 'b2', name: 'Jasper', nights: 1, why: 'Canyon', verification: 'verified' },
      ],
      foodStrategy: [],
      transport: { summary: 'Drive', notes: [] },
      beforeYouGo: [],
      packing: [],
      backups: [],
      omissions: [{ name: 'Yoho', reason: 'Not enough days.' }],
      unresolved: [],
      anchors: [
        { id: 'd1-a0-lake-louise', dayNumber: 1, name: 'Lake Louise', role: 'core', category: 'nature', disposition: 'preserved', verification: 'verified', anchorKind: 'named_place', placeId: 'p-louise' },
        { id: 'd1-a1-moraine-lake', dayNumber: 1, name: 'Moraine Lake', role: 'core', category: 'nature', disposition: 'preserved', verification: 'verified', anchorKind: 'named_place', placeId: 'p-moraine' },
        { id: 'd2-a0-sentinel-pass', dayNumber: 2, name: 'Sentinel Pass hike', role: 'core', category: 'hike', disposition: 'preserved', verification: 'verified', anchorKind: 'named_place', placeId: 'p-sentinel' },
        { id: 'd2-a1-a-quiet-overlook', dayNumber: 2, name: 'A Quiet Overlook Nobody Documented', role: 'optional', category: 'viewpoint', disposition: 'retained_unverified', verification: 'unverified', anchorKind: 'named_place' },
        { id: 'd3-a0-maligne-canyon', dayNumber: 3, name: 'Maligne Canyon', role: 'secondary', category: 'nature', disposition: 'preserved', verification: 'verified', anchorKind: 'named_place', placeId: 'p-maligne' },
      ],
      verification: { anchors: 5, verified: 4, partiallyVerified: 0, unverified: 1, legsMeasured: 1, legsEstimated: 0, legsUnmeasured: 1, deadlineReached: false },
      bookingPriorities: [],
      episodes: [],
      feasibility: { version: 1, verdict: 'unresolved_major_dependency', items: [{ area: 'transport', severity: 'dependency', dayNumber: 3, detail: 'Day 3 moves base and the main transfer has not been measured, so the day cannot be timed yet.' }], summary: '1 decision or measurement still open.' },
      metrics: { hotelChurn: 1, travelBurdenMinutesPerDay: 80, freeMinutesPerDay: 100, unmeasuredMajorTransfers: 1 },
      contract: { version: 1, contractVersion: 'sidequest-trip-contract/1', timingLock: 'user_explicit', timingDecidedBy: 'traveller', lockedFacts: 1, conflicts: [] },
    } as unknown as Itinerary['package'],
  } as unknown as Itinerary;
}

const needs: BookingItem[] = [
  { id: 'booking:stays', title: 'Stays: 2 bases, 3 nights', kind: 'accommodation', necessity: 'required', priority: 'book_first', group: 'stays', memberIds: ['booking:lodging:b1', 'booking:lodging:b2'], reason: '1 of 2 bases still need a bed; the route depends on all of them.', dayNumber: 1, date: '2026-09-10', capacityEvidence: 'unknown', status: 'soft_hold', travelerAction: 'Book a bed at each base, first night first', authority: 'model_proposal' },
  { id: 'booking:lodging:b1', title: '2 nights in Banff', kind: 'accommodation', necessity: 'required', priority: 'book_soon', group: 'stays', reason: 'The first night anchors the arrival day.', dayNumber: 1, date: '2026-09-10', baseId: 'b1', capacityEvidence: 'unknown', status: 'booked', bookedItemId: 'bk-1', travelerAction: 'Book somewhere to sleep in Banff', authority: 'model_proposal' },
  { id: 'booking:lodging:b2', title: '1 night in Jasper', kind: 'accommodation', necessity: 'required', priority: 'book_soon', group: 'stays', reason: 'The route sleeps here for 1 night.', dayNumber: 3, date: '2026-09-12', baseId: 'b2', capacityEvidence: 'unknown', status: 'open', travelerAction: 'Book somewhere to sleep in Jasper', authority: 'model_proposal' },
  { id: 'booking:rental', title: 'Rental car for the whole trip', kind: 'rental_vehicle', necessity: 'required', priority: 'book_first', reason: '320 km of the plan is driven; nothing else reaches the far stops.', date: '2026-09-10', capacityEvidence: 'unknown', status: 'open', travelerAction: 'Book the car, with the insurance excess you are comfortable with', authority: 'model_proposal' },
  { id: 'booking:guided:d2-a0-sentinel-pass', title: 'Sentinel Pass hike', kind: 'tour_guide', necessity: 'strongly_recommended', priority: 'keep_flexible', reason: 'Weather decides this.', dayNumber: 2, date: '2026-09-11', placeId: 'p-sentinel', capacityEvidence: 'unknown', status: 'open', travelerAction: 'Book Sentinel Pass with an operator', authority: 'model_proposal' },
];

const booked: BookedPlanItem[] = [
  { id: 'bk-1', tripId: 'trip-1', type: 'lodging', title: 'Moose Hotel', date: '2026-09-10', endDate: '2026-09-12', baseId: 'b1', status: 'booked', locked: true, cost: { amount: 640, currency: 'CAD' }, paid: 'paid', refundable: 'refundable', bookingItemId: 'booking:lodging:b1', source: 'marked', createdAt: '2026-08-20T00:00:00.000Z' },
  { id: 'bk-2', tripId: 'trip-1', type: 'flight', title: 'AC 123 YYZ → YYC', date: '2026-09-10', startTime: '08:00', endTime: '10:30', status: 'booked', locked: true, cost: { amount: 900, currency: 'CAD' }, paid: 'paid', cancellationDeadline: '2026-09-03', createdAt: '2026-08-15T00:00:00.000Z' },
];

function intelligence(): TravelIntelligence {
  return {
    bookings: { items: needs, booked, honored: [], conflicts: [] },
    readiness: { entries: [{ kind: 'visa', title: 'Entry requirements', summary: 'Not independently verified.', action: 'Check the official entry rules', links: [{ name: 'Official source', url: 'https://example.org' }], blocking: false, phase: 'do_now', state: 'unverified', tier: 'primary', facts: ['Reference, compiled 2026-06-01.'] }, { kind: 'local_setup', title: 'Parks Canada pass', summary: 'A park pass is needed at the gate.', links: [], blocking: false, phase: 'do_now', state: 'unverified', tier: 'primary' }] },
    sourceRegistry: [{ id: 'claim:advisory', kind: 'travel_advisory', subject: 'CA', claim: 'Exercise normal precautions', authority: 'official_current', sourceName: 'Official', state: 'confirmed', checkedAt: '2026-07-01T00:00:00Z', notes: [] }],
    weather: { days: [{ dayNumber: 2, date: '2026-09-11', kind: 'forecast', horizonNote: 'n', summary: 'Showers', sensitiveItems: [{ itemId: 'd2-a0-sentinel-pass', title: 'Sentinel Pass hike', sensitivity: 'high', fallbackType: 'indoor_alternative', decisionPoint: 'morning_of' }], planA: 'Hike' }], packingBasis: 'forecast', providerNote: 'n' },
    packing: { items: [{ id: 'p1' }, { id: 'p2' }], basis: 'forecast', basisNote: 'Forecast-based.', modelSuggestions: [] },
    budget: { currency: 'CAD', currencyBasis: 'traveller_envelope', conversionNote: 'n', travellers: 2, lines: [], total: { low: 2400, high: 3000, perPerson: true }, strategy: { saveHere: [], spendHere: [] }, booked: [], precisionNote: 'n' },
    transport: { primaryMode: 'drive', legs: [], terminal: {}, options: [{ legId: 'l1', legLabel: 'Banff → Jasper', mode: 'bus', durationMinutes: 240, durationBasis: 'estimated', costBand: 'low', transferBurden: 'medium', scenic: 'high', hotelDisruption: 'none', ease: 'moderate', recommended: false, why: 'A coach runs the Icefields Parkway in season.' }], modeNote: 'n' },
  } as unknown as TravelIntelligence;
}

describe('the trip state graph', () => {
  it('derives one state per node from the plan, the needs, the booked facts and the traveller’s acts', () => {
    const graph = buildTripStateGraph({ itinerary: itinerary(), intelligence: intelligence(), booked, now: NOW, resolutions: [{ bookingItemId: 'booking:guided:d2-a0-sentinel-pass', resolution: 'skipped' }] });
    const state = (id: string) => graph.nodes.find((n) => n.id === id)?.state;
    expect(state('timing')).toBe('suggested');
    expect(state('base:b1')).toBe('booked');
    expect(state('base:b2')).toBe('needs_booking');
    expect(state('day:3')).toBe('needs_decision');
    expect(state('day:2')).toBe('needs_verification');
    expect(state('experience:d1-a0-lake-louise')).toBe('verified');
    expect(state('experience:d2-a1-a-quiet-overlook')).toBe('optional');
    expect(state('booking:booking:rental')).toBe('needs_booking');
    expect(state('booking:booking:guided:d2-a0-sentinel-pass')).toBe('cancelled');
    expect(state('preparation:visa')).toBe('needs_verification');
    expect(graph.counts.needs_decision).toBeGreaterThanOrEqual(1);
    expect(graph.summary).toMatch(/need.* a decision/);
    expect(graph.dependents['base:b2']).toBeGreaterThan(0);
  });

  it('a decision the traveller recorded turns a suggestion into accepted; an observed change marks the day', () => {
    const decisions = deriveDecisions({ itinerary: itinerary(), intelligence: intelligence(), persisted: [{ key: 'route', chosen: 'Banff → Jasper', lock: 'user_explicit', decidedBy: 'traveller', decidedAt: '2026-08-30T00:00:00Z' }] });
    const graph = buildTripStateGraph({ itinerary: itinerary(), intelligence: intelligence(), booked, decisions, now: NOW, observations: [{ id: 'o1', factId: 'fact:forecast:2', kind: 'forecast', observedAt: '2026-09-01T00:00:00Z', previous: 'Clear', current: 'Rain', changed: true, dayNumbers: [2], summary: 'Day 2 now expects rain.', acknowledgedAt: null }] });
    expect(graph.nodes.find((n) => n.id === 'route')?.state).toBe('accepted');
    expect(graph.nodes.find((n) => n.id === 'timing')?.state).toBe('accepted');
    expect(graph.nodes.find((n) => n.id === 'day:2')?.state).toBe('changed');
    expect(dayState(graph, 3).state).toBe('needs_decision');
    expect(openNodes(graph)[0]?.state).toBe('needs_decision');
  });

  it('unknown is never false: missing evidence yields verification, only affirmative closure yields unavailable', () => {
    const closed = itinerary();
    closed.days[0]!.items[0] = { ...closed.days[0]!.items[0]!, operational: { provider: 'fixture', checkedAt: '2026-08-01T00:00:00Z', outcome: 'closed_permanently', basis: 'status_only', recheck: false, attribution: 'f', note: 'Permanently closed.' } };
    const graph = buildTripStateGraph({ itinerary: closed, intelligence: intelligence(), booked, now: NOW });
    expect(graph.nodes.find((n) => n.id === 'experience:d1-a0-lake-louise')?.state).toBe('unavailable');
    expect(graph.nodes.filter((n) => n.state === 'unavailable')).toHaveLength(1);
  });
});

describe('next best action', () => {
  it('ranks the open dependency first, then the required booking the trip stands on, and never invents a due date', () => {
    const graph = buildTripStateGraph({ itinerary: itinerary(), intelligence: intelligence(), booked, now: NOW });
    const next = buildNextActions({ graph, lifecycle: 'planning', daysUntilTrip: 9, now: NOW });
    expect(next.phase).toBe('prepare');
    expect(next.actions.length).toBeLessThanOrEqual(3);
    expect(next.actions[0]?.kind).toBe('decide');
    expect(next.actions[0]?.title).toMatch(/Day 3|transfer/);
    expect(next.actions.some((a) => a.kind === 'book' && /car|Jasper/.test(a.title))).toBe(true);
    expect(next.actions.every((a) => a.due === undefined)).toBe(true);
    expect(phaseFor('ready', 60, graph)).toBe('plan');
    expect(phaseFor('booked', 60, { ...graph, counts: { ...graph.counts, needs_decision: 0, needs_booking: 0 } })).toBe('prepare');
  });

  it('while travelling the day’s own action leads, with the leave-by time and its basis', () => {
    const plan = itinerary();
    const today = buildTodayView({ itinerary: plan, booked, backups: [], now: new Date('2026-09-10T10:30:00-06:00'), timeZone: 'America/Edmonton' });
    expect(today.active).toBe(true);
    expect(today.leaveBy?.time).toBe('11:35');
    expect(today.leaveBy?.basis).toBe('static');
    const graph = buildTripStateGraph({ itinerary: plan, intelligence: intelligence(), booked, now: NOW });
    const next = buildNextActions({ graph, lifecycle: 'traveling', daysUntilTrip: 0, now: NOW, today });
    expect(next.phase).toBe('travel');
    expect(next.actions[0]?.kind).toBe('travel');
    expect(next.actions[0]?.title).toMatch(/Leave by 11:35 for Moraine Lake/);
    expect(next.actions[0]?.why).toMatch(/measured without traffic/);
  });
});

describe('preflight', () => {
  it('buckets bookings, documents, weather, packing and the offline copy, and the verdict follows the attention list', () => {
    const graph = buildTripStateGraph({ itinerary: itinerary(), intelligence: intelligence(), booked, now: NOW });
    const preflight = buildPreflight({ graph, intelligence: intelligence(), booked, checks: { preflight: [], packing: ['p1'], checklist: [] }, daysUntilTrip: 9 });
    expect(preflight.verdict).toBe('not_yet');
    expect(preflight.ready.map((i) => i.id)).toContain('preflight:flights');
    expect(preflight.attention.map((i) => i.id)).toEqual(expect.arrayContaining(['preflight:lodging', 'preflight:car']));
    expect(preflight.later.some((i) => i.category === 'weather')).toBe(true);
    expect(preflight.attention.some((i) => i.title.includes('Day 3'))).toBe(true);
    const offline = [...preflight.attention, ...preflight.later].find((i) => i.id === 'preflight:offline');
    expect(offline?.checkId).toBe('offline');
    const ticked = buildPreflight({ graph, intelligence: intelligence(), booked, checks: { preflight: ['offline', 'readiness:visa'], packing: ['p1', 'p2'], checklist: [] }, daysUntilTrip: 2 });
    expect(ticked.ready.map((i) => i.id)).toEqual(expect.arrayContaining(['preflight:offline', 'preflight:readiness:visa', 'preflight:packing']));
  });
});

describe('decisions and controlled alternatives', () => {
  it('derives route, transport and timing records with alternatives and figures, and overlays the traveller’s row', () => {
    const decisions = deriveDecisions({ itinerary: itinerary(), intelligence: intelligence(), travellerFacts: ['Two hikers, one knee.'] });
    const route = decisions.find((d) => d.key === 'route')!;
    expect(route.chosen).toMatch(/Banff \(2 nights\) → Jasper \(1 night\)/);
    expect(route.alternatives[0]).toEqual({ label: 'Yoho', why: 'Not enough days.' });
    expect(route.tradeoffs.find((t) => t.label === 'Hotel changes')?.value).toBe('1');
    expect(route.decidedBy).toBe('model');
    const transport = decisions.find((d) => d.key === 'transport')!;
    expect(transport.alternatives.map((a) => a.label)).toEqual(expect.arrayContaining(['transit', 'bus for Banff → Jasper']));
    const timing = decisions.find((d) => d.key === 'timing')!;
    expect(timing.decidedBy).toBe('traveller');
    expect(timing.lock).toBe('user_explicit');
    const overlaid = deriveDecisions({ itinerary: itinerary(), intelligence: intelligence(), persisted: [{ key: 'transport', chosen: 'Coach on the Parkway', why: 'We would rather not drive.', lock: 'user_explicit', decidedBy: 'traveller', decidedAt: '2026-08-30T00:00:00Z' }] });
    expect(overlaid.find((d) => d.key === 'transport')?.chosen).toBe('Coach on the Parkway');
  });
});

describe('the deterministic delta', () => {
  const before = { bases: [{ id: 'b1', name: 'Banff', nights: 2 }, { id: 'b2', name: 'Jasper', nights: 1 }, { id: 'b3', name: 'Field', nights: 1 }], days: [{ dayNumber: 1, baseId: 'b1', anchors: [{ name: 'Lake Louise', role: 'core', transport: 'drive' }, { name: 'Moraine Lake', role: 'core' }] }, { dayNumber: 2, baseId: 'b3', anchors: [{ name: 'Emerald Lake', transport: 'drive' }] }, { dayNumber: 3, baseId: 'b2', anchors: [{ name: 'Maligne Canyon' }] }] };
  const after = { bases: [{ id: 'b1', name: 'Banff', nights: 3 }, { id: 'b2', name: 'Jasper', nights: 1 }], days: [{ dayNumber: 1, baseId: 'b1', anchors: [{ name: 'Lake Louise', role: 'core', transport: 'drive' }, { name: 'Moraine Lake', role: 'core' }] }, { dayNumber: 2, baseId: 'b1', anchors: [{ name: 'Johnston Canyon' }] }, { dayNumber: 3, baseId: 'b2', anchors: [{ name: 'Maligne Canyon' }] }] };

  it('reads bases, hotel changes, stops, signature stops and the days that change from the drafts themselves', () => {
    const delta = draftDelta(before, after);
    const line = (label: string) => delta.lines.find((l) => l.label === label)!;
    expect(line('Bases').before).toBe('3');
    expect(line('Bases').after).toBe('2');
    expect(line('Hotel changes').after).toBe('1');
    expect(line('Hotel changes').tone).toBe('better');
    expect(line('Driving legs').after).toBe('1');
    expect(delta.signatureKept).toEqual({ kept: 2, total: 2 });
    expect(delta.daysChanged).toEqual([2]);
    expect(delta.headline).toMatch(/Bases 3 → 2/);
  });

  it('compares measured metrics after an Apply as travel time and counts', () => {
    const lines = metricsDelta({ travelBurdenMinutesPerDay: 80, hotelChurn: 2, freeMinutesPerDay: 90 }, { travelBurdenMinutesPerDay: 55, hotelChurn: 1, freeMinutesPerDay: 120 }, 3);
    expect(lines.find((l) => l.label === 'Travel across the trip')?.change).toBe(-75);
    expect(lines.find((l) => l.label === 'Travel across the trip')?.tone).toBe('better');
    expect(lines.find((l) => l.label === 'Hotel changes')?.tone).toBe('better');
    expect(lines.find((l) => l.label === 'Free time per day')?.tone).toBe('better');
  });
});

describe('the ledger', () => {
  it('sums committed cost from paid facts, keeps the estimate range and names the major costs remaining', () => {
    const ledger = buildLedger({ budget: intelligence().budget, booked, openNeeds: needs.filter((n) => n.status === 'open' && !n.memberIds) });
    expect(ledger.estimated).toEqual({ low: 2400, high: 3000, currency: 'CAD', perPerson: true });
    expect(ledger.committed).toEqual({ amount: 1540, currency: 'CAD', count: 2 });
    expect(ledger.remainingMajor).toEqual(['lodging', 'the car']);
    expect(ledger.lines[0]?.refundable).toBe('refundable');
    expect(buildLedger({ budget: null, booked: [], openNeeds: [] }).committed).toBeNull();
  });
});

describe('a split day', () => {
  it('parses the sentence into groups, keeps the rejoin, and says what one car means', () => {
    const d = day(2, '2026-09-11', 'b1', [], { split: { who: 'Maya and Tom; the others', does: 'Sentinel Pass; the others: lakeshore and canoe', rejoin: 'Lunch at the lodge at 13:00' } });
    const plan = splitPlanFor(d, { bookingsOnDay: ['Canoe hire'] })!;
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0]).toEqual({ who: 'Maya and Tom', does: 'Sentinel Pass' });
    expect(plan.groups[1]?.does).toBe('lakeshore and canoe');
    expect(plan.rejoin).toBe('Lunch at the lodge at 13:00');
    expect(plan.transportNote).toMatch(/one car cannot serve both halves/);
    expect(plan.bookingsNote).toMatch(/Canoe hire/);
    expect(splitPlanFor(day(1, '2026-09-10', 'b1', []))).toBeNull();
  });
});

describe('the calendar builder', () => {
  it('writes VTIMEZONE from tz data, TZID on every local time, stable UIDs, SEQUENCE, status and the refresh interval', () => {
    const ics = buildCalendar({
      name: 'Rockies — Sidequest',
      description: 'Three days.',
      timeZones: ['America/Edmonton'],
      years: yearsBetween('2026-09-10', '2026-09-12'),
      stamp: '2026-09-01T09:00:00.000Z',
      refreshInterval: 'PT1H',
      primaryTimeZone: 'America/Edmonton',
      events: [
        { uid: 'trip-1-booked-bk-1@sidequest', date: '2026-09-10', startMinute: 15 * 60, endMinute: 11 * 60, endDate: '2026-09-12', timeZone: 'America/Edmonton', summary: 'Booked: Moose Hotel', status: 'confirmed', categories: ['Booked'], sequence: 3 },
        { uid: 'trip-1-anchor-d1-a0-lake-louise@sidequest', date: '2026-09-10', startMinute: 9 * 60, endMinute: 10 * 60 + 30, timeZone: 'America/Edmonton', summary: 'Lake Louise', description: 'Morning light; the car park fills by 8.', status: 'tentative', sequence: 3, geo: { lat: 51.4254, lng: -116.1773 } },
      ],
    });
    expect(ics).toContain('BEGIN:VTIMEZONE\r\nTZID:America/Edmonton');
    expect(ics).toContain('BEGIN:DAYLIGHT');
    expect(ics).toContain('BEGIN:STANDARD');
    expect(ics).toContain('TZOFFSETFROM:-0600\r\nTZOFFSETTO:-0700');
    expect(ics).toContain('DTSTART;TZID=America/Edmonton:20260910T090000');
    expect(ics).toContain('DTEND;TZID=America/Edmonton:20260912T110000');
    expect(ics).toContain('SEQUENCE:3');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).toContain('CATEGORIES:Booked');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(ics).toContain('X-PUBLISHED-TTL:PT1H');
    expect(ics).toContain('GEO:51.425400;-116.177300');
    expect(ics.split('\r\n').every((line) => line.length <= 75)).toBe(true);
    expect(vtimezoneFor('Asia/Tokyo', [2026]).filter((l) => l.startsWith('BEGIN:'))).toHaveLength(2);
  });

  it('builds an Add-to-Google link with local times and the zone', () => {
    const link = googleCalendarLink({ date: '2026-09-10', startMinute: 9 * 60, endMinute: 10 * 60, timeZone: 'America/Edmonton', summary: 'Lake Louise' });
    expect(link).toContain('calendar.google.com/calendar/render?action=TEMPLATE');
    expect(link).toContain('dates=20260910T090000%2F20260910T100000');
    expect(link).toContain('ctz=America%2FEdmonton');
  });
});

describe('reading a confirmation without a model', () => {
  const hotel = `Booking.com
Your booking is confirmed
Confirmation number: 3141.592.653
Hotel Granvia Kyoto
Address: 901 Higashi-Shiokoji-cho, Kyoto
Check-in: Monday, 12 October 2026 (from 15:00)
Check-out: Thursday, 15 October 2026 (until 11:00)
2 adults
Total price: ¥84,000
Free cancellation until 5 October 2026
Questions? Call +81 75 344 8888 or write to help@booking.com. Card ending 4242 4242 4242 4242.`;

  it('extracts a hotel: type, dates, times, reference, amount, deadline, address, and redacts card, phone and e-mail', () => {
    const redacted = redactSensitive(hotel);
    expect(redacted).not.toContain('4242 4242');
    expect(redacted).not.toContain('help@booking.com');
    expect(redacted).not.toContain('+81 75');
    const found = extractConfirmation(redacted, { tripStart: '2026-10-12', tripEnd: '2026-10-22', senderDomain: 'booking.com', subject: 'Your booking is confirmed' });
    expect(found.type).toBe('lodging');
    expect(found.provider).toBe('Booking.com');
    expect(found.date).toBe('2026-10-12');
    expect(found.endDate).toBe('2026-10-15');
    expect(found.startTime).toBe('15:00');
    expect(found.endTime).toBe('11:00');
    expect(found.confirmationRef).toBe('3141.592.653'.toUpperCase());
    expect(found.cost).toEqual({ amount: 84000, currency: 'JPY' });
    expect(found.cancellationDeadline).toBe('2026-10-05');
    expect(found.title).toMatch(/Hotel Granvia Kyoto/);
    expect(found.location).toMatch(/Higashi-Shiokoji/);
    expect(found.travellers).toBe(2);
    expect(found.fields.find((f) => f.key === 'date')?.confidence).toBe('high');
  });

  it('extracts a flight with its PNR and route, and reads an ambiguous 12/10/2026 by the trip window', () => {
    const flight = `Air Canada e-ticket itinerary
Booking reference (PNR): K7Q2ZP
AC 123  YYZ - YYC
Departs 12/10/2026 08:00  Arrives 12/10/2026 10:30 MDT
Passengers: 2
Total charged CAD 912.40`;
    const found = extractConfirmation(flight, { tripStart: '2026-10-12', tripEnd: '2026-10-22', senderDomain: 'aircanada.com' });
    expect(found.type).toBe('flight');
    expect(found.confirmationRef).toBe('K7Q2ZP');
    expect(found.date).toBe('2026-10-12');
    expect(found.startTime).toBe('08:00');
    expect(found.endTime).toBe('10:30');
    expect(found.title).toBe('AC123 · YYZ → YYC');
    expect(found.cost).toEqual({ amount: 912.4, currency: 'CAD' });
  });

  it('says what it could not find rather than guessing', () => {
    const found = extractConfirmation('Thanks for your order! See you soon.', {});
    expect(found.type).toBe('custom');
    expect(found.gaps).toEqual(expect.arrayContaining(['A confirmation reference', 'The date', 'What was booked']));
  });
});

describe('freshness', () => {
  it('lists volatile facts with staleness and recheckability, and summarises observed changes', () => {
    const facts = volatileFacts({ itinerary: itinerary(), intelligence: intelligence(), booked, now: NOW, capabilities: { forecast: true, hours: false, transit: false } });
    const forecast = facts.filter((f) => f.kind === 'forecast');
    expect(forecast).toHaveLength(3);
    expect(forecast[0]?.stale).toBe(true);
    expect(forecast[0]?.recheckable).toBe(true);
    const hours = facts.find((f) => f.id === 'fact:hours:d2-a0-sentinel-pass');
    expect(hours?.stale).toBe(true);
    expect(hours?.recheckable).toBe(false);
    expect(facts.some((f) => f.kind === 'transport' && f.subject.startsWith('AC 123'))).toBe(true);
    expect(facts.some((f) => f.kind === 'deadline')).toBe(true);
    expect(facts.some((f) => f.kind === 'advisory')).toBe(true);
    expect(factsDueForRecheck(facts).every((f) => f.kind === 'forecast')).toBe(true);
    const summary = summariseObservations([
      { id: 'o1', factId: 'fact:forecast:2', kind: 'forecast', observedAt: '2026-09-01T00:00:00Z', previous: 'Clear', current: 'Rain', changed: true, dayNumbers: [2], summary: 'Day 2 now expects rain.', acknowledgedAt: null },
      { id: 'o2', factId: 'fact:forecast:1', kind: 'forecast', observedAt: '2026-09-01T00:00:00Z', previous: 'Clear', current: 'Clear', changed: false, dayNumbers: [1], summary: 'Day 1 unchanged.', acknowledgedAt: null },
    ]);
    expect(summary.headline).toBe('1 thing changed since this trip was planned.');
  });
});
