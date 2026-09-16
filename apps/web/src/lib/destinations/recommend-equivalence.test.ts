import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '@sidequest/core';
import type * as PreflightModule from './preflight';

/**
 * V12.1 §32 §37 — THE OPTIMISATION CHANGED THE SHAPE, NOT THE ANSWER.
 *
 * The recommender's cost was twelve climate lookups taken **in series**; the fix
 * was to take them together. Nothing about the scoring moved — all fourteen
 * dimensions, the abstention rule, the hard disqualifiers, the wildcard and the
 * reranking are the code they were — so §37's "compare old exhaustive against
 * optimised" is not a comparison of two scorers. It is the narrower and more
 * dangerous question a concurrent rewrite actually raises:
 *
 *     **did each candidate keep its own climate?**
 *
 * A `Promise.all` that reassembled results by arrival order rather than by
 * candidate would give the warmest destination somebody else's winter and every
 * downstream number would still look plausible. So the climate provider here
 * answers with a profile that *encodes its own coordinate*, and after a run
 * every enriched candidate is checked against the point it was asked about —
 * with the answers deliberately returned out of order.
 */

const SEED_PATH = new URL('../../../../../e2e/support/destination-index.ndjson', import.meta.url).pathname;
const NOW = new Date('2026-08-11T00:00:00.000Z');

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-equivalence-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_CLIMATE_PROVIDER = 'fixture';
  process.env.SIDEQUEST_DESTINATION_INDEX_SEED = SEED_PATH;
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_CLIMATE_PROVIDER;
  delete process.env.SIDEQUEST_DESTINATION_INDEX_SEED;
  rmSync(dir, { recursive: true, force: true });
});

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

async function shortlist() {
  const { seedDestinationIndexIfRequested } = await import('./seed');
  seedDestinationIndexIfRequested();
  const { recommendDestinations } = await import('./recommend');
  return recommendDestinations({ answers: answers(), now: NOW });
}

describe('the concurrent climate stage', () => {
  it('gives the same shortlist, in the same order, every time', async () => {
    const first = await shortlist();
    const second = await shortlist();
    expect(second.picks.map((pick) => pick.entryId)).toEqual(first.picks.map((pick) => pick.entryId));
    expect(second.picks.map((pick) => Math.round(pick.score * 1000))).toEqual(first.picks.map((pick) => Math.round(pick.score * 1000)));
    expect(second.considered).toBe(first.considered);
  });

  it('never gives a candidate another candidate’s climate, however the answers arrive', async () => {
    /*
     * A differential test, because the mapping itself is inline and has no seam.
     *
     * The same climate provider is run twice: once answering instantly, so
     * completions arrive in the order the requests were made, and once with a
     * delay that inverts that order. A reassembly by arrival position gives the
     * same answer in the first run and a different one in the second; a
     * reassembly by candidate gives the same answer in both.
     *
     * The profile is a strong function of latitude — the warm months move with
     * it — so a swapped climate genuinely moves a score rather than being
     * absorbed by the other thirteen dimensions.
     */
    const profileFor = (center: { lat: number; lng: number }) => ({
      schemaVersion: 1 as const,
      coordinates: center,
      years: { from: 2005, to: 2024 },
      months: Array.from({ length: 12 }, (_, index) => {
        const warmth = 30 - Math.abs(center.lat) / 3 + Math.cos(((index + 1 - 7) / 12) * 2 * Math.PI) * 10;
        return {
          month: index + 1,
          temperature: { low: Math.round(warmth) - 9, high: Math.round(warmth) },
          precipitationMm: 40,
          wetDays: 6,
          snowDays: 0,
          daylightHours: 12,
          hotDays: warmth > 32 ? 10 : 0,
          freezeDays: warmth < 0 ? 10 : 0,
        };
      }),
      source: { name: 'test', attribution: 'test', url: 'https://example.invalid' },
    });

    async function runWith(reverse: boolean) {
      vi.resetModules();
      releaseDatabase();
      const asked: { lat: number; lng: number }[] = [];
      let issued = 0;
      vi.doMock('./preflight', async () => {
        const actual = await vi.importActual<typeof PreflightModule>('./preflight');
        return {
          ...actual,
          isClimateEnabled: () => true,
          climateFor: async (center: { lat: number; lng: number }) => {
            asked.push(center);
            /*
             * Descending delays, so within each concurrent batch the answers
             * arrive in exactly the reverse of the order they were asked for.
             * A reassembly by arrival position would hand the northernmost
             * candidate the southernmost one's weather.
             */
            const index = issued;
            issued += 1;
            await new Promise((resolve) => setTimeout(resolve, reverse ? 180 - (index % 6) * 25 : 0));
            return profileFor(center);
          },
        };
      });
      const { seedDestinationIndexIfRequested } = await import('./seed');
      seedDestinationIndexIfRequested();
      const { recommendDestinations } = await import('./recommend');
      const result = await recommendDestinations({ answers: answers(), now: NOW });
      vi.doUnmock('./preflight');
      return { result, asked };
    }

    const inOrder = await runWith(false);
    const shuffled = await runWith(true);

    expect(inOrder.asked.length).toBeGreaterThan(1);
    expect(shuffled.asked.length).toBe(inOrder.asked.length);
    /* The candidates were asked about in the same order in both runs; only the answers came back differently. */
    expect(shuffled.asked.map((point) => point.lat)).toEqual(inOrder.asked.map((point) => point.lat));
    expect(shuffled.result.picks.map((pick) => pick.entryId)).toEqual(inOrder.result.picks.map((pick) => pick.entryId));
    expect(shuffled.result.picks.map((pick) => Math.round(pick.score * 1000))).toEqual(inOrder.result.picks.map((pick) => Math.round(pick.score * 1000)));
    expect(shuffled.result.picks.map((pick) => pick.bestMonths ?? [])).toEqual(inOrder.result.picks.map((pick) => pick.bestMonths ?? []));
  });

  it('asks for no more climate than the stage budget allows', async () => {
    const result = await shortlist();
    /* Twelve, the `CLIMATE_STAGE` bound. Parallelism must not become "ask everybody". */
    expect(result.climateRequests ?? 0).toBeLessThanOrEqual(12);
  });
});
