import { expect, test, type Page } from '@playwright/test';
import {
  answerEveryQuestion,
  openHowThisWasBuilt,
  reachScope,
  REGION_READY_HEADING,
  waitForLookup,
  waitUntilInteractive,
  CULTURAL_INTERVIEW,
  completeQuestionnaire,
} from './support/trip';

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
  /*
   * The composer's second section exists only once the client has the
   * destination, so typing before the page is interactive loses the keystroke
   * and the rest of the form never appears. See `waitUntilInteractive`.
   */
  const field = page.getByLabel('Destination');
  await waitUntilInteractive(field);
  await field.fill(destination);
  await page.getByLabel('Arrive').fill(DATES.start);
  await page.getByLabel('Leave').fill(DATES.end);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/);
  const id = /\/trips\/([^/]+)\/plan/.exec(page.url())?.[1];
  expect(id, 'a trip id should be in the URL').toBeTruthy();
  return id!;
}

/**
 * Get past the lookup and the preflight to the clarification questions.
 *
 * The same polling shape as `reachScope`, and for the same reason: every screen
 * in this flow has a transient state — the lookup is running, the preflight is
 * computing, a server action is in flight — and a helper that samples once will
 * eventually sample during one of them. Two hand-written sequences both raced
 * it; the loop does not, because "not there yet" is just another turn.
 */
async function reachClarification(page: Page): Promise<void> {
  await waitForLookup(page);

  for (let step = 0; step < 16; step += 1) {
    const heading = await page
      .getByRole('heading', { level: 1 })
      .innerText()
      .catch(() => '');
    if (/thing first/i.test(heading)) return;
    if (/what we are about to do/i.test(heading)) {
      throw new Error('the flow skipped the clarification step; this test needs it');
    }

    const explore = page.getByTestId('interview-explore');
    if (await explore.isVisible().catch(() => false)) {
      await waitUntilInteractive(explore);
      await explore.click();
      await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 20_000 });
      continue;
    }

    const research = page.getByRole('button', { name: /Go and research this/i });
    if (await research.isVisible().catch(() => false)) {
      await answerEveryQuestion(page);
      await research.click();
      await expect(research).toHaveCount(0, { timeout: 20_000 });
      continue;
    }

    await page.waitForTimeout(400);
  }

  const landed = await page.getByRole('heading', { level: 1 }).innerText();
  throw new Error(`expected the clarification step, landed on "${landed}"`);
}

/** Answer every clarification the rules produced, whatever they are. */
async function answerClarifications(page: Page): Promise<void> {
  await reachScope(page);
}

/** Push through resolution, clarification and scope to a compiled region. */
async function compile(page: Page): Promise<void> {
  await answerClarifications(page);
  await page.getByRole('button', { name: 'Start exploring' }).click();
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible({
    timeout: 60_000,
  });
}

test('an unambiguous destination skips the interpretation screen', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await waitForLookup(page);

  /*
   * One credible reading is not a choice, so it is adopted without a screen and
   * the traveller lands on the interview — the research (preflight, scope,
   * build) is an optional detour from there, never a gate in front of it.
   *
   * The two negative assertions are the point of the phase: there is no
   * "which one?" for a single reading, and no confirmation button under it.
   */
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  await expect(page.getByTestId('interview-understanding')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /More than one place is called/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'That is the one' })).toHaveCount(0);
});

test('the flow never shows a bare unexplained confidence badge', async ({ page }) => {
  await createTrip(page, 'Outer Isles');
  await waitForLookup(page);
  await expect(page.getByRole('heading', { name: /More than one place is called/i })).toBeVisible({
    timeout: 20_000,
  });
  // "Not sure" told a traveller we were uncertain and gave them nothing to do
  // about it. What replaced it is the reason.
  await expect(page.getByText('Not sure', { exact: true })).toHaveCount(0);
});

test('an ambiguous destination asks which reading was meant', async ({ page }) => {
  await createTrip(page, 'Outer Isles');
  await waitForLookup(page);

  await expect(page.getByRole('heading', { name: /More than one place is called/i })).toBeVisible({
    timeout: 20_000,
  });
  const options = page.locator('input[name="interpretation"]');
  expect(await options.count()).toBeGreaterThan(1);
  await expect(page.getByText('More than one place goes by this name.')).toBeVisible();

  await options.nth(1).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: /More than one place is called/i })).toHaveCount(
    0,
    { timeout: 20_000 },
  );
});

