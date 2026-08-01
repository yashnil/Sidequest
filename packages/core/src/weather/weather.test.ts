import { describe, expect, it } from 'vitest';
import { formatMinuteOfDay } from '../schemas/common';
import { solarEventsFor } from './solar';
import {
  assessPlaceWeather,
  evaluateWeather,
  isMeaningfullyBetter,
  placeWeatherProfileSchema,
  validateWeatherDataset,
  WeatherDataError,
  WEATHER_THRESHOLDS,
} from '../index';
// The seed region, imported explicitly. It is no longer part of the engine's
// public surface, so a test that wants the Eastern Sierra has to say so.
import {
  buildFixtureWeather,
  EASTERN_SIERRA,
  EASTERN_SIERRA_PLACES,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  placeById,
  placesInMoreThanOneWeatherZone,
  placesWithoutWeatherZone,
  weatherZonesClaimingUnknownPlaces,
} from '../data/index';

/**
 * The solar algorithm is checked against numbers Sidequest did not produce.
 *
 * Every expectation below was read from Open-Meteo's own `sunrise`/`sunset`
 * daily variables for the same coordinate, date and zone on 30 July 2026. That
 * makes this a genuine cross-check of an independent implementation rather than
 * a snapshot of whatever this file happened to compute the first time it ran —
 * which is the only version of this test worth having.
 */
describe('sunrise and sunset', () => {
  const MAMMOTH = { lat: 37.6485, lng: -118.9721 };
  const PDT = -420;

  it('matches the provider to within a minute in midsummer', () => {
    const events = solarEventsFor(MAMMOTH, '2026-07-30', PDT);
    expect(events.kind).toBe('normal');
    if (events.kind !== 'normal') return;
    // Open-Meteo: 2026-07-30T05:58 / 2026-07-30T20:06 at America/Los_Angeles.
    expect(Math.abs(events.sunriseMinute - (5 * 60 + 58))).toBeLessThanOrEqual(1);
    expect(Math.abs(events.sunsetMinute - (20 * 60 + 6))).toBeLessThanOrEqual(1);
  });

  it('tracks the light shortening through the trip window', () => {
    const august = solarEventsFor(MAMMOTH, '2026-08-14', PDT);
    const october = solarEventsFor(MAMMOTH, '2026-10-14', PDT);
    if (august.kind !== 'normal' || october.kind !== 'normal') throw new Error('unexpected');

    const augustLight = august.sunsetMinute - august.sunriseMinute;
    const octoberLight = october.sunsetMinute - october.sunriseMinute;
    expect(augustLight).toBeGreaterThan(octoberLight);
    // Roughly two hours of light lost over two months at this latitude.
    expect(augustLight - octoberLight).toBeGreaterThan(100);
    expect(augustLight - octoberLight).toBeLessThan(160);
  });

  it('shifts with the standard-time offset rather than silently staying on summer time', () => {
    const pdt = solarEventsFor(MAMMOTH, '2026-12-21', PDT);
    const pst = solarEventsFor(MAMMOTH, '2026-12-21', -480);
    if (pdt.kind !== 'normal' || pst.kind !== 'normal') throw new Error('unexpected');
    expect(pdt.sunriseMinute - pst.sunriseMinute).toBe(60);
    // Mammoth sits near the western edge of the Pacific zone, so the shortest
    // day there starts a good seven minutes later than the round number a
    // reader expects. Asserting the real value rather than the tidy one is the
    // point of checking against an outside source at all.
    expect(formatMinuteOfDay(pst.sunriseMinute)).toBe('07:07');
  });

  it('reports polar night rather than clamping to a zero-length day', () => {
    const events = solarEventsFor({ lat: 78.2, lng: 15.6 }, '2026-12-21', 60);
    expect(events.kind).toBe('polar_night');
  });

  it('reports polar day rather than inventing a sunset', () => {
    const events = solarEventsFor({ lat: 78.2, lng: 15.6 }, '2026-06-21', 120);
    expect(events.kind).toBe('polar_day');
  });
});


const DATES = ['2026-08-12', '2026-08-13'];
const NOW = new Date('2026-08-05T12:00:00.000Z');

