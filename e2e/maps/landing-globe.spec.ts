import { expect, test, type Page } from '@playwright/test';
import { routeTiles } from './support/tiles';

/**
 * THE LANDING GLOBE'S LIFECYCLE, IN A REAL BROWSER.
 *
 * The ordinary suite pins the map provider off, so it only ever sees the
 * designed still. Here the provider is on (`playwright.maps.config.ts`, or
 * `playwright.globe.config.ts` on its own server), every tile is answered by
 * `support/tiles.ts`, and the production `AtlasGlobe` runs unchanged:
 * poster → loading → live, the 700 ms cross-fade, the declines, and what is
 * left behind when the visitor leaves.
 *
 * Observability is the component's own `data-phase` plus an init script that
 * records, from before the first byte is parsed, every phase the globe passes
 * through, whether the designed still was ever mounted, and how many WebGL
 * contexts were created and given back.
 */

const MAPLIBRE_MODULE = '**/vendor/maplibre/maplibre-gl.mjs';

declare global {
  interface Window {
    __globe: { phases: string[]; stillSeen: boolean; contextsCreated: number; contextsLost: number };
  }
}

/** Installed before any page script: phase history, still sightings, WebGL context ledger. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = { phases: [] as string[], stillSeen: false, contextsCreated: 0, contextsLost: 0 };
    window.__globe = record;
    const original = HTMLCanvasElement.prototype.getContext;
    const seen = new WeakSet<object>();
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const context = (original as (...a: unknown[]) => unknown).call(this, type, ...rest) as WebGLRenderingContext | null;
      if (context && (type === 'webgl' || type === 'webgl2') && !seen.has(context)) {
        seen.add(context);
        record.contextsCreated += 1;
        this.addEventListener('webglcontextlost', () => {
          record.contextsLost += 1;
        });
      }
      return context;
    } as typeof original;
    const scan = () => {
      const globe = document.querySelector('[data-testid="atlas-globe"]');
      if (!globe) return;
      const phase = globe.getAttribute('data-phase') ?? '';
      if (record.phases[record.phases.length - 1] !== phase) record.phases.push(phase);
      if (globe.querySelector('.survey-night')) record.stillSeen = true;
    };
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase'] });
  });
}

function globe(page: Page) {
  return page.getByTestId('atlas-globe');
}

/** The designed still lives inside the globe as the only `.survey-night` there. */
function still(page: Page) {
  return globe(page).locator('.survey-night');
}

/** The element the live map fades in on (the parent of MapLibre's container). */
function mapLayer(page: Page) {
  return globe(page).locator('.maplibregl-map').locator('xpath=..');
}

