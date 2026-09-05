import { describe, expect, it } from 'vitest';
import { CLAIM_KINDS, CONFIRMING_AUTHORITY, applySourcePolicy, claim, freshnessVerdict, mayConfirm, stateFromEvidence } from './claims';
import { bookingPriorityFor } from './booking';
import { buildReadinessPacket, OfficialTravelSourceRegistry } from './readiness';
import { LEG_MODES, ROAD_ROUTABLE_MODES, durationBasisOf, legFromSegment, trafficStateFor } from './transport';
import { buildTerminalPlan, TERMINAL_BUFFERS } from './terminal';
import { buildChecklist } from './checklist';
import { accessStateFor } from './weather-access';
import type { ItineraryDay, ItineraryItem } from '../schemas/itinerary';

const NOW = new Date('2026-06-01T12:00:00Z');

describe('source authority policy', () => {
  it('a model proposal can never confirm a legal fact: "you do not need a visa" is downgraded, not believed', () => {
    const c = claim({ id: 'v', kind: 'entry_visa', subject: 'FR', claim: 'No visa needed', authority: 'model_proposal', sourceName: 'model', state: 'confirmed' });
    expect(c.state).toBe('unverified');
    expect(c.notes.join(' ')).toMatch(/cannot confirm entry visa/);
  });

  it('only official current sources confirm entry, health, advisory and local-law claims', () => {
    for (const kind of ['entry_visa', 'transit_requirement', 'health_document', 'travel_advisory', 'local_law'] as const) {
      expect(CONFIRMING_AUTHORITY[kind]).toEqual(['official_current']);
      expect(mayConfirm(kind, 'authoritative_structured')).toBe(false);
      expect(mayConfirm(kind, 'trusted_reference')).toBe(false);
    }
  });

  it('static routing may confirm a duration but never live traffic; climate never confirms a forecast', () => {
    expect(mayConfirm('routing_duration', 'open_structured')).toBe(true);
    expect(mayConfirm('current_traffic', 'open_structured')).toBe(false);
    expect(mayConfirm('weather_forecast', 'model_proposal')).toBe(false);
    expect(mayConfirm('hotel_availability', 'model_proposal')).toBe(false);
    expect(mayConfirm('hotel_availability', 'trusted_reference')).toBe(false);
  });

  it('every claim kind has a policy row, and proposals (meal intent, packing) can never be confirmed by anyone', () => {
    for (const kind of CLAIM_KINDS) expect(Array.isArray(CONFIRMING_AUTHORITY[kind])).toBe(true);
    expect(CONFIRMING_AUTHORITY.meal_intent).toEqual([]);
    expect(CONFIRMING_AUTHORITY.packing_suggestion).toEqual([]);
  });

  it('UNKNOWN ≠ FALSE and MISSING ≠ CONTRADICTED: absence of evidence is unverified, never contradicted', () => {
    expect(stateFromEvidence({ found: false })).toBe('unverified');
    expect(stateFromEvidence({ found: true, contradicts: false })).toBe('confirmed');
    expect(stateFromEvidence({ found: true, contradicts: true })).toBe('contradicted');
  });

  it('PROVIDER FAILURE ≠ IMPOSSIBILITY: a failed provider produces unverified, even when it "found" nothing', () => {
    expect(stateFromEvidence({ found: false, providerFailed: true })).toBe('unverified');
  });

  it('STALE ≠ CURRENT: a forecast read two days ago wants a recheck; a stable reference never does', () => {
    const forecast = claim({ id: 'f', kind: 'weather_forecast', subject: 'd1', claim: 'Sunny', authority: 'authoritative_structured', sourceName: 'provider', state: 'confirmed', checkedAt: '2026-05-30T00:00:00Z' });
    expect(freshnessVerdict(forecast, NOW)).toBe('recheck');
    const identity = claim({ id: 'i', kind: 'place_identity', subject: 'p', claim: 'Exists', authority: 'open_structured', sourceName: 'osm', state: 'confirmed', checkedAt: '2020-01-01T00:00:00Z' });
    expect(freshnessVerdict(identity, NOW)).toBe('current');
    const undated = claim({ id: 'u', kind: 'opening_hours', subject: 'p', claim: '9–5', authority: 'official_current', sourceName: 'venue', state: 'confirmed' });
    expect(freshnessVerdict(undated, NOW)).toBe('unknown_age');
  });

  it('applying the policy keeps the source and the link so the traveller can still follow it', () => {
    const c = applySourcePolicy(claim({ id: 'x', kind: 'permit', subject: 'p', claim: 'Permit needed', authority: 'trusted_reference', sourceName: 'Guide', sourceUrl: 'https://example.org', state: 'unverified' }));
    expect(c.sourceUrl).toBe('https://example.org');
    expect(c.state).toBe('unverified');
  });
});

