import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import type { DayWeather, Itinerary, ItineraryDay, ItineraryItem, OperationalEvidence, OperationalOutcome, ScheduledOperational } from '@sidequest/core';
import { AUGUST_BASICS, FIXED_NOW, buildScenario } from '../../../../../packages/planner/src/testing/scenario';
import { compareForecast, compareHours, type OperationalEvidenceSeam } from './recheck';

/**
 * V9.1 §5 — THE HOURS AND FORECAST RECHECK, ON RECORDED EVIDENCE.
 *
 * The readings under `fixtures/` are the normalised `OperationalEvidence`
 * shape a places adapter hands the reconciler — never a raw provider payload
 * — recorded once for one planned visit. The comparison is a pure function,
 * so the first half of this file needs no database and no provider at all;
 * the second half runs the whole `recheckStaleFacts` with the operational
 * seam injected, and proves the same answers reach the persisted
 * observations, that a source that did not answer writes nothing, and that
 * the stored plan is byte-identical afterwards.
 */
const EVIDENCE = JSON.parse(readFileSync(new URL('./fixtures/operational-evidence.json', import.meta.url), 'utf8')) as Record<string, OperationalEvidence>;
const READINGS = JSON.parse(readFileSync(new URL('./fixtures/forecast-readings.json', import.meta.url), 'utf8')) as Record<string, DayWeather>;

/** Two days before the visit, so the assessment is inside the week that matters. */
const NOW = new Date('2026-09-20T08:00:00.000Z');
const OBSERVED_AT = NOW.toISOString();

function planned(outcome: OperationalOutcome): ScheduledOperational {
  return { provider: 'google-places', checkedAt: '2026-09-01T09:00:00.000Z', outcome, basis: 'regular', recheck: true, attribution: 'Place data © Google', note: 'Read when the plan was built.' };
}

/** The visit every fixture was recorded against: a museum, Tuesday 22 September, 10:00–11:30. */
function visit(outcome: OperationalOutcome = 'open_at_time') {
  const item: Pick<ItineraryItem, 'id' | 'title' | 'startMinute' | 'endMinute' | 'operational'> = { id: 'd2-a0-national-museum', title: 'National Museum', startMinute: 10 * 60, endMinute: 11 * 60 + 30, operational: planned(outcome) };
  const day: Pick<ItineraryDay, 'dayNumber' | 'date'> = { dayNumber: 2, date: '2026-09-22' };
  return { item, day };
}

function compare(evidence: OperationalEvidence | null, outcome: OperationalOutcome = 'open_at_time', placeClass: 'business_venue' | 'open_ground' = 'business_venue') {
  const { item, day } = visit(outcome);
  const before = structuredClone({ item, day, evidence });
  const result = compareHours({ item, day, evidence, placeClass, now: NOW, observedAt: OBSERVED_AT, factId: `fact:hours:${item.id}`, factKind: 'hours' });
  /* Nothing passed in is touched. */
  expect({ item, day, evidence }).toEqual(before);
  return result;
}

