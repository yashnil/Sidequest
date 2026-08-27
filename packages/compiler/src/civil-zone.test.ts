import { describe, expect, it } from 'vitest';
import {
  buildSolarDays,
  isCivilTimeZone,
  solarEventsFor,
  utcOffsetMinutesOn,
  type CompiledRegion,
  type WeatherLocation,
} from '@sidequest/core';
import { compileRegion } from './compile';
import { deriveScope } from './scope';
import { SYNTHETIC_WORLDS, fakeProviders, syntheticCandidate, type SyntheticWorldSpec } from './testing/fakes';
import type { CompilerProviders } from './providers';

/**
 * THE CIVIL CLOCK, FROM THE STAGE THAT RESOLVES IT TO THE NUMBER A TRAVELLER
 * READS.
 *
 * ---
 *
 * **The live evidence class.** A compilation resolved a real IANA zone for its
 * bases, wrote an upgraded scope carrying it — and then handed the *original*
 * scope to `buildBases` and to the weather-location stage. So every base and
 * every forecast point on delivered artifacts carried the longitude
 * approximation (`Etc/GMT±N`), which is the one identifier shape that knows
 * nothing about daylight saving. `WeatherLocation.timeZone` is the sole input
 * to `buildSolarDays`, so sunrise, sunset and every daylight judgement built on
 * them landed one to two hours out for half the year — on trips whose zone the
 * same run had confirmed.
 *
 * **What is asserted, and why it is asserted here.** Every case drives
 * `compileRegion` and reads the *stored artifact*, because the artifact is what
 * the itinerary reads: the view model resolves each solar day from
 * `region.weatherLocations[].timeZone` and each rendered wall clock from
 * `region.bases[].timeZone`. Asserting on the compiler's internal `scope`
 * would prove the const was built, which it always was.
 *
 * Fixture worlds only; no destination is named anywhere in this file.
 */

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

/** Straddles the autumn transition, so an offset that never moves is visible. */
const DST_DATES = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'];

function scopeOf(spec: SyntheticWorldSpec) {
  return deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    nights: DATES.length,
    revision: 1,
  });
}

async function compile(
  spec: SyntheticWorldSpec,
  options: {
    dates?: readonly string[];
    /** Bases the trip is allowed to move between. Zero keeps one base. */
    maxBaseChanges?: number;
    providers?: (base: CompilerProviders) => CompilerProviders;
  } = {},
): Promise<CompiledRegion> {
  const dates = options.dates ?? DATES;
  const base = fakeProviders(spec);
  const derived = scopeOf(spec);
  const result = await compileRegion({
    compilationId: `civil-zone-${spec.id}`,
    scope:
      options.maxBaseChanges === undefined
        ? derived
        : { ...derived, maxBaseChanges: options.maxBaseChanges },
    dates: [...dates],
    months: [...new Set(dates.map((date) => Number(date.slice(5, 7))))],
    providers: options.providers ? options.providers(base) : base,
    now: new Date('2026-08-10T09:00:00.000Z'),
  });
  if (!result.ok) throw new Error(`${spec.id} did not compile: ${result.code} — ${result.message}`);
  return result.region;
}

/**
 * The world the seam exists for: a destination whose record publishes no clock,
 * whose scope therefore starts on solar time, and whose real zone is
 * established by asking a source during the compilation.
 */
const UNCLOCKED = SYNTHETIC_WORLDS.unclocked_valley!;

/** Sunrise as the artifact's own data produces it, for one point on one date. */
function sunriseFrom(location: WeatherLocation, date: string): number {
  const events = solarEventsFor(
    location.coordinates,
    date,
    utcOffsetMinutesOn(date, location.timeZone),
  );
  if (events.kind !== 'normal') throw new Error('the fixture must not be polar');
  return events.sunriseMinute;
}