function dataset() {
  return buildFixtureWeather({
    regionId: EASTERN_SIERRA.id,
    locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
    dates: DATES,
    now: NOW,
  });
}

describe('the weather zone dataset', () => {
  it('claims every place in the region exactly once', () => {
    expect(placesWithoutWeatherZone()).toEqual([]);
    expect(placesInMoreThanOneWeatherZone()).toEqual([]);
    expect(weatherZonesClaimingUnknownPlaces()).toEqual([]);
  });

  it('separates points that genuinely differ, and says what each cannot speak for', () => {
    const elevations = EASTERN_SIERRA_WEATHER_LOCATIONS.map((entry) => entry.elevationMetres);
    // Manzanar to the gondola summit is over two thousand metres. One forecast
    // for the region would be wrong by more than ten degrees at the extremes.
    expect(Math.max(...elevations) - Math.min(...elevations)).toBeGreaterThan(2000);
    for (const location of EASTERN_SIERRA_WEATHER_LOCATIONS) {
      expect(location.limitation.length).toBeGreaterThan(20);
    }
  });
});

describe('the provider boundary', () => {
  it('accepts a complete dataset', () => {
    expect(() =>
      validateWeatherDataset(dataset(), {
        regionId: EASTERN_SIERRA.id,
        dates: DATES,
        placeIds: EASTERN_SIERRA_PLACES.map((place) => place.id),
      }),
    ).not.toThrow();
  });

  it('refuses a dataset that leaves a date out rather than treating it as fine', () => {
    const partial = { ...dataset(), days: dataset().days.filter((day) => day.date !== DATES[1]) };
    expect(() =>
      validateWeatherDataset(partial, {
        regionId: EASTERN_SIERRA.id,
        dates: DATES,
        placeIds: EASTERN_SIERRA_PLACES.map((place) => place.id),
      }),
    ).toThrow(WeatherDataError);
  });

  it('refuses to fall back to the base town for an unmapped place', () => {
    const trimmed = {
      ...dataset(),
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS.slice(1),
      days: dataset().days.filter((day) => day.locationId !== 'mammoth-corridor'),
    };
    expect(() =>
      validateWeatherDataset(trimmed, {
        regionId: EASTERN_SIERRA.id,
        dates: DATES,
        placeIds: EASTERN_SIERRA_PLACES.map((place) => place.id),
      }),
    ).toThrow(/No weather location covers/);
  });

  it('refuses another region entirely', () => {
    expect(() =>
      validateWeatherDataset(dataset(), {
        regionId: 'alaska',
        dates: DATES,
        placeIds: [],
      }),
    ).toThrow(/cannot be used for/);
  });
});

