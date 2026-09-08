import { expect, test, type Page } from '@playwright/test';
import { openHubView, openPrepareNotes } from './support/hub';
import { compileRegion, createTrip as makeTrip, CULTURAL_INTERVIEW, completeQuestionnaire } from './support/trip';

/**
 * WHAT A TRAVELLER SEES OF THE EVIDENCE.
 *
 * The compiler can resolve every fact perfectly and the product is no better for
 * it unless the board and the itinerary say so. These are the tests that stop
 * this phase being a schema nobody reads: a card that shows its sources, a
 * checklist that names what to book, and — as loudly — the unknowns.
 *
 * Offline throughout, against the synthetic worlds. Nothing here names a real
 * destination.
 */

const DATES = { start: '2026-08-12', end: '2026-08-16' };

async function createTrip(page: Page, destination: string): Promise<string> {
  await makeTrip(page, destination, DATES);
  await page.waitForURL(/\/trips\/[^/]+\/plan/);
  return /\/trips\/([^/]+)\/plan/.exec(page.url())?.[1] ?? '';
}

async function compile(page: Page): Promise<void> {
  await compileRegion(page);
}

/**
 * Through the questionnaire to the board.
 *
 * Real interest answers rather than clicking through: the interests step refuses
 * to advance on "if nearby" for everything, and a board scored against a
 * traveller who said nothing is not the board this test is about.
 */
async function reachBoard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Tell us how you travel' }).click();
  await page.waitForURL(/questionnaire/);

  await completeQuestionnaire(page, CULTURAL_INTERVIEW);

  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await page.waitForURL(/discover/, { timeout: 30_000 });
}

test('a card shows why we trust it, and what nobody publishes', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  /*
    ONE DISCLOSURE PER CARD, NOT TWO.

    The audit trail used to be its own `<details>` on the outside of every card,
    headed "Why we trust this (0 of 6 checked)" — a fraction nobody outside the
    team can act on, attached to a promise of trust it withdraws in the same
    breath, repeated down all twenty-four cards of a live board. It now sits
    inside the card's one disclosure and is headed for what is in it.

    The card is found by the sentence this test is about, which is in the
    document either way — so this cannot silently pick a card that has no
    evidence and then assert nothing.
  */
  const card = page
    .getByRole('article')
    .filter({ hasText: 'Nobody we could read publishes' })
    .first();
  const details = card.locator('details', { hasText: 'More about this place' }).first();

  // Collapsed by default: the audit trail is available, not imposed.
  expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);

  await card.getByText('More about this place').click();
  await expect(details).toHaveAttribute('open', '');

  // Named for what it holds, and the honest half is in the same panel as the
  // citations.
  await expect(
    details.getByText(/What we checked, and where it came from|Where this came from/),
  ).toBeVisible();
  await expect(details.getByText(/Nobody we could read publishes/)).toBeVisible();
});

test('a booking requirement is visible before the traveller commits to the stop', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  /*
   * The four labels the product actually uses, enumerated from
   * `OPERATING_BADGE_LABELS` and `ACCESS_BADGE_LABELS` rather than from memory.
   * "Book ahead" was never one of them — the reservation badge reads "Booking
   * needed" — so this alternation could only ever have matched on its other two
   * arms, and matched on neither once the permit label became "Entry permit".
   */
  await expect(
    page.getByText(/Booking needed|Timed entry|Entry permit|Permit needed/).first(),
  ).toBeVisible();
});

test('the itinerary carries a preparation list built from what the plan schedules', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await expect(build).toBeEnabled({ timeout: 15_000 });
  await build.click();
  await page.waitForURL(/itinerary/, { timeout: 60_000 });
  await openHubView(page, 'prepare');
  await openPrepareNotes(page);

  const prep = page.getByTestId('before-you-go');
  await expect(prep).toBeVisible();
  await expect(prep.getByRole('heading', { name: 'Before you go' })).toBeVisible();

  // Every line names the place it is about, so it can be tied to a day.
  const items = prep.locator('li');
  expect(await items.count()).toBeGreaterThan(0);
  await expect(items.first()).not.toBeEmpty();
});

test('the preparation list survives a refresh, because it is derived from the stored plan', async ({
  page,
}) => {
  const id = await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await page.waitForURL(/itinerary/, { timeout: 60_000 });
  await openHubView(page, 'prepare');
  await openPrepareNotes(page);

  const before = await page.getByTestId('before-you-go').innerText();
  await page.goto(`/trips/${id}/itinerary#prepare`);
  await openPrepareNotes(page);
  await expect(page.getByTestId('before-you-go')).toBeVisible();
  expect(await page.getByTestId('before-you-go').innerText()).toBe(before);
});

test('the evidence surfaces never claim a confidence percentage', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  /**
   * A number beside a fact reads as a measurement. Everything this product knows
   * about how sure it is comes out as a word — "Verified", "One source",
   * "Sources disagree" — precisely because those can be argued with.
   */
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/\b\d{1,3}%\s*(confident|confidence|sure|certain)/i);
  expect(body).not.toMatch(/confidence score/i);
});

test('the evidence panel is reachable and readable by keyboard', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  const card = page
    .getByRole('article')
    .filter({ hasText: 'Nobody we could read publishes' })
    .first();
  const summary = card.locator('summary', { hasText: 'More about this place' }).first();
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  const details = card.locator('details', { hasText: 'More about this place' }).first();
  await expect(details).toHaveAttribute('open', '');
  // Opened by the keyboard, and the evidence is genuinely on screen behind it.
  await expect(details.getByText(/Nobody we could read publishes/)).toBeVisible();
});
