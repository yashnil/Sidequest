import { expect, test } from '@playwright/test';
import {
  completeReview,
  createBenchmarkSessionFromCase,
  expectNothingIdentifying,
  lockAndReveal,
  reachReview,
  seedReviewableSession,
} from './support/benchmark';

/**
 * THE BLINDING, CHECKED AGAINST WHAT WAS ACTUALLY SENT.
 *
 * The offline scan proves the source contains no banned word. This proves the
 * *response* does not, which is a stronger and different claim. Two passes: the
 * rendered document with its scripts removed — markup, attributes, hidden text —
 * and the flight payload, which is where a value handed to a client component
 * travels whether or not any element renders it, and which is one right-click
 * away. That payload is the leak no amount of care in a component prevents.
 *
 * There is exactly one allowance and it is named in `support/benchmark.ts`: the
 * application's root 404 boundary, which Next serialises into every response and
 * which a route inside `/labs` cannot detach from.
 *
 * The last test is the counterweight. A renderer that never reveals anything
 * passes every neutrality assertion perfectly and is also completely broken, so
 * the names have to appear at the end.
 */

test('nothing on the progress or review screens identifies either system', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'blind-clean' });

  await page.goto(`/labs/benchmark/${sessionId}/run`);
  await expect(page.getByTestId('panel-states')).toBeVisible();
  await expectNothingIdentifying(page, 'the progress screen');

  await reachReview(page, sessionId);
  await expectNothingIdentifying(page, 'the review screen');
});

/**
 * The real composer path, before either arm has produced anything.
 *
 * Worth its own test because it is the state the interface will spend most of
 * its life in while the two planners are being written: two runs started, two
 * panels reading `Not started`, one shared clock and no review. A screen that
 * only worked once both plans existed would be a screen nobody could watch.
 */
test('a comparison started from a saved traveller says nothing while it waits', async ({
  page,
}) => {
  const sessionId = await createBenchmarkSessionFromCase(page);

  await expect(page.getByTestId('not-yet-reviewable')).toBeVisible();
  await expectNothingIdentifying(page, 'the progress screen before anything is built');

  /*
   * The review is checked *before* the run is started, not during it.
   *
   * It used to be checked after pressing start, on the assumption that there
   * would be a window in which both arms were still working. Under the fixture
   * providers there is not: a whole comparison now completes in about a second,
   * so the assertion raced the run and lost — and the failure said "a panel
   * appeared" when what had actually happened was that the benchmark got faster.
   *
   * With neither arm started, both panels read as pending, `bothTerminal` is
   * false, and the gate is closed for exactly the reason the gate exists. That is
   * the same invariant, observed at a moment the test controls.
   */
  await page.goto(`/labs/benchmark/${sessionId}/review`);
  await expect(page.getByTestId('panel-A')).toHaveCount(0);
  await expectNothingIdentifying(page, 'the review before either plan was started');

  /*
   * Two presses, and the screen between them is checked as carefully as the
   * others.
   *
   * The first buys the world both arms plan against and puts the follow-up
   * questions on screen; the second says the answers are in. The pause is where
   * a reviewer spends real time, so it is also where a tell would do the most
   * damage — and it is the one screen that did not exist when this spec was
   * first written.
   */
  await page.goto(`/labs/benchmark/${sessionId}/run`);
  await page.getByTestId('start-both').click();
  await expect(page.getByTestId('elapsed')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('start-both')).toHaveCount(0);
  await expectNothingIdentifying(page, 'the progress screen once the question round had opened');
});

test('a part-built and an unbuilt plan are just as anonymous', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, {
    seed: 'blind-broken',
    shape: 'partial_and_failed',
  });

  await reachReview(page, sessionId);
  await expectNothingIdentifying(page, 'the review screen with a failure on it');
});

/**
 * Reload five times.
 *
 * The assignment is drawn once and stored, so nothing about the presentation may
 * move between renders. A layout that reshuffled on refresh would itself be a
 * way to learn the mapping — press reload enough times and whichever panel keeps
 * its content is the one you are tracking.
 */
test('the panel order and content are stable across reloads', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'blind-stable' });
  await reachReview(page, sessionId);

  const readPanels = async () => ({
    order: await page.locator('[data-plan-label]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-plan-label')),
    ),
    bodies: await page.locator('[data-testid="plan-body"]').allInnerTexts(),
  });

  const first = await readPanels();
  /*
   * Both panels, once each, in whichever order the stored draw produced. The
   * order itself is a coin toss and asserting a particular one would be
   * asserting the coin; what must never change is that it is the same order on
   * every render.
   */
  expect([...first.order].sort()).toEqual(['A', 'B']);
  expect(first.bodies).toHaveLength(2);

  for (let reload = 0; reload < 5; reload += 1) {
    await page.reload();
    await expect(page.getByTestId('panel-A')).toHaveCount(1);
    const again = await readPanels();
    expect(again.order).toEqual(first.order);
    expect(again.bodies).toEqual(first.bodies);
    await expectNothingIdentifying(page, `the review screen on reload ${reload + 1}`);
  }
});

/**
 * And the other half: after the lock, the identities do appear.
 *
 * Asserted by name rather than by "something changed", because a report that
 * revealed a placeholder would satisfy a looser check while telling the reviewer
 * nothing at all.
 */
test('the identities appear once the review is locked and opened', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'blind-reveal' });
  await reachReview(page, sessionId);
  await completeReview(page);
  await lockAndReveal(page, sessionId);

  const shown = await page.getByTestId('identities').innerText();
  expect(shown.toLowerCase()).toContain('sidequest');
  expect(shown.toLowerCase()).toContain('baseline');
});

/**
 * The report refuses before the lock, and the refusal is the same whichever way
 * somebody arrived at it.
 */
test('the report refuses to show anything before the review is locked', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'blind-early' });

  await page.goto(`/labs/benchmark/${sessionId}/results`);
  await expect(page.getByTestId('identities')).toHaveCount(0);
  await expect(page.getByTestId('reveal')).toHaveCount(0);
  await expectNothingIdentifying(page, 'the report before the lock');
});
