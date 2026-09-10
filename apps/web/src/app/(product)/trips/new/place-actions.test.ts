import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * PLACING WHAT SOMEBODY TYPED, ON A DEPLOYMENT THAT HAS NOTHING.
 *
 * The production failure these exist to prevent, stated once: a fresh
 * deployment's database has no destination index, nothing else in the setup flow
 * ever asked a provider, and so every typed destination — "Japan" included —
 * reached the map as no coordinate at all. The canvas said ANYWHERE and the
 * seasons screen said the destination could not be placed.
 *
 * The environment here is that deployment: an empty database and no geocoder
 * configured. Everything below therefore exercises the tier that has to work
 * with nothing at all.
 */
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-place-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'place.db');
  delete process.env.SIDEQUEST_GEOCODER_PROVIDER;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.SIDEQUEST_DB_PATH;
});

describe('placing a typed destination with no index and no geocoder', () => {
  it('places an obvious country from the bundled reference', async () => {
    const { placeDestinationAction } = await import('./place-actions');
    const result = await placeDestinationAction({ text: 'Japan' });
    expect(result.ok).toBe(true);
    expect(result.placed).not.toBeNull();
    expect(result.placed!.source).toBe('reference');
    expect(result.placed!.featureType).toBe('country');
    expect(result.placed!.countryCode).toBe('JP');
    expect(result.placed!.referencePoint).toBe('Tokyo');
    /* Somewhere in Japan, not somewhere in the sea off Africa. */
    expect(result.placed!.center.lat).toBeGreaterThan(30);
    expect(result.placed!.center.lat).toBeLessThan(46);
    expect(result.placed!.center.lng).toBeGreaterThan(128);
    expect(result.placed!.center.lng).toBeLessThan(146);
  });

  it('places every country in the founder matrix, and keeps the traveller’s words', async () => {
    const { placeDestinationAction } = await import('./place-actions');
    for (const text of ['Japan', 'Hong Kong', 'Kyrgyzstan', 'Iceland', 'rural Japan', 'the steppes of Kyrgyzstan']) {
      const result = await placeDestinationAction({ text });
      expect(result.placed, text).not.toBeNull();
      expect(result.placed!.query, text).toBe(text);
    }
  });

  it('says "not placed" rather than inventing one for somewhere it does not know', async () => {
    const { placeDestinationAction } = await import('./place-actions');
    for (const text of ['Okavango Delta', 'Patagonia', 'New York City']) {
      const result = await placeDestinationAction({ text });
      expect(result.ok, text).toBe(true);
      expect(result.placed, text).toBeNull();
      /* The reason is about this deployment's configuration, never about the place. */
      expect(result.ok && result.placed === null ? result.reason : null, text).toBe('no_resolver');
    }
  });

  it('refuses a keystroke rather than resolving it', async () => {
    const { placeDestinationAction } = await import('./place-actions');
    const result = await placeDestinationAction({ text: 'J' });
    expect(result.ok && result.placed === null ? result.reason : null).toBe('too_short');
  });
});
