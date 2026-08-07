import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, compileRegion } from './support/trip';

/**
 * A CHOICE MADE AFTER THE BUILD FINISHED IS STILL ACCOUNTED FOR.
 *
 * The defect this exists to catch is not that reconciliation was wrong — it was
 * that reconciliation was a single *event*. The compile finished, one account
 * was written, and the provisional board stayed interactive afterwards, so
 * anything marked from that moment on had no reconciliation state at all: not
 * accounted for, not recorded as outstanding, and not mentioned — while the
 * panel above the board said "the full record — all N decisions you made".
 *
 * So this drives the awkward order on purpose. The region is compiled *first*,
 * and only then does the traveller go back and mark cards. Every assertion
 * below would have passed against the old code by accident except the ones that
 * matter: that the marks appear at all, and that the count the panel claims is
 * the count it holds.
 *
 * Deterministic rather than raced: `compileRegion` returns only once the build
 * has finished, so "after the account exists" is a fact about this test rather
 * than a hope about its timing. Nothing here sleeps.
 *
 * The last section resizes to a phone, because the full record is four columns
 * of whole sentences and 390 px is where that stops being a table anybody reads.
 */

const PHONE = { width: 390, height: 844 };

/** Mark the first n cards on the provisional board as must-dos. */
async function markMustDos(page: Page, tripId: string, count: number): Promise<string[]> {
  await page.goto(`/trips/${tripId}/provisional`);
  const cards = page.getByTestId('provisional-card');
  await expect(cards.first()).toBeVisible();

  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    /*
     * The card's own name node rather than the wrapper: the wrapper's text is
     * name plus locality, which does not survive a round trip through a filter.
     * Always the first card, because marking one as a must-do leaves it in
     * place — unlike hiding, which removes it.
     */
    const card = cards.nth(index);
    names.push((await card.locator('.font-display').first().innerText()).trim());
    await card.getByRole('button', { name: 'Must do' }).click();
    await expect(card.getByRole('button', { name: 'Must do' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  return names;
}

/**
 * Answer the questionnaire and build the board.
 *
 * The walk itself is `completeQuestionnaire` in `support/trip.ts` — shared,
 * because the version that used to live here pressed "Continue" a fixed number
 * of times, gave up silently at step 3 of 9, and then spent thirty seconds
 * waiting for a URL nothing was going to navigate to.
 */
async function reachDiscoveryBoard(page: Page, tripId: string): Promise<void> {
  await page.goto(`/trips/${tripId}/questionnaire`);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await page.waitForURL(/discover/, { timeout: 30_000 });
}

test('choices made after the build are accounted for, and the account reads on a phone', async ({
  page,
}) => {
  const tripId = await createTrip(page, 'Harbour City');
  await compileRegion(page);

  // The build is over and the account, if there is one, has been written.
  const marked = await markMustDos(page, tripId, 2);
  expect(marked, 'the provisional board should have cards to mark').toHaveLength(2);

  await reachDiscoveryBoard(page, tripId);

  /*
   * Something has to say what became of those two marks. Either the account
   * names them, or the page says plainly that they are still waiting — what it
   * must never do is show a board with no mention of them at all.
   */
  const panel = page.getByTestId('reconciliation-panel');
  await expect(panel).toBeVisible();

  const record = page.getByTestId('reconciliation-history');
  await record.locator('summary').click();

  const rows = record.locator('tbody tr');
  await expect(rows).toHaveCount(marked.length);

  const recordText = await record.innerText();
  for (const name of marked) expect(recordText).toContain(name);

  /*
   * The claim in the summary has to be the number of rows underneath it. This
   * is the sentence the old model made false the moment somebody marked a
   * thirteenth card.
   */
  expect(recordText).toContain(`all ${marked.length} decisions you made`);

  /*
   * No raw identity where a name goes, and no invented board version. Both were
   * real: a superseded card rendered its own id, and an entry with no recorded
   * board rendered "v" followed by nothing.
   */
  expect(recordText, 'a raw place identity leaked into the record').not.toMatch(
    /\b(?:place|poi|osm)[/:][\w/:-]+/i,
  );
  expect(recordText, 'an unrecorded board version rendered as a broken label').not.toMatch(
    /v(?:undefined|null|NaN)/,
  );

  /*
   * At 390 px the four-column table is replaced by the stacked presentation, and
   * only one of the two is in the accessibility tree at a time.
   */
  await page.setViewportSize(PHONE);
  await expect(record.getByTestId('reconciliation-history-stacked')).toBeVisible();
  await expect(record.locator('table')).toBeHidden();

  // And the controls on this panel are pressable with a thumb (WCAG 2.5.5).
  const refresh = page.getByTestId('weather-refresh');
  await expect(refresh).toBeVisible();
  const box = await refresh.boundingBox();
  expect(box!.height, 'the weather refresh is under the minimum target size').toBeGreaterThanOrEqual(
    44,
  );
});
