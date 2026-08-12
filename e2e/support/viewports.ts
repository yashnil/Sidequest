import { expect, type Page } from '@playwright/test';

/**
 * THE VIEWPORTS THE SUITE COVERS, NAMED ONCE.
 *
 * Written down here because the claim "we test at desktop, tablet and mobile"
 * was made repeatedly and was never true of the automated suite: the config
 * declared `Desktop Chrome` twice (1280x720, differing only in colour scheme)
 * and `iPhone 13` once — two sizes, one of them run twice, and no tablet at all.
 * Worse, `devices['iPhone 13'].viewport` is 390x**664**; the 844 that everybody
 * quoted is its *screen* height, which is not the box the layout is laid out in.
 *
 * So the sizes live in one exported constant, `playwright.config.ts` declares
 * them explicitly rather than inheriting whatever a device descriptor happens to
 * carry this release, and `playwright.config.test.ts` asserts the two agree.
 *
 * Colour scheme is not a viewport. `desktop-dark` is worth running and is not
 * counted here.
 *
 * ## The two corrections this list has needed
 *
 * **The height was a screen, not a viewport.** `mobile` said 390x**844** for
 * three phases — in this file, four lines under its own comment saying that 844
 * is the iPhone's screen height and 664 is the box a layout is laid out in. No
 * phone lays out at 844: the browser's own chrome takes the difference. A page
 * measured at 844 has 180 more vertical pixels than the device gives it, which
 * is exactly enough to hide every "is the sticky bar still on screen" and "does
 * this fold" failure the mobile project exists to find.
 *
 * **There was no narrow width at all.** The list bottomed out at 390, and the
 * homepage overflowed horizontally at every width below 383 — 8px at 375, 23px
 * at 360, 63px at 320, measured in both colour schemes — while three viewports
 * and a full-page screenshot sweep reported no overflow anywhere. Seven pixels
 * of margin between the narrowest declared width and the threshold is not
 * coverage; it is a coin landing the right way up. 360 is the width most
 * Androids lay out at and the one the defect was worst at.
 *
 * Both sizes are real device descriptors rather than round numbers — 390x664 is
 * `devices['iPhone 13']`, 360x780 is `devices['Galaxy S24']` — so a reviewer can
 * check them against something rather than against a preference.
 */
export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 664 },
  { name: 'phone-narrow', width: 360, height: 780 },
] as const;

export type Viewport = (typeof VIEWPORTS)[number];

/**
 * Start collecting the things a browser only says out loud.
 *
 * Returns the live array — read it at the end of the test, not during, because a
 * console error raised while the page is still settling is still an error.
 */
export function watchForRuntimeProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/**
 * The horizontal-overflow probe.
 *
 * A page that scrolls sideways is the single most common responsive failure and
 * the one screenshots hide, because a full-page screenshot is as wide as the
 * content rather than as wide as the window. One pixel of slack, because
 * sub-pixel rounding on fractional layouts routinely produces exactly that.
 *
 * Retried rather than sampled once: a late-loading image or a font swap can widen
 * the document a frame after navigation resolves, and a bare read would catch
 * either the moment before or the moment after at random.
 */
export async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  await expect(async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${where} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
}

/** Fail with every problem the run collected, not just the first. */
export function expectNoRuntimeProblems(problems: string[], where = 'Runtime problems'): void {
  expect(problems, `${where}:\n${problems.join('\n')}`).toEqual([]);
}
