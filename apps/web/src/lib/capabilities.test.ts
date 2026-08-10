import { afterEach, describe, expect, it } from 'vitest';
import { capabilityRegistry } from './capabilities';

/**
 * THE REGISTRY EARNS ITS PLACE BY REFUSING THINGS.
 *
 * A capability registry that only ever says yes is a lookup table. What makes
 * this one worth having is the three different ways it says no — and the
 * distinction between them is the exact one whose absence let a walking matrix
 * stand in for a rail network.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
});

function configureOpenStack(): void {
  process.env.SIDEQUEST_GEOCODER_PROVIDER = 'nominatim';
  process.env.SIDEQUEST_PLACE_BACKBONE = 'overture';
  process.env.SIDEQUEST_ROUTES_PROVIDER = 'valhalla';
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-credential';
}

describe('a capability nobody supplies is unsupported, not merely missing', () => {
  it('reports public transport as unsupported even on a fully configured build', () => {
    configureOpenStack();
    const verdict = capabilityRegistry().assess('route_transit');

    expect(verdict.available).toBe(false);
    /*
     * `unsupported` and not `unconfigured`. Nothing in this deployment can ever
     * answer it, so there is no variable a developer could set — and telling
     * them there is would send them looking for one.
     */
    expect(verdict.reason).toBe('unsupported');
    expect(verdict.providers).toEqual([]);
    expect(verdict.missing).toEqual([]);
  });

  it('never reports transit as available by borrowing the road router', () => {
    configureOpenStack();
    const registry = capabilityRegistry();
    /*
     * The substitution this exists to prevent. Valhalla registers three
     * capabilities and transit is not one of them, so a configured router
     * cannot make a transit question answerable.
     */
    expect(registry.assess('route_drive').available).toBe(true);
    expect(registry.assess('route_walk').available).toBe(true);
    expect(registry.assess('route_transit').available).toBe(false);
  });
});

describe('an unconfigured capability names what it needs, and only the name', () => {
  it('distinguishes "nobody set this up" from "nothing can do this"', () => {
    delete process.env.SIDEQUEST_ROUTES_PROVIDER;
    const verdict = capabilityRegistry().assess('route_drive');

    expect(verdict.available).toBe(false);
    expect(verdict.reason).toBe('unconfigured');
    expect(verdict.missing).toEqual(['SIDEQUEST_ROUTES_PROVIDER']);
  });

  it('never carries a value, only a variable name', () => {
    const secret = 'sk-ant-registry-must-never-carry-this';
    process.env.ANTHROPIC_API_KEY = secret;
    configureOpenStack();
    process.env.ANTHROPIC_API_KEY = secret;

    const serialised = JSON.stringify(capabilityRegistry().report());
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(secret.slice(0, 12));
  });
});

describe('coverage is a real constraint', () => {
  it('does not read a country-scoped source as evidence about another country', () => {
    const registry = capabilityRegistry().register({
      provider: 'a-national-park-service',
      capability: 'seasonal_access',
      authority: 'managing_authority',
      freshness: 'daily',
      persistence: 'storable',
      coverage: ['US'],
      configured: true,
    });

    expect(registry.assess('seasonal_access', 'US').available).toBe(true);
    /*
     * The failure mode for exactly the kind of official source most worth
     * having: a park service speaks authoritatively about its own country's
     * parks and about nowhere else.
     */
    const elsewhere = registry.assess('seasonal_access', 'JP');
    expect(elsewhere.available).toBe(false);
    expect(elsewhere.reason).toBe('out_of_coverage');
  });
});

describe('terms travel with the capability', () => {
  it('refuses to persist an answer whose source only permits a bounded cache', () => {
    configureOpenStack();
    const registry = capabilityRegistry();
    /*
     * A forecast is time-limited by its own nature and by its licence; the
     * places backbone is storable with attribution. A consumer that wants to
     * write either into a durable artifact has to ask, and the answers differ.
     */
    expect(registry.mayPersist('place_inventory')).toBe(true);
    expect(registry.mayPersist('weather_forecast')).toBe(false);
  });

  it('never permits persisting something unavailable', () => {
    expect(capabilityRegistry().mayPersist('route_transit')).toBe(false);
  });
});

describe('the report is complete', () => {
  it('answers for every declared capability, so nothing is silently unaccounted for', () => {
    const report = capabilityRegistry().report();
    const capabilities = new Set(report.map((entry) => entry.capability));
    expect(capabilities.size).toBe(report.length);
    /* And every unavailable one says why. */
    for (const entry of report) {
      if (!entry.available) expect(entry.reason).toBeDefined();
    }
  });
});
