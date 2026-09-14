import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, openReviewLedger, reachScope, waitUntilInteractive, DEFAULT_DATES } from './support/trip';

/**
 * THE FOUNDER-TEST REGRESSIONS, DRIVEN THROUGH THE ORDINARY PRODUCT.
 *
 * Section 27 asks for regression coverage of the things that went wrong the
 * moment a real person used this, and asks for it *without* hardcoding
 * destination names or screenshots. So every specification below drives the
 * normal routes and asserts a behaviour rather than a layout: that a traveller
 * can go back, that a corrected number is the number they typed, that a screen
 * they cannot get past offers them somewhere to go.
 *
 * The destination strings are the end-to-end fixture's own — `providers.ts`
 * maps them onto synthetic worlds — and nothing here depends on what is *in*
 * those worlds beyond the shape the fixture guarantees.
 */

test.describe('correcting an answer without starting again', () => {
  test('the traveller can reach an edit screen that already holds what they said', async ({
    page,
  }) => {
    const tripId = await createTrip(page, 'Harbour City');

    await page.goto(`/trips/${tripId}/edit`);
    const field = page.getByTestId('destination-input');
    await waitUntilInteractive(field);

    /* Their own answers, not a blank form. */
    await expect(field).toHaveValue('Harbour City');
    await page.getByTestId('setup-continue').locator('visible=true').first().click();
    await expect(page.getByTestId('timing-start')).toHaveValue(DEFAULT_DATES.start);
    await expect(page.getByTestId('timing-end')).toHaveValue(DEFAULT_DATES.end);
  });

  test('an edit changes the trip rather than creating a second one', async ({ page }) => {
    const tripId = await createTrip(page, 'Harbour City');

    const advance = () => page.getByTestId('setup-continue').locator('visible=true').first().click();
    await page.goto(`/trips/${tripId}/edit`);
    await waitUntilInteractive(page.getByTestId('destination-input'));
    await advance();
    await page.getByTestId('timing-end').fill('2026-08-18');
    await advance();
    await advance();
    await advance();

    await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
    /* The same trip. A new id here would mean the original was orphaned. */
    expect(page.url()).toContain(tripId);

    await page.goto(`/trips/${tripId}/edit`);
    await waitUntilInteractive(page.getByTestId('destination-input'));
    await advance();
    await expect(page.getByTestId('timing-end')).toHaveValue('2026-08-18');
  });
});

/**
 * MVP V3 — the party is its own screen, and the counts are steppers with a
 * live-region readout rather than free-text number inputs. The defect the old
 * tests guarded (a controlled number input settling at a leading zero) cannot
 * occur in a control with no text field; what is still worth asserting is the
 * bounds and that the readout follows the presses.
 */
async function reachWhoStep(page: Page): Promise<void> {
  const advance = () => page.getByTestId('setup-continue').locator('visible=true').first().click();
  await page.goto('/trips/new');
  const destination = page.getByTestId('destination-input');
  await waitUntilInteractive(destination);
  await destination.fill('Harbour City');
  await advance();
  await page.getByTestId('timing-exact').click();
  await page.getByTestId('timing-start').fill(DEFAULT_DATES.start);
  await page.getByTestId('timing-end').fill(DEFAULT_DATES.end);
  await advance();
  await page.getByTestId('party-couple').click();
}

