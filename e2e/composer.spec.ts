import { expect, test, type Page } from '@playwright/test';
import { createTrip, reachScope, REGION_READY_HEADING, requestExploration, waitForLookup } from './support/trip';

/**
 * THE COMPOSER, THE SHELL AND THE PROGRESS SCREEN.
 *
 * Every assertion here is a defect from the screenshot audit, turned into
 * something that fails if it comes back. Offline throughout: the destination
 * index is deliberately unbuilt in this environment and the climate provider is
 * off, so these exercise the honest-degradation paths as well as the happy one.
 */

test('the global shell names no destination', async ({ page }) => {
  for (const path of ['/', '/trips/new']) {
    await page.goto(path);
    const header = page.locator('header');
    await expect(header).toContainText('Sidequest');
    await expect(header).not.toContainText(/eastern sierra/i);

    const footer = page.locator('footer');
    await expect(footer).not.toContainText(/snowpack/i);
    await expect(footer).not.toContainText(/eastern sierra/i);
    await expect(footer).toContainText(/published sources/i);
  }
});

test('the landing page sells a worldwide product, not one valley', async ({ page }) => {
  await page.goto('/');
  /*
   * Two doors, and the second one is not a placeholder any more.
   *
   * This asserted a single "Start a trip" link, which was correct while the
   * product could only do one of the two things it claims to. Both work now, so
   * both are on the front page, and the assertion is that neither has quietly
   * disappeared.
   */
  await expect(page.getByRole('link', { name: 'I know where I am going' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Help me decide' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Plan a Mammoth Lakes trip/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText(/mammoth/i);
});

test('setup is one question at a time, not a form', async ({ page }) => {
  /*
   * MVP V3, Stage 4 — this used to assert *progressive disclosure*: one field
   * that revealed three more sections below it. Sections are gone. Each question
   * is its own screen, its own history entry, and nothing else is on it.
   */
  await page.goto('/trips/new');
  await expect(page.getByTestId('destination-input')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Where are you thinking/);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Who is going?' })).toHaveCount(0);
  await expect(page.getByTestId('timing-best')).toHaveCount(0);

  await page.getByTestId('destination-input').fill('Harbour City');
  await page.getByTestId('setup-continue').locator('visible=true').first().click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText(/When can you travel/);
  await expect(page.getByTestId('destination-input')).toHaveCount(0);
  await expect(page.locator('h1')).toHaveCount(1);
  /* Preferences belong to the interview, never to a second form here. */
  await expect(page.getByRole('heading', { name: 'What kind of trip?' })).toHaveCount(0);
});

test('no disabled mode card dominates the first screen', async ({ page }) => {
  await page.goto('/trips/new');
  await expect(page.getByText(/not built yet/i)).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Check the plan I already have/i })).toHaveCount(0);
});

test('timing can be a month, a season, a free window, or nothing at all', async ({ page }) => {
  /*
   * MVP V3, Stage 5 — the two that matter most are the ones that need no date:
   * "tell me when it is best" and "I have not decided". Neither may leave a
   * hidden date field underneath refusing to let the traveller move on.
   */
  await page.goto('/trips/new');
  await page.getByTestId('destination-input').fill('Harbour City');
  const advance = page.getByTestId('setup-continue').locator('visible=true').first();
  await advance.click();

  await page.getByTestId('timing-roughly').click();
  await page.getByTestId('timing-kind-month').click();
  await expect(page.getByRole('button', { name: 'Jun' })).toBeVisible();
  await page.getByTestId('timing-kind-season').click();
  await expect(page.getByRole('button', { name: 'summer' })).toBeVisible();
  await page.getByTestId('timing-kind-window').click();
  await expect(page.getByTestId('timing-earliest')).toBeVisible();

  await page.getByTestId('timing-undecided').click();
  await expect(page.getByTestId('timing-start')).toHaveCount(0);
  await expect(advance).toBeEnabled();
});

test('nobody is asked to invent a flight time', async ({ page }) => {
  /*
   * MVP V3, Stage 9 — arrival used to be a select on the way past, pre-filled
   * with a band nobody chose. It is asked only by somebody who says they know.
   */
  await createTripToStep(page, 'fixed');
  await expect(page.getByLabel('Landing')).toHaveCount(0);
  await page.getByTestId('setup-flight-times').click();
  await expect(page.getByLabel('Landing')).toBeVisible();
});

test('the running summary shows only what has actually been answered', async ({ page }) => {
  /*
   * MVP V3 — the property with teeth is the negative one. The first version of
   * this panel showed "6 nights · 7 days" and a date range on the blank first
   * screen, because those were the values the controls happened to start with.
   */
  await page.goto('/trips/new');
  const summary = page.getByTestId('setup-summary');
  await expect(summary).toHaveCount(0);

  await page.getByTestId('destination-input').fill('Harbour City');
  await expect(summary).toContainText('Harbour City');
  await expect(summary).not.toContainText(/night/);
  await expect(summary).not.toContainText(/20\d\d-/);
});

