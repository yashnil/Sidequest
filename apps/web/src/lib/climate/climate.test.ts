import { describe, expect, it } from 'vitest';
import { daylightHoursByMonth } from './openmeteo';

/**
 * The climate profile's daylight column, checked at the longitudes where the
 * old implementation broke.
 *
 * The defect: `daylightHoursByMonth` asked `solarEventsFor` for sunrise and
 * sunset with `utcOffsetMinutes: 0` and subtracted. At Greenwich that is
 * harmless; nine time zones east, solar noon lands hours before clock noon, the
 * sunrise minute clamps at zero, and the difference reads as a short day. A
 * compiled Tokyo scope carried 9.63 hours for May against a real ~14.1, and the
 * "best months" reasoning consumed the wrong column verbatim. These tests are
 * against published almanac values, so they fail for the old code and pass only
 * for an offset-free day-length computation.
 */
describe('daylightHoursByMonth', () => {
  it('gives Tokyo real seasonal daylight, not a clamp artefact', () => {
    const hours = daylightHoursByMonth(35.6764, 139.65, 2025);
    // June (index 5) ~14.5h, December (index 11) ~9.7h, May (index 4) ~14.1h.
    expect(Math.abs(hours[5]! - 14.5)).toBeLessThan(0.3);
    expect(Math.abs(hours[11]! - 9.7)).toBeLessThan(0.3);
    expect(Math.abs(hours[4]! - 14.1)).toBeLessThan(0.3);
    // The audited failure value can never come back for early summer.
    expect(hours[4]!).toBeGreaterThan(13);
  });

  it('is symmetric across hemispheres at the same |latitude|', () => {
    const north = daylightHoursByMonth(45, 170, 2025);
    const south = daylightHoursByMonth(-45, -170, 2025);
    // June in the north ≈ December in the south, whatever the longitude — day
    // length is a function of latitude and date alone.
    expect(Math.abs(north[5]! - south[11]!)).toBeLessThan(0.2);
    expect(Math.abs(north[11]! - south[5]!)).toBeLessThan(0.2);
  });

  it('reports polar day and polar night as 24 and 0 rather than gaps', () => {
    const svalbard = daylightHoursByMonth(78.2, 15.6, 2025);
    expect(svalbard[5]).toBe(24);
    expect(svalbard[11]).toBe(0);
  });

  it('answers every month exactly once', () => {
    expect(daylightHoursByMonth(35.6764, 139.65, 2025)).toHaveLength(12);
  });
});
