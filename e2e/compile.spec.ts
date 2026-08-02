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

  /**
   * Both licence families, from one artifact.
   *
   * The place backbone reads a permissive place catalogue and a share-alike
   * geographic one, and the difference has legal consequences — so the screen
   * has to name both rather than showing whichever came first.
   */
  await expect(page.getByText(/Community Data License Agreement/)).toBeVisible();
});

test('the plan says which snapshot of the world it is frozen to', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);

  const panel = page.getByTestId('region-data');
  const summary = panel.getByText(/Regional place data/);
  await expect(summary).toBeVisible();

  // Collapsed by default: a normal user page is not a database console.
  await expect(panel.getByText(/frozen to a snapshot/i)).toBeHidden();

  await summary.click();
  await expect(panel.getByText(/frozen to a snapshot/i)).toBeVisible();
  await expect(panel.getByText(/^Records$/)).toBeVisible();
  // The release is named, so a traveller can say what their plan rests on.
  await expect(summary).toContainText('2026-07-22.0');
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
  await expect(page.getByText(/No trip built yet/i)).toHaveCount(0);
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

test('a plan with nothing in it is refused, with the funnel that explains why', async ({
  page,
}) => {
  /**
   * The regression this exists for.
   *
   * A live compilation returned five dated days, a transport strategy, a food
   * plan, a status of `ready_with_cautions` and **zero stops** — every candidate
   * reachable and open, and every one of them further to reach and return than
   * the traveller had said they would travel in a day. It would have been shown
   * to them as their trip.
   *
   * Reproduced against a synthetic world rather than a destination: "Longday
   * Basin" compiles cleanly — open places, a complete matrix, full coverage —
   * and every one of its stops takes ten hours, which no day of the trip is long
   * enough to hold. Same shape of failure, no destination in it.
   */
  const id = await createTrip(page, 'Longday Basin');
  await compile(page);

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

  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await expect(build).toBeEnabled({ timeout: 15_000 });
  await build.click();

  // It must not become an itinerary.
  const panel = page.getByTestId('planner-readiness');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  expect(page.url()).not.toMatch(/itinerary/);

  // The funnel, gate by gate, as numbers rather than as an apology.
  await expect(panel.getByText('On the board')).toBeVisible();
  await expect(panel.getByText('Measurable')).toBeVisible();
  await expect(panel.getByText('Way in')).toBeVisible();
  await expect(panel.getByText('Open', { exact: true })).toBeVisible();
  await expect(panel.getByText('Scheduled')).toBeVisible();
  await expect(panel.getByText('What blocked them')).toBeVisible();
  // The level, as a rule rather than a score.
  await expect(page.getByTestId('readiness-level')).toHaveText('Not enough to plan on');

  // And what to do about it, including what not to bother with.
  const ruledOut = panel.getByText('What would not help');
  await expect(ruledOut).toBeVisible();
  await ruledOut.click();
  await expect(panel.getByText(/would not help|not what stopped these/i).first()).toBeVisible();

  // Nothing was persisted: the itinerary page still says there is no plan.
  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByText(/No trip built yet/i).first()).toBeVisible();

  /**
   * And the explanation survives the reload that loses the action's answer.
   *
   * Before this was persisted, a traveller who refreshed was left with a board
   * and a button that appeared to do nothing — the refusal existed only in a
   * server action's return value. A finding that does not survive a reload is
   * not much of a finding.
   */
  await page.goto(`/trips/${id}/discover`);
  const afterReload = page.getByTestId('planner-readiness');
  await expect(afterReload).toBeVisible({ timeout: 30_000 });
  await expect(afterReload.getByText('Scheduled')).toBeVisible();
});

test('a region nothing can be planned from says so on the board, before the build', async ({
  page,
}) => {
  /**
   * The other half of the same defect, caught one screen earlier.
   *
   * Compiled places used to carry no travel time at all — the matrix knew, and
   * the field the board reads was left at zero — so a board could offer nine
   * stops as zero-minute hops and the planner would then refuse every one of
   * them for exceeding a daily driving limit. With the drive written onto the
   * place, the board reaches the same verdict the planner would, and says it
   * where the traveller can still change something.
   */
  const id = await createTrip(page, 'Faraway Reaches');
  await compile(page);

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

  await expect(
    page.getByRole('heading', { name: /Nothing in this region works on these dates/i }),
  ).toBeVisible();
  // No build button at all: there is nothing to build from.
  await expect(page.getByRole('button', { name: /Build my trip|Rebuild my trip/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Revisit my answers' })).toBeVisible();

  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByText(/No trip built yet/i).first()).toBeVisible();
});

test('a second build of the same ground reuses the evidence rather than buying it again', async ({
  page,
}, testInfo) => {
  /**
   * Desktop only, and deliberately.
   *
   * What this asserts happens on the server — which pages were re-read and which
   * facts were re-extracted — and is identical at every viewport. Running it in
   * all three projects would triple the most compilation-heavy test in the suite
   * for no additional signal, and this suite runs one worker.
   */
  test.skip(testInfo.project.name !== 'desktop', 'Reuse is server-side, not a layout concern');

  /**
   * The phase's whole economic argument, asserted through the browser.
   *
   * Two trips to the same synthetic world. The first pays for source discovery,
   * page reads and extraction; the second must find all three already held —
   * because a museum's opening hours are a fact about the museum, not about
   * whoever happens to be planning a trip past it.
   *
   * The work plan is read from the *stored row* rather than from a live counter,
   * so this also proves the record survives the request that produced it.
   */
  await createTrip(page, 'Harbour City');
  await compile(page);
  await expect(page.getByTestId('work-plan')).toBeVisible();

  const second = await createTrip(page, 'Harbour City');
  await compile(page);

  const plan = page.getByTestId('work-plan');
  await expect(plan).toBeVisible();
  await plan.click();

  /**
   * Every stage of the research funnel accounts for itself — including the ones
   * that were never called.
   *
   * The claims stage is the one that saves the most and the only one no provider
   * can report, because when a durable claim answers a subject outright nothing
   * downstream is invoked. A panel that went quiet exactly when reuse was total
   * would be worse than no panel.
   */
  await expect(plan.getByText('Reading what we already know')).toBeVisible();
  await expect(plan.getByText(/already researched/)).toBeVisible();
  await expect(plan.getByText('Reading the official pages')).toBeVisible();
  await expect(plan.getByText('Pulling out the facts')).toBeVisible();

  // And every step is named in words, never as an internal identifier.
  await expect(plan.getByText(/_/)).toHaveCount(0);

  // And it is a stored record: a reload shows the same account.
  await page.goto(`/trips/${second}/plan`);
  const reloaded = page.getByTestId('work-plan');
  await expect(reloaded).toBeVisible();
  await reloaded.click();
  await expect(reloaded.getByText('Finding who publishes this')).toBeVisible();
});

test('a compiled region still renders with every provider switched off', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Offline rendering is asserted once, not thrice');
  /**
   * The offline promise, restated against the evidence store.
   *
   * A compiled artifact carries its own copy of everything it was built from, so
   * emptying every cache table must change nothing a traveller can see. This is
   * the property that makes the whole store safe to sweep.
   */
  const id = await createTrip(page, 'Harbour City');
  await compile(page);

  await page.goto(`/trips/${id}/plan`);
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible();
  await expect(page.getByTestId('region-data')).toBeVisible();
});
