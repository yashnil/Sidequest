import { expect, test } from '@playwright/test';
import { createTrip, reachScope, waitForLookup } from './support/trip';

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

test('the composer discloses progressively rather than showing thirty fields', async ({ page }) => {
  await page.goto('/trips/new');

  // Before a destination there is one question, not a form.
  await expect(page.getByLabel('Destination')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'When?' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What kind of trip?' })).toHaveCount(0);

  await page.getByLabel('Destination').fill('Harbour City');
  await expect(page.getByRole('heading', { name: 'When?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What kind of trip?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Who is going?' })).toBeVisible();
});

test('no disabled mode card dominates the first screen', async ({ page }) => {
  await page.goto('/trips/new');
  await expect(page.getByText(/not built yet/i)).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Check the plan I already have/i })).toHaveCount(0);
});

test('dates can be a month or a season, and arrival can be a band', async ({ page }) => {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Harbour City');

  await page.getByRole('radio', { name: 'Some time in a month' }).check();
  await expect(page.getByLabel('Which month?')).toBeVisible();

  await page.getByRole('radio', { name: 'Some time in a season' }).check();
  await expect(page.getByRole('radio', { name: 'Summer' })).toBeVisible();

  await page.getByRole('radio', { name: 'These exact dates' }).check();

  /*
   * Nobody is forced to invent a flight time. This is the field that used to be
   * an `<input type="time">` pre-filled with 15:00, whose fabricated value then
   * decided how much of day one existed.
   */
  const arrival = page.getByLabel('When do you get in?');
  await expect(arrival).toBeVisible();
  await arrival.selectOption({ label: 'Not booked yet' });
});

test('the live intent rail reflects what has been answered so far', async ({ page }) => {
  await page.goto('/trips/new');
  const rail = page.getByRole('complementary', { name: 'What we have so far' });
  await expect(rail).toBeVisible();

  await page.getByLabel('Destination').fill('Harbour City');
  await expect(rail).toContainText('Harbour City');

  await page.getByRole('radio', { name: 'Drive' }).check();
  await expect(rail).toContainText('Drive');
});

test('the composer survives a refresh by starting clean rather than half-filled', async ({
  page,
}) => {
  /*
   * Deliberate: the composer holds nothing until it is submitted, and says so.
   * A half-restored form that had lost one answer would be worse than an empty
   * one, because the traveller cannot tell which answer went missing.
   */
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Harbour City');
  await page.reload();
  await expect(page.getByLabel('Destination')).toHaveValue('');
});

test('trip context is shown by the page, not claimed by the shell', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  const context = page.getByTestId('trip-context');
  await expect(context).toBeVisible();
  await expect(context).toContainText('Harbour City');
  await expect(context).toContainText(/night/);
  // It lives below the global header, which still names no place.
  await expect(page.locator('header')).not.toContainText('Harbour City');
});

test('a typed destination is looked up without a screen asking permission', async ({ page }) => {
  await createTrip(page, 'Harbour City');

  // The screen that used to sit here said "Reading Harbour City" and had one
  // button on it, whose only possible answer was yes.
  await expect(page.getByRole('button', { name: 'Read this' })).toHaveCount(0);
  await waitForLookup(page);
  await expect(page.getByRole('heading', { name: /as we read it/i })).toBeVisible({
    timeout: 20_000,
  });
});

test('the preflight is honest about having no index coverage', async ({ page }) => {
  await createTrip(page, 'Harbour City');
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
  await page.getByRole('button', { name: 'Build the region' }).click();

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

  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible({
    timeout: 90_000,
  });
});

test('the whole journey is reachable by keyboard', async ({ page }) => {
  await page.goto('/trips/new');

  // Tab to the destination field and type into it without touching the mouse.
  await page.keyboard.press('Tab'); // skip link
  for (let step = 0; step < 8; step += 1) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('role'));
    if (focused === 'combobox') break;
    await page.keyboard.press('Tab');
  }
  await expect(page.locator('input[role=combobox]')).toBeFocused();
  await page.keyboard.type('Harbour City');
  await expect(page.getByRole('heading', { name: 'When?' })).toBeVisible();
});
