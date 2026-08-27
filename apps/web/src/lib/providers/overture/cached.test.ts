import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geographicScopeSchema, REGION_PACK_VERSION, type GeographicScope, type RegionPack } from '@sidequest/core';

/*
 * A PARTIAL PACK IS A FLOOR, NOT A HIT.
 *
 * These tests drive the cached provider with every collaborator injected,
 * because the defect they exist for lived exactly in the composition: the
 * store, the catalogue and the builder were each correct alone, and the cache
 * still turned one time-starved build into the truth about a destination for a
 * whole release — a live metropolitan pack shipped four of six layers empty,
 * and every later compile reused it as a hit.
 */

const findRegionPack = vi.fn();
const findStaleRegionPack = vi.fn();
const saveRegionPack = vi.fn();
vi.mock('../../db/pack-repository', () => ({
  findRegionPack: (...args: unknown[]) => findRegionPack(...args),
  findStaleRegionPack: (...args: unknown[]) => findStaleRegionPack(...args),
  saveRegionPack: (...args: unknown[]) => saveRegionPack(...args),
}));

vi.mock('../../db/compiler-repository', () => ({
  readProviderCache: () => undefined,
  writeProviderCache: () => undefined,
}));

const innerGetPack = vi.fn();
vi.mock('./pack', () => ({
  createOverturePackProvider: () => ({ name: 'overture-pack', getPack: innerGetPack }),
}));

vi.mock('./catalog', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    latestRelease: async () => ({
      catalog: 'overture',
      releaseId: '2026-07-22.0',
      resolvedAt: '2026-08-01T00:00:00.000Z',
      catalogUrl: 'https://example.invalid/catalog.json',
    }),
  };
});

import { createCachedPackProvider, hashFor } from './cached';

function scopeFor(): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'relation/1',
    destinationName: 'Testville',
    destinationEntityType: 'city',
    breadth: 'city',
    center: { lat: 40.7, lng: -74 },
    bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    timeZones: ['UTC'],
    shape: {
      kind: 'bounds',
      bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    },
    transport: {
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk'],
      carAvailable: true,
      acceptsWaterOrAirTransfers: true,
      basis: 'default',
      note: 'Test transport.',
    },
    maxBaseChanges: 0,
    nights: 4,
    rationale: 'A test scope.',
    confidence: { level: 'high', signals: [], note: 'Test.' },
    confirmedByUser: true,
  });
}

function packStub(state: 'ready' | 'partial', label: string): RegionPack {
  return {
    id: `pack-${label}`,
    state,
    scopeHash: 'scope-hash',
    contentHash: `hash-${label}`,
    schemaVersion: REGION_PACK_VERSION,
    releases: [
      { catalog: 'overture', releaseId: '2026-07-22.0', resolvedAt: '2026-08-01T00:00:00.000Z' },
    ],
    layers: [],
    ...(state === 'partial'
      ? { failure: { code: 'coverage', detail: `${label}: some areas were not read.` } }
      : {}),
  } as unknown as RegionPack;
}

beforeEach(() => {
  findRegionPack.mockReset();
  findStaleRegionPack.mockReset();
  saveRegionPack.mockReset();
  innerGetPack.mockReset();
  saveRegionPack.mockImplementation((pack: RegionPack) => pack);
});

describe('the cached pack provider and a stored partial', () => {
  const scope = scopeFor();

  it('reuses a ready pack without building', async () => {
    findRegionPack.mockReturnValue(packStub('ready', 'stored'));
    const provider = createCachedPackProvider();

    const outcome = await provider.getPack({ scope, now: new Date('2026-08-21T00:00:00Z') });

    expect(outcome.kind).toBe('ready');
    expect(innerGetPack).not.toHaveBeenCalled();
  });

  it('rebuilds when the stored pack is partial, and the completed build wins', async () => {
    findRegionPack.mockReturnValue(packStub('partial', 'starved'));
    const completed = packStub('ready', 'completed');
    innerGetPack.mockResolvedValue({ kind: 'ready', pack: completed, source: 'built' });
    saveRegionPack.mockImplementation((pack: RegionPack) => pack);
    const provider = createCachedPackProvider();

    const outcome = await provider.getPack({ scope, now: new Date('2026-08-21T00:00:00Z') });

    expect(innerGetPack).toHaveBeenCalledTimes(1);
    expect(saveRegionPack).toHaveBeenCalledWith(completed);
    expect(outcome.kind).toBe('ready');
    expect((outcome as { pack: RegionPack }).pack.contentHash).toBe('hash-completed');
  });

  it('keeps the stored partial when the rebuild fares no better', async () => {
    const stored = packStub('partial', 'starved');
    findRegionPack.mockReturnValue(stored);
    const relapse = packStub('partial', 'relapse');
    innerGetPack.mockResolvedValue({ kind: 'partial', pack: relapse, reason: 'still starved' });
    /* The store keeps the better pack; here the stored one is no worse, so it wins. */
    saveRegionPack.mockReturnValue(stored);
    const provider = createCachedPackProvider();

    const outcome = await provider.getPack({ scope, now: new Date('2026-08-21T00:00:00Z') });

    expect(outcome.kind).toBe('partial');
    expect((outcome as { pack: RegionPack }).pack.contentHash).toBe('hash-starved');
  });

  it('falls back to the stored partial when the rebuild fails outright', async () => {
    const stored = packStub('partial', 'starved');
    findRegionPack.mockReturnValue(stored);
    innerGetPack.mockResolvedValue({
      kind: 'unavailable',
      code: 'provider_unavailable',
      message: 'The data files did not answer.',
    });
    const provider = createCachedPackProvider();

    const outcome = await provider.getPack({ scope, now: new Date('2026-08-21T00:00:00Z') });

    /* The floor holds: a failed rebuild must not degrade partial into stale or empty. */
    expect(outcome.kind).toBe('partial');
    expect((outcome as { pack: RegionPack }).pack.contentHash).toBe('hash-starved');
    expect(saveRegionPack).not.toHaveBeenCalled();
    expect(findStaleRegionPack).not.toHaveBeenCalled();
  });
});

describe('the scope hash the cache is keyed on', () => {
  it('is stable for one scope', () => {
    const scope = scopeFor();
    expect(hashFor(scope)).toBe(hashFor(scopeFor()));
  });
});