test.describe('traveller counts behave like numbers', () => {
  test('the counts start where the party shape says and move by one', async ({ page }) => {
    await reachWhoStep(page);
    /* "Two of us" starts at two adults and no children; the readout says so before anything is pressed. */
    await expect(page.getByTestId('count-adults')).toHaveText('2');
    await expect(page.getByTestId('count-children')).toHaveText('0');

    await page.getByRole('button', { name: 'One more child' }).click();
    await expect(page.getByTestId('count-children')).toHaveText('1');
    await page.getByRole('button', { name: 'One more adult' }).click();
    await expect(page.getByTestId('count-adults')).toHaveText('3');
  });

  test('a count never goes below its minimum', async ({ page }) => {
    await reachWhoStep(page);
    /* One adult, never zero — the bound the markup has always advertised. */
    await page.getByRole('button', { name: 'One fewer adult' }).click();
    await expect(page.getByTestId('count-adults')).toHaveText('1');
    await expect(page.getByRole('button', { name: 'One fewer adult' })).toBeDisabled();
  });

  test('the steppers respect their bounds', async ({ page }) => {
    await reachWhoStep(page);
    const fewer = page.getByRole('button', { name: 'One fewer child' });
    /* Already at zero, so the control that would go below it is unavailable. */
    await expect(fewer).toBeDisabled();
    await page.getByRole('button', { name: 'One more child' }).click();
    await expect(fewer).toBeEnabled();
  });
});

test.describe('the questionnaire remembers where you were', () => {
  test('a refresh returns to the step the traveller had reached', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes');
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);
    const start = page.getByTestId('interview-start');
    await waitUntilInteractive(start);
    await start.click();

    await page.getByRole('checkbox', { name: 'Hiking', exact: true }).check();
    await page.getByTestId('interview-continue').click();
    /*
     * WAIT FOR THE STEP TO CHANGE, THEN READ IT.
     *
     * `getAttribute` is a read at one instant, and the assertion below is about
     * a transition: pressing Continue saves the answer through a server action
     * and the next question arrives after it. Asserting on the first attribute
     * read after the click passes whenever the machine is quick and fails
     * whenever it is busy — which is what it did, in two projects of a
     * single-worker run of the whole suite and in neither of them on its own.
     * The wait is the assertion; the equality below only names what it is
     * waiting for.
     */
    await expect(page.getByTestId('interview-question-priorities')).toBeHidden({ timeout: 30_000 });
    const second = page.locator('[data-testid^="interview-question-"]');
    await expect(second).toBeVisible();
    const id = await second.getAttribute('data-testid');
    expect(id).not.toBe('interview-question-priorities');

    await page.reload();
    /*
     * The defect this guards: the position was React state while the answers
     * were saved, so a refresh came back at step one with everything intact.
     */
    await expect(page.getByTestId(id!)).toBeVisible();
  });

  test('going back and forward keeps an edit made on the way', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes');
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);
    const start = page.getByTestId('interview-start');
    await waitUntilInteractive(start);
    await start.click();

    await page.getByRole('checkbox', { name: 'Hiking', exact: true }).check();
    await page.getByTestId('interview-continue').click();
    await expect(page.getByTestId('interview-question-priority_roles')).toBeVisible();

    /* Answer the second screen, step back, and come forward again. */
    const chosen = page.locator('input[type=radio][value="couple"]');
    await chosen.check();
    await page.getByTestId('interview-continue').click();
    await expect(page.getByTestId('interview-question-priority_roles')).toBeHidden();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('interview-question-priority_roles')).toBeVisible();
    await expect(page.locator('input[type=radio][value="couple"]')).toBeChecked();
  });

  test('the review step lists the answers, not only a summary of them', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes');
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);
    await completeQuestionnaire(page);
    /* The last screen is the review, and its button says so. */
    await expect(page.getByRole('button', { name: /Open the Discovery Board/i })).toBeVisible();

    /*
     * The review separates what the traveller said from what Sidequest
     * assumed, and every row has a control that jumps back to its question.
     */
    /*
     * MVP V3, Stage 39 — the glance leads, and every question's own row waits
     * behind one disclosure. Both are asserted: a review with no glance is the
     * database listing this redesign removed, and a review with no ledger is a
     * plan the traveller cannot check.
     */
    await expect(page.getByTestId('review-glance')).toBeVisible();
    await expect(page.getByTestId('glance-feel')).toBeVisible();
    await expect(page.getByTestId('glance-edit-feel')).toBeVisible();
    await openReviewLedger(page);
    const told = page.getByTestId('review-told');
    await expect(told).toBeVisible();
    await expect(told.getByRole('button', { name: /^Change/ }).first()).toBeVisible();
    await expect(page.getByTestId('review-assumed')).toBeVisible();
    await expect(page.getByTestId('review-hard')).toBeVisible();
  });
});