describe('a destination whose civil zone the compilation resolved', () => {
  it('puts that zone on every forecast point, not the longitude approximation', async () => {
    const region = await compile(UNCLOCKED);

    expect(region.weatherLocations.length).toBeGreaterThan(0);
    for (const location of region.weatherLocations) {
      expect(location.timeZone).toBe(UNCLOCKED.timeZone);
      /* Stated structurally as well, so a future `Etc/GMT-7` cannot pass by
       * happening to equal the fixture's string. */
      expect(isCivilTimeZone(location.timeZone)).toBe(true);
    }
  });

  it('puts it on every base, including one the per-point lookup could not settle', async () => {
    const region = await compile(UNCLOCKED);
    for (const base of region.bases) {
      expect(base.timeZone).toBe(UNCLOCKED.timeZone);
    }
  });

  it('moves sunrise by the hour the approximation was losing', async () => {
    const region = await compile(UNCLOCKED);
    const location = region.weatherLocations[0]!;
    const date = DATES[0]!;

    /*
     * The number the artifact now produces, against the number it produced
     * while the un-upgraded scope was being read. `Etc/GMT+7` is standard time
     * all year; the civil zone is on summer time in August, so the two differ
     * by exactly the daylight-saving hour — which is the size of the error that
     * shipped.
     */
    const approximated = solarEventsFor(location.coordinates, date, -7 * 60);
    if (approximated.kind !== 'normal') throw new Error('the fixture must not be polar');
    expect(sunriseFrom(location, date) - approximated.sunriseMinute).toBe(60);
  });

  it('tracks a daylight-saving transition inside the trip, which a fixed offset cannot', async () => {
    const region = await compile(UNCLOCKED, { dates: DST_DATES });
    const location = region.weatherLocations[0]!;

    const before = utcOffsetMinutesOn(DST_DATES[0]!, location.timeZone);
    const after = utcOffsetMinutesOn(DST_DATES[3]!, location.timeZone);
    /*
     * The whole content of "a civil zone rather than an offset": the clock
     * moves inside the trip. Under the shipped behaviour both of these read
     * −420 and every daylight number on the later days was an hour late.
     */
    expect(before).toBe(-360);
    expect(after).toBe(-420);

    const solar = buildSolarDays({
      locations: region.weatherLocations,
      dates: DST_DATES,
      utcOffsetMinutesFor: (point, date) => utcOffsetMinutesOn(date, point.timeZone),
      computedAt: '2026-08-10T09:00:00.000Z',
    });
    const first = solar.find((day) => day.date === DST_DATES[0]! && day.locationId === location.id);
    const last = solar.find((day) => day.date === DST_DATES[3]! && day.locationId === location.id);
    /* An hour back, plus the three days of seasonal drift. Never zero. */
    expect(first!.sunsetMinute - last!.sunsetMinute).toBeGreaterThan(55);
  });

  it('overrules an adapter that answers on its own clock', async () => {
    /*
     * Not hypothetical: the shipped adapter read its own diagnostics for the
     * zone, and because resolution and compilation are separate requests it had
     * never called the lookup — so it stamped `UTC` on every point of every
     * compiled region. An adapter is an injected boundary, and the compilation
     * holds the better answer, so the reconciliation is the compiler's.
     */
    const region = await compile(UNCLOCKED, {
      providers: (base) => ({
        ...base,
        weatherLocations: {
          name: 'adapter-that-ignores-the-scope',
          async plan(input) {
            const answer = await base.weatherLocations.plan(input);
            return {
              ...answer,
              locations: answer.locations.map((location) => ({ ...location, timeZone: 'UTC' })),
            };
          },
        },
      }),
    });
    for (const location of region.weatherLocations) {
      expect(location.timeZone).toBe(UNCLOCKED.timeZone);
    }
  });
});

describe('a destination whose civil zone could not be settled', () => {
  it('says so on the forecast point rather than presenting the guess as precise', async () => {
    const region = await compile({
      ...UNCLOCKED,
      id: 'unclocked-valley-unresolved',
      timeZoneResolution: 'unresolved',
    });

    expect(region.scope.timeZones[0]).toBe('Etc/GMT+7');
    for (const location of region.weatherLocations) {
      /*
       * The honest degradation available at this layer. The schema requires an
       * identifier and the offset is still the best available number, so the
       * *claim* degrades rather than the value: every surface renders
       * `limitation`, and it now says the daylight times are approximations.
       */
      expect(location.limitation).toContain('not settled to one confirmed civil time zone');
      expect(location.limitation).toContain('approximation');
    }
  });

  it('does not stamp that caveat on a destination whose zone was confirmed', async () => {
    const region = await compile(UNCLOCKED);
    for (const location of region.weatherLocations) {
      expect(location.limitation).not.toContain('not settled');
    }
  });
});

describe('a destination whose extent spans more than one civil zone', () => {
  /**
   * Two bases, two clocks, and neither may be applied to the other. The rule
   * `singleTimeZone` exists to enforce is that "more than one" is a real answer
   * — so the upgrade must not fire, and the daylight claim degrades exactly as
   * it does when no zone was resolved at all.
   */
  const SPANNING: SyntheticWorldSpec = {
    ...SYNTHETIC_WORLDS.rail_corridor!,
    id: 'rail-corridor-zones',
    publishesTimeZone: false,
    timeZoneResolution: 'resolved',
    baseTimeZones: { '0': 'Europe/Berlin', '1': 'Europe/Warsaw', '2': 'Europe/Warsaw' },
  };

  it('never collapses the two onto one clock', async () => {
    const region = await compile(SPANNING, { maxBaseChanges: 2 });
    const zones = new Set(region.bases.map((base) => base.timeZone));
    expect(zones.size).toBeGreaterThan(1);
  });

  it('keeps a base that is not the destination centroid on its own resolved clock', async () => {
    const region = await compile(SPANNING, { maxBaseChanges: 2 });
    /*
     * The failure this closes is a base inheriting the destination's zone
     * because the destination is where the adapter happened to look. Asserted
     * per base against what the source said about *that base's* coordinates.
     */
    for (const base of region.bases) {
      const suffix = base.id.split('-').at(-1) ?? '';
      expect(base.timeZone).toBe(SPANNING.baseTimeZones![suffix]);
    }
  });

  it('degrades the daylight claim rather than picking a side', async () => {
    const region = await compile(SPANNING, { maxBaseChanges: 2 });
    for (const location of region.weatherLocations) {
      expect(location.limitation).toContain('not settled to one confirmed civil time zone');
    }
  });
});