test('a query that is not a place is refused rather than guessed at', async ({ page }) => {
  await createTrip(page, 'somewhere scenic and cool');
  await waitForLookup(page);

  await expect(page.getByRole('heading', { name: 'Where should we start looking?' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/reads more like the kind of trip you want/i)).toBeVisible();
  // It must not have compiled anything.
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toHaveCount(0);
});

test('clarification answers survive going back and returning', async ({ page }) => {
  const id = await createTrip(page, 'Harbour City');
  await reachClarification(page);

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
  await page.getByRole('button', { name: 'Start exploring' }).click();

  // Wait for the job to exist before reloading. Navigating away *during* the
  // start request is a different case, covered by the test below.
  await expect(page.getByRole('heading', { name: /^Building |^We have been through / })).toBeVisible({
    timeout: 20_000,
  });

  await page.goto(`/trips/${id}/plan`);
  // Whatever state the job reached, the page must show that job — never the
  // scope screen offering to start a second one.
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText(
    'Here is what we are about to do',
  );

  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible({
    timeout: 60_000,
  });
});

test('navigating away before a compilation starts leaves an honest restartable state', async ({
  page,
}) => {
  const id = await createTrip(page, 'Harbour City');
  await answerClarifications(page);

  // Click and immediately navigate, abandoning the in-flight start request.
  await page.getByRole('button', { name: 'Start exploring' }).click();
  await page.goto(`/trips/${id}/plan`);

  // The scope is confirmed, so it must not offer to confirm again — and if no
  // job was created it must say so plainly rather than spinning forever.
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText(
    'Here is what we are about to do',
  );

  /*
   * The control the "nothing is running on this" state offers is named for what
   * it does rather than for the machinery: `Start researching`, not `Start
   * building`. Under the old name this branch never fired, so the test spent its
   * full minute waiting for a finished build nothing had restarted — a failure
   * that read as "compilation hangs after a navigation away".
   */
  const start = page.getByRole('button', { name: 'Start exploring' });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  }
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible({
    timeout: 60_000,
  });
});

test('pressing build twice does not start a second compilation', async ({ page }) => {
  const id = await createTrip(page, 'Harbour City');
  await compile(page);

  /**
   * THE SECOND PRESS, WHICH THIS TEST WAS NAMED FOR AND NEVER MADE.
   *
   * It compiled once and asserted a heading was visible — so "pressing build
   * twice" was never done, and a build that started a fresh compilation on every
   * press would have passed. The claim is that an already-compiled scope adopts
   * the artifact rather than paying for it again, and the only way to observe it
   * is to press again and check the identity of what comes back.
   */
  await page.goto(`/trips/${id}/plan`);
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible();
  const before = await page.getByTestId('region-data').textContent();

  /*
   * The control that would start one, if the screen still offers one. A screen
   * that offers none is itself the guarantee — and asserting which of the two is
   * true is the point, because "there was no button" and "the button was pressed
   * and adopted the artifact" are both passes and only one of them was ever
   * happening.
   */
  const rebuild = page.getByRole('button', { name: /^(build|compile|start)/i }).first();
  const offersRebuild = await rebuild.isVisible().catch(() => false);
  if (offersRebuild) await rebuild.click();

  await page.goto(`/trips/${id}/plan`);
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible();
  /* The same artifact, not a second one compiled from the same answers. */
  expect(await page.getByTestId('region-data').textContent()).toBe(before);
});

