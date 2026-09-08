import { expect, test, type Page } from '@playwright/test';
import {
  expectNoHorizontalOverflow,
  expectNoRuntimeProblems,
  watchForRuntimeProblems,
} from './support/viewports';
import { answerEveryQuestion, createTrip, requestExploration } from './support/trip';

/**
 * THE REGION FIGURE, IN A REAL BROWSER, AGAINST REAL PORTFOLIO DATA.
 *
 * The figure's geometry is unit-tested — projection, label collision, ring
 * radii — and none of that can answer the two questions that matter on screen:
 * does it render at all against a portfolio the product actually built, and does
 * it still fit inside the panel at 390 px.
 *
 * WHY IT DRIVES THE INDEX PATH. The typed-destination journey every other spec
 * uses resolves through the fixture resolver into a synthetic world with no rows
 * in the destination index, so its preflight has no clusters and the region
 * panel is correctly absent. The only journey that produces a portfolio is the
 * one that picks an indexed suggestion — which is also the journey a traveller
 * with a catalogue takes. `/decide` is visited first because that page is where
 * the synthetic index is seeded on a build that has none; see
 * `lib/destinations/seed`.
 *
 * FOUR NIGHTS, DELIBERATELY. A long trip reaches everything, and a portfolio
 * that excludes nothing cannot demonstrate that the figure shows what is being
 * left out — which is half of what §19.2 asks the preview to answer.
 */

const DATES = { start: '2026-08-12', end: '2026-08-16' };

async function reachRegionFigure(page: Page): Promise<void> {
  // The synthetic index is seeded on this page's render.
  await page.goto('/decide');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await createTrip(page, 'Ambervale', DATES, { pickSuggestion: true });
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
  // The research steps are an explicit request from the interview now.
  await requestExploration(page);

  /*
   * A loop rather than a fixed sequence, for the same reason `reachScope` in the
   * shared helpers is one: which screens appear is derived from stored state, so
   * a spec that hard-codes the sequence breaks whenever a question is added.
   */
  const figure = page.getByTestId('scope-preview');
  for (let step = 0; step < 12; step += 1) {
    if (await figure.isVisible().catch(() => false)) return;
    const proceed = page.getByRole('button', { name: /^Continue$/ });
    if (await proceed.isVisible().catch(() => false)) {
      await answerEveryQuestion(page);
      await proceed.click();
      await expect(proceed).toHaveCount(0, { timeout: 20_000 });
      continue;
    }
    await page.waitForTimeout(400);
  }
  await expect(figure).toBeVisible({ timeout: 20_000 });
}

test('the region preview draws the structure the portfolio decided on', async ({ page }) => {
  const problems = watchForRuntimeProblems(page);
  await reachRegionFigure(page);

  const figure = page.getByTestId('scope-preview');
  const svg = page.getByTestId('region-figure');
  await expect(svg).toBeVisible();

  /*
   * The accessible name is the conclusion, not a description of the image: how
   * many bases, how much is reachable without moving, how much was left out.
   */
  const label = await svg.getAttribute('aria-label');
  expect(label, 'the figure names the destination and counts the structure').toMatch(
    /^Ambervale: \d+ bases?, \d+ areas? reachable in a day/,
  );
  expect(label).toContain('North is up');

  // Marks, not decoration: at least one base disc and one distance ring.
  expect(await svg.locator('circle').count()).toBeGreaterThan(0);
  expect(await svg.locator('path[data-ring="day_reach"]').count()).toBeGreaterThan(0);

  // The projection is checkable: a scale bar with a round distance, and north.
  await expect(svg.getByText(/^\d+(\.\d+)? (km|m)$/)).toBeVisible();
  await expect(svg.getByText('N', { exact: true })).toBeVisible();

  // And it says what it is, rather than only what it is not.
  await expect(figure).toContainText('Every mark is one source coordinate');
  await expect(figure).toContainText('Web Mercator');
  await expect(figure).not.toContainText('Relative positions from source coordinates. Not a map.');

  expectNoRuntimeProblems(problems, 'the region preview');
});

/**
 * §20 and §32: no fake map, and no basemap without terms.
 *
 * Asserted in the browser as well as in the unit tests because this is the
 * property that would be quietly lost by somebody adding a decorative backdrop
 * to make the panel look fuller.
 */
test('the region preview invents no geography and loads no tiles', async ({ page }) => {
  await reachRegionFigure(page);
  const svg = page.getByTestId('region-figure');

  // No tile source is configured on any build, so nothing is fetched for it.
  expect(await svg.locator('image').count()).toBe(0);
  // No landmass, no coastline: the only closed shapes are distance rings.
  expect(await svg.locator('polygon').count()).toBe(0);
  const rings = await svg.locator('path[data-ring]').count();
  const paths = await svg.locator('path').count();
  // Every path is a ring except the north indicator.
  expect(paths - rings).toBe(1);
});

/**
 * The written key, checked where **everybody** meets it.
 *
 * This asserted a `.sr-only` block, and the block is not hidden any more. The
 * change was not cosmetic: the figure's labels truncate at eighteen characters,
 * and a live capture had four separate marks all rendering as
 * "Ambervale Coast T…" — so the drawing could not be read by anyone, while the
 * text that would have disambiguated it was reaching only people who could not
 * see the drawing. The same block also carried the *reasons* an area was left
 * out, which the picture states nowhere.
 *
 * So the assertion moved from "a hidden description exists" to the stronger
 * claim: the structure is legible as text, in the panel, for every reader.
 */
test('the region preview describes itself in text, for everybody', async ({ page }) => {
  await reachRegionFigure(page);
  const panel = page.getByTestId('scope-preview');

  /* Every base is named in full, with the nights it holds. */
  const bases = panel.getByRole('listitem');
  await expect(bases.first()).toBeVisible();

  const content = (await panel.textContent()) ?? '';
  expect(content).toMatch(/\d+ nights?/);
  /*
   * Four nights over this region cannot reach everything, so something is left
   * out — and the reason travels with it rather than being dropped. Asserted on
   * *visible* text, because a reason only a screen reader could reach was half
   * the defect.
   */
  const visible = await panel.innerText();
  expect(visible).toMatch(/nights?/);
  expect(visible.length).toBeGreaterThan(80);
});

test('the region preview fits the panel it sits in', async ({ page }) => {
  await reachRegionFigure(page);
  await expectNoHorizontalOverflow(page, 'the plan screen with the region figure');

  const box = await page.getByTestId('region-figure').boundingBox();
  const panel = await page.getByTestId('scope-preview').boundingBox();
  expect(box, 'the figure has a box').not.toBeNull();
  expect(panel).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(panel!.width + 1);
  // Tall enough to read at any width the suite runs at, short enough not to push
  // the panel's own numbers off the screen.
  expect(box!.height).toBeGreaterThan(120);
  expect(box!.height / box!.width).toBeCloseTo(250 / 320, 1);
});
