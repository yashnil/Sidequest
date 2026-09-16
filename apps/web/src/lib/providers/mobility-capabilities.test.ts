import { afterEach, describe, expect, it } from 'vitest';
import { measurableModes, measurementAvailability, timetableAvailability, unavailabilityNote } from '@sidequest/core';
import { mobilityCapabilities } from './mobility-capabilities';

/**
 * V12.1 §9 §10 — the registry has to be able to say the three different things
 * that were one sentence before: nothing does this mode, something does it and
 * does not reach here, and something does it and we may not keep the answer.
 */

const ICELAND = { lat: 64.1466, lng: -21.9426 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };

const KEYS = ['SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_ROUTES_COVERAGE', 'SIDEQUEST_ROUTES_GLOBAL_PROVIDER', 'OPENROUTESERVICE_API_KEY', 'SIDEQUEST_TRANSIT_PROVIDER', 'SIDEQUEST_COMPOSER_PROVIDER'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function only(env: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

describe('mobility capabilities', () => {
  it('reports no provider at all when nothing is configured', () => {
    only({});
    const capabilities = mobilityCapabilities();
    expect(measurementAvailability(capabilities, 'drive')).toBe('no_provider');
    expect(measurableModes(capabilities)).toHaveLength(0);
  });

  it('measures inside a declared coverage and not outside it', () => {
    /* The deployed shape, with the coverage the probe found: an Iceland tile build. */
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_COVERAGE: 'IS' });
    const capabilities = mobilityCapabilities();
    expect(measurementAvailability(capabilities, 'drive', ICELAND)).toBe('measurable');
    expect(measurementAvailability(capabilities, 'drive', TOKYO)).toBe('outside_coverage');
  });

  it('treats an undeclared coverage as worth asking, never as a refusal', () => {
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla' });
    expect(measurementAvailability(mobilityCapabilities(), 'drive', TOKYO)).toBe('measurable');
  });

  it('never claims to measure a ferry, a flight or a trail', () => {
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_COVERAGE: 'IS' });
    const capabilities = mobilityCapabilities();
    for (const mode of ['ferry', 'boat', 'flight', 'trail', 'horse', 'cable_car_or_lift'] as const) {
      expect(measurementAvailability(capabilities, mode, ICELAND), `${mode} was claimed`).toBe('no_provider');
    }
  });

  it('never claims a timetable without a timetable provider', () => {
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla' });
    expect(timetableAvailability(mobilityCapabilities(), 'rail', TOKYO)).toBe('no_provider');
  });

  it('claims transit only when a transit provider is named', () => {
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_TRANSIT_PROVIDER: 'valhalla' });
    expect(measurementAvailability(mobilityCapabilities(), 'urban_transit', TOKYO)).toBe('measurable');
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla' });
    expect(measurementAvailability(mobilityCapabilities(), 'urban_transit', TOKYO)).toBe('no_provider');
  });

  it('reaches everywhere once a global router is configured', () => {
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_COVERAGE: 'IS', SIDEQUEST_ROUTES_GLOBAL_PROVIDER: 'openrouteservice', OPENROUTESERVICE_API_KEY: 'x' });
    expect(measurementAvailability(mobilityCapabilities(), 'drive', TOKYO)).toBe('measurable');
  });

  it('gives the fixture world its own measured modes, so a fixture trip is not unready for want of a router', () => {
    only({ SIDEQUEST_COMPOSER_PROVIDER: 'fixture' });
    expect(measurementAvailability(mobilityCapabilities(), 'drive', TOKYO)).toBe('measurable');
  });

  it('explains a gap in operator language, never in a traveller’s', () => {
    only({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_COVERAGE: 'IS' });
    const capabilities = mobilityCapabilities();
    expect(unavailabilityNote(measurementAvailability(capabilities, 'ferry', ICELAND), 'ferry')).toMatch(/No provider configured/);
    expect(unavailabilityNote(measurementAvailability(capabilities, 'drive', TOKYO), 'drive')).toMatch(/coverage does not reach/);
    expect(unavailabilityNote(measurementAvailability(capabilities, 'drive', ICELAND), 'drive')).toBeNull();
  });
});