describe('multimodal transport and traffic semantics', () => {
  const segment = (mode: 'drive' | 'ferry' | 'unsupported' | 'rail', provenance: 'measured' | 'unmeasured' | 'official' | 'modelled') => ({
    fromId: 'a',
    toId: 'b',
    fromName: 'A',
    toName: 'B',
    minutes: provenance === 'unmeasured' ? null : 60,
    km: provenance === 'unmeasured' ? null : 50,
    mode,
    role: 'approach' as const,
    provenance,
    ...(provenance === 'unmeasured' ? { unmeasuredReason: 'mode_not_routed' as const } : {}),
  });

  it('a flight the road router could not route is plausible and unmeasured — never impossible', () => {
    const leg = legFromSegment({ id: 'l', dayNumber: 2, segment: segment('unsupported', 'unmeasured'), hint: 'flight', departAt: null, now: NOW });
    expect(leg.mode).toBe('flight');
    expect(leg.plausibility).toBe('plausible');
    expect(leg.unmeasuredReason).toBe('mode_not_road_routable');
    expect(leg.trafficState).toBe('not_applicable');
  });

  it('a ferry, a boat and a guide transfer are real modes, not road failures', () => {
    expect(legFromSegment({ id: 'l', dayNumber: 1, segment: segment('ferry', 'unmeasured'), hint: 'boat', departAt: null, now: NOW }).mode).toBe('boat');
    expect(legFromSegment({ id: 'l', dayNumber: 1, segment: { ...segment('unsupported', 'unmeasured') }, hint: 'guide_or_lodge_transfer', departAt: null, now: NOW }).mode).toBe('guide_transfer');
    expect(ROAD_ROUTABLE_MODES.has('flight')).toBe(false);
    expect(ROAD_ROUTABLE_MODES.has('ferry')).toBe(false);
    expect(LEG_MODES.length).toBeGreaterThanOrEqual(18);
  });

  it('static road routing is measured_static and is never labelled live traffic', () => {
    expect(durationBasisOf({ provenance: 'measured' })).toBe('measured_static');
    const leg = legFromSegment({ id: 'l', dayNumber: 1, segment: segment('drive', 'measured'), departAt: new Date('2026-06-01T12:10:00Z'), now: NOW });
    expect(leg.durationBasis).toBe('measured_static');
    expect(leg.trafficState).not.toBe('live');
  });

  it('live traffic only exists inside the provider horizon; a trip months away gets typical', () => {
    expect(trafficStateFor({ mode: 'car', basis: 'traffic_aware', departAt: new Date('2026-06-01T13:00:00Z'), now: NOW, providerTrafficAware: true })).toBe('live');
    expect(trafficStateFor({ mode: 'car', basis: 'traffic_aware', departAt: new Date('2026-09-01T13:00:00Z'), now: NOW, providerTrafficAware: true })).toBe('typical');
    expect(trafficStateFor({ mode: 'walk', basis: 'measured_static', departAt: null, now: NOW, providerTrafficAware: true })).toBe('not_applicable');
    expect(trafficStateFor({ mode: 'car', basis: 'measured_static', departAt: null, now: NOW, providerTrafficAware: false })).toBe('not_applicable');
  });

  it('a published timetable is scheduled_transit; an unverified scheduled leg is an estimate', () => {
    expect(durationBasisOf({ provenance: 'official' })).toBe('scheduled_transit');
    expect(durationBasisOf({ provenance: 'official', unverifiedScheduled: true })).toBe('estimated');
    expect(durationBasisOf({ provenance: 'modelled' })).toBe('estimated');
  });
});

