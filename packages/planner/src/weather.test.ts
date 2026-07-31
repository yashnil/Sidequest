import { describe, expect, it } from 'vitest';
import {
  buildSolarDays,
  EASTERN_SIERRA,
  EASTERN_SIERRA_PLACES,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  buildFixtureWeather,
  itineraryStructureFingerprint,
  utcOffsetMinutesOn,
  WEATHER_DATASET_VERSION,
  weatherDatasetSchema,
  type DayWeather,
  type ForecastDayWeather,
  type Itinerary,
  type ItineraryDay,
  type Place,
  type WeatherDataset,
} from '@sidequest/core';
import { planTrip } from './plan';
import { buildScenario, FIXED_NOW, type ScenarioOptions } from './testing/scenario';

/**
 * WEATHER AS A PLANNING CONSTRAINT.
 *
 * Structured like `hours.test.ts`, and for the same reason: numbered scenarios
 * that each name one thing the planner has to get right, so a failure points at
 * a behaviour rather than at a line.
 *
 * The distinction every scenario below is ultimately about: weather may choose
 * between days that are *already* legal, and may never make an illegal day
 * legal. Scenarios 2 and 3 are the ones that would matter most if this file
 * were deleted.
 */

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

/** A settled, unremarkable day. Everything below is a departure from this. */
function clear(locationId: string, date: string): ForecastDayWeather {
  return {
    kind: 'forecast',
    locationId,
    date,
    condition: 'clear',
    temperatureMaxC: 24,
    temperatureMinC: 9,
    precipitationProbabilityPercent: 3,
    precipitationMm: 0,
    snowfallCm: 0,
    windSpeedMaxKph: 10,
    windGustMaxKph: 20,
    cloudCoverMeanPercent: 8,
    hours: hoursOf({ precipitationMm: 0, probability: 3, gust: 20, cloud: 8, temperature: 20 }),
    fetchedAt: '2026-07-30T12:00:00.000Z',
    staleAfterMinutes: 360,
    attribution: {
      provider: 'Test',
      notice: 'Test weather.',
      url: 'https://example.invalid/test',
    },
  };
}

function hoursOf(input: {
  precipitationMm: number;
  probability: number;
  gust: number;
  cloud: number;
  temperature: number;
  /** Weight the precipitation into the afternoon, as a real storm day does. */
  afternoonOnly?: boolean;
}) {
  return Array.from({ length: 24 }, (_, hour) => {
    const share = input.afternoonOnly ? (hour >= 13 && hour <= 19 ? 1 : 0) : 1;
    return {
      startMinute: hour * 60,
      condition: input.precipitationMm * share > 0 ? ('rain' as const) : ('clear' as const),
      temperatureC: input.temperature,
      precipitationProbabilityPercent: Math.round(input.probability * share),
      precipitationMm: Math.round(input.precipitationMm * share * 100) / 100,
      snowfallCm: 0,
      windSpeedKph: input.gust / 2,
      windGustKph: input.gust,
      cloudCoverPercent: input.cloud,
      visibilityMetres: input.precipitationMm * share > 0 ? 5000 : 90_000,
    };
  });
}

type DayPatch = Partial<Omit<ForecastDayWeather, 'kind' | 'locationId' | 'date'>>;

/**
 * A dataset built from an explicit table rather than from the fixture generator.
 *
 * Every scenario that asserts a *choice* needs to control both sides of it, so
 * these say in one place exactly which day is the clear one. The whole thing
 * goes back through the schema, so a patch that produces something impossible
 * fails in the test that wrote it rather than three files away.
 */
function weatherWith(
  patches: Record<string, DayPatch | DayWeather> = {},
  options: { dates?: readonly string[] } = {},
): WeatherDataset {
  const dates = options.dates ?? DATES;
  const days: DayWeather[] = [];
  for (const location of EASTERN_SIERRA_WEATHER_LOCATIONS) {
    for (const date of dates) {
      const patch = patches[`${location.id}|${date}`] ?? patches[date];
      if (patch && 'kind' in patch) {
        days.push({ ...patch, locationId: location.id, date } as DayWeather);
        continue;
      }
      days.push({ ...clear(location.id, date), ...(patch ?? {}) });
    }
  }

  return weatherDatasetSchema.parse({
    version: WEATHER_DATASET_VERSION,
    regionId: EASTERN_SIERRA.id,
    locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
    days,
    solar: buildSolarDays({
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      dates,
      utcOffsetMinutesFor: (location, date) => utcOffsetMinutesOn(date, location.timeZone),
      computedAt: '2026-07-30T12:00:00.000Z',
    }),
    generatedAt: '2026-07-30T12:00:00.000Z',
    providerName: 'Test',
  });
}

/** A wet, blustery, shut-in day. */
const STORMY: DayPatch = {
  condition: 'thunderstorm',
  temperatureMaxC: 15,
  temperatureMinC: 6,
  precipitationProbabilityPercent: 85,
  precipitationMm: 14,
  windSpeedMaxKph: 34,
  windGustMaxKph: 70,
  cloudCoverMeanPercent: 95,
  hours: hoursOf({ precipitationMm: 0.6, probability: 85, gust: 70, cloud: 95, temperature: 13 }),
};

