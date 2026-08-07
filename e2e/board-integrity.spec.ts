import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, reachScope } from './support/trip';

/**
 * WHAT THE BOARD IS, SAID OUT LOUD.
 *
 * `BoardIntegrity` was computed on every build and rendered on no screen, and so
 * was `ProvisionalBoard.counts`. The consequence is not a missing feature but a
 * wrong impression: a board that quietly set records aside looks exactly like a
 * destination with little in it.
 *
 * These are the assertions that make the difference visible — and, just as
 * importantly, that the panel stays *silent* about everything the artifact does
 * not actually record. A permanent "0 practical stops set aside" would be worse
 * than saying nothing.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

/** The authored fixture, which reaches a board with no provider switched on. */
async function reachAuthoredBoard(page: Page): Promise<void> {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await expect(page.getByRole('heading', { name: 'What are you actually here for?' })).toBeVisible();
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
}

test('the discovery board says how much is here, in words and numbers', async ({ page }) => {
  await reachAuthoredBoard(page);

  const panel = page.getByTestId('board-integrity');
  await expect(panel).toBeVisible();

  // A count of things to choose between, and a count of kinds. Both real.
  await expect(panel.getByTestId('board-integrity-fact-attractions')).toBeVisible();
  const attractions = Number(
    await panel.getByTestId('board-integrity-fact-attractions').innerText(),
  );
  expect(attractions).toBeGreaterThan(0);

  // The sentence carries a number rather than an adjective.
  await expect(panel.getByTestId('board-integrity-summary')).toContainText(/\d/);
});

/**
 * The rule that keeps the panel from inventing facts.
 *
 * `refused['utility_role']` is structurally near zero on every artifact the live
 * provider produces — the inventory separates support from candidates long
 * before a board sees either — and the authored fixture writes no role tags at
 * all, so `roleUnknown === admitted`. Neither of those is a fact about this
 * board, and neither may appear.
 */
test('the board claims nothing the artifact does not record', async ({ page }) => {
  await reachAuthoredBoard(page);

  const panel = page.getByTestId('board-integrity');
  await expect(panel).toBeVisible();

  for (const fact of [
    'supportKeptSeparately',
    'withheldUnplaceable',
    'removedOutOfScope',
    'removedUtilityRole',
    'roleUnclassified',
  ]) {
    await expect(panel.getByTestId(`board-integrity-fact-${fact}`)).toHaveCount(0);
  }

  // And no "0 …" anywhere, which is what a fabricated count looks like on screen.
  const values = await panel.locator('dd').allInnerTexts();
  expect(values.every((value) => value.trim() !== '0')).toBe(true);
});

/**
 * The same verdict twice, from the same artifact.
 *
 * A refresh re-derives the whole reading from the stored compiled region, so a
 * panel that moved between two renders of one artifact would be describing
 * something other than the artifact.
 */
test('the same integrity state renders after a refresh', async ({ page }) => {
  await reachAuthoredBoard(page);

  const state = page.getByTestId('board-integrity').locator('[data-board-state]');
  const before = await state.getAttribute('data-board-state');
  const summary = await page.getByTestId('board-integrity-summary').innerText();
  expect(before).toBeTruthy();

  await page.reload();

  await expect(page.getByTestId('board-integrity')).toBeVisible();
  await expect(
    page.getByTestId('board-integrity').locator('[data-board-state]'),
  ).toHaveAttribute('data-board-state', before!);
  await expect(page.getByTestId('board-integrity-summary')).toHaveText(summary);
});

/**
 * Nothing on this panel is an identifier with its underscores out.
 *
 * `replace(/_/g, ' ')` is the exact mechanism that put "hot spring, scenic
 * drive" in front of a traveller, and `stageLabel` exists to refuse it. This is
 * the browser-visible form of that rule.
 */
