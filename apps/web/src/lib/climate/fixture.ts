import { CLIMATE_DATASET_VERSION, type ClimateProfile } from '@sidequest/core';
import { daylightHoursByMonth } from './openmeteo';
import type { ClimateProvider } from './openmeteo';

/**
 * A DETERMINISTIC CLIMATE, FOR TESTS THAT NEED "USE THIS TIMING" TO EXIST.
 *
 * `SIDEQUEST_CLIMATE_PROVIDER=fixture`. Not a record of any real place: a
 * smooth seasonal curve keyed on latitude (hemisphere-aware, cooler towards
 * the poles), a wet season opposite the warm one, and locally computed
 * daylight — enough for the recommender to rank the months and propose a
 * window, which is the press two production trips lost. Never used unless
 * asked for by name, and the doctor reports it as a fixture.
 */
export function fixtureClimateProvider(): ClimateProvider {
  return {
    name: 'fixture',
    async getProfile({ lat, lng, now }) {
      const year = now.getUTCFullYear() - 1;
      const daylight = daylightHoursByMonth(lat, lng, year);
      const southern = lat < 0;
      const polar = Math.min(1, Math.abs(lat) / 90);
      const months = Array.from({ length: 12 }, (_, i) => {
        const month = i + 1;
        /* Warmest around July in the north, January in the south. */
        const phase = ((month - (southern ? 1 : 7)) / 12) * 2 * Math.PI;
        const seasonal = Math.cos(phase);
        const high = 30 - polar * 28 + seasonal * (6 + polar * 14);
        const low = high - 9;
        const wet = Math.max(0, -seasonal);
        return {
          month,
          temperature: { low: Math.round(low * 10) / 10, high: Math.round(high * 10) / 10 },
          precipitationMm: Math.round(40 + wet * 120),
          wetDays: Math.round(6 + wet * 12),
          snowDays: low < 0 ? Math.round(Math.min(31, -low * 2)) : 0,
          daylightHours: daylight[i] ?? 12,
          hotDays: high > 32 ? Math.round(Math.min(31, (high - 32) * 6)) : 0,
          freezeDays: low < 0 ? Math.round(Math.min(31, -low * 3)) : 0,
        };
      });
      const profile: ClimateProfile = {
        schemaVersion: CLIMATE_DATASET_VERSION,
        coordinates: { lat, lng },
        sampleYearFrom: year - 19,
        sampleYearTo: year,
        months,
        provider: 'fixture',
        dataset: 'sidequest-fixture-normals',
        attribution: 'Synthetic normals for testing; not a record of any real place.',
        retrievedAt: now.toISOString(),
      };
      return { kind: 'profile', profile };
    },
  };
}
