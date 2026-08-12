import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createTrip, reachScope, waitUntilInteractive, DEFAULT_DATES } from './support/trip';

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
    const field = page.getByLabel('Destination');
    await waitUntilInteractive(field);

    /* Their own answers, not a blank form. */
    await expect(field).toHaveValue('Harbour City');
    await expect(page.getByLabel('Arrive')).toHaveValue(DEFAULT_DATES.start);
    await expect(page.getByLabel('Leave')).toHaveValue(DEFAULT_DATES.end);
  });

  test('an edit changes the trip rather than creating a second one', async ({ page }) => {
    const tripId = await createTrip(page, 'Harbour City');

    await page.goto(`/trips/${tripId}/edit`);
    const field = page.getByLabel('Destination');
    await waitUntilInteractive(field);
    await page.getByLabel('Leave').fill('2026-08-18');
    await page.getByRole('button', { name: /See what we make of it/i }).click();

    await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
    /* The same trip. A new id here would mean the original was orphaned. */
    expect(page.url()).toContain(tripId);

    await page.goto(`/trips/${tripId}/edit`);
    await waitUntilInteractive(page.getByLabel('Destination'));
    await expect(page.getByLabel('Leave')).toHaveValue('2026-08-18');
  });
});

test.describe('traveller counts behave like numbers', () => {
  test('clearing the field and typing does not produce a leading zero', async ({ page }) => {
    await page.goto('/trips/new');
    const destination = page.getByLabel('Destination');
    await waitUntilInteractive(destination);
    await destination.fill('Harbour City');
    await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
    await page.getByLabel('Leave').fill(DEFAULT_DATES.end);

    const children = page.getByLabel('Children');
    await waitUntilInteractive(children);
    await expect(children).toHaveValue('0');

    /*
     * The exact reported sequence. A controlled number input bound to `0` and
     * updated through `Number(value)` never re-renders on the way through the
     * empty string, so the DOM keeps it and the next keystroke reads `01`.
     */
    await children.click();
    /*
     * `fill('')` rather than select-all-and-delete. On macOS Chromium `Control+A`
     * is the emacs binding for start-of-line, not select-all, so the sequence
     * that reads like "clear it" leaves the field intact and types *in front of*
     * the zero — which produced a `10` and would have made this specification
     * pass or fail on the platform rather than on the product.
     */
    await children.fill('');
    await expect(children).toHaveValue('');
    await children.type('1');
    await children.blur();
    await expect(children).toHaveValue('1');
  });

  test('an emptied count settles at its minimum rather than at zero', async ({ page }) => {
    await page.goto('/trips/new');
    const destination = page.getByLabel('Destination');
    await waitUntilInteractive(destination);
    await destination.fill('Harbour City');
    await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
    await page.getByLabel('Leave').fill(DEFAULT_DATES.end);

    const adults = page.getByLabel('Adults');
    await waitUntilInteractive(adults);
    await adults.click();
    await adults.fill('');
    await adults.blur();
    /* One adult, never zero — the bound the markup has always advertised. */
    await expect(adults).toHaveValue('1');
  });

  test('the steppers respect their bounds', async ({ page }) => {
    await page.goto('/trips/new');
    const destination = page.getByLabel('Destination');
    await waitUntilInteractive(destination);
    await destination.fill('Harbour City');
    await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
    await page.getByLabel('Leave').fill(DEFAULT_DATES.end);

    const fewer = page.getByRole('button', { name: 'One fewer child' });
    await waitUntilInteractive(fewer);
    /* Already at zero, so the control that would go below it is unavailable. */
    await expect(fewer).toBeDisabled();

    await page.getByRole('button', { name: 'One more child' }).click();
    await expect(page.getByLabel('Children')).toHaveValue('1');
    await expect(fewer).toBeEnabled();
  });
});

