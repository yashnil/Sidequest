import { expect, test } from '@playwright/test';
import { createTrip, openHowThisWasBuilt, reachScope, REGION_READY_HEADING } from './support/trip';

/**
 * WHAT THE PROGRESS SCREEN IS ALLOWED TO SAY ABOUT TIME.
 *
 * Every assertion here is a sentence that reached a traveller and should not
 * have. The headline one, verbatim from the screen this replaces:
 *
 *   > roughly 0s–0s to go
 *
 * It was produced by multiplying this run's median stage duration by the count
 * of stages left, from a clock that advanced one millisecond per stage. The unit
 * tests in `packages/core/src/schemas/timing.test.ts` assert the estimator
 * refuses; these assert that nothing on the *rendered page* can say it either,
 * which is a different claim and the one a traveller experiences.
 *
 * Offline throughout. The compiler runs against the deterministic synthetic
 * worlds (`SIDEQUEST_COMPILER_PROVIDER=fixture`), so the timings are real
 * measurements of real work and nothing here waits on somebody else's network.
 * "Harbour City" is a synthetic test world; no real destination is named.
 */

/** Anything that reads as a fabricated or impossible duration. */
const ZERO_RANGE = /\b0\s*s\s*[–-]\s*0\s*s\b/;
const NEGATIVE_DURATION = /-\d+\s*(?:s|m)\b/;
const PERCENTAGE = /\d+\s*%/;

test('the progress screen shows elapsed time immediately and no fabricated estimate', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await reachScope(page);
  await page.getByRole('button', { name: 'Start exploring' }).click();

  const finished = page.getByRole('heading', { name: REGION_READY_HEADING });

  /*
   * No estimate, checked while the build is running — which is the only time the
   * element could exist at all.
   *
   * It used to be one `toHaveCount(0)` after the wait, and a synthetic world
   * compiles in about a second, so it was almost always asserting the absence of
   * an element from a screen that no longer had *any* progress markup on it: a
   * pass that would have survived the estimator being switched back on. Sampling
   * until the plan lands puts the assertion where the defect would be. A fresh
   * environment has no comparable history, so `estimateRemainingFrom` refuses
   * and the screen renders silence; an estimate in any of these frames is a
   * failure.
   */
  const estimate = page.getByTestId('progress-estimate');
  for (let sample = 0; sample < 40; sample += 1) {
    if (await finished.isVisible().catch(() => false)) break;
    await expect(estimate).toHaveCount(0);
    await page.waitForTimeout(300);
  }

  await expect(finished).toBeVisible({ timeout: 30_000 });

  /*
   * The measured total, on the finished plan, inside the build report.
   *
   * The report is a `<details>` now — the whole engine's account of itself moved
   * behind one door — so the figure is not on screen until somebody opens it.
   * Opened rather than read through the closed panel with `textContent`, because
   * a number nobody can see is not a number the product shows.
   *
   * A duration or an honest statement that it was under one — and "0s" is
   * neither. This used to demand `/\d+\s*(?:s|m)/`, which a synthetic build
   * satisfied by rendering "0s in total, measured": a measurement of zero
   * seconds, presented with the word *measured* beside it, for a build that took
   * several hundred milliseconds. The floor that replaced it says "Under a
   * second" instead, which is the true sentence and has no digit in it.
   */
  await openHowThisWasBuilt(page);
  const total = page.getByTestId('build-duration');
  await expect(total).toBeVisible();
  await expect(total).toHaveText(/\d+\s*(?:s|m)|[Uu]nder a second/);
  await expect(total).not.toHaveText(/(^|\D)0\s*s\b/);
});

test('nothing on the progress screen is a percentage, a zero range or a negative duration', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await reachScope(page);
  await page.getByRole('button', { name: 'Start exploring' }).click();

  const heading = page.getByRole('heading', { name: REGION_READY_HEADING });

  /*
   * Sampled repeatedly while the build runs rather than once at the end. The
   * defect this guards against was transient by nature: "roughly 0s–0s to go"
   * appeared *during* the wait and was gone by the time the region was ready, so
   * a single check after completion would never have seen it.
   */
  for (let sample = 0; sample < 25; sample += 1) {
    if (await heading.isVisible().catch(() => false)) break;

    const text = await page.locator('body').innerText();
    expect(ZERO_RANGE.test(text), `a zero-width range reached the screen: ${text}`).toBe(false);
    expect(NEGATIVE_DURATION.test(text), `a negative duration reached the screen`).toBe(false);
    expect(PERCENTAGE.test(text), `a percentage reached the screen`).toBe(false);

    await page.waitForTimeout(600);
  }
});

