import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { destinationCatalog } from '@sidequest/core';
import { SCENARIOS } from '../../../../../packages/core/src/advisor/eval/scenarios';
import { runScenario } from '../../../../../packages/core/src/advisor/eval/run';

/**
 * EVERY EVALUATION SCENARIO, AS ONE REPORT. Not part of `npm run test`: it
 * writes a file. Run with the harness config:
 *
 *   SIDEQUEST_COMPARE_OUT=<file.json> npx vitest run --config vitest.harness.config.ts
 *
 * This was the before/after harness of the 2026-10 rebuild: it ran the
 * previous ranker and the advisor on the same inputs, and the comparison it
 * produced is recorded in `docs/destination-discovery/REPORT.md`. The previous
 * ranker has been removed, so there is no "before" left to run; what remains
 * is the advisor's half, in the same row shape (`after`), so a report written
 * today can still be read beside the recorded one.
 */
describe('advisor scenario report', () => {
  it('ranks every scenario', () => {
    const catalog = destinationCatalog();
    const rows = [];
    for (const scenario of SCENARIOS) {
      const after = runScenario(scenario, catalog);
      rows.push({
        id: scenario.id,
        title: scenario.title,
        text: scenario.text,
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
