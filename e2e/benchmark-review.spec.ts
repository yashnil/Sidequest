import { expect, test } from '@playwright/test';
import { completeReview, reachReview, seedReviewableSession, showPanel } from './support/benchmark';

/**
 * THE RULES THE REVIEW ENFORCES, EXERCISED THROUGH THE INTERFACE.
 *
 * Every one of these is guarded in SQL as well, and that is the point of testing
 * them here: the browser is where somebody would find the hole. A disabled
 * button and a second tab are not the same guarantee, and this file is the one
 * that opens the second tab.
 */

test('a locked review cannot be locked again', async ({ page, context }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'review-double-lock' });

  await reachReview(page, sessionId);
  await completeReview(page);
  // The draft is written on a delay, so the second tab has something complete
  // to load rather than an empty form with a disabled button.
  await expect(page.getByTestId('lock-open')).toBeEnabled();
  await page.waitForTimeout(1_500);

  const second = await context.newPage();
  await reachReview(second, sessionId);
  await expect(second.getByTestId('lock-open')).toBeEnabled();

  await page.getByTestId('lock-open').click();
  await page.getByTestId('lock-confirm').click();
  await page.waitForURL(new RegExp(`/labs/benchmark/[^/]+/results`));

  /*
   * The second tab still believes it can lock, which is exactly the situation
   * the repository's `WHERE review_locked_at IS NULL` exists for. It gets a
   * refusal, and the refusal says nothing about either system.
   */
  await second.getByTestId('lock-open').click();
  await second.getByTestId('lock-confirm').click();
  await expect(second.getByTestId('lock-error')).toContainText('already locked');
  await second.close();
});

test('a part-built and an unbuilt plan are both still reviewable', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, {
    seed: 'review-broken',
    shape: 'partial_and_failed',
  });
  await reachReview(page, sessionId);

  await showPanel(page, 'A');
  await showPanel(page, 'B');

  /*
   * A failure is a legitimate reason to prefer the other plan, so the forced
   * choices are still asked — and "cannot judge" is offered on every one of
   * them, because forcing a judgement about a plan that does not exist produces
   * noise indistinguishable from a real low score.
   */
  const cannotJudge = page.locator('input[type=radio][name^="choice-"][value="cannot_judge"]');
  expect(await cannotJudge.count()).toBe(6);
  await cannotJudge.first().check();
  await expect(cannotJudge.first()).toBeChecked();
});

test('a plan can be marked unrateable, and the review still locks', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, {
    seed: 'review-unrateable',
    shape: 'partial_and_failed',
  });
  await reachReview(page, sessionId);

  await completeReview(page, { choice: 'A' });
  await showPanel(page, 'B');
  const panelB = page.getByTestId('panel-B');
  await panelB.getByRole('checkbox', { name: 'I cannot rate this one' }).check();
  await panelB.getByLabel('Why not').fill('It stopped before there was anything to read.');

  await expect(page.getByTestId('lock-open')).toBeEnabled();
  await page.getByTestId('lock-open').click();
  await page.getByTestId('lock-confirm').click();
  await page.waitForURL(new RegExp(`/labs/benchmark/[^/]+/results`));
});

/**
 * Three rounds, and the fourth refused.
 *
 * The bound is per system and enforced by a unique index, and the interface's
 * job is to report the refusal in words that do not say which arm ran out —
 * which, since the rounds are always claimed in pairs, it never has to.
 */
test('a fourth change request is refused', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'review-corrections' });
  await reachReview(page, sessionId);

  const box = page.getByLabel('What should change?');
  const send = page.getByTestId('correction-send');
  const note = page.getByTestId('correction-note');

  for (let round = 1; round <= 3; round += 1) {
    await box.fill(`Please move the long drive off day ${round}.`);
    await send.click();
    await expect(note).toContainText('Sent to both', { timeout: 15_000 });
    await expect(page.getByText(`Rounds used: ${round} / 3`)).toBeVisible();
  }

  await box.fill('One more change, please.');
  await send.click();
  await expect(note).toContainText('as many rounds as they are allowed', { timeout: 15_000 });
});

/**
 * One box, both plans. There is deliberately no way to address one of them, and
 * a per-plan control appearing later would let a reviewer tune one system.
 */
test('there is exactly one correction box, and it addresses both', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'review-one-box' });
  await reachReview(page, sessionId);

  await expect(page.getByLabel('What should change?')).toHaveCount(1);
  await expect(page.getByTestId('correction-send')).toHaveCount(1);
  await expect(page.getByText('sent to both plans word for word')).toBeVisible();
});