test('no raw stage identifier reaches the screen, in the phases or in the disclosure', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await reachScope(page);
  await page.getByRole('button', { name: 'Start exploring' }).click();

  /*
   * `reusing_shared_claims` reached a traveller as "reusing shared claims" —
   * lowercase, no article, the identifier with its underscores taken out. The
   * label map that should have caught it was a hand-keyed duplicate, and the
   * fallback tidied the raw string instead of refusing it.
   *
   * Two patterns, because both forms are failures: the identifier itself, and
   * the de-underscored version that looks enough like English to survive review.
   */
  /*
   * The disclosure exists on the progress screen *and* on the finished plan —
   * deliberately, because "what did this build do" is a question people ask
   * afterwards. **Both** are checked now, rather than whichever one the test
   * happened to catch: the running one while the build runs, and the finished
   * one unconditionally afterwards. On the finished plan it moved inside the
   * build report, so it has to be opened twice — the report, then the stage list
   * inside it — and a version of this test that only ever caught the progress
   * screen would have said nothing at all about the state a traveller returns to.
   */
  const finished = page.getByRole('heading', { name: REGION_READY_HEADING });

  function refuseIdentifiers(text: string): void {
    expect(text.length, 'an unopened stage list reads as empty and proves nothing').toBeGreaterThan(
      0,
    );
    expect(/[a-z0-9]+_[a-z0-9]+/.test(text), `a raw identifier reached the screen: ${text}`).toBe(
      false,
    );
    expect(text).not.toMatch(/\breusing shared claims\b/);
    expect(text).not.toMatch(/\benriching priority candidates\b/);
  }

  const running = page.getByTestId('technical-stages').first();
  for (let sample = 0; sample < 20; sample += 1) {
    if (await finished.isVisible().catch(() => false)) break;
    if (await running.isVisible().catch(() => false)) {
      if (!(await running.evaluate((element) => (element as HTMLDetailsElement).open))) {
        /*
         * BOUNDED, BECAUSE THE THING BEING CLICKED IS SUPPOSED TO VANISH.
         *
         * The fixture compiler finishes a synthetic world in about a second, so
         * this loop is a sampler: it asserts about the progress screen when it
         * catches one, and the finished plan below is the check that always
         * runs. When the build completes between the visibility test above and
         * this click, the same `data-testid` is still in the document — inside
         * the finished plan's *closed* build report — and the default click
         * waits sixty seconds for an element that will never become visible.
         * Observed twice across three gate runs, as a minute-long timeout with
         * the panel it wanted sitting open beside it.
         *
         * Two seconds is not a tolerance for a slow page; it is the statement
         * that a control on screen right now is clickable now. Failing it means
         * the screen changed underneath, which is the loop's exit condition and
         * not a defect.
         */
        try {
          await running.locator(':scope > summary').click({ timeout: 2_000 });
        } catch {
          break;
        }
      }
      const text = await running.innerText().catch(() => '');
      /*
       * AN EMPTY READ IS TWO DIFFERENT FAILURES AND ONLY ONE OF THEM IS REAL.
       *
       * A stage list that is on the screen and reads empty is the vacuity this
       * guard exists for — an unopened `<details>` returns nothing, and a test
       * that scanned it for identifiers would pass against anything. But the
       * build can also finish *between* the visibility check and the read, and
       * then the progress screen is gone and the empty string is a fact about
       * the navigation rather than about the panel. Observed once in three
       * consecutive gate runs, as "an unopened stage list reads as empty and
       * proves nothing" on a run where nothing was wrong with the panel.
       *
       * So the two are told apart by asking again: still there and empty is the
       * failure; gone is the loop's own exit condition, one iteration early.
       */
      if (text.length === 0 && !(await running.isVisible().catch(() => false))) break;
      refuseIdentifiers(text);
    }
    await page.waitForTimeout(400);
  }

  await expect(finished).toBeVisible({ timeout: 30_000 });
  await openHowThisWasBuilt(page);
  /*
   * The stored list *inside the report*, not the first one on the page.
   *
   * The progress screen's copy can still be in the document — hidden — when the
   * finished plan renders, and `.first()` picked it: the click then waited the
   * full minute for an element that was never going to become visible, on a
   * panel that had been sitting open beside it the whole time.
   */
  const stored = page.getByTestId('how-this-was-built').getByTestId('technical-stages');
  await expect(stored).toBeVisible();
  await stored.locator(':scope > summary').click();
  refuseIdentifiers(await stored.innerText());
});

test('a finished phase never goes back to working while somebody watches', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await reachScope(page);
  await page.getByRole('button', { name: 'Start exploring' }).click();

  /*
   * The ordering defect as it was seen rather than as it was reasoned about.
   *
   * `researching_official_constraints` and `discovering_food` were mapped to the
   * *verifying* phase and execute before `enriching_priority_candidates`, which
   * was mapped to *finding* — so a traveller watched "Finding the strongest
   * places" report Done and then, a few seconds later, report Working again.
   */
  const settled = new Set<string>();
  const heading = page.getByRole('heading', { name: REGION_READY_HEADING });

  for (let sample = 0; sample < 40; sample += 1) {
    if (await heading.isVisible().catch(() => false)) break;

    const cards = page.locator('ol > li').filter({ hasText: /Working|Done|Waiting|Partly done|Failed/ });
    const count = await cards.count();
    const seen: { label: string; status: string }[] = [];
    for (let index = 0; index < count; index += 1) {
      const text = await cards.nth(index).innerText().catch(() => '');
      const status = /^(Working|Done|Waiting|Partly done|Failed)/.exec(text.trim())?.[1];
      if (status) seen.push({ label: text.split('\n')[1] ?? String(index), status });
    }

    for (const [index, entry] of seen.entries()) {
      const isNewest = index === seen.length - 1;
      if (settled.has(entry.label) && !isNewest) {
        expect(
          entry.status === 'Done' || entry.status === 'Partly done',
          `"${entry.label}" un-finished while a later phase was already under way`,
        ).toBe(true);
      }
      if (entry.status === 'Done' || entry.status === 'Partly done') settled.add(entry.label);
    }

    await page.waitForTimeout(500);
  }
});