describe('the hours comparison, as a pure function over recorded evidence', () => {
  it('the recorded visit falls on a Tuesday, which the fixtures are keyed to', () => {
    expect(new Date('2026-09-22T12:00:00Z').getUTCDay()).toBe(2);
  });

  it('unchanged regular hours → no observation', () => {
    expect(compare(EVIDENCE.unchanged_regular!)).toEqual({ comparable: true, changed: false, before: 'open_at_time', after: 'open_at_time' });
  });

  it('the venue now closes before the visit ends → the exact traveller sentence', () => {
    const result = compare(EVIDENCE.closes_earlier!);
    expect(result.comparable && result.changed).toBe(true);
    if (!result.comparable || !result.changed) return;
    expect(result.observation).toEqual({
      factId: 'fact:hours:d2-a0-national-museum',
      kind: 'hours',
      observedAt: OBSERVED_AT,
      previous: 'open_at_time',
      current: 'closes_earlier',
      changed: true,
      dayNumbers: [2],
      summary: 'National Museum on day 2 is now closing before the planned visit ends; it was open at the planned time when the plan was built.',
    });
  });

  it('closed on the date, permanently closed, temporarily closed now → each its own sentence', () => {
    const sentence = (name: string) => {
      const result = compare(EVIDENCE[name]!);
      return result.comparable && result.changed ? result.observation.summary : null;
    };
    expect(sentence('closed_on_date')).toBe('National Museum on day 2 is now closed on that date; it was open at the planned time when the plan was built.');
    expect(sentence('closed_permanently')).toBe('National Museum on day 2 is now listed as permanently closed; it was open at the planned time when the plan was built.');
    expect(sentence('closed_temporarily_now')).toBe('National Museum on day 2 is now listed as temporarily closed right now; it was open at the planned time when the plan was built.');
  });

  it('a visit the reconciler already moved to opening time, read fresh as open → no observation', () => {
    expect(compare(EVIDENCE.unchanged_regular!, 'opens_later')).toEqual({ comparable: true, changed: false, before: 'opens_later', after: 'open_at_time' });
    expect(compare(EVIDENCE.unchanged_regular!, 'closes_earlier')).toEqual({ comparable: true, changed: false, before: 'closes_earlier', after: 'open_at_time' });
  });

  it('provider failure → not comparable, never "closed"; so is no evidence at all, and a visit with no earlier reading', () => {
    expect(compare(EVIDENCE.provider_failure!)).toEqual({ comparable: false, reason: 'source_unavailable' });
    expect(compare(null)).toEqual({ comparable: false, reason: 'source_unavailable' });
    const { day } = visit();
    expect(compareHours({ item: { id: 'x', title: 'X', startMinute: 600, endMinute: 660 }, day, evidence: EVIDENCE.closed_permanently!, placeClass: 'business_venue', now: NOW, observedAt: OBSERVED_AT, factId: 'fact:hours:x', factKind: 'hours' })).toEqual({ comparable: false, reason: 'no_previous_reading' });
  });

  it('a place hours do not apply to is never "changed" by a reading that carries hours', () => {
    const result = compare(EVIDENCE.closes_earlier!, 'open_at_time', 'open_ground');
    expect(result).toEqual({ comparable: true, changed: false, before: 'open_at_time', after: 'not_applicable' });
  });
});

describe('the forecast comparison rule, on recorded readings', () => {
  const day = { dayNumber: 2, date: '2026-09-22', weather: { evidence: 'forecast', summary: 'Clear, 18 °C', condition: 'clear', temperatureMaxC: 18, temperatureMinC: 8, precipitationProbabilityPercent: 10, precipitationMm: 0, decisions: [], cautions: [], backups: [], provider: 'fixture', attribution: 'fixture', fetchedAt: '2026-09-01T06:00:00.000Z', staleAfterMinutes: 360 } } as unknown as ItineraryDay;

  it('dry → wet is a change, and says when the rain falls', () => {
    const before = structuredClone(day);
    const result = compareForecast(day, READINGS.dry_to_wet);
    expect(day).toEqual(before);
    expect(result?.changed).toBe(true);
    expect(result?.summary).toBe('Day 2 now expects rain in the afternoon (80% chance); it was dry when the plan was built.');
    expect(result?.previous).toBe('Clear, 18 °C');
    expect(result?.current).toBe('rain, 9–17 °C, 80% chance of rain');
  });

  it('a high that moves by more than five degrees is a change', () => {
    const result = compareForecast(day, READINGS.warmer_by_six);
    expect(result?.changed).toBe(true);
    expect(result?.summary).toBe('Day 2 now expects a high of 24 °C; the plan was built against 18 °C.');
  });
});

/* ------------------------------------------------------------------------------------------------ */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-recheck-hours-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  delete process.env.SIDEQUEST_WEATHER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

const RECHECK_NOW = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

/** The stop the recheck will ask about: the first placed activity of the plan, given a stored reading and a provider identity. */
const STOP = (() => {
  const day = PLAN.days[0]!;
  const item = day.items.find((i) => i.kind === 'activity' && i.placeId)!;
  return { day, item };
})();

/** Evidence recorded against the stored plan's own visit: the same window either side of it, or one that closes fifteen minutes in. */
function evidenceFor(shape: 'unchanged' | 'closes_earlier'): OperationalEvidence {
  const weekday = new Date(`${STOP.day.date}T12:00:00Z`).getUTCDay();
  return {
    ...EVIDENCE.unchanged_regular!,
    weekly: [{ day: weekday, openMinute: Math.max(0, STOP.item.startMinute - 60), closeMinute: shape === 'unchanged' ? STOP.item.endMinute + 60 : STOP.item.startMinute + 15 }],
  };
}