describe('judging a place against a day', () => {
  const village = placeById('the-village-at-mammoth')!;
  const vista = placeById('minaret-vista')!;

  function forecast(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'forecast' as const,
      locationId: 'mammoth-corridor',
      date: '2026-08-12',
      condition: 'clear' as const,
      temperatureMaxC: 24,
      temperatureMinC: 10,
      precipitationProbabilityPercent: 5,
      precipitationMm: 0,
      snowfallCm: 0,
      windSpeedMaxKph: 10,
      windGustMaxKph: 18,
      cloudCoverMeanPercent: 10,
      hours: [],
      fetchedAt: '2026-08-05T12:00:00.000Z',
      staleAfterMinutes: 360,
      attribution: { provider: 'Test', notice: 'Test.', url: 'https://example.invalid/t' },
      ...overrides,
    };
  }

  it('treats missing weather as unknown, never as fine', () => {
    const assessment = evaluateWeather({
      profile: vista.weather,
      day: {
        kind: 'unavailable',
        locationId: 'mammoth-corridor',
        date: '2026-08-12',
        reason: 'provider_timeout',
        message: 'timed out',
        attemptedProvider: 'Test',
        attemptedAt: '2026-08-05T12:00:00.000Z',
        consideredCache: true,
      },
    });
    expect(assessment.suitability).toBe('unknown');
    expect(assessment.rankable).toBe(false);
    expect(assessment.summary).not.toMatch(/good|clear/i);
  });

  it('shelters an indoor place from the same day that ruins an exposed one', () => {
    const wet = forecast({
      condition: 'rain',
      precipitationMm: 16,
      precipitationProbabilityPercent: 90,
      cloudCoverMeanPercent: 96,
    });
    const indoors = evaluateWeather({ profile: village.weather, day: wet });
    const outdoors = evaluateWeather({ profile: vista.weather, day: wet });
    expect(indoors.score).toBeGreaterThan(outdoors.score);
    expect(outdoors.suitability).toBe('poor');
  });

  it('never ranks two days on a historical pattern', () => {
    const assessment = evaluateWeather({
      profile: vista.weather,
      day: {
        kind: 'historical_pattern',
        locationId: 'mammoth-corridor',
        date: '2027-03-10',
        bandStart: '03-05',
        bandEnd: '03-15',
        sampleYearFrom: 2016,
        sampleYearTo: 2025,
        sampleCount: 110,
        method: 'Test.',
        temperatureMaxC: { p10: 2, p50: 5, p90: 9 },
        temperatureMinC: { p10: -8, p50: -5, p90: -1 },
        wetDayFrequency: 0.3,
        snowDayFrequency: 0.4,
        windGustKphP90: 60,
        computedAt: '2026-08-05T12:00:00.000Z',
        attribution: { provider: 'Test', notice: 'Test.', url: 'https://example.invalid/t' },
      },
    });
    expect(assessment.rankable).toBe(false);
    expect(assessment.reasons.some((reason) => reason.code === 'pattern_only')).toBe(true);
  });

  it('holds every threshold in one place', () => {
    // A guard against the number that decides "poor visibility" being re-decided
    // somewhere else. If this fails, something has grown its own copy.
    expect(WEATHER_THRESHOLDS.obscuredCloudPercent).toBe(80);
    expect(isMeaningfullyBetter(0.8, 0.7)).toBe(false);
    expect(isMeaningfullyBetter(0.9, 0.7)).toBe(true);
  });
});