describe('booking priority without fake urgency', () => {
  it('a required thing with a fixed time or a long lead is book first; a weather-sensitive option keeps flexible', () => {
    expect(bookingPriorityFor({ necessity: 'required', hardDependency: true, fixedDateTime: true, limitedCapacity: false, fewAlternatives: false, longLeadTime: false, weatherSensitive: false, importance: 'core' })).toBe('book_first');
    expect(bookingPriorityFor({ necessity: 'optional', hardDependency: false, fixedDateTime: false, limitedCapacity: false, fewAlternatives: false, longLeadTime: false, weatherSensitive: true, importance: 'optional' })).toBe('keep_flexible');
    expect(bookingPriorityFor({ necessity: 'strongly_recommended', hardDependency: false, fixedDateTime: false, limitedCapacity: false, fewAlternatives: false, longLeadTime: false, weatherSensitive: false, importance: 'secondary' })).toBe('can_wait');
  });
  it('capacity is never assumed limited: a required item with nothing fixed is book soon, not book first', () => {
    expect(bookingPriorityFor({ necessity: 'required', hardDependency: false, fixedDateTime: false, limitedCapacity: false, fewAlternatives: false, longLeadTime: false, weatherSensitive: false, importance: 'secondary' })).toBe('book_soon');
  });
});

describe('country readiness', () => {
  const base = { destinationName: 'Iceland', destinationCountry: 'IS', tripStart: '2026-08-10', tripEnd: '2026-08-20', drives: true, remote: true, strenuous: true, water: true, now: NOW };

  it('never says "you do not need a visa": an international trip with a known citizenship is unverified with official links', () => {
    const { packet, claims } = buildReadinessPacket({ ...base, profile: { citizenship: 'US', transitCountries: [] } });
    const visa = packet.entries.find((e) => e.kind === 'visa')!;
    expect(visa.state).toBe('unverified');
    expect(visa.summary).toMatch(/not independently verified/);
    expect(visa.summary).not.toMatch(/do not need|no visa/i);
    expect(visa.links.map((l) => l.name).join(' ')).toMatch(/Department of State/);
    expect(claims.every((c) => c.state !== 'confirmed' || c.authority === 'traveller_stated')).toBe(true);
    expect(packet.international).toBe('yes');
  });

  it('a domestic trip drops the visa layer to not applicable', () => {
    const { packet } = buildReadinessPacket({ ...base, destinationCountry: 'US', profile: { citizenship: 'US', transitCountries: [] } });
    expect(packet.international).toBe('no');
    expect(packet.entries.find((e) => e.kind === 'visa')!.state).toBe('not_applicable');
    expect(packet.entries.find((e) => e.kind === 'passport_validity')!.state).toBe('not_applicable');
  });

  it('with no profile nothing is inferred: citizenship-dependent entries need input and the official entry point is offered', () => {
    const { packet } = buildReadinessPacket({ ...base, profile: null });
    expect(packet.international).toBe('unknown');
    expect(packet.entries.find((e) => e.kind === 'visa')!.state).toBe('needs_input');
    expect(packet.entries.find((e) => e.kind === 'visa')!.links.some((l) => /iatatravelcentre/.test(l.url))).toBe(true);
    expect(packet.profileProvided).toBe(false);
  });

  it('a passport that expires before the trip ends is a blocking problem from the traveller’s own statement', () => {
    const { packet } = buildReadinessPacket({ ...base, profile: { citizenship: 'GB', passportExpiry: '2026-08', transitCountries: [] } });
    const passport = packet.entries.find((e) => e.kind === 'passport_validity')!;
    expect(passport.state).toBe('problem');
    expect(passport.blocking).toBe(true);
    expect(packet.blockingCount).toBe(1);
  });

  it('a traveller from an uncovered country is told so honestly rather than handed another country’s advice', () => {
    const { packet } = buildReadinessPacket({ ...base, profile: { citizenship: 'BR', transitCountries: [] } });
    const advisory = packet.entries.find((e) => e.kind === 'advisory')!;
    expect(advisory.summary).toMatch(/doesn’t yet have a country-specific advisory adapter/);
    expect(new OfficialTravelSourceRegistry().coveredTravellerCountries()).toContain('US');
  });

  it('driving abroad raises the licence question without answering it; at home it does not', () => {
    expect(buildReadinessPacket({ ...base, profile: { citizenship: 'DE', transitCountries: [] } }).packet.entries.find((e) => e.kind === 'driving_document')!.state).toBe('unverified');
    expect(buildReadinessPacket({ ...base, destinationCountry: 'DE', profile: { citizenship: 'DE', transitCountries: [], drivingLicenceCountry: 'DE' } }).packet.entries.find((e) => e.kind === 'driving_document')!.state).toBe('not_applicable');
  });
});

