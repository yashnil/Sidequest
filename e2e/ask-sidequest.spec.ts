import { expect, test } from '@playwright/test';
import { completeQuestionnaire, createTrip } from './support/trip';

/**
 * ASK SIDEQUEST, REACHABLE AND HONEST.
 *
 * PRODUCTION LOCK V5 §43. What this proves is the part unit tests cannot: the
 * panel is on the finished trip, it opens, it takes a request, and — running
 * against the fixture composer, which cannot invent a change — it comes back
 * with a sentence rather than an error page or a silent nothing.
 *
 * It deliberately does not assert an itinerary change. The browser suite runs
 * offline against saved fixtures and spends no model call, so a real edit has no
 * business happening here; that belongs to the live pass.
 *
 * The negative half matters as much: no graph vocabulary reaches the traveller
 * (§44), and the panel never appears in print.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

test.describe('Ask Sidequest', () => {
  test('is on the finished trip, opens, and answers without showing any of its own machinery', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes', { start: AUGUST.start, end: AUGUST.end });
    await completeQuestionnaire(page);
    await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
    await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
    await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });

    const open = page.getByTestId('ask-sidequest-open');
    await expect(open).toBeVisible();
    await open.click();

    const sheet = page.getByTestId('ask-sidequest-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Ask Sidequest' })).toBeVisible();
    /* The blank-box problem: a finished trip is a hard prompt to answer, so there are examples. */
    await expect(sheet.getByRole('button', { name: 'Make this less rushed' })).toBeVisible();

    await sheet.getByRole('button', { name: 'Why did you put this here?' }).click();
    /* The fixture path explains rather than edits, which is the honest offline answer. */
    await expect(sheet.getByText(/saved fixtures/i)).toBeVisible({ timeout: 20_000 });

    /* §44 — none of the graph's vocabulary reaches a traveller. */
    const text = (await sheet.innerText()).toLowerCase();
    for (const word of ['blast radius', 'checkpoint', 'interrupt', 'thread', 'langgraph', 'patch', 'node', 'activity:', 'trip_fact:', 'day:1:']) {
      expect(text, word).not.toContain(word);
    }

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('is not part of the printed packet', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes', { start: AUGUST.start, end: AUGUST.end });
    await completeQuestionnaire(page);
    await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
    await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
    await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });

    await expect(page.getByTestId('ask-sidequest-open')).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('ask-sidequest-open')).toBeHidden();
  });
});