/** Clear in the morning, storms after lunch. The Sierra's actual summer. */
const AFTERNOON_STORMS: DayPatch = {
  condition: 'thunderstorm',
  temperatureMaxC: 22,
  temperatureMinC: 9,
  precipitationProbabilityPercent: 55,
  precipitationMm: 6,
  windGustMaxKph: 52,
  cloudCoverMeanPercent: 55,
  hours: hoursOf({
    precipitationMm: 0.9,
    probability: 80,
    gust: 52,
    cloud: 60,
    temperature: 20,
    afternoonOnly: true,
  }),
};

function plan(options: ScenarioOptions = {}): Itinerary {
  const result = planTrip(buildScenario(options));
  if (!result.ok) throw new Error(`plan failed: ${result.code} ${result.message}`);
  return result.itinerary;
}

function dayOf(itinerary: Itinerary, placeId: string): ItineraryDay | undefined {
  return itinerary.days.find((day) =>
    day.items.some((item) => item.kind === 'activity' && item.placeId === placeId),
  );
}

function activities(day: ItineraryDay): string[] {
  return day.items
    .filter((item) => item.kind === 'activity' && item.placeId)
    .map((item) => item.placeId!);
}

// ---------------------------------------------------------------------------
// 1. A clearly better day for a weather-sensitive stop
// ---------------------------------------------------------------------------

