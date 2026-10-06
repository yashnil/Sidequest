import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSUMERS, capabilityRegistry } from './capabilities.mjs';

/**
 * CAPABILITY → CONSUMER. Every capability the registry can advertise names
 * the canonical seam that consumes it, and that seam's file exists. A
 * capability with no consumer is never `available`.
 */
const WEB_SRC = join(__dirname, '..', '..');
const CORE_SRC = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'core', 'src');

function filesNamed(consumer: string): string[] {
  return [...consumer.matchAll(/([\w./-]+\.(?:ts|tsx|mjs))/g)].map((m) => m[1]!);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const ALL_FILES = [...walk(WEB_SRC), ...walk(CORE_SRC)];

describe('LIVE WORLD V1 closure — capability to consumer audit', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-x', SIDEQUEST_COMPILER_PROVIDER: 'open', SIDEQUEST_GEOCODER_PROVIDER: 'nominatim', SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_TRANSIT_PROVIDER: 'google', SIDEQUEST_TRAFFIC_PROVIDER: 'google', GOOGLE_MAPS_API_KEY: 'AIza-x', SIDEQUEST_FX_PROVIDER: 'frankfurter', SIDEQUEST_MAP_TILES: 'https://tiles.example/{z}/{x}/{y}.png', SIDEQUEST_CLIMATE_PROVIDER: 'openmeteo' };
  const registry = capabilityRegistry(env);

  it('every capability is in the consumer table, and every named consumer file exists', () => {
    for (const cap of registry.capabilities) {
      expect(cap.id in CONSUMERS, `${cap.id} has no consumer entry`).toBe(true);
      expect(cap.consumer).toBe(CONSUMERS[cap.id]);
      for (const file of filesNamed(cap.consumer ?? '')) {
        const suffix = `/${file.replace(/^core\//, '')}`;
        expect(ALL_FILES.some((f) => f.endsWith(suffix)), `${cap.id}: ${file} not found`).toBe(true);
      }
    }
  });

  it('a capability without a canonical consumer is never advertised as available', () => {
    for (const cap of registry.capabilities) {
      if (cap.consumer === null || cap.adapterOnly) expect(cap.available, `${cap.id} advertised without a consumer`).toBe(false);
    }
    expect(registry.byId['routing.bicycle']!.available).toBe(false);
    expect(registry.byId['lodging.live_price']!.available).toBe(false);
    expect(registry.byId['lodging.availability']!.available).toBe(false);
  });

  it('Google photos are adapter-only: never offered as the photo provider, even with a key and imagery off', () => {
    const noImagery = capabilityRegistry({ ...env, SIDEQUEST_IMAGERY_PROVIDER: 'off' });
    expect(noImagery.byId['places.photos']!.provider).toBeNull();
    expect(noImagery.byId['places.photos']!.adapterOnly).toBe(true);
    expect(noImagery.byId['places.photos']!.available).toBe(false);
    expect(registry.byId['places.photos']!.provider).toBe('wikimedia');
  });

  it('operational capabilities are usable with a key, and with recorded responses, but not from a fixture compiler alone', () => {
    expect(registry.byId['places.hours']!.available && registry.byId['places.business_status']!.available).toBe(true);
    const recorded = capabilityRegistry({ SIDEQUEST_COMPOSER_PROVIDER: 'fixture', SIDEQUEST_COMPILER_PROVIDER: 'fixture', SIDEQUEST_WEATHER_PROVIDER: 'fixture', SIDEQUEST_IMAGERY_PROVIDER: 'fixture', SIDEQUEST_FX_PROVIDER: 'fixture', SIDEQUEST_PLACES_FIXTURE: '/tmp/recorded.json' });
    expect(recorded.byId['places.hours']!.provider).toBe('google-places');
    expect(recorded.byId['places.hours']!.fixture).toBe(true);
    expect(recorded.byId['places.hours']!.costClass).toBe('free');
    expect(recorded.mode).toBe('fixture');
  });
});
