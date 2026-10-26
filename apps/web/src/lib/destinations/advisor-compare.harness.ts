import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { destinationCatalog, type FocusKey, type TripComposerAnswers, type TripTheme } from '@sidequest/core';
import { SCENARIOS } from '../../../../../packages/core/src/advisor/eval/scenarios';
import { runScenario } from '../../../../../packages/core/src/advisor/eval/run';

/**
 * BEFORE AND AFTER, ON THE SAME INPUTS. Not part of `npm run test`: it reads a
 * real destination index (a copy, via SIDEQUEST_DB_PATH) and runs the previous
 * ranker once per scenario. Run with the harness config:
 *
 *   SIDEQUEST_DB_PATH=<copy.db> SIDEQUEST_COMPARE_OUT=<file.json> \
 *     npx vitest run --config vitest.harness.config.ts
 *
 * The previous ranker reads `themes`; the advisor's interests are mapped back
 * onto them so it ranks the same request.
 */
const THEMES: Record<FocusKey, TripTheme[]> = {
  mountains: ['mountains'],
  hiking: ['outdoors'],
  wildlife: ['wildlife'],
  lakes: ['water'],
  beaches: ['water'],
  rainforest: ['outdoors'],
  road_trips: ['outdoors'],
  desert: ['outdoors'],
  volcanoes: ['outdoors'],
  snow: ['outdoors'],
  culture_food: ['culture', 'food'],
  cities: ['cities'],
};

describe('advisor before/after', () => {
  it('ranks every scenario with both systems', async () => {
    process.env.SIDEQUEST_CLIMATE_PROVIDER = 'fixture';
    const { recommendDestinations } = await import('./recommend');
    const catalog = destinationCatalog();
    const rows = [];
    for (const scenario of SCENARIOS) {
      const after = runScenario(scenario, catalog);
      const themes = [...new Set((after.answers.discovery?.focus ?? []).flatMap((key) => THEMES[key]))];
      const oldAnswers: TripComposerAnswers = { ...after.answers, themes: themes.length > 0 ? themes : after.answers.themes };
      const started = Date.now();
      const before = await recommendDestinations({ answers: oldAnswers, now: new Date('2026-10-26T12:00:00Z') });
      rows.push({
        id: scenario.id,
        title: scenario.title,
        text: scenario.text,
        before: {
          ms: Date.now() - started,
          picks: before.picks.slice(0, 3).map((pick) => ({ name: pick.qualifiedName, type: pick.featureType, score: pick.score, coverage: pick.coverage })),
          distinctScores: new Set(before.picks.map((pick) => pick.score)).size,
          picksShown: before.picks.length,
        },
        after: {
          ms: after.ms,
          asked: after.asked,
          skipped: after.skipped,
          stop: after.stopReason,
          picks: after.shortlist.picks.map((pick) => ({ name: `${pick.name}, ${pick.context}`, kind: pick.kind, score: pick.score, coverage: pick.coverage, signature: pick.signature })),
          alternates: after.shortlist.alternates.map((pick) => pick.name),
          checks: after.checks.map((check) => ({ kind: check.check.kind, pass: check.pass, detail: check.detail })),
          regions: after.regions,
          spread: after.shortlist.readout.spread,
          relaxation: after.shortlist.readout.relaxation,
        },
      });
    }
    writeFileSync(process.env.SIDEQUEST_COMPARE_OUT ?? 'advisor-compare.json', JSON.stringify(rows, null, 2));
  }, 600_000);
});
