import { afterEach, describe, expect, it, vi } from 'vitest';


/* These load the real atlas artifact; the budget is for a loaded machine, not a performance claim. */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The advisor's world under failure: a missing or unreadable atlas file must
 * degrade to the curated catalog and say so, never throw on a request path.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('advisorWorld', () => {
  it('serves the global atlas when its file is present', async () => {
    const { advisorWorld } = await import('./world');
    const { world, atlas, degraded } = advisorWorld();
    expect(degraded).toBeNull();
    expect(atlas).not.toBeNull();
    expect(world.size).toBeGreaterThan(30_000);
  });

  it('falls back to the curated catalog, and says why, when the file cannot be found', async () => {
    vi.stubEnv('SIDEQUEST_ATLAS_PATH', '/nonexistent/atlas.json.gz');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { advisorWorld } = await import('./world');
    const { destinationCatalog } = await import('@sidequest/core');
    const { world, atlas, degraded } = advisorWorld();
    expect(atlas).toBeNull();
    expect(degraded).toMatch(/not found/);
    expect(world.size).toBe(destinationCatalog().length);
    /* Asked twice, it answers the same and logs once. */
    expect(advisorWorld().world).toBe(world);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
