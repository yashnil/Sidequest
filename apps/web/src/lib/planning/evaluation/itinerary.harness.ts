import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluationBoards } from './boards';
import { PROFILE_CASES } from './profiles';
import { runCase, summarise, type CaseMetrics } from './run';

/**
 * RELEASE CANDIDATE — THE ITINERARY EVALUATION, WRITTEN TO A FILE.
 *
 * Every board (`boards.ts`) crossed with every traveller (`profiles.ts`),
 * through the real assembler, board and planner (`run.ts`). Deterministic and
 * offline: no model, no provider, no database.
 *
 *   npx vitest run -c vitest.harness.config.ts apps/web/src/lib/planning/evaluation/itinerary.harness.ts
 *
 * writes `docs/release-candidate/itinerary/latest.json`; set
 * `SIDEQUEST_ITINERARY_EVAL_OUT` to write somewhere else (the committed
 * `baseline.json` and `after.json` were written that way). Never part of
 * `npm run test`: it is a measurement, not a gate.
 */
const OUT = resolve(process.cwd(), process.env.SIDEQUEST_ITINERARY_EVAL_OUT ?? 'docs/release-candidate/itinerary/latest.json');

describe('itinerary evaluation', () => {
  it('plans every board for every traveller and writes the measurements', () => {
    const boards = evaluationBoards();
    const cases: CaseMetrics[] = [];
    for (const board of boards) for (const profile of PROFILE_CASES) cases.push(runCase(board, profile));
    const summary = summarise(cases);
    const byProfile = Object.fromEntries(PROFILE_CASES.map((p) => [p.key, summarise(cases.filter((c) => c.profile === p.key))]));
    const bySource = Object.fromEntries([...new Set(boards.map((b) => b.source))].map((s) => [s, summarise(cases.filter((c) => c.source === s))]));
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          what: 'Sidequest itinerary evaluation: every board crossed with every traveller, planned by the real assembler, board and planner. Travel times are estimates (no router is recorded for these boards). See apps/web/src/lib/planning/evaluation/.',
          boards: boards.map((b) => ({ key: b.key, label: b.label, source: b.source, bases: b.bases.length, places: b.places.length, nights: b.nights })),
          profiles: PROFILE_CASES,
          summary,
          byProfile,
          bySource,
          cases,
        },
        null,
        1,
      )}\n`,
    );
    const failed = cases.filter((c) => !c.ok);
    expect(failed.map((c) => `${c.board} × ${c.profile}: ${c.error}`)).toEqual([]);
    expect(cases.length).toBe(boards.length * PROFILE_CASES.length);
  }, 600_000);
});
