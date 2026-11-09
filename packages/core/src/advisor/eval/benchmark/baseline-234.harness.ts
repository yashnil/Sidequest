import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers } from '../../../schemas/composer';
import { buildAdvisorShortlist } from '../../advise';
import { destinationCatalog, DESTINATION_CATALOG_VERSION } from '../../catalog/index';
import { parseTravelRequest } from '../../parse';
import { BENCH_REQUESTS } from './requests';

/**
 * FREEZES THE 234-DESTINATION RECOMMENDER'S ANSWERS TO THE BENCHMARK.
 *
 * Run once, at the last commit before the global recommender
 * (`596ece1`), and committed as `docs/global-destinations/baseline/baseline-234.json`.
 * To reproduce it later: check that commit out in a worktree, copy this file
 * and `requests.ts` beside it, and run
 *
 *     npx vitest run --config vitest.harness.config.ts packages/core/src/advisor/eval/benchmark/baseline-234.harness.ts
 *
 * It uses only what that commit exports — the parser, the catalog and
 * `buildAdvisorShortlist` — and no clock beyond `NOW`, so the output is
 * byte-stable. Never part of `npm run test`.
 */

const NOW = new Date('2026-11-08T12:00:00Z');
const OUT = fileURLToPath(new URL('../../../../../../docs/global-destinations/baseline/baseline-234.json', import.meta.url));

describe('baseline: the 234-destination advisor on the global benchmark', () => {
  it('writes every shortlist', () => {
    const catalog = destinationCatalog();
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));
    const runs = BENCH_REQUESTS.map((request) => {
      const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
      const parsed = parseTravelRequest(request.text, base, NOW);
      const started = performance.now();
      const shortlist = buildAdvisorShortlist({ answers: parsed.answers, catalog, catalogVersion: DESTINATION_CATALOG_VERSION, now: NOW });
      const ms = performance.now() - started;
      const row = (pick: (typeof shortlist.picks)[number]) => {
        const entry = byId.get(pick.id)!;
        return {
          id: pick.id,
          name: pick.name,
          context: pick.context,
          countries: pick.countries,
          center: pick.center,
          kind: pick.kind,
          wikidataId: pick.wikidataId ?? null,
          score: pick.score,
          coverage: pick.coverage,
          cost: entry.cost,
          familiarity: entry.familiarity,
          car: entry.access.car,
          family: entry.family,
          experiences: entry.experiences,
          why: pick.why,
        };
      };
      return {
        id: request.id,
        category: request.category,
        text: request.text,
        readings: parsed.readings.map((reading) => `${reading.kind}: ${reading.label}`),
        picks: shortlist.picks.map(row),
        alternates: shortlist.alternates.map(row),
        relaxation: shortlist.readout.relaxation,
        eligible: shortlist.stats.eligible,
        excluded: shortlist.stats.excluded,
        ms: Math.round(ms * 100) / 100,
      };
    });
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      `${JSON.stringify({ system: 'advisor-234', commit: '596ece1', catalogVersion: DESTINATION_CATALOG_VERSION, catalog: catalog.length, now: NOW.toISOString(), requests: runs.length, runs }, null, 1)}\n`,
    );
    expect(runs.length).toBe(BENCH_REQUESTS.length);
  });
});