test('the panel renders no compiler identifier', async ({ page }) => {
  await reachAuthoredBoard(page);

  const text = await page.getByTestId('board-integrity').innerText();
  expect(text, 'a snake_case identifier reached the panel').not.toMatch(/[a-z]_[a-z]/);
  // The de-underscored form is harder to spot and just as wrong: a lowercase,
  // singular, machine-shaped phrase inside a sentence about the traveller.
  expect(text).not.toMatch(/\b(membership unknown|utility role|optional satellite)\b/i);
});

/**
 * THE EMPTY BOARD, EXPLAINED BY THE CONSTRAINT THAT IS ACTUALLY BINDING.
 *
 * `unreachable_region` is the one synthetic world that empties a board, and in
 * it every place is *inside* the radius and simply too far to get to and back
 * from. The copy that used to be here named season, radius and effort — two of
 * which are false in this world — and offered one link that could change only
 * two of the three.
 */
test('an empty board names the binding constraint rather than three plausible ones', async ({
  page,
}) => {
  const id = await createTrip(page, 'Faraway Reaches');
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible({
    timeout: 90_000,
  });

  await page.getByRole('link', { name: 'Tell us how you travel' }).click();
  await page.waitForURL(/questionnaire/);
  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'History & culture: A few times' }).check();
  await page.getByRole('radio', { name: 'Easy nature walks: A few times' }).check();
  for (let step = 0; step < 14; step += 1) {
    const build = page.getByRole('button', { name: 'Build my discovery board' });
    if (await build.isVisible().catch(() => false)) {
      await build.click();
      break;
    }
    const next = page.getByRole('button', { name: 'Continue' });
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForTimeout(150);
  }
  await page.waitForURL(/discover/, { timeout: 30_000 });

  const panel = page.getByTestId('board-integrity');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-board-state]')).toHaveAttribute('data-board-state', 'blocked');

  // The one thing that is actually stopping them.
  await expect(page.getByTestId('board-integrity-summary')).toContainText(
    /further than you have said you will travel in a day/i,
  );

  const text = await panel.innerText();
  // And not the three plausible causes that used to be named here. In this world
  // nothing is out of season and nothing is outside the radius.
  expect(text, 'the season is not what is binding here').not.toMatch(/season/i);
  expect(text, 'the radius is not what is binding here').not.toMatch(/radius/i);

  // A remedy that could move the binding constraint…
  await expect(page.getByTestId('board-recovery-adjust_travel_tolerance')).toBeVisible();
  // …and none for a problem this trip does not have.
  await expect(page.getByTestId('board-recovery-broaden_scope')).toHaveCount(0);
  await expect(page.getByTestId('board-recovery-allow_satellite')).toHaveCount(0);

  // The state survives a refresh, with no provider reachable at any point.
  await page.reload();
  await expect(
    page.getByTestId('board-integrity').locator('[data-board-state]'),
  ).toHaveAttribute('data-board-state', 'blocked');

  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByText(/No trip built yet/i).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// The provisional board
// ---------------------------------------------------------------------------

async function reachProvisionalBoard(page: Page): Promise<string> {
  const tripId = await createTrip(page, 'Faraway Reaches');
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();
  await page.waitForTimeout(2_000);
  await page.goto(`/trips/${tripId}/provisional`);
  await expect(page.getByTestId('provisional-card').first()).toBeVisible();
  return tripId;
}

/**
 * The provisional board's counts are the *persisted* ones, which is what makes
 * this the honest half: `droppedUtilityRole` is written when the board is
 * committed, so it says the same thing on every render whether or not a single
 * provider is reachable.
 */
test('the provisional board says what it is, and says the same after a refresh', async ({
  page,
}) => {
  await reachProvisionalBoard(page);

  const panel = page.getByTestId('board-integrity');
  await expect(panel).toBeVisible();
  const state = await panel.locator('[data-board-state]').getAttribute('data-board-state');
  const summary = await page.getByTestId('board-integrity-summary').innerText();

  await page.reload();
  await expect(
    page.getByTestId('board-integrity').locator('[data-board-state]'),
  ).toHaveAttribute('data-board-state', state!);
  await expect(page.getByTestId('board-integrity-summary')).toHaveText(summary);

  const text = await page.getByTestId('board-integrity').innerText();
  expect(text).not.toMatch(/[a-z]_[a-z]/);
});