function day(dayNumber: number, date: string, items: Partial<ItineraryItem>[], window = { startMinute: 8 * 60, endMinute: 20 * 60 }): ItineraryDay {
  return {
    dayNumber,
    date,
    baseId: 'b',
    baseName: 'Base',
    theme: 'Test',
    window: { ...window, usableMinutes: window.endMinute - window.startMinute },
    items: items.map((item, i) => ({ id: `i${i}`, kind: 'activity', title: `Stop ${i}`, startMinute: 9 * 60, endMinute: 10 * 60, durationMinutes: 60, reason: 'r', weatherSensitive: false, ...item }) as ItineraryItem),
    totals: { activityMinutes: 0, travelMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, travelKm: 0, freeMinutes: 0, strenuousCount: 0, unmeasuredLegCount: 0 },
    transport: { primaryMode: 'drive', modes: ['drive'], serviceIds: [], parkingNotes: [], accessNotes: [], verifyBeforeTravel: [] },
    availability: { flexiblePlaceIds: [], cautions: [], verifyBeforeTravel: [], bookings: [] },
    weather: { evidence: 'unavailable', summary: 'n/a', precipitationProbabilityPercent: null, decisions: [], cautions: [], backups: [], provider: 'none', attribution: 'none' },
    food: { summary: 'n/a', slots: [], remote: false, notes: [], reservations: [] },
    intensity: 'moderate',
    warnings: [],
  } as ItineraryDay;
}

