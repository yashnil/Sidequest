import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { foodProviderChoice } from './region';

/**
 * THE FOOD SWITCH HAS AN ADDRESS.
 *
 * `SIDEQUEST_FOOD_PROVIDER=off` is a whole-product difference: every meal on
 * every day of every plan becomes time held rather than somewhere named. The
 * doctor prints a line telling an operator which of the two their deployment is
 * running, and until this existed there was nothing for the doctor's test to
 * compare that line against — the predicate was an inline expression halfway
 * down `resolveRegionContext`, so the test pinned the script's own prose
 * instead. Weather, imagery and timezone each learned this the hard way: a
 * duplicated predicate is allowed to exist, it is not allowed to disagree
 * quietly, and it can only be checked for disagreement if it has a name.
 *
 * Two things are asserted. The predicate answers the same way the app behaves
 * under every environment the operator can produce, and `region.ts` reads the
 * variable in exactly one place — because a second reading is how the named
 * function and the real decision drift apart while both look right.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'region.ts'), 'utf8');
const VARIABLE = 'SIDEQUEST_FOOD_PROVIDER';

const previous = process.env[VARIABLE];

afterEach(() => {
  if (previous === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = previous;
});

describe('the food provider choice', () => {
  it('is off only when the operator asked for off', () => {
    delete process.env[VARIABLE];
    expect(foodProviderChoice(), 'a deployment that said nothing lost its restaurants').toBe('on');

    process.env[VARIABLE] = 'off';
    expect(foodProviderChoice()).toBe('off');

    /* Anything else is on, rather than each reader guessing at it separately. */
    for (const value of ['', 'on', 'live', 'OFF ']) {
      process.env[VARIABLE] = value;
      expect(foodProviderChoice(), `"${value}" was read as a request to switch food off`).toBe('on');
    }
  });

  it('is the only place region.ts reads the variable', () => {
    /*
     * Counted over the source rather than asserted about behaviour, because the
     * failure this prevents is a *second* reading rather than a wrong one: the
     * inline expression this replaced sat two hundred lines below the doctor's
     * only handle on it, and a deployment could have been reading one predicate
     * while the operator was shown the other. Prose about the variable is not a
     * reading, so only `process.env.` accesses are counted.
     */
    const readings = SOURCE.split(`process.env.${VARIABLE}`).length - 1;
    expect(
      readings,
      `region.ts reads ${VARIABLE} ${readings} times; the decision belongs in foodProviderChoice alone`,
    ).toBe(1);
  });
});

describe('V1 — scan regions located with Google Places expire after the cache window', () => {
  it('is fresh inside 29 days, expired after, and never expires open-data regions or compiled ones', async () => {
    const { scanCoordinatesExpired } = await import('./region');
    const created = '2026-09-01T00:00:00.000Z';
    const google = { compilerVersion: 'discovery-scan/1', createdAt: created, places: [{ source: { kind: 'google_places' } }] } as never;
    const osm = { compilerVersion: 'discovery-scan/1', createdAt: created, places: [{ source: { kind: 'osm' } }] } as never;
    const compiled = { compilerVersion: 'compiler/9', createdAt: created, places: [{ source: { kind: 'google_places' } }] } as never;
    expect(scanCoordinatesExpired(google, new Date('2026-09-20T00:00:00Z'))).toBe(false);
    expect(scanCoordinatesExpired(google, new Date('2026-10-05T00:00:00Z'))).toBe(true);
    expect(scanCoordinatesExpired(osm, new Date('2027-01-01T00:00:00Z'))).toBe(false);
    expect(scanCoordinatesExpired(compiled, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });
});