async function bringGlobeIntoView(page: Page): Promise<void> {
  await globe(page).scrollIntoViewIfNeeded();
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    /* A refused favicon or an empty test tile is not the globe's error. */
    if (/Failed to load resource/.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

test.describe('server render, before any script runs', () => {
  test.use({ javaScriptEnabled: false });

  test('the first paint is the silhouette, never the example sketch', async ({ page }) => {
    await page.goto('/');
    await expect(globe(page)).toHaveAttribute('data-phase', 'poster');
    const silhouette = page.getByTestId('globe-silhouette');
    await expect(silhouette).toBeAttached();
    await expect(silhouette.locator('.globe-silhouette')).toBeVisible();
    await expect(still(page)).toHaveCount(0);
    await expect(globe(page).locator('canvas')).toHaveCount(0);
  });
});

test('a capable browser loads MapLibre from vendor and fades the globe in over its silhouette', async ({ page }) => {
  const errors = collectErrors(page);
  const tiles = await routeTiles(page);
  await instrument(page);
  const moduleResponse = page.waitForResponse((r) => r.url().endsWith('/vendor/maplibre/maplibre-gl.mjs'));
  await page.goto('/');
  await bringGlobeIntoView(page);

  const response = await moduleResponse;
  expect(response.status()).toBe(200);
  await expect(globe(page)).toHaveAttribute('data-phase', 'live', { timeout: 30_000 });

  /* The library arrived as a module, its stylesheet once, and a real canvas drew. */
  await expect(page.locator('link#maplibre-gl-css')).toHaveCount(1);
  await expect(globe(page).locator('canvas.maplibregl-canvas')).toHaveCount(1);
  expect(tiles.requests.some((url) => url.includes('tiles.openfreemap.org'))).toBe(true);

  /* The cross-fade ends with the map fully in and at scale, and the silhouette gone. */
  const layer = mapLayer(page);
  await expect(layer).toHaveCSS('transition-duration', /0\.7s/);
  await expect(layer).toHaveCSS('opacity', '1');
  await expect(layer).toHaveCSS('transform', /matrix\(1, 0, 0, 1, 0, 0\)|none/);
  await expect(page.getByTestId('globe-silhouette')).toHaveCSS('opacity', '0');

  /* Live chrome: the credits and the pause control appear only now. */
  await expect(page.getByRole('button', { name: 'Pause the tour' })).toBeVisible();

  const record = await page.evaluate(() => window.__globe);
  expect(record.phases).toEqual(['poster', 'loading', 'live']);
  expect(record.stillSeen).toBe(false);
  /* The capability probe gave its context back; the live map holds exactly one. */
  expect(record.contextsCreated - record.contextsLost).toBe(1);
  expect(errors).toEqual([]);
});

test('before the library answers, the map layer is transparent and slightly small under the silhouette', async ({ page }) => {
  await routeTiles(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(MAPLIBRE_MODULE, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/');
  await bringGlobeIntoView(page);
  await expect(globe(page)).toHaveAttribute('data-phase', 'loading');
  const layer = globe(page).locator('div[style*="scale(0.985)"]');
  await expect(layer).toHaveCSS('opacity', '0');
  await expect(page.getByTestId('globe-silhouette')).toHaveCSS('opacity', '1');
  await expect(still(page)).toHaveCount(0);
  release();
  await expect(globe(page)).toHaveAttribute('data-phase', 'live', { timeout: 30_000 });
});

test('a map library that never arrives retries, then settles on the designed still', async ({ page }) => {
  const errors = collectErrors(page);
  await routeTiles(page);
  await instrument(page);
  let attempts = 0;
  await page.route(MAPLIBRE_MODULE, (route) => {
    attempts += 1;
    return route.fulfill({ status: 404, body: 'gone' });
  });
  await page.goto('/');
  await bringGlobeIntoView(page);
  /* Two retries (700 ms, 1800 ms) then `failed`; well inside this bound. */
  await expect(globe(page)).toHaveAttribute('data-phase', 'failed', { timeout: 15_000 });
  await expect(still(page)).toBeVisible();
  await expect(page.getByTestId('globe-silhouette')).toHaveCount(0);
  await expect(globe(page).locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause the tour' })).toHaveCount(0);
  /* The hero is still a working page: the example index and its link answer. */
  await expect(page.getByRole('button', { name: /02/ }).first()).toBeVisible();
  await expect(page.getByTestId('home-prompt')).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(1);
  const record = await page.evaluate(() => window.__globe);
  expect(record.phases).toEqual(['poster', 'loading', 'failed']);
  expect(record.contextsCreated - record.contextsLost).toBe(0);
  expect(errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
});

test('an aborted library request is the same decline', async ({ page }) => {
  await routeTiles(page);
  await page.route(MAPLIBRE_MODULE, (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await bringGlobeIntoView(page);
  await expect(globe(page)).toHaveAttribute('data-phase', 'failed', { timeout: 15_000 });
  await expect(still(page)).toBeVisible();
});

test('a visitor who asked to save data gets the still and no map download', async ({ page }) => {
  await routeTiles(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ saveData: true }) });
  });
  await page.goto('/');
  await bringGlobeIntoView(page);
  await expect(globe(page)).toHaveAttribute('data-phase', 'failed');
  await expect(still(page)).toBeVisible();
  /* No map was built: no stylesheet injected, no canvas. (The render-time modulepreload hint is the only map request allowed.) */
  await expect(page.locator('link#maplibre-gl-css')).toHaveCount(0);
  await expect(globe(page).locator('canvas')).toHaveCount(0);
});

test.describe('reduced motion', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('the silhouette does not breathe, the globe arrives without a fade, and the tour does not advance', async ({ page }) => {
    await routeTiles(page);
    await page.goto('/');
    const silhouette = page.getByTestId('globe-silhouette').locator('.globe-silhouette');
    await expect(silhouette).toHaveCSS('animation-name', 'none');
    await bringGlobeIntoView(page);
    await expect(globe(page)).toHaveAttribute('data-phase', 'live', { timeout: 30_000 });
    await expect(mapLayer(page)).toHaveCSS('transition-duration', /^(1e-05s|0\.00001s|0s)$/);
    await expect(mapLayer(page)).toHaveCSS('opacity', '1');
    /* Nothing auto-advances, so there is nothing to pause. */
    await expect(page.getByRole('button', { name: 'Pause the tour' })).toHaveCount(0);
    const regions = page.getByRole('list', { name: 'Example regions' }).getByRole('button');
    await expect(regions.first()).toHaveAttribute('aria-pressed', 'true');
    /* Longer than a flight + drawing + hold would take with motion on. */
    await page.waitForTimeout(11_000);
    await expect(regions.first()).toHaveAttribute('aria-pressed', 'true');
    /* The region buttons still work. */
    await regions.nth(1).click();
    await expect(regions.nth(1)).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('with motion', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  test('the silhouette breathes while it waits', async ({ page }) => {
    await routeTiles(page);
    await page.route(MAPLIBRE_MODULE, () => {
      /* Never answered: the silhouette stays up. */
    });
    await page.goto('/');
    await expect(page.getByTestId('globe-silhouette').locator('.globe-silhouette')).toHaveCSS('animation-name', 'globe-breathe');
  });
});

test('on a phone the globe waits until its panel is on screen, then starts', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'phone layout only');
  await routeTiles(page);
  await page.goto('/');
  const box = await globe(page).boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport).toBeTruthy();
  if (box && viewport && box.y >= viewport.height) {
    /* Below the fold: nothing starts until it is seen. */
    await page.waitForTimeout(1500);
    await expect(globe(page)).toHaveAttribute('data-phase', 'poster');
  }
  await bringGlobeIntoView(page);
  await expect(globe(page)).toHaveAttribute('data-phase', 'live', { timeout: 30_000 });
  const canvas = globe(page).locator('canvas.maplibregl-canvas');
  /* Measured once the 700 ms fade-and-scale (0.985 → 1) has settled, not mid-transition. */
  await expect
    .poll(async () => {
      const canvasBox = await canvas.boundingBox();
      const globeBox = await globe(page).boundingBox();
      return canvasBox && globeBox ? Math.abs(canvasBox.width - globeBox.width) : Number.POSITIVE_INFINITY;
    }, { timeout: 5_000 })
    .toBeLessThanOrEqual(2);
  /* No horizontal page scroll at phone width. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the live map follows the window when it is resized', async ({ page }) => {
  const errors = collectErrors(page);
  await routeTiles(page);
  await page.goto('/');
  await bringGlobeIntoView(page);
  await expect(globe(page)).toHaveAttribute('data-phase', 'live', { timeout: 30_000 });
  const canvas = globe(page).locator('canvas.maplibregl-canvas');
  const start = page.viewportSize()!;
  for (const size of [
    { width: 900, height: 700 },
    { width: 390, height: 664 },
    { width: 1440, height: 900 },
    start,
  ]) {
    await page.setViewportSize(size);
    await bringGlobeIntoView(page);
    await expect
      .poll(async () => {
        const [c, g] = await Promise.all([canvas.boundingBox(), globe(page).boundingBox()]);
        return c && g ? Math.abs(c.width - g.width) + Math.abs(c.height - g.height) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(2);
  }
  await expect(globe(page)).toHaveAttribute('data-phase', 'live');
  expect(errors).toEqual([]);
});

test('leaving the page and coming back releases the WebGL context and the globe returns', async ({ page }) => {
  /* Three full boots under software GL; each is a few seconds on an idle machine and far more on a busy one. */
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await routeTiles(page);
  await instrument(page);
  await page.goto('/');
  await bringGlobeIntoView(page);
  await expect(globe(page)).toHaveAttribute('data-phase', 'live', { timeout: 30_000 });

  for (let round = 0; round < 3; round += 1) {
    /* Away, in the app: the composer. The globe unmounts and must give its context back. */
    await page.getByTestId('home-new-trip').click();
    await page.waitForURL(/\/trips\/new/);
    await expect(globe(page)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.__globe.contextsCreated - window.__globe.contextsLost))
      .toBe(0);

    /* And back. */
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/');
    await bringGlobeIntoView(page);
    await expect(globe(page)).toHaveAttribute('data-phase', 'live', { timeout: 30_000 });
    await expect(globe(page).locator('canvas.maplibregl-canvas')).toHaveCount(1);
    await expect(still(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__globe.contextsCreated - window.__globe.contextsLost)).toBe(1);
  }
  expect(errors).toEqual([]);
});
