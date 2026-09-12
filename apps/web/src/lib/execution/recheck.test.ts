import { mkdtempSync, rmSync } from 'node:fs';
import { hoursChangeIsReal } from './recheck';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import type { DayWeather, Itinerary, ItineraryDay, WeatherCondition } from '@sidequest/core';
import { AUGUST_BASICS, FIXED_NOW, buildScenario } from '../../../../../packages/planner/src/testing/scenario';
import type { RecheckDeps } from './recheck';

/**
 * V9 §9 — THE RECHECK RE-READS, WRITES DOWN, AND NEVER EDITS.
 *
 * Everything here runs on the offline fixture weather, which is a function of
 * the date: asked again, it answers exactly what the plan was built against,
 * so an honest recheck finds nothing changed. `SIDEQUEST_FIXTURE_WEATHER_SHIFT`
 * — honoured only with the fixture composer and fixture weather — reads the
 * answer for a day later, which walks the four-step cycle and is the one way
 * an offline test sees a change. The comparison rule (wet/dry, ±5 °C on the
 * high) is tested on its own first, against hand-written readings.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-recheck-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
  delete process.env.SIDEQUEST_FIXTURE_WEATHER_SHIFT;
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  delete process.env.SIDEQUEST_WEATHER_PROVIDER;
  delete process.env.SIDEQUEST_FIXTURE_WEATHER_SHIFT;
  rmSync(dir, { recursive: true, force: true });
});

/** Two days after the plan was built: inside the forecast horizon, past the forecast's own staleness. */
const RECHECK_NOW = new Date(FIXED_NOW.getTime() + 2 * 86_400_000);

/** The three forecast days of the fixture plan; the fourth sits past the horizon and is a climate pattern. */
const FORECAST_DAYS = 3;

/**
 * The weather seam on the test's own clock. The production seam
 * (`fetchWeatherSnapshot`) reads the wall clock to decide which dates are
 * forecasts, so a plan dated 2026 is a climate pattern by the time this file
 * runs; the same provider, asked at the plan's own instant, answers with the
 * forecast the plan was built against. Everything after the fetch — the
 * fixture shift, the point matching, the comparison, the persistence — is the
 * production code.
 */
const onTheTestClock: RecheckDeps['fetchWeather'] = async (target) => {
  const { resolveTripWeather } = await import('@/lib/weather/index');
  return resolveTripWeather({ regionId: target.regionId, dates: [...target.dates], locations: target.locations, now: RECHECK_NOW });
};

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

function forecastReading(day: ItineraryDay, overrides: Partial<Extract<DayWeather, { kind: 'forecast' }>> = {}): DayWeather {
  return {
    kind: 'forecast',
    locationId: day.weather.locationId ?? 'x',
    date: day.date,
    condition: 'clear',
    temperatureMaxC: day.weather.temperatureMaxC ?? 20,
    temperatureMinC: day.weather.temperatureMinC ?? 8,
    precipitationProbabilityPercent: 5,
    precipitationMm: 0,
    snowfallCm: 0,
    windSpeedMaxKph: 10,
    windGustMaxKph: 20,
    cloudCoverMeanPercent: 10,
    hours: [],
    fetchedAt: RECHECK_NOW.toISOString(),
    staleAfterMinutes: 360,
    attribution: { provider: 'test', notice: 'test', url: 'https://example.invalid', dataset: 'test' },
    ...overrides,
  } as DayWeather;
}

async function seedTrip(): Promise<string> {
  const { createTrip, saveItinerary } = await import('@/lib/db/repository');
  const trip = createTrip(AUGUST_BASICS, 'owner-browser');
  const itinerary: Itinerary = {
    ...PLAN,
    tripId: trip.id,
    package: {
      source: 'model_draft',
      draftVersion: 1,
      archetype: 'single_base_urban',
      purpose: 'A fixture plan for the recheck.',
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
      anchors: [],
      verification: { anchors: 0, verified: 0, partiallyVerified: 0, unverified: 0, scheduled: 0, rejected: 0, legsMeasured: 0, legsUnmeasured: 0, deadlineReached: false, providerNotes: [] },
      bookingPriorities: [],
    } as unknown as Itinerary['package'],
  };
  saveItinerary(itinerary);
  return trip.id;
}

