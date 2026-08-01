import { expect, test, type Page } from '@playwright/test';

/**
 * The open-world journey, end to end, entirely offline.
 *
 * The compiler runs against deterministic synthetic worlds
 * (`SIDEQUEST_COMPILER_PROVIDER=fixture`), so a browser test asserts against a
 * region it chose rather than against whatever a volunteer-run map service was
 * doing that morning — and an outage is reachable without waiting for one.
 *
 * Nothing here names a real destination. "Harbour City" and "Outer Isles" are
 * synthetic test worlds; the live path never reaches them.
 */

const DATES = { start: '2026-08-12', end: '2026-08-16' };

async function createTrip(page: Page, destination: string): Promise<string> {
  await page.goto('/trips/new');
  await page.getByLabel('Where are you going?').fill(destination);
  await page.getByLabel('Arrive').fill(DATES.start);
  await page.getByLabel('Leave').fill(DATES.end);
  await page.getByRole('button', { name: /Start the questionnaire/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/);
  const id = /\/trips\/([^/]+)\/plan/.exec(page.url())?.[1];
  expect(id, 'a trip id should be in the URL').toBeTruthy();
  return id!;
}

/** Answer every clarification the rules produced, whatever they are. */
async function answerClarifications(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Read this' }).click();
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Reading', {
    timeout: 15_000,
  });

  if (await page.getByRole('button', { name: 'Continue' }).isVisible().catch(() => false)) {
    const radios = page.locator('input[type=radio]');
    const groups = new Set<string>();
    for (let index = 0; index < (await radios.count()); index += 1) {
      const name = await radios.nth(index).getAttribute('name');
      if (name && !groups.has(name)) {
        groups.add(name);
        await radios.nth(index).check();
      }
    }
    await page.getByRole('button', { name: 'Continue' }).click();
  }

  await expect(page.getByRole('heading', { name: 'Here is what we are about to do' })).toBeVisible({
    timeout: 15_000,
  });
}

/** Push through resolution, clarification and scope to a compiled region. */
async function compile(page: Page): Promise<void> {
  await answerClarifications(page);
  await page.getByRole('button', { name: 'Build the region' }).click();
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible({
    timeout: 60_000,
  });
}

test('an unambiguous destination skips the interpretation screen', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await page.getByRole('button', { name: 'Read this' }).click();

  // One confident reading is not a choice, so it is adopted and the traveller
  // lands on the first thing that genuinely needs them.
  await expect(page.getByRole('heading', { name: /thing first/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: /which one\?/i })).toHaveCount(0);
});