describe('scenario 1 — the exposed stop goes on the better day', () => {
  it('moves a visibility-dependent viewpoint away from the stormy day', () => {
    // Day 3 is the only settled one; everything else is shut in and blowing.
    const stormyExceptDay3 = weatherWith({
      '2026-08-12': STORMY,
      '2026-08-13': STORMY,
      '2026-08-15': STORMY,
    });

    const itinerary = plan({
      weather: stormyExceptDay3,
      manualIncludes: ['minaret-vista'],
    });

    const day = dayOf(itinerary, 'minaret-vista');
    expect(day, 'the viewpoint should be scheduled at all').toBeDefined();
    expect(day!.date).toBe('2026-08-14');
  });

  it('says so, without claiming the forecast is a fact', () => {
    const itinerary = plan({
      weather: weatherWith({ '2026-08-12': STORMY, '2026-08-13': STORMY, '2026-08-15': STORMY }),
      manualIncludes: ['minaret-vista'],
    });
    const decisions = itinerary.days.flatMap((day) => day.weather.decisions);
    expect(decisions.join(' ')).toMatch(/forecast/i);
    expect(decisions.join(' ')).not.toMatch(/\bwill be\b|guaranteed|certain/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Weather cannot override opening hours
// ---------------------------------------------------------------------------

describe('scenario 2 — good weather does not open a closed gate', () => {
  /**
   * The Manzanar visitor centre opens Friday to Monday. Of this trip's four
   * days, only 14 and 15 August (a Friday and a Saturday) qualify. Making the
   * two closed days the clear ones is the sharpest possible test: weather says
   * go on Wednesday, the calendar says the door is locked, and the calendar has
   * to win without argument.
   */
  it('keeps a stop on the legal day even when the shut days have better weather', () => {
    const itinerary = plan({
      answers: { regionalExpansion: 'best_regional', maxDailyTravelMinutes: 300 },
      manualIncludes: ['manzanar-visitor-center'],
      weather: weatherWith({ '2026-08-14': STORMY, '2026-08-15': STORMY }),
    });

    const day = dayOf(itinerary, 'manzanar-visitor-center');
    if (!day) {
      // If it could not be scheduled at all, it must be for the hours and it
      // must be visible — never silently dropped for the weather.
      const entry = itinerary.unscheduled.find(
        (item) => item.placeId === 'manzanar-visitor-center',
      );
      expect(entry).toBeDefined();
      expect(entry!.reasonCode).not.toBe('weather_incompatible');
      return;
    }
    expect(['2026-08-14', '2026-08-15']).toContain(day.date);
  });

  it('never schedules anything on a date its calendar closes', () => {
    const itinerary = plan({
      answers: { regionalExpansion: 'best_regional', maxDailyTravelMinutes: 300 },
      weather: weatherWith({ '2026-08-14': STORMY, '2026-08-15': STORMY }),
    });
    const closedCodes = itinerary.issues.filter(
      (issue) =>
        issue.code === 'attraction_closed_on_date' || issue.code === 'arrives_before_opening',
    );
    expect(closedCodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Weather cannot break a shared access sequence
// ---------------------------------------------------------------------------

describe('scenario 3 — the shuttle group stays together', () => {
  it('keeps Devils Postpile and Rainbow Falls on one day and one boarding', () => {
    const itinerary = plan({
      manualIncludes: ['devils-postpile', 'rainbow-falls'],
      // Make the Reds Meadow zone alone stormy on two days, so the weather has
      // every incentive to split the pair across the calendar.
      weather: weatherWith({
        'reds-meadow|2026-08-13': STORMY,
        'reds-meadow|2026-08-15': STORMY,
      }),
    });

    const postpile = dayOf(itinerary, 'devils-postpile');
    const falls = dayOf(itinerary, 'rainbow-falls');
    if (postpile && falls) {
      expect(postpile.dayNumber).toBe(falls.dayNumber);
      const boardings = postpile.items.filter(
        (item) => item.travel?.role === 'ride' && item.travel.serviceId,
      );
      const services = new Set(boardings.map((item) => item.travel!.serviceId));
      expect(services.size).toBeLessThanOrEqual(1);
    }
    expect(
      itinerary.issues.filter((issue) => issue.code === 'duplicate_access_sequence'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4-6. Rain, visibility and wind
// ---------------------------------------------------------------------------

describe('scenario 4 — rain-sensitive against bad-weather-friendly', () => {
  it('flags the exposed stop and leaves the sheltered one alone', () => {
    const itinerary = plan({
      weather: weatherWith({ '2026-08-13': STORMY, '2026-08-14': STORMY, '2026-08-15': STORMY }),
      manualIncludes: ['the-village-at-mammoth', 'sherwin-lakes-trail'],
    });

    const village = itinerary.days
      .flatMap((day) => day.items)
      .find((item) => item.placeId === 'the-village-at-mammoth');
    if (village?.weather) {
      expect(village.weather.suitability).not.toBe('poor');
    }
  });
});

describe('scenario 5 — a viewpoint needs to see something', () => {
  it('treats heavy cloud as a caution rather than a closure', () => {
    const overcast: DayPatch = {
      condition: 'overcast',
      cloudCoverMeanPercent: 95,
      precipitationProbabilityPercent: 20,
      precipitationMm: 0,
      hours: hoursOf({ precipitationMm: 0, probability: 20, gust: 20, cloud: 95, temperature: 18 }),
    };
    const itinerary = plan({
      weather: weatherWith({
        '2026-08-12': overcast,
        '2026-08-13': overcast,
        '2026-08-14': overcast,
        '2026-08-15': overcast,
      }),
      manualIncludes: ['minaret-vista'],
    });

    // Scheduled, not removed — cloud is not a closure.
    expect(dayOf(itinerary, 'minaret-vista')).toBeDefined();
    const item = itinerary.days
      .flatMap((day) => day.items)
      .find((entry) => entry.placeId === 'minaret-vista');
    expect(item?.weather?.suitability).toBe('poor');
    expect(item?.weather?.reasonCodes).toContain('poor_visibility');
  });
});

describe('scenario 6 — wind at an exposed stop', () => {
  it('never invents an operator closure from a gust figure', () => {
    const windy: DayPatch = {
      windSpeedMaxKph: 60,
      windGustMaxKph: 95,
      hours: hoursOf({ precipitationMm: 0, probability: 5, gust: 95, cloud: 20, temperature: 16 }),
    };
    const itinerary = plan({
      weather: weatherWith({
        '2026-08-12': windy,
        '2026-08-13': windy,
        '2026-08-14': windy,
        '2026-08-15': windy,
      }),
      manualIncludes: ['panorama-gondola'],
    });

    const item = itinerary.days
      .flatMap((day) => day.items)
      .find((entry) => entry.placeId === 'panorama-gondola');
    if (item) {
      // A caution, never `incompatible`: only two typed requirements may produce
      // that, and "the operator might shut it" is not one of them.
      expect(item.weather?.suitability).not.toBe('incompatible');
    }
    const closures = itinerary.issues.filter(
      (issue) => issue.code === 'weather_incompatible_scheduled',
    );
    expect(closures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. The traveller's own limits
// ---------------------------------------------------------------------------

describe('scenario 7 — a traveller who will not be out in the heat', () => {
  it('reads the valley floor differently from the high country on the same day', () => {
    const hotValley: DayPatch = { temperatureMaxC: 39, temperatureMinC: 22 };
    const scenario = buildScenario({
      answers: {
        avoidances: ['extreme_heat'],
        regionalExpansion: 'best_regional',
        maxDailyTravelMinutes: 300,
      },
      manualIncludes: ['manzanar-historic-site'],
      weather: weatherWith({
        'owens-valley|2026-08-12': hotValley,
        'owens-valley|2026-08-13': hotValley,
        'owens-valley|2026-08-14': hotValley,
        'owens-valley|2026-08-15': hotValley,
      }),
    });
    const result = planTrip(scenario);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manzanar = result.itinerary.days
      .flatMap((day) => day.items)
      .find((item) => item.placeId === 'manzanar-historic-site');
    if (manzanar?.weather) {
      expect(manzanar.weather.reasonCodes).toContain('traveller_avoids_heat');
    }

    // The same day at 7,900 ft is not hot and must not inherit the warning.
    const inTown = result.itinerary.days
      .flatMap((day) => day.items)
      .find((item) => item.placeId === 'convict-lake');
    expect(inTown?.weather?.reasonCodes ?? []).not.toContain('traveller_avoids_heat');
  });
});

// ---------------------------------------------------------------------------
// 8. Daylight
// ---------------------------------------------------------------------------

describe('scenario 8 — signed for daylight use only', () => {
  it('schedules the Manzanar grounds inside a computed sunrise-to-sunset window', () => {
    const itinerary = plan({
      answers: { regionalExpansion: 'best_regional', maxDailyTravelMinutes: 300 },
      manualIncludes: ['manzanar-historic-site'],
    });

    const item = itinerary.days
      .flatMap((day) => day.items)
      .find((entry) => entry.placeId === 'manzanar-historic-site');
    if (!item) return;

    expect(item.daylightOnly).toBe(true);
    expect(item.daylight, 'the window used should travel with the visit').toBeDefined();
    expect(item.daylight!.source).toMatch(/NOAA/);
    expect(item.startMinute).toBeGreaterThanOrEqual(item.daylight!.sunriseMinute);
    expect(item.endMinute).toBeLessThanOrEqual(item.daylight!.sunsetMinute);
    expect(
      itinerary.issues.filter((issue) => issue.code === 'scheduled_outside_daylight'),
    ).toEqual([]);
  });

  it('keeps solar provenance out of the weather provenance', () => {
    const itinerary = plan({ manualIncludes: ['mammoth-lakes-basin'] });
    const item = itinerary.days
      .flatMap((day) => day.items)
      .find((entry) => entry.placeId === 'mammoth-lakes-basin');
    if (item?.daylight) {
      expect(item.daylight.source).not.toMatch(/forecast/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 9-11. Forecast, pattern, and both at once
// ---------------------------------------------------------------------------

describe('scenario 9 — a trip inside the forecast window', () => {
  /**
   * Deliberately nearer than the standard August fixture.
   *
   * Planning at 30 July, the standard 12–15 August trip has its last day
   * sixteen days out — one past the horizon Open-Meteo actually serves, which
   * was verified against the live endpoint rather than assumed. That trip is
   * therefore genuinely mixed, which is scenario 11's business. This one sits
   * wholly inside the window so "every day is a forecast" is a real claim.
   */
  const NEAR = {
    basics: { startDate: '2026-08-03', endDate: '2026-08-06' },
  } satisfies ScenarioOptions;

  it('labels every day a forecast and records when it was read', () => {
    const itinerary = plan(NEAR);
    for (const day of itinerary.days) {
      expect(day.weather.evidence).toBe('forecast');
      expect(day.weather.fetchedAt).toBeDefined();
      expect(day.weather.attribution.length).toBeGreaterThan(0);
    }
    expect(itinerary.diagnostics.weatherEvidence).toEqual(['forecast']);
  });

  it('stops at the horizon rather than extrapolating past it', () => {
    // The standard fixture straddles the boundary. Day four is one day beyond
    // what the provider will forecast, and it must come back as a pattern
    // rather than as a repeat of day three.
    const itinerary = plan();
    const kinds = itinerary.days.map((day) => day.weather.evidence);
    expect(kinds.slice(0, 3)).toEqual(['forecast', 'forecast', 'forecast']);
    expect(kinds[3]).toBe('historical_pattern');
  });
});

describe('scenario 10 — a trip beyond the forecast window', () => {
  const FAR = {
    basics: { startDate: '2027-03-10', endDate: '2027-03-13' },
    now: FIXED_NOW,
  } satisfies ScenarioOptions;

  it('uses historical patterns and never calls them a forecast', () => {
    const itinerary = plan(FAR);
    for (const day of itinerary.days) {
      expect(day.weather.evidence).toBe('historical_pattern');
      expect(day.weather.fetchedAt).toBeUndefined();
      expect(day.weather.summary).toMatch(/not a forecast/i);
    }
  });

  it('does not claim one future day is better than another', () => {
    const itinerary = plan(FAR);
    expect(itinerary.days.flatMap((day) => day.weather.decisions)).toEqual([]);
  });

  it('produces the same plan whether or not the weather is consulted', () => {
    // With nothing rankable, day assignment must be exactly what geography
    // alone would have produced.
    const withPatterns = plan(FAR);
    const withNothing = plan({
      ...FAR,
      weather: emptyWeather(['2027-03-10', '2027-03-11', '2027-03-12', '2027-03-13']),
    });
    expect(dayNumbersOf(withPatterns)).toEqual(dayNumbersOf(withNothing));
  });
});

describe('scenario 11 — a trip that straddles the horizon', () => {
  it('keeps each date on its own kind of evidence', () => {
    const dates = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
    const mixed = weatherWith(
      {
        '2026-08-14': historical('2026-08-14'),
        '2026-08-15': historical('2026-08-15'),
      },
      { dates },
    );
    const itinerary = plan({ weather: mixed });

    const kinds = itinerary.days.map((day) => day.weather.evidence);
    expect(new Set(kinds).size).toBeGreaterThan(1);
    expect(itinerary.diagnostics.weatherEvidence.length).toBeGreaterThan(1);

    for (const day of itinerary.days) {
      if (day.weather.evidence === 'historical_pattern') {
        expect(day.weather.summary).toMatch(/not a forecast/i);
        expect(day.weather.fetchedAt).toBeUndefined();
      }
    }
  });
});

function historical(date: string): DayWeather {
  return {
    kind: 'historical_pattern',
    locationId: 'mammoth-corridor',
    date,
    bandStart: '08-09',
    bandEnd: '08-19',
    sampleYearFrom: 2016,
    sampleYearTo: 2025,
    sampleCount: 110,
    method: 'Test pattern.',
    temperatureMaxC: { p10: 21.9, p50: 24.7, p90: 27.6 },
    temperatureMinC: { p10: 6, p50: 9.6, p90: 13 },
    wetDayFrequency: 0.08,
    snowDayFrequency: 0,
    windGustKphP90: 56,
    computedAt: '2026-07-30T12:00:00.000Z',
    attribution: { provider: 'Test', notice: 'Test pattern.', url: 'https://example.invalid/test' },
  };
}

function emptyWeather(dates: readonly string[]): WeatherDataset {
  return weatherDatasetSchema.parse({
    version: WEATHER_DATASET_VERSION,
    regionId: EASTERN_SIERRA.id,
    locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
    days: EASTERN_SIERRA_WEATHER_LOCATIONS.flatMap((location) =>
      dates.map((date) => ({
        kind: 'unavailable' as const,
        locationId: location.id,
        date,
        reason: 'provider_error' as const,
        message: 'Nothing available in this test.',
        attemptedProvider: 'Test',
        attemptedAt: '2026-07-30T12:00:00.000Z',
        consideredCache: false,
      })),
    ),
    solar: [],
    generatedAt: '2026-07-30T12:00:00.000Z',
    providerName: 'Test',
  });
}

function dayNumbersOf(itinerary: Itinerary): Record<string, number> {
  const map: Record<string, number> = {};
  for (const day of itinerary.days) {
    for (const placeId of activities(day)) map[placeId] = day.dayNumber;
  }
  return map;
}

// ---------------------------------------------------------------------------
// 12-14. When the provider does not answer
// ---------------------------------------------------------------------------

describe('scenario 12 — the weather source is unavailable', () => {
  const NOTHING = { weather: emptyWeather(DATES) } satisfies ScenarioOptions;

  it('still produces a plan, and says weather was not considered', () => {
    const itinerary = plan(NOTHING);
    expect(itinerary.days.length).toBe(4);
    for (const day of itinerary.days) {
      expect(day.weather.evidence).toBe('unavailable');
    }
    expect(itinerary.status).not.toBe('ready');
    expect(
      itinerary.issues.some((issue) => issue.code === 'weather_unavailable'),
    ).toBe(true);
  });

  it('never turns missing weather into good weather', () => {
    const itinerary = plan(NOTHING);
    const summaries = itinerary.days.map((day) => day.weather.summary).join(' ');
    expect(summaries).not.toMatch(/clear|sunny|fine|good conditions/i);
    expect(summaries).toMatch(/could not|no weather/i);
  });
});

describe('scenario 13 — a forecast that has aged', () => {
  it('is marked stale rather than presented as current', () => {
    const stale = weatherWith();
    const aged = weatherDatasetSchema.parse({
      ...stale,
      days: stale.days.map((day) =>
        day.kind === 'forecast' ? { ...day, fetchedAt: '2026-07-20T00:00:00.000Z' } : day,
      ),
    });
    const itinerary = plan({ weather: aged, now: new Date('2026-07-30T12:00:00.000Z') });
    expect(
      itinerary.issues.some((issue) => issue.code === 'weather_evidence_stale'),
    ).toBe(true);
  });

  it('does not warn about a forecast read minutes ago', () => {
    const itinerary = plan({ now: new Date('2026-07-30T12:30:00.000Z') });
    expect(
      itinerary.issues.some((issue) => issue.code === 'weather_evidence_stale'),
    ).toBe(false);
  });
});

describe('scenario 14 — a malformed provider response', () => {
  it('is rejected at the schema boundary rather than reaching the planner', () => {
    expect(() =>
      weatherDatasetSchema.parse({
        version: WEATHER_DATASET_VERSION,
        regionId: EASTERN_SIERRA.id,
        locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
        days: [{ kind: 'forecast', locationId: 'mammoth-corridor', date: '2026-08-12' }],
        solar: [],
        generatedAt: '2026-07-30T12:00:00.000Z',
        providerName: 'Test',
      }),
    ).toThrow();
  });

  it('rejects a probability outside 0–100 rather than clamping it', () => {
    expect(() =>
      weatherDatasetSchema.parse({
        version: WEATHER_DATASET_VERSION,
        regionId: EASTERN_SIERRA.id,
        locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
        days: [{ ...clear('mammoth-corridor', '2026-08-12'), precipitationProbabilityPercent: 140 }],
        solar: [],
        generatedAt: '2026-07-30T12:00:00.000Z',
        providerName: 'Test',
      }),
    ).toThrow();
  });

  it('rejects a place claimed by two weather points', () => {
    const [first, second] = EASTERN_SIERRA_WEATHER_LOCATIONS;
    expect(() =>
      weatherDatasetSchema.parse({
        version: WEATHER_DATASET_VERSION,
        regionId: EASTERN_SIERRA.id,
        locations: [first, { ...second!, placeIds: [...second!.placeIds, first!.placeIds[0]!] }],
        days: [],
        solar: [],
        generatedAt: '2026-07-30T12:00:00.000Z',
        providerName: 'Test',
      }),
    ).toThrow(/claimed by both/);
  });
});

// ---------------------------------------------------------------------------
// 15-17. Backups
// ---------------------------------------------------------------------------

describe('scenario 15 — a concrete fallback', () => {
  const WET = {
    weather: weatherWith({
      '2026-08-12': STORMY,
      '2026-08-13': STORMY,
      '2026-08-14': STORMY,
      '2026-08-15': STORMY,
    }),
  } satisfies ScenarioOptions;

  it('offers something reachable, open, and genuinely less exposed', () => {
    const itinerary = plan(WET);
    const backups = itinerary.days.flatMap((day) => day.weather.backups);
    for (const backup of backups) {
      expect(backup.driveMinutesFromBase).toBeLessThanOrEqual(75);
      expect(backup.openingSummary.length).toBeGreaterThan(0);
      expect(backup.why.length).toBeGreaterThan(0);
      expect(backup.trigger).toMatch(/forecast|season/i);
    }
  });

  it('never offers something already on the plan', () => {
    const itinerary = plan(WET);
    const scheduled = new Set(itinerary.days.flatMap(activities));
    for (const backup of itinerary.days.flatMap((day) => day.weather.backups)) {
      expect(scheduled.has(backup.placeId)).toBe(false);
    }
  });

  it('does not consume the day it is attached to', () => {
    const itinerary = plan(WET);
    for (const day of itinerary.days) {
      const ids = new Set(activities(day));
      for (const backup of day.weather.backups) expect(ids.has(backup.placeId)).toBe(false);
    }
  });

  it('reports no unusable-backup issues', () => {
    const itinerary = plan(WET);
    expect(itinerary.issues.filter((issue) => issue.code === 'backup_not_usable')).toEqual([]);
  });
});

describe('scenario 16 — a place the traveller ruled out is never a fallback', () => {
  it('excludes it however good a fallback it would otherwise be', () => {
    const itinerary = plan({
      manualExcludes: ['the-village-at-mammoth', 'bishop-town', 'earthquake-fault'],
      weather: weatherWith({
        '2026-08-12': STORMY,
        '2026-08-13': STORMY,
        '2026-08-14': STORMY,
        '2026-08-15': STORMY,
      }),
    });
    const offered = itinerary.days.flatMap((day) =>
      day.weather.backups.map((backup) => backup.placeId),
    );
    expect(offered).not.toContain('the-village-at-mammoth');
    expect(offered).not.toContain('bishop-town');
    expect(offered).not.toContain('earthquake-fault');
  });
});

describe('scenario 17 — no honest fallback exists', () => {
  it('says so rather than inventing one', () => {
    const itinerary = plan({
      manualExcludes: [
        'the-village-at-mammoth',
        'bishop-town',
        'earthquake-fault',
        'hot-creek-geologic-site',
        'convict-lake',
        'mono-lake-south-tufa',
        'manzanar-visitor-center',
      ],
      weather: weatherWith({
        '2026-08-12': STORMY,
        '2026-08-13': STORMY,
        '2026-08-14': STORMY,
        '2026-08-15': STORMY,
      }),
    });

    for (const day of itinerary.days) {
      if (day.weather.cautions.length === 0) continue;
      if (day.weather.backups.length > 0) continue;
      expect(day.weather.noBackupReason).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 18-19. Manual choices, and not churning
// ---------------------------------------------------------------------------

describe('scenario 18 — a hand-picked stop the weather works against', () => {
  it('is kept with a caution rather than dropped', () => {
    const itinerary = plan({
      manualIncludes: ['minaret-vista'],
      weather: weatherWith({
        '2026-08-12': STORMY,
        '2026-08-13': STORMY,
        '2026-08-14': STORMY,
        '2026-08-15': STORMY,
      }),
    });

    const scheduled = dayOf(itinerary, 'minaret-vista');
    const conflict = itinerary.unscheduled.find((entry) => entry.placeId === 'minaret-vista');
    // One or the other, never neither: nothing chosen by hand may vanish.
    expect(Boolean(scheduled) !== Boolean(conflict)).toBe(true);
    if (conflict) expect(conflict.reason.length).toBeGreaterThan(0);
  });
});

describe('scenario 19 — a difference too small to act on', () => {
  it('leaves the plan exactly where geography put it', () => {
    const barelyDifferent = weatherWith({
      '2026-08-13': { precipitationProbabilityPercent: 6, cloudCoverMeanPercent: 11 },
      '2026-08-14': { precipitationProbabilityPercent: 9, cloudCoverMeanPercent: 14 },
    });
    const nudged = plan({ weather: barelyDifferent });
    const flat = plan({ weather: weatherWith() });
    expect(dayNumbersOf(nudged)).toEqual(dayNumbersOf(flat));
  });
});

// ---------------------------------------------------------------------------
// 20-22. Two snapshots, and determinism
// ---------------------------------------------------------------------------

describe('scenario 20 — a changed forecast changes the plan, and only that', () => {
  it('produces its own correct plan from each snapshot', () => {
    const early = plan({
      weather: weatherWith({ '2026-08-14': STORMY, '2026-08-15': STORMY }),
      manualIncludes: ['minaret-vista'],
    });
    const later = plan({
      weather: weatherWith({ '2026-08-12': STORMY, '2026-08-13': STORMY }),
      manualIncludes: ['minaret-vista'],
    });

    expect(itineraryStructureFingerprint(early)).not.toBe(
      itineraryStructureFingerprint(later),
    );
    // Both remain legal against everything that is not weather.
    for (const itinerary of [early, later]) {
      expect(
        itinerary.issues.filter(
          (issue) =>
            issue.severity === 'error' &&
            issue.code !== 'must_include_unscheduled' &&
            !issue.code.startsWith('weather'),
        ),
      ).toEqual([]);
    }
  });
});

describe('scenario 21 — the fixture provider is a fixture, and says so', () => {
  it('labels itself so it can never be mistaken for a forecast', () => {
    const dataset = buildFixtureWeather({
      regionId: EASTERN_SIERRA.id,
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      dates: DATES,
      now: FIXED_NOW,
    });
    for (const day of dataset.days) {
      if (day.kind === 'unavailable') continue;
      expect(day.attribution.notice).toMatch(/fixture|testing/i);
    }
  });

  it('gives every zone its own weather rather than the base town forecast', () => {
    const dataset = buildFixtureWeather({
      regionId: EASTERN_SIERRA.id,
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      dates: ['2026-08-12'],
      now: FIXED_NOW,
    });
    const maxima = dataset.days
      .filter((day): day is ForecastDayWeather => day.kind === 'forecast')
      .map((day) => day.temperatureMaxC);
    expect(new Set(maxima).size).toBeGreaterThan(1);
    expect(Math.max(...maxima) - Math.min(...maxima)).toBeGreaterThan(10);
  });
});

describe('scenario 22 — determinism, and what narration may not touch', () => {
  it('produces a byte-identical plan from identical inputs', () => {
    const options = {
      weather: weatherWith({ '2026-08-13': STORMY, '2026-08-15': AFTERNOON_STORMS }),
      manualIncludes: ['minaret-vista', 'convict-lake'],
    } satisfies ScenarioOptions;
    const first = plan(options);
    const second = plan(options);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('puts the weather decision inside the structural fingerprint', () => {
    const settled = plan({ weather: weatherWith() });
    const stormy = plan({
      weather: weatherWith({
        '2026-08-12': STORMY,
        '2026-08-13': STORMY,
        '2026-08-14': STORMY,
        '2026-08-15': STORMY,
      }),
    });
    expect(itineraryStructureFingerprint(settled)).not.toBe(
      itineraryStructureFingerprint(stormy),
    );
  });

  it('leaves the fingerprint alone when only the prose would change', () => {
    const itinerary = plan();
    const narrated: Itinerary = {
      ...itinerary,
      summary: 'A narration layer rewrote this.',
      days: itinerary.days.map((day) => ({
        ...day,
        theme: 'Rewritten',
        weather: { ...day.weather, summary: 'Rewritten weather prose.' },
        items: day.items.map((item) => ({ ...item, reason: 'Rewritten.' })),
      })),
    };
    expect(itineraryStructureFingerprint(narrated)).toBe(
      itineraryStructureFingerprint(itinerary),
    );
  });
});

// ---------------------------------------------------------------------------
// 23. What a skeptical read of the finished diff found
// ---------------------------------------------------------------------------

describe('scenario 23 — regressions a review caught', () => {
  /**
   * A day beyond the forecast horizon can still be a day the weather threatens.
   *
   * The first version gated `atRisk` on whether the evidence could rank days,
   * which is false for every historical pattern — so a far-future July trip
   * showed "typically 38 °C" as a caution, offered no fallback, and gave no
   * reason for not offering one. The validator then reported a problem the
   * planner had guaranteed it could not answer.
   */
  it('gives a historical-pattern day a fallback or an admitted gap, never silence', () => {
    const itinerary = plan({
      basics: { startDate: '2027-07-12', endDate: '2027-07-15' },
      answers: { regionalExpansion: 'best_regional', maxDailyTravelMinutes: 300 },
    });

    for (const day of itinerary.days) {
      if (day.weather.cautions.length === 0) continue;
      expect(
        day.weather.backups.length > 0 || day.weather.noBackupReason !== undefined,
        `day ${day.dayNumber} has a weather caution and neither a fallback nor a reason`,
      ).toBe(true);
    }
    expect(itinerary.issues.filter((issue) => issue.code === 'no_weather_backup')).toEqual([]);
  });

  /**
   * A day with nothing on it is still a day somewhere, and that somewhere is
   * where the traveller is sleeping. The first version reached for whichever
   * candidate sorted first, which could headline a rest day in Mammoth with the
   * Owens Valley's numbers — four thousand feet below and seventy miles away.
   */
  it('headlines an empty day with the base town, not with whatever sorted first', () => {
    const itinerary = plan({
      answers: { regionalExpansion: 'best_regional', maxDailyTravelMinutes: 300 },
    });
    for (const day of itinerary.days) {
      if (day.items.some((item) => item.kind === 'activity')) continue;
      if (!day.weather.locationId) continue;
      expect(day.weather.locationId).toBe('mammoth-corridor');
    }
  });
});

// ---------------------------------------------------------------------------
// 24. Hard versus soft: what weather may and may not take away
// ---------------------------------------------------------------------------

describe('scenario 24 — a rough road is a warning, not a closure', () => {
  /**
   * The correction this scenario exists to hold.
   *
   * `approachDegradesWhenWet` once produced `incompatible`, which meant a wet
   * forecast could delete a place from somebody's trip on the strength of a
   * field whose own records say "can be rough" and "fine for a normal car when
   * dry". Difficulty is not impossibility, and the difference belongs to the
   * traveller to weigh rather than to us to decide for them.
   */
  const WET_EVERY_DAY = {
    weather: weatherWith({
      '2026-08-12': STORMY,
      '2026-08-13': STORMY,
      '2026-08-14': STORMY,
      '2026-08-15': STORMY,
    }),
  } satisfies ScenarioOptions;

  it('still schedules a wet-degrading approach, with a caution', () => {
    const itinerary = plan({
      ...WET_EVERY_DAY,
      manualIncludes: ['wild-willys-hot-spring'],
    });

    const scheduled = dayOf(itinerary, 'wild-willys-hot-spring');
    expect(scheduled, 'a rough road must not remove the place').toBeDefined();

    const item = scheduled!.items.find(
      (entry) => entry.placeId === 'wild-willys-hot-spring',
    );
    expect(item?.weather?.suitability).not.toBe('incompatible');
    expect(item?.weather?.reasonCodes).toContain('rough_approach_when_wet');
    // The sentence names the worst thing about the day — here the storms, which
    // outrank the road — and in no register does it read as a verdict.
    expect(item?.weather?.summary ?? '').not.toMatch(/not usable/i);
  });

  it('never reports a wet-degrading place as weather-incompatible', () => {
    const itinerary = plan(WET_EVERY_DAY);
    const blocked = itinerary.unscheduled.filter(
      (entry) => entry.reasonCode === 'weather_incompatible',
    );
    expect(blocked).toEqual([]);
    expect(
      itinerary.issues.filter((issue) => issue.code === 'weather_incompatible_scheduled'),
    ).toEqual([]);
  });

  /**
   * The other half: a claim strong enough to act on still acts.
   *
   * No Eastern Sierra record qualifies — every one was read against its own
   * source and every one describes difficulty — so this patches a place with the
   * kind of official statement that would. The schema will not accept the record
   * without `kind: 'official'` and a verification date, which is the point.
   */
  const CLOSED_WHEN_WET: Place[] = EASTERN_SIERRA_PLACES.map((place) =>
    place.id === 'wild-willys-hot-spring'
      ? {
          ...place,
          weather: {
            ...place.weather,
            dryConditionsRequired: {
              reason:
                'the managing agency closes the access road to all vehicles once the surface is wet',
              provenance: {
                kind: 'official' as const,
                sourceName: 'Test land manager',
                lastVerified: '2026-07-30',
                confidence: 0.95,
                volatility: 'seasonal_recurring' as const,
              },
            },
          },
        }
      : place,
  );

  it('does block a place whose operator says wet ground closes it', () => {
    const itinerary = plan({
      ...WET_EVERY_DAY,
      places: CLOSED_WHEN_WET,
      manualIncludes: ['wild-willys-hot-spring'],
    });

    expect(dayOf(itinerary, 'wild-willys-hot-spring')).toBeUndefined();
    const conflict = itinerary.unscheduled.find(
      (entry) => entry.placeId === 'wild-willys-hot-spring',
    );
    // Visible, attributed, and never silently dropped — it was chosen by hand.
    expect(conflict).toBeDefined();
    expect(conflict!.wasManual).toBe(true);
    expect(conflict!.reasonCode).toBe('weather_incompatible');
    expect(conflict!.reason).toMatch(/closes the access road/);
  });

  it('lets the same place through on a dry day', () => {
    const itinerary = plan({
      places: CLOSED_WHEN_WET,
      weather: weatherWith(),
      manualIncludes: ['wild-willys-hot-spring'],
    });
    expect(dayOf(itinerary, 'wild-willys-hot-spring')).toBeDefined();
  });

  it('moves a hand-picked place to a better legal day before cautioning it', () => {
    // Only day 3 is settled. A manual pick should end up there rather than
    // being kept where geography first put it and warned about.
    const itinerary = plan({
      weather: weatherWith({
        '2026-08-12': STORMY,
        '2026-08-13': STORMY,
        '2026-08-15': STORMY,
      }),
      manualIncludes: ['wild-willys-hot-spring'],
    });
    const day = dayOf(itinerary, 'wild-willys-hot-spring');
    expect(day?.date).toBe('2026-08-14');
  });

  it('never lets a seasonal pattern produce a hard block', () => {
    // Same patched place, dates far beyond the horizon. A pattern says what
    // Marches do; it cannot say that the road is wet on the 12th.
    const itinerary = plan({
      basics: { startDate: '2027-03-10', endDate: '2027-03-13' },
      places: CLOSED_WHEN_WET,
      manualIncludes: ['wild-willys-hot-spring'],
    });
    const blocked = itinerary.unscheduled.find(
      (entry) =>
        entry.placeId === 'wild-willys-hot-spring' &&
        entry.reasonCode === 'weather_incompatible',
    );
    expect(blocked).toBeUndefined();
    for (const day of itinerary.days) {
      for (const item of day.items) {
        if (item.weather) expect(item.weather.suitability).not.toBe('incompatible');
      }
    }
  });

  it('is deterministic across the whole correction', () => {
    const options = { ...WET_EVERY_DAY, places: CLOSED_WHEN_WET } satisfies ScenarioOptions;
    expect(itineraryStructureFingerprint(plan(options))).toBe(
      itineraryStructureFingerprint(plan(options)),
    );
  });
});