test.describe('the questionnaire remembers where you were', () => {
  /*
   * The step titles are level-two headings now: the page grew a stable h1
   * above the interpretation panel so the heading order stops reading inside
   * out, and the step's own heading — the one that changes per step — was
   * demoted with it. These selectors follow the step heading, not the page's.
   */
  test('a refresh returns to the step the traveller had reached', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes');
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);

    const first = page.getByRole('heading', { level: 2 });
    await expect(first).toBeVisible();
    const firstTitle = (await first.textContent())?.trim();

    /*
     * Answer enough to move. The first step refuses to advance while every
     * interest is left at its default, which is deliberate — "if nearby" on
     * everything gives the planner nothing — so this picks a real level rather
     * than the first radio on the page.
     */
    const core = page.locator('input[type=radio][value="core"]');
    await waitUntilInteractive(core.first());
    await core.first().check();
    await page.getByRole('button', { name: 'Continue' }).click();

    const second = page.getByRole('heading', { level: 2 });
    await expect(second).not.toHaveText(firstTitle ?? '');
    const secondTitle = (await second.textContent())?.trim();

    await page.reload();
    /*
     * The defect: the position was React state while the answers were saved, so
     * a refresh came back at step one with everything intact and nothing to say
     * which answers had been reached deliberately — under a header reading
     * "Saved as you go".
     */
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(secondTitle ?? '');
  });

  test('going back and forward keeps an edit made on the way', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes');
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);

    const core = page.locator('input[type=radio][value="core"]');
    await waitUntilInteractive(core.first());
    await core.first().check();
    await page.getByRole('button', { name: 'Continue' }).click();

    /* Change something on the second step, then step back and forward again. */
    const onSecond = page.locator('input[type=radio]');
    await waitUntilInteractive(onSecond.first());
    const chosen = onSecond.nth(1);
    await chosen.check();
    await expect(chosen).toBeChecked();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();
    await page.getByRole('button', { name: 'Continue' }).click();

    /*
     * `goBack` used to change the index and save nothing, so an edit made on a
     * step and stepped away from was lost until the traveller happened to walk
     * forward through it again.
     */
    await expect(page.locator('input[type=radio]').nth(1)).toBeChecked();
  });

  test('the review step lists the answers, not only a summary of them', async ({ page }) => {
    await createTrip(page, 'Mammoth Lakes');
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);

    const core = page.locator('input[type=radio][value="core"]');
    await waitUntilInteractive(core.first());
    await core.first().check();

    /*
     * Walk to the end.
     *
     * The step count is derived from the region, so this polls for "am I still
     * on a step with a Continue on it" rather than counting to a number. Each
     * click waits for the *heading* to change, which is the readiness condition
     * for a step transition — `networkidle` is not, because the move is a
     * client transition and the heading is the only thing that proves it landed.
     */
    for (let step = 0; step < 15; step += 1) {
      const next = page.getByRole('button', { name: 'Continue' });
      if (!(await next.isVisible().catch(() => false))) break;
      const before = (await page.getByRole('heading', { level: 2 }).textContent())?.trim() ?? '';
      await next.click();
      await expect(page.getByRole('heading', { level: 2 })).not.toHaveText(before);
    }
    /* The last step is the review, and its button says so. */
    await expect(page.getByRole('button', { name: /Build my discovery board/i })).toBeVisible();

    const answers = page.getByTestId('review-answers');
    await expect(answers).toBeVisible();
    /*
     * The review screen used to render a personality card and no answer at all —
     * nothing on it to check, immediately before the expensive research.
     */
    await expect(answers.getByText('Pace', { exact: false }).first()).toBeVisible();
    await expect(answers.getByRole('button', { name: /^Change/ }).first()).toBeVisible();
  });
});

test.describe('the questionnaire is shorter, not just apologetic', () => {
  test('a step whose only question the composer answered is not shown at all', async ({ page }) => {
    /*
     * Carrying the composer's answers across stopped the questionnaire
     * *contradicting* the traveller, which was the worst of it. It did not make
     * the questionnaire any shorter: every question was still asked, in the
     * same words, with a badge over it.
     *
     * The spending-style step's only control is one the composer asks. So a
     * traveller who answered it up front should never see that screen — and the
     * answer must still be on the review screen, marked as an assumption, with
     * a way to change it.
     */
    await page.goto('/trips/new');
    const destination = page.getByLabel('Destination');
    await waitUntilInteractive(destination);
    await destination.fill('Mammoth Lakes');
    await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
    await page.getByLabel('Leave').fill(DEFAULT_DATES.end);

    /* Answer the budget question on the composer. */
    await page.getByRole('button', { name: /A few more that change the plan/i }).click();
    const budget = page.getByRole('radio', { name: /Mid-range|Keep it cheap/i }).first();
    await waitUntilInteractive(budget);
    await budget.check();

    await page.getByRole('button', { name: /See what we make of it/i }).click();
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);

    const core = page.locator('input[type=radio][value="core"]');
    await waitUntilInteractive(core.first());
    await core.first().check();

    const headings: string[] = [];
    for (let step = 0; step < 15; step += 1) {
      const heading = page.getByRole('heading', { level: 2 });
      headings.push(((await heading.textContent()) ?? '').trim());
      const next = page.getByRole('button', { name: 'Continue' });
      if (!(await next.isVisible().catch(() => false))) break;
      const before = headings[headings.length - 1]!;
      await next.click();
      await expect(heading).not.toHaveText(before);
    }

    /* The step that asks it is gone. */
    expect(headings.some((title) => /spending style/i.test(title))).toBe(false);
    /* And the answer is on the review screen, marked as carried over. */
    const answers = page.getByTestId('review-answers');
    await expect(answers).toBeVisible();
    await expect(answers.getByText('Spending style').first()).toBeVisible();
    await expect(answers.getByText('assumed').first()).toBeVisible();
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
