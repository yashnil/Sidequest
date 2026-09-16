import { describe, expect, it } from 'vitest';
import { controlForMode, routingForMode, scheduleForMode, type Journey, type JourneyTruth } from './journey';
import { journeyRechecks } from './recheck';
import type { TravelMode } from './vocabulary';

/**
 * V12.1 §24 — a recheck is worth showing only where staleness could break the
 * trip, where somebody else owns the answer, and where the answer exists yet.
 */

function journey(mode: TravelMode, truth: JourneyTruth, over: Partial<Journey> = {}): Journey {
  return {
    version: 1,
    origin: { id: 'a', name: 'Piraeus' },
    destination: { id: 'b', name: 'Naxos' },
    mode,
    control: controlForMode(mode),
    routing: routingForMode(mode),
    schedule: scheduleForMode(mode),
    truth,
    minutes: truth === 'unknown' ? null : 200,
    km: null,
    reservation: 'unknown',
    booking: 'unknown',
    evidence: { source: truth === 'timetabled' ? 'timetable' : truth === 'operator_set' ? 'operator' : 'none', freshness: truth === 'timetabled' ? 'seasonal' : truth === 'operator_set' ? 'date_bound' : 'unknown' },
    routeCritical: true,
    ...over,
  };
}

const TRIP = '2026-08-01';

describe('what earns a recheck', () => {
  it('asks about a seasonal ferry timetable once the season is close enough to be published', () => {
    const rechecks = journeyRechecks({ journeys: [journey('ferry', 'timetabled')], departureDate: TRIP, now: new Date('2026-07-15T00:00:00Z') });
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]!.detail).toMatch(/timetable/i);
    expect(rechecks[0]!.owner).toBe('traveler');
  });

  it('says nothing at all nine months out', () => {
    /* The winter timetable it would check is not published; asking is noise. */
    expect(journeyRechecks({ journeys: [journey('ferry', 'timetabled')], departureDate: TRIP, now: new Date('2025-11-01T00:00:00Z') })).toHaveLength(0);
  });

  it('asks the traveller to confirm an operator pickup in the week before', () => {
    const rechecks = journeyRechecks({ journeys: [journey('operator_transfer', 'operator_set', { operator: 'the lodge' })], departureDate: TRIP, now: new Date('2026-07-26T00:00:00Z') });
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]!.detail).toMatch(/the lodge/);
    expect(rechecks[0]!.urgency).toBe('before_you_go');
  });

  it('marks it urgent inside three days', () => {
    const rechecks = journeyRechecks({ journeys: [journey('ferry', 'timetabled')], departureDate: TRIP, now: new Date('2026-07-30T00:00:00Z') });
    expect(rechecks[0]!.urgency).toBe('now');
  });
});

describe('what never earns one', () => {
  it('never asks about a measured road leg', () => {
    /* A road geometry measured in March is still true in August. */
    expect(journeyRechecks({ journeys: [journey('drive', 'measured', { evidence: { source: 'router', freshness: 'stable' } })], departureDate: TRIP, now: new Date('2026-07-30T00:00:00Z') })).toHaveLength(0);
  });

  it('never asks about a journey that is only unknown because we could not route it', () => {
    /* §22: our unfinished work is never a traveller's task, and that holds here too. */
    const ours = journey('drive', 'unknown', { unknownReason: 'outside_provider_coverage' });
    expect(journeyRechecks({ journeys: [ours], departureDate: TRIP, now: new Date('2026-07-30T00:00:00Z') })).toHaveLength(0);
  });

  it('never asks about a leg the route does not rest on', () => {
    expect(journeyRechecks({ journeys: [journey('ferry', 'timetabled', { routeCritical: false })], departureDate: TRIP, now: new Date('2026-07-30T00:00:00Z') })).toHaveLength(0);
  });

  it('never asks about a walk or a trail stage', () => {
    expect(journeyRechecks({ journeys: [journey('trail', 'unknown'), journey('walk', 'estimated')], departureDate: TRIP, now: new Date('2026-07-30T00:00:00Z') })).toHaveLength(0);
  });
});

describe('the list stays short', () => {
  it('never shows more than three, however many perish', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      journey('ferry', 'timetabled', { origin: { id: `a${index}`, name: `Port ${index}` }, destination: { id: `b${index}`, name: `Island ${index}` } }),
    );
    expect(journeyRechecks({ journeys: many, departureDate: TRIP, now: new Date('2026-07-30T00:00:00Z') })).toHaveLength(3);
  });

  it('counts two legs on the same corridor as one thing to check', () => {
    const there = journey('ferry', 'timetabled');
    const back = journey('ferry', 'timetabled');
    expect(journeyRechecks({ journeys: [there, back], departureDate: TRIP, now: new Date('2026-07-30T00:00:00Z') })).toHaveLength(1);
  });

  it('puts the soonest first', () => {
    const flight = journey('flight', 'unknown', { origin: { id: 'x', name: 'Malé' }, destination: { id: 'y', name: 'the atoll' }, evidence: { source: 'none', freshness: 'volatile' } });
    const ferry = journey('ferry', 'timetabled');
    const rechecks = journeyRechecks({ journeys: [ferry, flight], departureDate: TRIP, now: new Date('2026-07-31T00:00:00Z') });
    expect(rechecks.length).toBeGreaterThanOrEqual(1);
    expect(rechecks[0]!.urgency).toBe('now');
  });
});