describe('terminal logistics', () => {
  it('a booked departure flight sets the leave-by time from check-in, the transfer and the car return, and flags a stop scheduled after it', () => {
    const last = day(3, '2026-06-03', [{ startMinute: 12 * 60, endMinute: 13 * 60, durationMinutes: 60 }]);
    const flight = { id: 'f', tripId: 't', type: 'flight' as const, title: 'Home', date: '2026-06-03', startTime: '14:00', status: 'booked' as const, locked: true, createdAt: NOW.toISOString() };
    const plan = buildTerminalPlan({ international: 'yes', arrivalTime: '15:00', departureTime: '14:00', drives: true, firstDay: day(1, '2026-06-01', []), lastDay: last, booked: [flight] });
    const expectedLeaveBy = 14 * 60 - TERMINAL_BUFFERS.checkInInternational - TERMINAL_BUFFERS.rentalReturn - TERMINAL_BUFFERS.transferEstimate;
    expect(plan.departure.basis).toBe('booked');
    expect(plan.departure.boundaryMinute).toBe(expectedLeaveBy);
    expect(plan.departureRespected).toBe(false);
    expect(plan.violations[0]).toMatch(/leave-by/);
  });

  it('a stated (unbooked) time defers to the reconciler’s own day window and only explains the buffers behind it', () => {
    const last = day(3, '2026-06-03', [{ startMinute: 12 * 60, endMinute: 13 * 60, durationMinutes: 60 }], { startMinute: 8 * 60, endMinute: 13 * 60 + 30 });
    const plan = buildTerminalPlan({ international: 'yes', arrivalTime: '15:00', departureTime: '18:00', drives: true, firstDay: day(1, '2026-06-01', []), lastDay: last, booked: [] });
    expect(plan.departure.basis).toBe('stated');
    expect(plan.departure.boundaryMinute).toBe(13 * 60 + 30);
    expect(plan.departureRespected).toBe(true);
    expect(plan.departure.bufferMinutes).toBe(TERMINAL_BUFFERS.checkInInternational);
    expect(plan.departure.vehicleLabel).toMatch(/Return the car/);
  });

  it('nothing before a booked arrival: the first day’s stops must start after immigration, the desk and the transfer', () => {
    const first = day(1, '2026-06-01', [{ startMinute: 15 * 60 + 30, endMinute: 16 * 60, durationMinutes: 30 }]);
    const arrival = { id: 'a', tripId: 't', type: 'flight' as const, title: 'In', date: '2026-06-01', startTime: '12:00', endTime: '15:00', status: 'booked' as const, locked: true, createdAt: NOW.toISOString() };
    const plan = buildTerminalPlan({ international: 'no', arrivalTime: '15:00', departureTime: '18:00', drives: false, firstDay: first, lastDay: day(2, '2026-06-02', []), booked: [arrival] });
    expect(plan.arrival.basis).toBe('booked');
    expect(plan.arrival.boundaryMinute).toBe(15 * 60 + TERMINAL_BUFFERS.immigrationDomestic + TERMINAL_BUFFERS.transferEstimate);
    expect(plan.arrivalRespected).toBe(false);
  });
});

describe('access states', () => {
  const d = day(1, '2026-06-01', []);
  it('unknown hours is not closed, and a lake has no hours at all', () => {
    const noHours = accessStateFor({ id: 'x', kind: 'activity', title: 'Museum', startMinute: 600, endMinute: 660, durationMinutes: 60, reason: 'r', weatherSensitive: false, placeId: 'p' } as ItineraryItem, d, 'museum');
    expect(noHours.state).toBe('hours_unknown');
    expect(noHours.note).toMatch(/kept/);
    const lake = accessStateFor({ id: 'y', kind: 'activity', title: 'Lake', startMinute: 600, endMinute: 660, durationMinutes: 60, reason: 'r', weatherSensitive: true } as ItineraryItem, d, 'water');
    expect(lake.state).toBe('open_access');
    expect(lake.verifyBeforeTravel).toBe(false);
  });
  it('only affirmative evidence produces confirmed_closed', () => {
    const closed = accessStateFor({ id: 'z', kind: 'activity', title: 'Road', startMinute: 600, endMinute: 660, durationMinutes: 60, reason: 'r', weatherSensitive: false, accessWarning: 'Closed for the season' } as ItineraryItem, d, 'scenic_drive');
    expect(closed.state).toBe('confirmed_closed');
  });
});

describe('checklist phases fit the calendar', () => {
  const packet = buildReadinessPacket({ destinationName: 'X', destinationCountry: 'FR', tripStart: '2026-06-05', tripEnd: '2026-06-10', profile: { citizenship: 'US', transitCountries: [] }, drives: false, remote: false, strenuous: false, water: false, now: NOW }).packet;
  const packing = { items: [], basis: 'unknown' as const, basisNote: 'n', modelSuggestions: [] };
  it('a trip in four days has no "one month out" or "one week out" phase', () => {
    const list = buildChecklist({ readiness: packet, bookings: [], packing, recheck: [], daysUntilTrip: 4 });
    expect(list.phases.map((p) => p.phase)).not.toContain('one_month_out');
    expect(list.phases.map((p) => p.phase)).not.toContain('one_week_out');
    expect(list.phases[0]!.phase).toBe('do_now');
  });
  it('a trip in ninety days keeps the long-range phases', () => {
    const list = buildChecklist({ readiness: packet, bookings: [], packing, recheck: [], daysUntilTrip: 90 });
    expect(list.phases.map((p) => p.phase)).toContain('one_month_out');
  });
});