describe('the forecast comparison rule', () => {
  it('is null when the plan or the fresh reading is not a forecast — unknown is never a change', async () => {
    const { compareForecast } = await import('./recheck');
    const day = PLAN.days[0]!;
    expect(day.weather.evidence).toBe('forecast');
    expect(compareForecast(day, undefined)).toBeNull();
    expect(compareForecast(day, { ...forecastReading(day), kind: 'unavailable', reason: 'provider_error', message: 'x', attemptedProvider: 'x', attemptedAt: 'x', consideredCache: false } as unknown as DayWeather)).toBeNull();
    expect(compareForecast({ ...day, weather: { ...day.weather, evidence: 'historical_pattern' } }, forecastReading(day))).toBeNull();
  });

  it('calls a day changed when it crosses from dry to wet, and says when the rain falls', async () => {
    const { compareForecast } = await import('./recheck');
    const dry = PLAN.days.find((d) => (d.weather.precipitationProbabilityPercent ?? 0) < 50 && !/rain|storm/i.test(d.weather.condition ?? ''))!;
    expect(dry).toBeDefined();
    const wet = compareForecast(
      dry,
      forecastReading(dry, {
        condition: 'rain',
        precipitationProbabilityPercent: 76,
        precipitationMm: 7,
        hours: Array.from({ length: 24 }, (_, hour) => ({ startMinute: hour * 60, condition: 'rain', temperatureC: 15, precipitationProbabilityPercent: 70, precipitationMm: hour >= 13 && hour <= 17 ? 1.4 : 0, snowfallCm: 0, windSpeedKph: 10, windGustKph: 20, cloudCoverPercent: 90, visibilityMetres: 6000 })),
      }),
    );
    expect(wet?.changed).toBe(true);
    expect(wet?.summary).toBe(`Day ${dry.dayNumber} now expects rain in the afternoon (76% chance); it was dry when the plan was built.`);
  });

  it('calls a day changed when the high moves by more than five degrees, and not for less', async () => {
    const { compareForecast, TEMPERATURE_BAND_C } = await import('./recheck');
    const day = PLAN.days[0]!;
    const previousMax = day.weather.temperatureMaxC!;
    const stillDry = { condition: (day.weather.condition?.toLowerCase().replace(/ /g, '_') ?? 'clear') as WeatherCondition, precipitationProbabilityPercent: day.weather.precipitationProbabilityPercent };
    const small = compareForecast(day, forecastReading(day, { ...stillDry, temperatureMaxC: previousMax + TEMPERATURE_BAND_C }));
    expect(small?.changed).toBe(false);
    expect(small?.summary).toContain('still matches the plan');
    const large = compareForecast(day, forecastReading(day, { ...stillDry, temperatureMaxC: previousMax + TEMPERATURE_BAND_C + 1 }));
    expect(large?.changed).toBe(true);
    expect(large?.summary).toContain(`now expects a high of ${Math.round(previousMax + TEMPERATURE_BAND_C + 1)} °C`);
  });
});

describe('the fixture shift switch', () => {
  it('is off unless both the composer and the weather are the offline fixture', async () => {
    const { fixtureWeatherShiftDays } = await import('./recheck');
    expect(fixtureWeatherShiftDays({ SIDEQUEST_FIXTURE_WEATHER_SHIFT: '1' })).toBe(0);
    expect(fixtureWeatherShiftDays({ SIDEQUEST_FIXTURE_WEATHER_SHIFT: '1', SIDEQUEST_COMPOSER_PROVIDER: 'fixture' })).toBe(0);
    expect(fixtureWeatherShiftDays({ SIDEQUEST_FIXTURE_WEATHER_SHIFT: '1', SIDEQUEST_WEATHER_PROVIDER: 'fixture' })).toBe(0);
    expect(fixtureWeatherShiftDays({ SIDEQUEST_FIXTURE_WEATHER_SHIFT: '1', SIDEQUEST_COMPOSER_PROVIDER: 'fixture', SIDEQUEST_WEATHER_PROVIDER: 'fixture' })).toBe(1);
    expect(fixtureWeatherShiftDays({ SIDEQUEST_FIXTURE_WEATHER_SHIFT: '40', SIDEQUEST_COMPOSER_PROVIDER: 'fixture', SIDEQUEST_WEATHER_PROVIDER: 'fixture' })).toBe(7);
  });
});