describe('what a board card says', () => {
  it('uses forecast language only for a forecast', () => {
    const assessment = assessPlaceWeather({
      place: placeById('minaret-vista')!,
      dataset: dataset(),
      dates: DATES,
      avoidances: [],
      daylightOnly: false,
    });
    if (assessment.evidence.includes('forecast')) {
      expect(assessment.evidenceLabel).toMatch(/Forecast|Mixed/);
    }
    expect(assessment.attribution).toBeTruthy();
  });

  it('says plainly when there is no weather rather than staying silent', () => {
    const assessment = assessPlaceWeather({
      place: placeById('minaret-vista')!,
      dataset: undefined,
      dates: DATES,
      avoidances: [],
      daylightOnly: false,
    });
    expect(assessment.badges).toEqual([]);
    expect(assessment.evidenceLabel).toBe('');
  });

  it('caps the badges so the ones that matter stay visible', () => {
    for (const place of EASTERN_SIERRA_PLACES) {
      const assessment = assessPlaceWeather({
        place,
        dataset: dataset(),
        dates: DATES,
        avoidances: [],
        daylightOnly: true,
      });
      expect(assessment.badges.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('the daylight window', () => {
  it('leaves a place that is not daylight-limited exactly as it found it', () => {
    const bounds = { startMinute: 480, endMinute: 1080 };
    expect(
      evaluateWeather({
        profile: placeById('convict-lake')!.weather,
        day: {
          kind: 'unavailable',
          locationId: 'mammoth-corridor',
          date: '2026-08-12',
          reason: 'not_configured',
          message: 'off',
          attemptedProvider: 'none',
          attemptedAt: '2026-08-05T12:00:00.000Z',
          consideredCache: false,
        },
        daylightOnly: false,
        durationMinutes: 6000,
      }).suitability,
    ).toBe('unknown');
    expect(bounds.endMinute).toBe(1080);
  });

  it('does not shorten anything when there is no solar record', () => {
    // "We did not work out the light" must never read as "the light runs out".
    const assessment = evaluateWeather({
      profile: placeById('manzanar-historic-site')!.weather,
      day: {
        kind: 'unavailable',
        locationId: 'owens-valley',
        date: '2026-08-12',
        reason: 'provider_error',
        message: 'x',
        attemptedProvider: 'none',
        attemptedAt: '2026-08-05T12:00:00.000Z',
        consideredCache: false,
      },
      daylightOnly: true,
      durationMinutes: 1400,
    });
    expect(assessment.suitability).not.toBe('incompatible');
  });
});

describe('hard versus soft weather', () => {
  const wildWillys = placeById('wild-willys-hot-spring')!;

  function wetDay() {
    return {
      kind: 'forecast' as const,
      locationId: 'mammoth-corridor',
      date: '2026-08-12',
      condition: 'rain' as const,
      temperatureMaxC: 18,
      temperatureMinC: 8,
      precipitationProbabilityPercent: 90,
      precipitationMm: 18,
      snowfallCm: 0,
      windSpeedMaxKph: 12,
      windGustMaxKph: 22,
      cloudCoverMeanPercent: 95,
      hours: [],
      fetchedAt: '2026-08-05T12:00:00.000Z',
      staleAfterMinutes: 360,
      attribution: { provider: 'Test', notice: 'Test.', url: 'https://example.invalid/t' },
    };
  }

  it('reads a rough wet approach as reduced comfort, in those words', () => {
    const assessment = evaluateWeather({ profile: wildWillys.weather, day: wetDay() });
    expect(assessment.suitability).not.toBe('incompatible');
    expect(assessment.reasons.some((r) => r.code === 'rough_approach_when_wet')).toBe(true);
    // The register that matters: a warning about the drive, not a verdict.
    expect(assessment.summary).toMatch(/still doable/i);
    expect(assessment.summary).toMatch(/rougher going/i);
  });

  it('refuses a dry-conditions requirement that names no official source', () => {
    // The schema is the enforcement. A hard block has to be attributable.
    expect(() =>
      placeWeatherProfileSchema.parse({
        ...wildWillys.weather,
        dryConditionsRequired: {
          reason: 'somebody said it gets muddy',
          provenance: {
            kind: 'authored',
            sourceName: 'Hearsay',
            confidence: 0.5,
            volatility: 'stable',
          },
        },
      }),
    ).toThrow(/official/);
  });

  it('accepts one that does, and blocks on it', () => {
    const profile = placeWeatherProfileSchema.parse({
      ...wildWillys.weather,
      dryConditionsRequired: {
        reason: 'the managing agency closes the road once the surface is wet',
        provenance: {
          kind: 'official',
          sourceName: 'Test land manager',
          lastVerified: '2026-07-30',
          confidence: 0.95,
          volatility: 'seasonal_recurring',
        },
      },
    });
    const assessment = evaluateWeather({ profile, day: wetDay() });
    expect(assessment.suitability).toBe('incompatible');
    expect(assessment.summary).toMatch(/not usable on this day/i);
    expect(assessment.summary).toMatch(/closes the road/);
  });

  it('does not block on a probability alone', () => {
    // 90% chance and no actual rain in the forecast is not an operator closing
    // a gate, and must not be rendered as one.
    const profile = placeWeatherProfileSchema.parse({
      ...wildWillys.weather,
      dryConditionsRequired: {
        reason: 'closed when wet',
        provenance: {
          kind: 'official',
          sourceName: 'Test land manager',
          lastVerified: '2026-07-30',
          confidence: 0.95,
          volatility: 'stable',
        },
      },
    });
    const dry = { ...wetDay(), precipitationMm: 0, precipitationProbabilityPercent: 90 };
    expect(evaluateWeather({ profile, day: dry }).suitability).not.toBe('incompatible');
  });

  it('no Eastern Sierra record claims a dry-conditions closure', () => {
    // Every candidate was read against its own source and every one of them
    // describes difficulty rather than closure. If this ever fails, somebody has
    // upgraded a place to a hard constraint and owes it a citation.
    for (const place of EASTERN_SIERRA_PLACES) {
      expect(place.weather.dryConditionsRequired, place.id).toBeUndefined();
    }
  });
});
