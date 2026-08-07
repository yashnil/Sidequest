import { chromium } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PlaywrightJourneyDriver, SqliteJourneyStore } from './adapters.ts';
import {
  budgetFromEnv,
  budgetViolations,
  provisionalDeadline,
  renderMeasurements,
  runLiveJourney,
  systemClock,
} from '../support/live-journey.ts';

/**
 * THE PHASE-12 LIVE JOURNEY, MEASURED.
 *
 * Run by hand against a dev server carrying the open provider stack. Not part of
 * the test suite and deliberately outside its glob: everything here spends real
 * money on somebody else's infrastructure, which is the opposite of what an
 * automated suite may do.
 *
 * This file is now an adapter and nothing else. The journey lives in
 * `e2e/support/live-journey.ts` and is tested offline in `e2e/live/harness.test.ts`
 * against a fake clock and a fake database — because the previous version of
 * this script was the *only* thing that had ever executed the journey, and its
 * five defects were therefore invisible until they had already cost a
 * destination's worth of verification:
 *
 *   1. a ten-minute provisional-board window around a ten-and-a-half-minute
 *      compile, so the board — persisted, 45 cards, version 1 — was reported as
 *      `null`;
 *   2. `/discover` opened without completing a questionnaire, which redirects,
 *      so three board-level fields were measuring the questionnaire;
 *   3. `getByRole('article')` on the provisional board, which renders none;
 *   4. `.catch(() => 0)` turning unavailable measurements into product zeros;
 *   5. the throwaway database deleted before the assertions were finished, so
 *      Bali's board behaviour is permanently unverifiable for that run.
 *
 * Usage:
 *   node --experimental-strip-types e2e/live/phase-12.eval.ts "New York" ny 2027-05-10 2027-05-14 "One base"
 *
 * Environment:
 *   SIDEQUEST_BASE_URL          default http://localhost:4200
 *   SIDEQUEST_DB_PATH           default ./apps/web/data/live.db
 *   SIDEQUEST_EVAL_TRANSPORT    default Drive
 *   SIDEQUEST_EVAL_COMPILE_MS   the bounded evaluation deadline, default 45 min
 *   SIDEQUEST_EVAL_TEARDOWN     'delete' to remove a throwaway database *after*
 *                               the report is written; anything else keeps it
 */

const BASE = process.env.SIDEQUEST_BASE_URL ?? 'http://localhost:4200';
const OUT = 'test-results/live';
const DB = process.env.SIDEQUEST_DB_PATH ?? './apps/web/data/live.db';

const destination = process.argv[2] ?? 'Kyrgyzstan';
const slug = process.argv[3] ?? 'kg';
const start = process.argv[4] ?? '2027-07-05';
const end = process.argv[5] ?? '2027-07-16';
const strategy = process.argv[6] ?? 'Two bases';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const budget = budgetFromEnv(process.env);
  const violations = budgetViolations(budget);
  if (violations.length > 0) {
    /*
     * A budget that cannot hold its own invariants is refused before a browser
     * opens, because the alternative is spending money to produce a report that
     * already fails its integrity walk.
     */
    process.stderr.write(`refusing to run — budget violations: ${violations.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }

  const since = new Date().toISOString();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const store = new SqliteJourneyStore(DB, since);
  const driver = new PlaywrightJourneyDriver(context, page, {
    baseUrl: BASE,
    outDir: OUT,
    slug,
    strategyTimeoutMs: budget.preflightMs,
    transport: process.env.SIDEQUEST_EVAL_TRANSPORT ?? 'Drive',
  });

  const reportPath = `${OUT}/${slug}-phase12.json`;

  const run = await runLiveJourney(
    {
      clock: systemClock,
      store,
      driver,
      /*
       * Publication is the thing teardown waits for, so it is written to disk
       * *and* fsync'd by `writeFileSync` before this resolves. Printing to
       * stdout as well, because a report that only exists in a file somebody
       * has to go and find is a report that gets summarised from memory.
       */
      publish: (report) => {
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      },
      /*
       * THE DATABASE OUTLIVES THE REPORT, AND OPT-IN AT THAT.
       *
       * Deleting a throwaway database while assertions were still outstanding is
       * why one of two live destinations has no board-level record at all. The
       * journey will not call this until `publish` has resolved; this end adds
       * the second guard — it keeps a copy beside the report, so even a
       * deliberate teardown leaves the evidence inspectable.
       */
      teardown:
        process.env.SIDEQUEST_EVAL_TEARDOWN === 'delete'
          ? () => {
              copyFileSync(DB, `${OUT}/${slug}-teardown-copy.db`);
              store.close();
              rmSync(DB, { force: true });
            }
          : () => {
              store.close();
            },
    },
    {
      destination,
      slug,
      start,
      end,
      strategy,
      transport: process.env.SIDEQUEST_EVAL_TRANSPORT ?? 'Drive',
      themes: ['Mountains and high country', 'Hiking and being outside'],
      marks: 3,
      budget,
    },
  );

  await browser.close();

  /*
   * A one-screen summary of what was and was not established, printed last so it
   * is the thing on screen when the run ends. The full report is in the file.
   */
  process.stdout.write(
    [
      '',
      `=== ${destination} — harness ${run.report.harnessVersion} ===`,
      `report:       ${reportPath}${run.published ? '' : '  (NOT WRITTEN)'}`,
      `deadline:     compile ${Math.round(budget.compileMs / 1000)}s, provisional ${Math.round(
        provisionalDeadline(budget) / 1000,
      )}s`,
      `teardown:     ${run.teardownPerformed ? 'performed after publication' : 'not performed'}`,
      '',
      /*
       * Every field, measured and not, through the one renderer. Printing only
       * the gaps meant a reader had to hold two lists in their head to work out
       * which numbers in the JSON were real; printing all of them through
       * `renderMeasurement` means an absence and a zero are one line apart and
       * visibly different.
       */
      ...renderMeasurements(run.report.measurements),
      '',
      `failures:     ${run.report.harnessFailures.length}`,
      ...run.report.harnessFailures.map(
        (failure) => `  - [${failure.kind}] ${failure.step}: ${failure.detail}`,
      ),
      `not measured: ${run.report.notMeasured.length}`,
      ...run.report.notMeasured.map((entry) => `  - ${entry.field}: ${entry.reads}`),
      '',
    ].join('\n'),
  );

  if (!run.report.ok) process.exitCode = 1;
}

void main();
