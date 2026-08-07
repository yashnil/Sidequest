import { expect, test } from '@playwright/test';
import { createTrip, reachScope } from './support/trip';

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
  await page.getByRole('button', { name: 'Build the region' }).click();

  /*
   * Either clock, because both are real and which one you catch depends on how
   * fast the build was.
   *
   * A synthetic world compiles in about a second — faster than a browser can
   * reliably assert against a screen that only exists while it is running. The
   * first version of this test waited twenty seconds for `progress-elapsed` and
   * failed because the element had already been replaced by the finished plan.
   *
   * So: the live elapsed figure if the build is still going, the measured total
   * on the finished page if it is not. Racing the environment to prove a
   * property that holds in both states would be testing the machine, not the
   * product.
   */
  const elapsed = page.getByTestId('progress-elapsed');
  const total = page.getByTestId('build-duration');
  await expect(elapsed.or(total).first()).toBeVisible({ timeout: 30_000 });
  /*
   * A duration or an honest statement that it was under one — and "0s" is
   * neither.
   *
   * This used to demand `/\d+\s*(?:s|m)/`, which a synthetic build satisfied by
   * rendering "0s in total, measured": a measurement of zero seconds, presented
   * with the word *measured* beside it, for a build that took several hundred
   * milliseconds. The floor that replaced it says "Under a second" instead, which
   * is the true sentence and has no digit in it. Both forms are accepted here;
   * a bare zero is accepted by neither.
   */
  await expect(elapsed.or(total).first()).toHaveText(/\d+\s*(?:s|m)|[Uu]nder a second/, {
    timeout: 30_000,
  });
  await expect(elapsed.or(total).first()).not.toHaveText(/(^|\D)0\s*s\b/);

  /*
   * No estimate, and that is the pass condition rather than a gap.
   *
   * A fresh environment has no comparable history, so `estimateRemainingFrom`
   * refuses and the screen renders silence. An estimate appearing here would
   * mean the bar had been lowered.
   */
  await expect(page.getByTestId('progress-estimate')).toHaveCount(0);
});

test('nothing on the progress screen is a percentage, a zero range or a negative duration', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();

  const heading = page.getByRole('heading', { name: 'What this trip is built on' });

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
  await page.getByRole('button', { name: 'Build the region' }).click();

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
   * afterwards. Either one satisfies this: the identifier must not reach a
   * traveller in either state.
   */
  const disclosure = page.getByTestId('technical-stages').first();
  await expect(disclosure).toBeVisible({ timeout: 30_000 });
  // Open it: the identifier this guards against lived in the stage list, which
  // is behind the disclosure and therefore invisible to a check that never opens it.
  await disclosure.locator('summary').click();

  const heading = page.getByRole('heading', { name: 'What this trip is built on' });
  for (let sample = 0; sample < 20; sample += 1) {
    const text = await disclosure.innerText();
    expect(/[a-z0-9]+_[a-z0-9]+/.test(text), `a raw identifier reached the screen: ${text}`).toBe(
      false,
    );
    expect(text).not.toMatch(/\breusing shared claims\b/);
    expect(text).not.toMatch(/\benriching priority candidates\b/);
    if (await heading.isVisible().catch(() => false)) break;
    await page.waitForTimeout(600);
  }
});

test('a finished phase never goes back to working while somebody watches', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();

  /*
   * The ordering defect as it was seen rather than as it was reasoned about.
   *
   * `researching_official_constraints` and `discovering_food` were mapped to the
   * *verifying* phase and execute before `enriching_priority_candidates`, which
   * was mapped to *finding* — so a traveller watched "Finding the strongest
   * places" report Done and then, a few seconds later, report Working again.
   */
  const settled = new Set<string>();
  const heading = page.getByRole('heading', { name: 'What this trip is built on' });

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
