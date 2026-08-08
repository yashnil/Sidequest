import { chromium, expect, type Page } from '@playwright/test';

/**
 * THE BOUNDED LIVE PILOT.
 *
 * A script, not a test, and outside both runners' globs for the same reason the
 * other `.eval.ts` files are: it spends real money against real providers, and
 * nothing that spends money should be reachable by typing `npm test`.
 *
 * It drives the founder's own path — the composer, the run screen, the wait —
 * through a browser, because a harness that called the orchestrator directly
 * would prove the orchestrator works and prove nothing about the surface the
 * founder is going to use.
 *
 * What it deliberately does not do: submit a rating. The primary metric of this
 * benchmark is a human's blind forced choice, and a script that produced one
 * would be manufacturing the finding the whole exercise exists to collect. The
 * sessions it leaves behind are unlocked and unreviewed, which is exactly the
 * state the founder should find them in.
 *
 * Usage, with the app already running on the given port with live switches and
 * a budget:
 *
 *   node --experimental-strip-types e2e/live/benchmark-pilot.eval.ts
 *
 * Environment:
 *   SIDEQUEST_BASE_URL   default http://127.0.0.1:4300
 *   SIDEQUEST_PILOT_CASES  comma-separated case ids; defaults to the two the
 *                          goal asks for — a well-covered transit city, and a
 *                          broad or weak-data destination.
 *   SIDEQUEST_PILOT_DEADLINE_MS  per pair; default 15 minutes.
 *   SIDEQUEST_PILOT_QUESTION_DEADLINE_MS  waiting for the question round to
 *                          open; default 12 minutes.
 */

const BASE_URL = process.env.SIDEQUEST_BASE_URL ?? 'http://127.0.0.1:4300';

/**
 * Pair one is a dense transit city with strong open data; pair two is the
 * opposite end of the library. Two cases rather than sixteen because this is a
 * bounded pilot, and because the second one is where a planner is most likely to
 * be caught inventing.
 */
const CASES = (process.env.SIDEQUEST_PILOT_CASES ?? 'city-transit-tokyo,weak-data-sao-tome')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const DEADLINE_MS = Number(process.env.SIDEQUEST_PILOT_DEADLINE_MS ?? 15 * 60_000);

/**
 * How long to wait for the question round to open.
 *
 * Separate from the plan deadline because it is a different wait: buying a
 * region's places, routes, hours and forecast, with no model call in it at all.
 */
const QUESTION_ROUND_DEADLINE_MS = Number(
  process.env.SIDEQUEST_PILOT_QUESTION_DEADLINE_MS ?? 12 * 60_000,
);

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface PairResult {
  caseId: string;
  sessionId: string | null;
  reachedReview: boolean;
  elapsedMs: number;
  note: string;
}