test.describe('one intake, not two', () => {
  test('the composer asks nothing about how you travel, and the interview asks it once', async ({ page }) => {
    /*
     * QUALITY V1 — the composer used to ask budget, pace, transport, themes
     * and crowds, and the interview asked them again with better questions.
     * The composer now holds only what every itinerary needs; every
     * preference is the interview's, asked once.
     */
    await page.goto('/trips/new');
    const destination = page.getByTestId('destination-input');
    await waitUntilInteractive(destination);
    await destination.fill('Mammoth Lakes');
    /* No preference question anywhere in setup. */
    await expect(page.getByRole('radio', { name: /Mid-range|Keep it cheap/i })).toHaveCount(0);

    await createTrip(page, 'Mammoth Lakes', DEFAULT_DATES);
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);

    const seen = await completeQuestionnaire(page);
    expect(seen).toContain('budget');
    await openReviewLedger(page);
    await expect(page.getByTestId('review-told')).toBeVisible();
    await expect(page.getByTestId('review-change-budget')).toBeVisible();
  });
});

test.describe('no screen in the journey leaves a traveller without an action', () => {
  test('every step of the plan flow offers at least one control', async ({ page }) => {
    /*
     * The first version of this guarded its only real assertion behind
     * `if (await blocked.isVisible())` — and the blocked state is not reachable
     * under the fixture compiler, so the branch never ran and the spec reduced
     * to "the page has a button", which is true of a crashed page.
     *
     * The invariant worth asserting is the one section 18.1 states: no step
     * strands the traveller. So this walks the flow and checks it at every step
     * it actually reaches, and fails if it reaches none.
     */
    const tripId = await createTrip(page, 'Harbour City');

    /* Something to press on the first screen the flow lands on. */
    const actions = page.locator(
      'main button:not([disabled]), main a[href], main input[type=radio], main input[type=checkbox]',
    );
    await expect(actions.first()).toBeVisible({ timeout: 20_000 });
    const first = ((await page.getByRole('heading', { level: 1 }).textContent()) ?? '').trim();

    /*
     * Walked with the suite's own helper rather than a locator guessed here.
     * The step is derived from stored state, so which controls exist depends on
     * the destination — a hand-rolled walk finds one screen, declares victory
     * and asserts nothing about the rest of the flow.
     */
    await reachScope(page);

    const scopeHeading = page.getByRole('heading', { level: 1 });
    await expect(scopeHeading).toBeVisible();
    expect(((await scopeHeading.textContent()) ?? '').trim()).not.toBe(first);
    await expect(actions.first()).toBeVisible();

    /* And the scope screen offers a way back, not only a way on. */
    await expect(page.getByRole('button', { name: /Rework it/i })).toBeVisible();

    /* A refresh lands on the same step, with controls, rather than nowhere. */
    await page.goto(`/trips/${tripId}/plan`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      ((await scopeHeading.textContent()) ?? '').trim(),
    );
    await expect(actions.first()).toBeVisible();
  });

  test('the blocked-build panel, when it renders, always carries a way out', async () => {
    /*
     * The blocked state cannot be provoked from the browser under the fixture
     * compiler — that is what the fixture is for. What can be asserted is the
     * *contract*: the panel and its actions ship together, so a build that ever
     * renders one renders the other. Asserted on the markup rather than on a
     * state we cannot reach, and named as such rather than dressed up as a
     * journey test.
     */
    const source = await readFile(
      new URL('../apps/web/src/components/PlanFlow.tsx', import.meta.url),
      'utf8',
    );
    const panel = source.slice(source.indexOf("data-testid=\"compile-unavailable\""));
    expect(panel).toContain('providerNextActions.length > 0');
    expect(panel).toContain('buttonClass(');
    /* And the heading agrees with the panel rather than claiming a lookup. */
    expect(source).toContain('We cannot research');
  });
});