async function seedTrip(): Promise<string> {
  const { createTrip, saveItinerary } = await import('@/lib/db/repository');
  const trip = createTrip(AUGUST_BASICS, 'owner-browser');
  const days = PLAN.days.map((day) => (day.dayNumber !== STOP.day.dayNumber ? day : { ...day, items: day.items.map((item) => (item.id !== STOP.item.id ? item : { ...item, operational: planned('open_at_time') })) }));
  const itinerary: Itinerary = {
    ...PLAN,
    tripId: trip.id,
    days,
    package: {
      source: 'model_draft',
      draftVersion: 1,
      archetype: 'single_base_urban',
      purpose: 'A fixture plan for the hours recheck.',
      routeRationale: 'One base for four days.',
      assumptions: [],
      tradeoffs: [],
      bases: [{ id: PLAN.baseId, name: 'Mammoth Lakes', nights: 3, why: 'Central to everything.', verification: 'verified', coordinates: { lat: 37.6485, lng: -118.9721 } }],
      foodStrategy: [],
      transport: { summary: 'By car.', notes: [] },
      beforeYouGo: [],
      packing: [],
      backups: [],
      omissions: [],
      unresolved: [],
      anchors: [
        {
          id: STOP.item.id,
          dayNumber: STOP.day.dayNumber,
          name: STOP.item.title,
          role: 'core',
          category: 'museum',
          disposition: 'preserved',
          verification: 'verified',
          anchorKind: 'named_place',
          placeId: STOP.item.placeId,
          identity: { method: 'places', provider: 'google-places', providerRef: 'places/fixture-museum', coordinates: { lat: 37.6485, lng: -118.9721 }, placeClass: 'business_venue' },
        },
      ],
      verification: { anchors: 1, verified: 1, partiallyVerified: 0, unverified: 0, scheduled: 1, rejected: 0, legsMeasured: 0, legsUnmeasured: 0, deadlineReached: false, providerNotes: [] },
      bookingPriorities: [],
    } as unknown as Itinerary['package'],
  };
  saveItinerary(itinerary);
  return trip.id;
}

async function runWith(seam: OperationalEvidenceSeam) {
  const tripId = await seedTrip();
  const { recheckStaleFacts } = await import('./recheck');
  const { listObservations } = await import('@/lib/db/execution-repository');
  const { getItinerary } = await import('@/lib/db/repository');
  const before = JSON.stringify(getItinerary(tripId));
  const outcome = await recheckStaleFacts(tripId, { now: RECHECK_NOW, fetchWeather: async () => null, seam });
  expect(outcome.ran).toBe(true);
  if (!outcome.ran) throw new Error('did not run');
  /* The plan is never edited by a recheck, whatever it saw. */
  expect(JSON.stringify(getItinerary(tripId))).toBe(before);
  return { outcome, stored: listObservations(tripId) };
}

describe('recheckStaleFacts with the operational seam injected (zero providers)', () => {
  it('asks the seam once for the stop with a reading, and writes nothing when the hours are unchanged', async () => {
    const asked: { placeId: string; providerRef?: string }[] = [];
    const { outcome, stored } = await runWith(async (input) => {
      asked.push({ placeId: input.placeId, ...(input.providerRef ? { providerRef: input.providerRef } : {}) });
      return evidenceFor('unchanged');
    });
    expect(asked).toEqual([{ placeId: STOP.item.placeId, providerRef: 'places/fixture-museum' }]);
    expect(outcome.counts.hoursRequests).toBe(1);
    expect(outcome.counts.changed).toBe(0);
    expect(outcome.observations).toEqual([]);
    expect(stored).toEqual([]);
  });

  it('writes one observation, in the traveller sentence, when the venue now closes before the visit ends', async () => {
    const { outcome, stored } = await runWith(async () => evidenceFor('closes_earlier'));
    expect(outcome.counts.hoursRequests).toBe(1);
    expect(outcome.counts.changed).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      factId: `fact:hours:${STOP.item.id}`,
      kind: 'hours',
      previous: 'open_at_time',
      current: 'closes_earlier',
      changed: true,
      dayNumbers: [STOP.day.dayNumber],
      summary: `${STOP.item.title} on day ${STOP.day.dayNumber} is now closing before the planned visit ends; it was open at the planned time when the plan was built.`,
      acknowledgedAt: null,
    });
  });

  it('a source that did not answer writes nothing and is counted as not comparable — never as closed', async () => {
    const failed = await runWith(async () => EVIDENCE.provider_failure!);
    expect(failed.outcome.counts.hoursRequests).toBe(1);
    expect(failed.outcome.counts.changed).toBe(0);
    expect(failed.outcome.counts.notComparable).toBeGreaterThanOrEqual(1);
    expect(failed.stored).toEqual([]);

    const threw = await runWith(async () => {
      throw new Error('socket hang up');
    });
    expect(threw.outcome.counts.changed).toBe(0);
    expect(threw.stored).toEqual([]);
  });
});