describe('rechecking a stored plan against the fixture weather', () => {
  it('asks once, finds nothing changed when the sky is the same, and records the check', async () => {
    const tripId = await seedTrip();
    const { recheckStaleFacts } = await import('./recheck');
    const { lastFactCheck, listObservations } = await import('@/lib/db/execution-repository');
    const { getItinerary } = await import('@/lib/db/repository');
    const before = JSON.stringify(getItinerary(tripId));

    const outcome = await recheckStaleFacts(tripId, { now: RECHECK_NOW, fetchWeather: onTheTestClock });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.counts.weatherRequests).toBe(1);
    /* Three forecast days are due; a stop with hours on record is due too, and with no operational source configured it is counted as not comparable, never as changed. */
    expect(outcome.counts.due).toBeGreaterThanOrEqual(FORECAST_DAYS);
    expect(outcome.counts.checked).toBe(FORECAST_DAYS);
    expect(outcome.counts.hoursRequests).toBe(0);
    expect(outcome.counts.notComparable).toBe(outcome.counts.due - FORECAST_DAYS);
    expect(outcome.counts.changed).toBe(0);
    expect(outcome.observations).toEqual([]);
    expect(listObservations(tripId)).toEqual([]);
    expect(lastFactCheck(tripId)?.checkedAt).toBe(RECHECK_NOW.toISOString());
    /* The plan is never edited. */
    expect(JSON.stringify(getItinerary(tripId))).toBe(before);
  });

  it('is throttled: a second ask inside six hours is skipped as recent', async () => {
    const tripId = await seedTrip();
    const { recheckStaleFacts } = await import('./recheck');
    await recheckStaleFacts(tripId, { now: RECHECK_NOW, fetchWeather: onTheTestClock });
    const again = await recheckStaleFacts(tripId, { now: new Date(RECHECK_NOW.getTime() + 5 * 3_600_000), fetchWeather: onTheTestClock });
    expect(again).toEqual({ ran: false, skipped: 'recent', lastCheckedAt: RECHECK_NOW.toISOString() });
    const later = await recheckStaleFacts(tripId, { now: new Date(RECHECK_NOW.getTime() + 7 * 3_600_000), fetchWeather: onTheTestClock });
    expect(later.ran).toBe(true);
  });

  it('writes one observation per changed day, in a sentence, when the fixture is shifted', async () => {
    process.env.SIDEQUEST_FIXTURE_WEATHER_SHIFT = '1';
    const tripId = await seedTrip();
    const { recheckStaleFacts } = await import('./recheck');
    const { listObservations } = await import('@/lib/db/execution-repository');
    const { getItinerary } = await import('@/lib/db/repository');
    const before = JSON.stringify(getItinerary(tripId));

    const outcome = await recheckStaleFacts(tripId, { now: RECHECK_NOW, fetchWeather: onTheTestClock });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.counts.weatherRequests).toBe(1);
    /* Shifted one day, the fixture's clear → partly cloudy → rain cycle turns day 2 wet; day 1 stays dry and day 3 stays wet. */
    expect(outcome.counts.changed).toBe(1);
    expect(outcome.observations[0]?.summary).toBe('Day 2 now expects rain in the afternoon (76% chance); it was dry when the plan was built.');
    const stored = listObservations(tripId);
    expect(stored.length).toBe(outcome.counts.changed);
    for (const observation of stored) {
      expect(observation.kind).toBe('forecast');
      expect(observation.changed).toBe(true);
      expect(observation.dayNumbers).toHaveLength(1);
      expect(observation.summary).toMatch(/^Day \d+ now /);
      expect(observation.summary).toMatch(/when the plan was built\.|the plan was built against/);
      expect(observation.acknowledgedAt).toBeNull();
    }
    expect(JSON.stringify(getItinerary(tripId))).toBe(before);

    /* The same change observed again after the window is not written twice while it stands unacknowledged. */
    const again = await recheckStaleFacts(tripId, { now: new Date(RECHECK_NOW.getTime() + 7 * 3_600_000), fetchWeather: onTheTestClock });
    expect(again.ran).toBe(true);
    expect(listObservations(tripId).length).toBe(stored.length);
  });

  it('says nothing when the weather source does not answer', async () => {
    const tripId = await seedTrip();
    const { recheckStaleFacts } = await import('./recheck');
    const { listObservations } = await import('@/lib/db/execution-repository');
    const outcome = await recheckStaleFacts(tripId, { now: RECHECK_NOW, fetchWeather: async () => null });
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    expect(outcome.counts.changed).toBe(0);
    expect(outcome.counts.notComparable).toBe(outcome.counts.due);
    expect(listObservations(tripId)).toEqual([]);
  });

  it('skips a trip with no plan and a trip that does not exist', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const { recheckStaleFacts } = await import('./recheck');
    const bare = createTrip(AUGUST_BASICS, 'owner-browser').id;
    expect(await recheckStaleFacts(bare, { now: RECHECK_NOW })).toEqual({ ran: false, skipped: 'no_plan', lastCheckedAt: null });
    expect(await recheckStaleFacts('e2a2f2ce-0000-4000-8000-000000000000', { now: RECHECK_NOW })).toEqual({ ran: false, skipped: 'no_trip', lastCheckedAt: null });
  });
});

describe('what counts as an hours change', () => {
  it('a visit the reconciler already moved to opening time is not "changed" when it now reads open', () => {
    expect(hoursChangeIsReal('opens_later', 'open_at_time')).toBe(false);
    expect(hoursChangeIsReal('closes_earlier', 'open_at_time')).toBe(false);
    expect(hoursChangeIsReal('open_at_time', 'open_at_time')).toBe(false);
  });
  it('a closure, or a visit that was open and now is not, is a change; an unknown reading never is', () => {
    expect(hoursChangeIsReal('open_at_time', 'closed_on_date')).toBe(true);
    expect(hoursChangeIsReal('open_at_time', 'opens_later')).toBe(true);
    expect(hoursChangeIsReal('opens_later', 'closed_permanently')).toBe(true);
    expect(hoursChangeIsReal('open_at_time', 'hours_unknown')).toBe(false);
  });
});
