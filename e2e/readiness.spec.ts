import { expect, test, type Page } from '@playwright/test';
import { compileRegion, createTrip, reachScope } from './support/trip';

/**
 * DOES THE RESEARCH READING CHANGE WHAT A TRAVELLER SEES?
 *
 * For one pass it did not. Readiness was computed, validated, tested against
 * hand-made numbers and frozen onto every artifact, and no screen read it — a
 * diagnostic wearing a contract's clothes. These specifications exist to make
 * that failure impossible to repeat: each one drives the ordinary product routes
 * and asserts that the *board a person lands on* differs by the reading.
 *
 * Every trip below names a synthetic world and asserts which world it got, so a
 * specification can never quietly pass against the wrong fixture — which has
 * happened here before, when two ferry tests spent months exercising a metro.
 */

/** The reading the board is showing, or null when the panel is absent. */
async function readinessLevel(page: Page): Promise<string | null> {
  const panel = page.getByTestId('research-readiness');
  if ((await panel.count()) === 0) return null;
  return panel.getAttribute('data-readiness-level');
}

/**
 * Reach the screen a compiled world lands on.
 *
 * The plan "ready" screen rather than the Discovery Board, and that is where the
 * reading is most useful anyway: it comes *before* nine questionnaire steps, so a
 * traveller learns the ground is thin before investing in answering rather than
 * after. Reaching it needs no questionnaire, which also keeps this specification
 * independent of any one world's question set.
 */
async function compileWorld(page: Page, destination: string) {
  await createTrip(page, destination);
  await reachScope(page);
  await compileRegion(page);
}

test('a well-evidenced destination reaches the board with no interruption', async ({ page }) => {
  await compileWorld(page, 'Harbour City');

  /*
   * `ready` says nothing on purpose. A banner on every healthy trip is a banner
   * nobody reads by the third one, so the absence of the panel *is* the
   * assertion — together with the board actually being there.
   */
  const level = await readinessLevel(page);
  expect(level).toBeNull();
  await expect(page.getByRole('link', { name: /Tell us how you travel/i })).toBeVisible();
});

test('a thin destination shows the board and says what is missing', async ({ page }) => {
  await compileWorld(page, 'Little-Known Valley');

  /*
   * Asserted, not conditioned on. An earlier version of this file wrapped every
   * check in `if (panel exists)` and passed against a product where the panel
   * never rendered at all — the exact vacuity these specifications exist to
   * prevent. The weak-data world is genuinely sparse, so it must say so; it must
   * not be blocked, because there is a real trip to be had there.
   */
  const level = await readinessLevel(page);
  expect(level).not.toBeNull();
  expect(level).not.toBe('blocked');
  expect(level).not.toBe('ready');

  const panel = page.getByTestId('research-readiness');
  await expect(panel).toBeVisible();
  // A finding, not a shrug: the panel names something specific.
  await expect(panel).toContainText(/\d/);
  // And the journey continues, because a thin trip is still a trip.
  await expect(page.getByRole('link', { name: /Tell us how you travel/i })).toBeVisible();
});

test('the reading survives a refresh rather than being recomputed differently', async ({
  page,
}) => {
  await compileWorld(page, 'Little-Known Valley');
  const before = await readinessLevel(page);
  expect(before).not.toBeNull();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const after = await readinessLevel(page);

  /*
   * The verdict is frozen onto the artifact rather than recomputed at render, so
   * a second look at the same trip cannot produce a second answer. A board that
   * explains itself differently on the second visit is worse than one that does
   * not explain itself at all.
   */
  expect(after).toBe(before);
});

test('a repair that ran is reported, whether or not it helped', async ({ page }) => {
  await compileWorld(page, 'Little-Known Valley');

  const recovery = page.getByTestId('readiness-recovery');
  if ((await recovery.count()) > 0) {
    /*
     * A failed attempt that disappears from the record is how an automatic loop
     * comes to look like it never ran — and a traveller who waited through it is
     * owed the sentence either way.
     */
    await expect(recovery).toContainText(/found \d+ more|nothing further came back/i);
  }
});

test('no readiness copy leaks the machinery', async ({ page }) => {
  await compileWorld(page, 'Little-Known Valley');

  const panel = page.getByTestId('research-readiness');
  await expect(panel).toBeVisible();
  const text = (await panel.innerText()).toLowerCase();
  for (const word of [
    'packet',
    'portfolio',
    'containment',
    'candidate',
    'provider',
    'compile',
    'inventory',
    'overlay',
    'quota',
  ]) {
    expect(text, `readiness copy says "${word}"`).not.toContain(word);
  }
});

test('a destination nothing can reach is thin rather than pretending', async ({ page }) => {
  /**
   * The world whose every stop is further out than a day can reach. It compiles
   * cleanly, so nothing upstream refuses it — and the honest reading is `thin`:
   * there is real ground here and not much a trip can use, which is a different
   * statement from "we found nothing" and from "this is fine".
   */
  await compileWorld(page, 'Faraway Reaches');
  expect(await readinessLevel(page)).toBe('thin');
});