async function runPair(page: Page, caseId: string): Promise<PairResult> {
  const started = Date.now();
  const fail = (note: string, sessionId: string | null = null): PairResult => ({
    caseId,
    sessionId,
    reachedReview: false,
    elapsedMs: Date.now() - started,
    note,
  });

  await page.goto(`${BASE_URL}/labs/benchmark/new`);
  const select = page.getByTestId('case-select');
  try {
    await select.waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    return fail('The composer never became usable.');
  }

  await select.selectOption(caseId);
  await page.getByTestId('composer-submit-saved').click();
  try {
    await page.waitForURL(/\/labs\/benchmark\/[^/]+\/run/, { timeout: 60_000 });
  } catch {
    return fail('The session was not created.');
  }

  const sessionId = decodeURIComponent(/\/labs\/benchmark\/([^/]+)\/run/.exec(page.url())?.[1] ?? '');
  say(`  session ${sessionId}`);

  /*
   * WAIT FOR THE PAGE TO BE ALIVE BEFORE PRESSING ANYTHING.
   *
   * The control is a server action bound to a form, and a bound function action
   * has no HTML fallback: before hydration the button is on screen and pressing
   * it does nothing at all. This script used to click the instant the URL
   * settled, so the press was swallowed, no run rows appeared, and it then
   * polled for a control that would never render until its whole deadline
   * expired — reporting the pair as incomplete without a single provider call
   * having been made.
   *
   * The offline suite has a helper for exactly this. This is the same wait,
   * written out because a script outside the test runner cannot import it.
   */
  const start = page.getByTestId('start-both');
  await start.waitFor({ state: 'visible', timeout: 30_000 });
  // Press, then confirm it took: the run rows are written synchronously by the
  // action, so the control disappearing is the acknowledgement.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await start.first().click();
    try {
      await expect(start).toHaveCount(0, { timeout: 10_000 });
      break;
    } catch {
      if (attempt === 5) return fail('The start control never took a press.', sessionId);
      await page.reload();
      await start.waitFor({ state: 'visible', timeout: 30_000 });
    }
  }

  /*
   * THE QUESTION ROUND, PASSED THROUGH WITHOUT ANSWERING ANYTHING.
   *
   * The first press buys the world and puts the follow-up questions on screen;
   * the second says the answers are in. This script presses the second and
   * answers nothing, deliberately.
   *
   * A traveller's answer to "would you move to a second place to sleep" is a
   * preference, and a script inventing one would be manufacturing exactly the
   * kind of input this benchmark exists to collect from a person — the same
   * objection as inventing a rating, applied one screen earlier. So the
   * questions are left unanswered, they are recorded as unanswered, and the
   * founder's own sessions are where answered ones come from.
   *
   * What that costs is real and is stated in the results: these pairs show what
   * both planners do with the shared request alone.
   */
  const planDeadline = Date.now() + QUESTION_ROUND_DEADLINE_MS;
  let asked = 0;
  let planned = false;
  while (Date.now() < planDeadline) {
    const plan = page.getByTestId('plan-both');
    if (await plan.count()) {
      asked = await page
        .getByTestId('pooled-questions')
        .locator('li')
        .count()
        .catch(() => 0);
      // Same acknowledgement as the first press: the control is gated on the
      // state the action requires, so it going away is the press landing.
      await plan.first().click();
      try {
        await expect(plan).toHaveCount(0, { timeout: 15_000 });
        planned = true;
        break;
      } catch {
        await page.reload();
        continue;
      }
    }
    await page.waitForTimeout(5_000);
    await page.reload();
  }
  if (!planned) return fail('The question round never opened, or the second press never took.', sessionId);
  say(`  ${asked} follow-up question(s) were asked and left unanswered by design`);

  /*
   * Wait on the screen's own readiness signal rather than on a duration.
   *
   * A wall-clock sleep would either be too short for a cold compile — the
   * measured ones run to ten minutes — or long enough to hide a run that died in
   * the first thirty seconds. The review link appears when both arms have
   * stopped, whichever way they stopped, which is the only thing worth waiting
   * for.
   */
  const deadline = Date.now() + DEADLINE_MS;
  let reachedReview = false;
  while (Date.now() < deadline) {
    const link = page.getByTestId('to-review');
    if (await link.count()) {
      reachedReview = true;
      break;
    }
    await page.waitForTimeout(5_000);
    await page.reload();
  }

  return {
    caseId,
    sessionId,
    reachedReview,
    elapsedMs: Date.now() - started,
    note: reachedReview ? 'Both arms stopped; the session is reviewable.' : 'Deadline reached before both arms stopped.',
  };
}

async function main(): Promise<void> {
  say(`Live benchmark pilot against ${BASE_URL}`);
  say(`Cases: ${CASES.join(', ')}`);
  say('');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results: PairResult[] = [];

  try {
    for (const caseId of CASES) {
      say(`— ${caseId}`);
      const result = await runPair(page, caseId);
      results.push(result);
      say(`  ${result.reachedReview ? 'reviewable' : 'incomplete'} after ${Math.round(result.elapsedMs / 1000)}s — ${result.note}`);
      say('');
    }
  } finally {
    await browser.close();
  }

  say('Summary');
  for (const result of results) {
    say(`  ${result.caseId}: session=${result.sessionId ?? 'none'} reviewable=${result.reachedReview} seconds=${Math.round(result.elapsedMs / 1000)}`);
  }
  say('');
  say('No ratings were submitted. The sessions are unlocked and unreviewed by design.');
}

await main();