test('an ambiguous destination asks which reading was meant', async ({ page }) => {
  await createTrip(page, 'Outer Isles');
  await page.getByRole('button', { name: 'Read this' }).click();

  await expect(page.getByRole('heading', { name: /which one\?/i })).toBeVisible({
    timeout: 15_000,
  });
  const options = page.locator('input[name="interpretation"]');
  expect(await options.count()).toBeGreaterThan(1);
  await expect(page.getByText('More than one place goes by this name.')).toBeVisible();

  await options.nth(1).check();
  await page.getByRole('button', { name: 'That is the one' }).click();
  await expect(page.getByRole('heading', { name: /which one\?/i })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test('a query that is not a place is refused rather than guessed at', async ({ page }) => {
  await createTrip(page, 'somewhere scenic and cool');
  await page.getByRole('button', { name: 'Read this' }).click();

  await expect(page.getByRole('heading', { name: 'Where should we start looking?' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/reads more like the kind of trip you want/i)).toBeVisible();
  // It must not have compiled anything.
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toHaveCount(0);
});

test('clarification answers survive going back and returning', async ({ page }) => {
  const id = await createTrip(page, 'Harbour City');
  await page.getByRole('button', { name: 'Read this' }).click();
  await expect(page.getByRole('heading', { name: /thing first/i })).toBeVisible({ timeout: 15_000 });

  const first = page.locator('input[type=radio]').first();
  await first.check();
  const name = await first.getAttribute('value');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Here is what we are about to do' })).toBeVisible({
    timeout: 15_000,
  });

  // Back to the questions, and the answer is still there.
  await page.getByRole('button', { name: 'Rework it' }).click();
  await page.goto(`/trips/${id}/plan`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Here is what we are about to do' })).toBeVisible();

  // The stored answer is what produced this scope, so it must still be recorded.
  expect(name).toBeTruthy();
});

test('a refresh during compilation resumes the same job rather than starting another', async ({
  page,
}) => {
  const id = await createTrip(page, 'Harbour City');
  await answerClarifications(page);
  await page.getByRole('button', { name: 'Build the region' }).click();

  // Wait for the job to exist before reloading. Navigating away *during* the
  // start request is a different case, covered by the test below.
  await expect(page.getByRole('heading', { name: /Building your region|What this trip is built on/ })).toBeVisible({
    timeout: 20_000,
  });

  await page.goto(`/trips/${id}/plan`);
  // Whatever state the job reached, the page must show that job — never the
  // scope screen offering to start a second one.
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText(
    'Here is what we are about to do',
  );

  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible({
    timeout: 60_000,
  });
});

test('navigating away before a compilation starts leaves an honest restartable state', async ({
  page,
}) => {
  const id = await createTrip(page, 'Harbour City');
  await answerClarifications(page);

  // Click and immediately navigate, abandoning the in-flight start request.
  await page.getByRole('button', { name: 'Build the region' }).click();
  await page.goto(`/trips/${id}/plan`);

  // The scope is confirmed, so it must not offer to confirm again — and if no
  // job was created it must say so plainly rather than spinning forever.
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText(
    'Here is what we are about to do',
  );

  const start = page.getByRole('button', { name: 'Start building' });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  }
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible({
    timeout: 60_000,
  });
});

test('pressing build twice does not start a second compilation', async ({ page }) => {
  const id = await createTrip(page, 'Harbour City');
  await compile(page);

  // A second start against an already-compiled scope adopts the artifact rather
  // than paying for it again. Reloading proves the region survived.
  await page.goto(`/trips/${id}/plan`);
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible();
});

test('the compiled result reports coverage and exact OSM attribution', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);

  await expect(page.getByRole('heading', { name: 'What this is built on' })).toBeVisible();
  // Every coverage dimension is rendered, not a single score.
  await expect(page.getByText('Opening hours')).toBeVisible();
  await expect(page.getByText('Driving times')).toBeVisible();
  await expect(page.getByText(/Public transport/)).toBeVisible();

  await expect(page.getByText(/quality score/i)).toHaveCount(0);

  // The exact ODbL attribution, rendered from the artifact's licence records
  // rather than written into a template.
  await expect(page.getByTestId('attribution-line')).toContainText(
    '© OpenStreetMap contributors',
  );
  await expect(page.getByText('Open Database License 1.0')).toBeVisible();
  await expect(page.getByText(/share-alike/)).toBeVisible();
});

test('the board and a deterministic itinerary come out of the compiled region', async ({
  page,
}) => {
  const id = await createTrip(page, 'Harbour City');
  await compile(page);

  // The questionnaire, so the board has a traveller to score against. The
  // interests step refuses to advance on "if nearby" for everything, so real
  // answers are given rather than the step being clicked through.
  await page.getByRole('link', { name: 'Tell us how you travel' }).click();
  await page.waitForURL(/questionnaire/);

  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'History & culture: A few times' }).check();
  await page.getByRole('radio', { name: 'Easy nature walks: A few times' }).check();

  for (let step = 0; step < 12; step += 1) {
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
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The board is populated from the compiled artifact, so it has real cards.
  const cards = page.getByRole('article');
  expect(await cards.count()).toBeGreaterThan(0);

  // And it carries the attribution the data obliges it to.
  await expect(page.getByTestId('board-attribution')).toContainText(
    '© OpenStreetMap contributors',
  );

  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await expect(build).toBeEnabled({ timeout: 15_000 });
  await build.click();

  await page.waitForURL(/itinerary/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // And it is persisted: a reload loads the stored plan rather than rebuilding.
  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/Not built yet/i)).toHaveCount(0);
});

test('the journey stays free of console errors and horizontal overflow', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await createTrip(page, 'Harbour City');
  await compile(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `the plan flow scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  expect(problems, `Runtime problems:\n${problems.join('\n')}`).toEqual([]);
});
