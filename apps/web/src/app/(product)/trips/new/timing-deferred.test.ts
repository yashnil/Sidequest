import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * "TELL ME WHEN IT IS BEST" SURVIVES A PROVIDER THAT IS NOT THERE.
 *
 * The production screen said: "We could not place this destination on the map
 * yet, so we cannot compare its seasons. Pick your own dates and we will plan
 * around them." Three failures in one sentence — it treated a missing coordinate
 * as a fact about the destination, it treated a temporary gap as permanent, and
 * it told the traveller to abandon the planning mode they had just chosen.
 *
 * The doctrine these hold to is the product's own: unknown is not false, and a
 * provider failure is not a geographic impossibility.
 */
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-timing-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'timing.db');
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_ACTION_FENCES;
  delete process.env.SIDEQUEST_CLIMATE_PROVIDER;
});

describe('the timing recommendation when the evidence is not there', () => {
  it('defers rather than refusing when nothing has placed the destination yet', async () => {
    const { recommendTimingAction } = await import('./timing-actions');
    const result = await recommendTimingAction({ entryId: null, lat: null, lng: null, nights: 7, months: [], season: null, earliest: null, latest: null });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.deferred).toBe(true);
    expect(result.ok === false ? result.note : '').toBe("We'll choose the best window once we understand the trip.");
    /* The one thing it must never say again. */
    expect(result.ok === false ? result.note : '').not.toMatch(/could not place|cannot compare|Pick your own dates and we will plan around them/i);
  });

  it('defers rather than refusing when the climate archive is switched off', async () => {
    process.env.SIDEQUEST_CLIMATE_PROVIDER = 'off';
    const { recommendTimingAction } = await import('./timing-actions');
    const result = await recommendTimingAction({ entryId: null, lat: 35.68, lng: 139.69, nights: 7, months: [], season: null, earliest: null, latest: null });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.deferred).toBe(true);
    /* It offers the alternatives without demanding one. */
    expect(result.ok === false ? result.note : '').toMatch(/Sidequest will choose the best window/);
  });
});
