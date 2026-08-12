import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '@sidequest/core';

/**
 * WHAT THE CATALOGUE COULD OFFER, MEASURED WHERE THE ASK IS MADE.
 *
 * `RECOMMENDABLE` names five feature types and the live release supplies two of
 * them: 203 regions and 37 counties reach the universe scan, and not one island,
 * national park or protected area, because the index is built from Overture's
 * *divisions* theme. The sentence a traveller reads about that used to be
 * inferred from the eight picks on screen, which made a claim about our
 * catalogue out of a scoring outcome. It is measured here instead, and this is
 * the seam where the measurement is taken.
 *
 * Runs against a temporary database seeded through the real import path with the
 * invented five-country index the browser suite ships. No network: the climate
 * provider is switched off, which is also the state the deployment runs in.
 */

const SEED_PATH = new URL('../../../../../e2e/support/destination-index.ndjson', import.meta.url)
  .pathname;

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-recommend-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_CLIMATE_PROVIDER = 'off';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_CLIMATE_PROVIDER;
  delete process.env.SIDEQUEST_DESTINATION_INDEX_SEED;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-11T00:00:00.000Z');

function answers(): TripComposerAnswers {
  return {
    ...emptyComposerAnswers('help_me_decide', NOW),
    dates: { mode: 'month', month: 7, wantsRecommendation: false },
    duration: { mode: 'fixed', nights: 7, wantsRecommendation: false },
    shape: 'two_bases',
    transport: 'drive',
    themes: ['outdoors'],
  };
}

async function rank(seedPath: string) {
  process.env.SIDEQUEST_DESTINATION_INDEX_SEED = seedPath;
  const { seedDestinationIndexIfRequested } = await import('./seed');
  seedDestinationIndexIfRequested();
  const { recommendDestinations } = await import('./recommend');
  return recommendDestinations({ answers: answers(), now: NOW });
}

describe('the shortlist states what the index could not supply', () => {
  it('names the missing kinds when the release holds only administrative rows', async () => {
    const shortlist = await rank(SEED_PATH);
    expect(shortlist.picks.length).toBeGreaterThan(0);
    const spots = shortlist.blindSpots.join(' ');
    expect(spots).toContain('administrative region or county');
    expect(spots).toContain('islands, national parks or protected areas');
  });

  /**
   * The same seed with one protected area added.
   *
   * It does not have to reach the shortlist, and on this fixture it does not —
   * which is the whole point. The sentence is about what the catalogue holds, so
   * one row in the index is enough to make it false, and the old rule that read
   * the picks would have gone on saying it.
   */
  it('stops saying it as soon as the index holds one', async () => {
    const seeded = `${dir}/with-park.ndjson`;
    const rows = [
      JSON.stringify({
        sourceId: 'AA-country',
        subtype: 'country',
        primaryName: 'Ambervale',
        aliases: [],
        countryCode: 'AA',
        population: 6_000_000,
        prominence: 90,
        bbox: { xmin: 5, xmax: 11, ymin: 43, ymax: 49 },
      }),
      JSON.stringify({
        sourceId: 'AA-region-0',
        subtype: 'region',
        primaryName: 'Ambervale Highlands',
        aliases: [],
        countryCode: 'AA',
        parentId: 'AA-country',
        prominence: 70,
        bbox: { xmin: 7, xmax: 9, ymin: 45, ymax: 47 },
      }),
      JSON.stringify({
        sourceId: 'AA-park-0',
        subtype: 'protected',
        class: 'national_park',
        primaryName: 'Ambervale Wilds',
        aliases: [],
        countryCode: 'AA',
        bbox: { xmin: 7.4, xmax: 7.6, ymin: 45.4, ymax: 45.6 },
      }),
    ];
    writeFileSync(seeded, `${rows.join('\n')}\n`);

    const shortlist = await rank(seeded);
    expect(shortlist.blindSpots.join(' ')).not.toContain('administrative region or county');
  });
});