/**
 * HIDING WAS A ONE-WAY DOOR.
 *
 * `hidden` is one of four buttons on every card, the view filtered hidden cards
 * out, and no control anywhere brought one back. The mark is stored, so a
 * refresh did not help either — a traveller could reach a blank page and stay
 * there.
 */
test('hiding places is reversible from the board itself', async ({ page }) => {
  await reachProvisionalBoard(page);

  const cards = page.getByTestId('provisional-card');
  const total = await cards.count();
  expect(total).toBeGreaterThan(0);

  await cards.first().getByRole('button', { name: 'Hide it' }).click();
  await expect(cards).toHaveCount(total - 1);

  // The way back appears as soon as anything is hidden, not only when everything is.
  const control = page.getByTestId('hidden-control');
  await expect(control).toBeVisible();
  await control.getByRole('button', { name: 'Show hidden places' }).click();
  await expect(cards).toHaveCount(total);
});

test('hiding every place leaves an explanation and a way back', async ({ page }) => {
  await reachProvisionalBoard(page);

  const cards = page.getByTestId('provisional-card');
  const total = await cards.count();

  for (let remaining = total; remaining > 0; remaining -= 1) {
    await cards.first().getByRole('button', { name: 'Hide it' }).click();
    await expect(cards).toHaveCount(remaining - 1);
  }

  const empty = page.getByTestId('provisional-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText(/Nothing has been thrown away/i);

  await empty.getByRole('button', { name: 'Show hidden places' }).click();
  await expect(cards).toHaveCount(total);

  // And the marks were real: they are still hidden after a reload.
  await page.reload();
  await expect(page.getByTestId('provisional-empty')).toBeVisible();
});

/**
 * ONE SHARED TRANSITION MUST NOT DISABLE FORTY CARDS.
 *
 * `disabled={pending}` disabled all four buttons on every card the instant any
 * one of them was pressed — including the button that had just been pressed. A
 * disabled element cannot hold focus, so focus fell to `<body>` and a keyboard
 * user lost their place on the board every single time they marked something.
 */
test('marking a place keeps the pressed button focusable and the rest usable', async ({ page }) => {
  await reachProvisionalBoard(page);

  const first = page.getByTestId('provisional-card').first();
  const button = first.getByRole('button', { name: 'Must do' });
  await button.click();

  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toBeEnabled();
  // Focus stayed where the traveller put it.
  await expect(button).toBeFocused();

  // Nothing anywhere on the board was disabled by that press.
  const disabled = await page.locator('[data-testid="provisional-card"] button:disabled').count();
  expect(disabled, 'no card button may be disabled by another card saving').toBe(0);
});

test('both boards report their state to a screen reader', async ({ page }) => {
  await reachProvisionalBoard(page);
  const provisional = page.getByTestId('provisional-status');
  await expect(provisional).toHaveAttribute('aria-live', 'polite');
  await expect(provisional).toHaveAttribute('role', 'status');

  await reachAuthoredBoard(page);
  const board = page.getByTestId('board-status');
  await expect(board).toHaveAttribute('aria-live', 'polite');
  await expect(board).toHaveAttribute('role', 'status');
  /*
   * The settled state rather than the change, so it carries counts — and phrased
   * as a sentence rather than as a copy of the visible counter beside it. A live
   * region that repeats the visible text verbatim is announced twice, and a
   * second node with the same leading shape made every `getByText(/^\d+ in/)` in
   * the suite ambiguous.
   */
  await expect(board).toContainText(/\d+ places included/);
  await expect(board).toContainText(/out of \d+/);
});
