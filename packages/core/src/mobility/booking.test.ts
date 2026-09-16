import { describe, expect, it } from 'vitest';
import { buildFeasibilityReport } from '../feasibility/report';
import type { Itinerary } from '../schemas/itinerary';
import { controlForMode, journeyNeedsTravelerAction, routingForMode, scheduleForMode, type Journey, type JourneyTruth } from './journey';
import type { TravelMode } from './vocabulary';

/**
 * V12.1 §22 — A JOURNEY MAY RAISE A BOOKING ONLY WHERE THERE IS SOMETHING TO BOOK.
 *
 * §22's rule, in its own words: *"Do NOT generate 'decide transportation' because
 * Sidequest failed to route something. Sidequest failure remains Sidequest-owned
 * uncertainty."*
 *
 * The temptation is strongest exactly here. An untimed leg looks like an open
 * question, and turning it into a task makes the product feel thorough while
 * handing the traveller work only we can do. V11 §`owner` settled the principle
 * for feasibility items and `next-action.ts:73` enforces it; this holds the
 * mobility layer to it, from both ends — the journey's own predicate and the
 * feasibility report the state graph reads.
 */

function journey(mode: TravelMode, truth: JourneyTruth, over: Partial<Journey> = {}): Journey {
  return {
    version: 1,
    origin: { id: 'a', name: 'A' },
    destination: { id: 'b', name: 'B' },
    mode,
    control: controlForMode(mode),
    routing: routingForMode(mode),
    schedule: scheduleForMode(mode),
    truth,
    minutes: truth === 'unknown' || truth === 'contradicted' ? null : 90,
    km: null,
    reservation: 'unknown',
    booking: 'unknown',
    evidence: { source: 'none', freshness: 'unknown' },
    routeCritical: true,
    ...over,
  };
}

const ITINERARY = { days: [], issues: [], unscheduled: [], package: undefined, transportStrategy: { primaryMode: 'drive' } } as unknown as Itinerary;

function items(journeys: readonly Journey[], family: Parameters<typeof buildFeasibilityReport>[0]['operatingType']) {
  return buildFeasibilityReport({ itinerary: ITINERARY, journeys, operatingType: family }).items;
}

describe('what a journey may ask of a traveller', () => {
  it('asks nothing when the only problem is that we could not route it', () => {
    for (const reason of ['no_provider_for_mode', 'outside_provider_coverage', 'provider_did_not_answer', 'measurement_implausible'] as const) {
      const untimed = journey('drive', 'unknown', { unknownReason: reason });
      expect(journeyNeedsTravelerAction(untimed), reason).toBe(false);
    }
  });

  it('asks nothing of a trail stage or an operator’s transfer', () => {
    expect(journeyNeedsTravelerAction(journey('trail', 'unknown'))).toBe(false);
    expect(journeyNeedsTravelerAction(journey('operator_transfer', 'operator_set', { booking: 'operator' }))).toBe(false);
  });

  it('does ask for a reservation somebody has to make', () => {
    expect(journeyNeedsTravelerAction(journey('rail', 'timetabled', { reservation: 'required' }))).toBe(true);
    expect(journeyNeedsTravelerAction(journey('ferry', 'unknown', { booking: 'traveler' }))).toBe(true);
    expect(journeyNeedsTravelerAction(journey('flight', 'unknown', { booking: 'traveler' }))).toBe(true);
  });

  it('does not turn a frequent metro into a booking', () => {
    expect(journeyNeedsTravelerAction(journey('urban_transit', 'unknown'))).toBe(false);
  });
});

describe('what reaches the feasibility report', () => {
  it('files a journey no provider could time as Sidequest’s own work', () => {
    const report = items([journey('drive', 'unknown', { unknownReason: 'no_provider_for_mode' })], 'self_drive_road_trip');
    const transport = report.filter((item) => item.area === 'transport');
    expect(transport.length).toBeGreaterThan(0);
    expect(transport.every((item) => item.owner === 'sidequest')).toBe(true);
    for (const item of transport) expect(item.detail).not.toMatch(/decide|choose|pick/i);
  });

  it('raises a contradicted crossing as something the traveller has to settle', () => {
    const report = items([journey('ferry', 'contradicted', { contradiction: 'The operator lists no winter sailings on this route.' })], 'island_hopping');
    const blocker = report.find((item) => item.severity === 'blocker');
    expect(blocker).toBeTruthy();
    expect(blocker!.owner).toBeUndefined();
    expect(blocker!.detail).toMatch(/no winter sailings/i);
  });

  it('raises nothing at all when every route-critical journey is settled for this family', () => {
    const report = items([journey('rail', 'timetabled'), journey('urban_transit', 'unknown')], 'rail_journey');
    expect(report.filter((item) => item.area === 'transport')).toHaveLength(0);
  });

  it('behaves exactly as before when no journeys are supplied', () => {
    /* The compatibility guarantee: a caller that has not adopted the layer sees no change. */
    const before = buildFeasibilityReport({ itinerary: ITINERARY });
    expect(before.items.filter((item) => item.area === 'transport')).toHaveLength(0);
    expect(before.verdict).toBe('feasible');
  });
});