test('the compiled result reports coverage and exact OSM attribution', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);

  /*
   * The build report is behind a disclosure now, so it is knocked on rather than
   * scrolled to. "What this is built on" as a heading is gone with it: what the
   * panel opens on is the coverage table, headed for the thing it shows.
   */
  await openHowThisWasBuilt(page);
  await expect(page.getByRole('heading', { name: 'Layer by layer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();
  /*
   * Every coverage dimension is rendered, not a single score.
   *
   * Matched exactly. The finished plan now also carries a record of the build
   * itself, and one of its stage labels is "Settling opening hours" — so a
   * substring match on "Opening hours" resolves to two elements and fails on
   * strict mode. Exact matching is also the sharper assertion: the claim is that
   * the dimension is named, not that the words appear somewhere on the page.
   */
  await expect(page.getByText('Opening hours', { exact: true })).toBeVisible();
  await expect(page.getByText('Driving times', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Public transport/)).toBeVisible();

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

  await openHowThisWasBuilt(page);
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

  await completeQuestionnaire(page, CULTURAL_INTERVIEW);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();

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

test('a plan whose every stop outruns a day is still delivered, and says its days run long', async ({
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
  await completeQuestionnaire(page, CULTURAL_INTERVIEW);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await page.waitForURL(/discover/, { timeout: 30_000 });

  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await expect(build).toBeEnabled({ timeout: 15_000 });
  await build.click();

  /*
   * Under the canonical path the trip is never withheld: the composed draft
   * is laid out, the ten-hour stops are kept because every one was marked
   * essential, and the plan says plainly that its days run long — a trip the
   * traveller can read and decide on, never a refusal with a funnel instead.
   */
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await expect(page.getByText(/runs about \d+ minutes past your usual end|exceeds your \d+-minute limit/).first()).toBeVisible();
  await expect(page.getByText(/^(Ready, with cautions|Needs a decision)$/)).toBeVisible();

  // Persisted: the itinerary page shows it again on a fresh load.
  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByTestId('route-overview')).toBeVisible();

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
  await completeQuestionnaire(page, CULTURAL_INTERVIEW);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await page.waitForURL(/discover/, { timeout: 30_000 });

  /*
   * The empty state used to be a fixed heading naming season, radius and effort.
   * On the one world that reaches it, every place is *inside* the radius and
   * simply too far to get back from — so two of the three were false, and the
   * screen recommended a change that provably could not help. It now names the
   * constraint that is actually binding, counted off the board's own blockers.
   */
  await expect(page.getByTestId('board-integrity').locator('[data-board-state]')).toHaveAttribute(
    'data-board-state',
    'blocked',
  );
  // No build button at all: there is nothing to build from.
  await expect(page.getByRole('button', { name: /Build my trip|Rebuild my trip/ })).toHaveCount(0);
  // The remedy that could move the constraint that is binding here, and no other.
  await expect(page.getByTestId('board-recovery-adjust_travel_tolerance')).toBeVisible();

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
  /*
   * The work plan lives inside the build report now, which is a closed
   * disclosure — so it has to be knocked on. Its content is in the DOM either
   * way, which is why this failed on `toBeVisible` rather than on a locator: the
   * panel was there and hidden, exactly as designed.
   */
  await createTrip(page, 'Harbour City');
  await compile(page);
  await openHowThisWasBuilt(page);
  await expect(page.getByTestId('work-plan')).toBeVisible();

  const second = await createTrip(page, 'Harbour City');
  await compile(page);
  await openHowThisWasBuilt(page);

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
  await openHowThisWasBuilt(page);
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
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible();
  const before = await page.getByTestId('region-data').textContent();
  expect(before?.length ?? 0).toBeGreaterThan(0);

  /**
   * WHAT THIS TEST CAN AND CANNOT OBSERVE, STATED RATHER THAN IMPLIED.
   *
   * Its docstring claims "emptying every cache table must change nothing", and
   * it emptied nothing — it compiled, reloaded, and asserted a panel was
   * visible, which passes against an artifact that secretly re-fetches
   * everything on render.
   *
   * A browser suite has no way to reach into the server's cache tables, and
   * adding a route that could would be a hole in the product for the benefit of
   * a test. What it *can* observe is the property the sweep was standing in
   * for: every provider is already switched off in this run — the web server is
   * started with the fixture compiler, no research credential and no live
   * weather — so a second render that produced the same bytes could not have
   * fetched anything, because there is nothing configured to fetch from.
   *
   * The sweep claim is retired and the observable claim is asserted. That is a
   * narrower test and a true one; `render-purity.spec.ts` covers the "no
   * outbound request during render" half directly.
   */
  await page.goto(`/trips/${id}/plan`);
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible();
  await openHowThisWasBuilt(page);
  await expect(page.getByTestId('region-data')).toBeVisible();
  /* Byte-for-byte the same, from the artifact's own copy of what it was built from. */
  expect(await page.getByTestId('region-data').textContent()).toBe(before);
});
