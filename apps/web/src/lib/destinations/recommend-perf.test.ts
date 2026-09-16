import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '@sidequest/core';

/**
 * V12.1 §31 §36 §47 — THE DETERMINISTIC RECOMMENDER BENCHMARK.
 *
 * ── WHY THIS IS A SEPARATE PASS ─────────────────────────────────────────────
 *
 * V9.1 settled the rule and V12.1 inherits it: a performance measurement inside
 * `npm run test` saturates every core, starves the suites beside it, and then
 * measures the contention rather than the code. It runs under
 * `npm run test:perf`, alone, on an idle machine.
 *
 * ── WHAT IT MEASURES, AND WHAT IT DOES NOT ──────────────────────────────────
 *
 * The **local** pipeline: the universe scan, the per-country feature reads, the
 * region portfolios and two full passes of the fourteen-dimension ranking. The
 * climate provider is the deterministic fixture, so the number is reproducible
 * and is not a measurement of somebody else's archive.
 *
 * That is the right thing to gate on. The V11 live acceptance's 101.9 s was
 * twelve *sequential* HTTP requests to the ERA5 archive; the fix was to stop
 * taking them in series (`recommend.ts`, stage 2), and what remains after it is
 * this — the work Sidequest actually does.
 *
 * ── SCALE ───────────────────────────────────────────────────────────────────
 *
 * Runs against whatever index `SIDEQUEST_PERF_DB` names, or the development
 * database if it holds one, and **reports the row count it measured against**.
 * A benchmark that quietly measured a five-country fixture and printed a number
 * is exactly how "820 ms" came to stand for an operation that took two minutes:
 * the figure was honestly obtained and was unrepresentative, and nothing in it
 * said so.
 */

const CANDIDATE_DBS = [process.env.SIDEQUEST_PERF_DB, 'apps/web/data/sidequest.db', 'data/sidequest.db'].filter(Boolean) as string[];

function answers(): TripComposerAnswers {
  return {
    ...emptyComposerAnswers('help_me_decide', new Date('2026-09-14T00:00:00Z')),
    dates: { mode: 'season', season: 'summer', wantsRecommendation: false },
    duration: { mode: 'fixed', nights: 10, wantsRecommendation: false },
    pace: 'balanced',
    origin: 'San Francisco',
  };
}

describe('recommender performance, at the scale it actually runs at', () => {
  it('ranks the real index inside the budget', async () => {
    const fs = await import('node:fs');
    const database = CANDIDATE_DBS.find((path) => fs.existsSync(path));
    if (!database) {
      console.warn('No destination index found; set SIDEQUEST_PERF_DB to a database that holds one.');
      return;
    }
    process.env.SIDEQUEST_DB_PATH = database;
    process.env.SIDEQUEST_CLIMATE_PROVIDER = 'fixture';

    const { destinationIndexSize, scanRecommendationUniverse } = await import('../db/destination-index-repository');
    const { recommendDestinations } = await import('./recommend');

    const rows = destinationIndexSize();
    const scanStart = Date.now();
    const scan = scanRecommendationUniverse({ featureTypes: ['region', 'county', 'island', 'national_park', 'protected_area'], perCountry: 3, limit: 240 });
    const scanMs = Date.now() - scanStart;

    const runs: number[] = [];
    let considered = 0;
    let picks = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const started = Date.now();
      const shortlist = await recommendDestinations({ answers: answers(), now: new Date('2026-09-14T00:00:00Z') });
      runs.push(Date.now() - started);
      considered = shortlist.considered;
      picks = shortlist.picks.length;
    }
    const cold = runs[0]!;
    const warm = Math.min(...runs.slice(1));

    console.warn(
      [
        `index rows          ${rows}`,
        `universe scan       ${scanMs} ms (${scan.countries} countries, ${scan.indexRowsRead} index rows, ${scan.payloadRowsRead} payloads)`,
        `candidates scored   ${considered}`,
        `picks               ${picks}`,
        `cold                ${cold} ms`,
        `warm                ${warm} ms`,
      ].join('\n'),
    );

    /*
     * The gate §55 sets. Deliberately generous against the ≤5 s / ≤2 s target,
     * because this runs on whatever machine somebody has and a benchmark that
     * fails on a laptop under load teaches people to ignore it. What it is
     * actually holding is the shape: 101.9 s was an architecture, not a slow
     * machine, and nothing that reintroduces a per-candidate round trip can pass
     * this however fast the host is.
     */
    expect(cold).toBeLessThan(10_000);
    expect(warm).toBeLessThan(5_000);
    expect(picks).toBeGreaterThan(0);
  }, 300_000);
});