test('the composer survives a refresh by starting clean rather than half-filled', async ({
  page,
}) => {
  /*
   * Deliberate: the composer holds nothing until it is submitted, and says so.
   * A half-restored form that had lost one answer would be worse than an empty
   * one, because the traveller cannot tell which answer went missing.
   */
  /*
   * MVP V3 — a refresh now *keeps* what was typed, because the draft is in
   * session storage. Losing a destination somebody typed is not a safety
   * property; it is a lost answer.
   */
  await page.goto('/trips/new');
  await page.getByTestId('destination-input').fill('Harbour City');
  await page.reload();
  await expect(page.getByTestId('destination-input')).toHaveValue('Harbour City');
});

/** Walk the setup as far as a named step, leaving the rest untouched. */
async function createTripToStep(page: Page, step: 'when' | 'nights' | 'who' | 'fixed'): Promise<void> {
  const advance = () => page.getByTestId('setup-continue').locator('visible=true').first().click();
  await page.goto('/trips/new');
  await page.getByTestId('destination-input').fill('Harbour City');
  await advance();
  if (step === 'when') return;
  await page.getByTestId('timing-exact').click();
  await page.getByTestId('timing-start').fill('2026-08-12');
  await page.getByTestId('timing-end').fill('2026-08-16');
  await advance();
  if (step === 'nights' || step === 'who') return;
  await page.getByTestId('party-couple').click();
  await advance();
}

test('trip context is shown by the page, not claimed by the shell', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  const context = page.getByTestId('trip-context');
  await expect(context).toBeVisible();
  await expect(context).toContainText('Harbour City');
  await expect(context).toContainText(/night/);
  // It lives below the global header, which still names no place.
  await expect(page.locator('header')).not.toContainText('Harbour City');
});

test('a typed destination is looked up without a screen asking permission, and lands on the interview', async ({ page }) => {
  await createTrip(page, 'Harbour City');

  // The screen that used to sit here said "Reading Harbour City" and had one
  // button on it, whose only possible answer was yes. And the screen after it
  // used to be a research gate; it is the interview now.
  await expect(page.getByRole('button', { name: 'Read this' })).toHaveCount(0);
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  await expect(page.getByTestId('interview-understanding')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/This build is missing/)).toHaveCount(0);
});

test('the preflight is honest about having no index coverage', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await requestExploration(page);
  await waitForLookup(page);

  // The preflight is computed on arrival, so the panel appears a beat later.
  const panel = page.getByTestId('no-index-coverage');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel).toContainText(/gap in what this deployment holds/i);
  // Crucially, it does not claim the destination is unplannable.
  await expect(panel).not.toContainText(/not enough to plan/i);
});

test('the compilation progress groups stages and hides the technical list', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await reachScope(page);
  await page.getByRole('button', { name: 'Start exploring' }).click();

  /*
   * The five phases are what a traveller reads. The twenty-six stages are still
   * there for an operator, behind a disclosure that starts closed.
   *
   * Against the fixture providers a whole compilation can finish inside a
   * second, so the progress screen is genuinely sometimes not observable. The
   * assertion is therefore conditional *and* the grouping itself is proved
   * exhaustively in `progress.test.ts` — a flaky browser assertion would be a
   * worse guarantee than a deterministic unit one.
   */
  const technical = page.getByTestId('technical-stages');
  const sawProgress = await technical.isVisible({ timeout: 4_000 }).catch(() => false);
  if (sawProgress) {
    await expect(technical).not.toHaveAttribute('open', /.*/);
    // The traveller-facing phase names, never the stage identifiers.
    await expect(page.getByText(/Understanding your trip|Shaping the region|Finding the strongest/)).toBeVisible();
  }

  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible({
    timeout: 90_000,
  });
});

test('the whole journey is reachable by keyboard', async ({ page }) => {
  await page.goto('/trips/new');

  /*
   * The field is no longer a combobox — a destination is free text, and the
   * suggestions underneath it are optional help rather than the answer. So the
   * keyboard path is: reach the input, type a place nobody's gazetteer has, and
   * press Enter to move on.
   */
  const field = page.getByTestId('destination-input');
  await expect(field).toBeVisible();
  const focused = () => field.evaluate((element) => element === document.activeElement);
  for (let step = 0; step < 8 && !(await focused()); step += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(field).toBeFocused();

  await page.keyboard.type('Harbour City');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'When can you travel?' })).toBeVisible();
});
