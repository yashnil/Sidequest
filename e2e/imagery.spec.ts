import { adviseToShortlist } from './support/advisor';
import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * IMAGERY, THROUGH THE BROWSER.
 *
 * Four properties, and three of them are about what does *not* happen.
 *
 * The environment is the same synthetic one the rest of the suite uses: five
 * invented countries and a fixture compiler, which puts the imagery resolver in
 * fixture mode too. That is deliberate rather than convenient — a deployment
 * running its whole stack on fixtures must never be the one deployment that
 * reaches a live volunteer-run service, and here it means the whole file runs
 * offline while still exercising the real licence gate, because the fixture
 * builds its records *through* that gate rather than around it.
 *
 * Every external host is blocked at the route layer below, so "no network during
 * render" is enforced rather than hoped for: a request that would have gone out
 * fails the test by being recorded, not by making the suite slow.
 */

/** Anything that is not our own dev server. */
function isExternal(request: Request): boolean {
  const host = new URL(request.url()).hostname;
  return host !== '127.0.0.1' && host !== 'localhost';
}

/**
 * How a blocked external request is answered.
 *
 * Three of them, because they are three *different* things to a browser and the
 * product has to survive all three identically — which it did not. `abort` is an
 * offline laptop or a proxy that drops third-party images; `not_found` is a
 * Wikimedia file deleted after we stored its URL, which answers 404 with an image
 * content type; `corrupt` is a 200 whose bytes are not a picture, which is what a
 * captive portal or a truncated transfer produces.
 *
 * All three end at the same place: `HTMLImageElement.complete` with
 * `naturalWidth === 0`, the state in which a browser draws its own broken-file
 * glyph. That is the property `noBrokenImages` below asserts against.
 */
type BlockMode = 'abort' | 'not_found' | 'corrupt';

/**
 * Block the outside world and remember what tried to leave.
 */
async function sealOff(page: Page, mode: BlockMode = 'abort'): Promise<{ external: string[] }> {
  const external: string[] = [];
  await page.route('**/*', async (route, request) => {
    if (!isExternal(request)) {
      await route.continue();
      return;
    }
    external.push(request.url());
    if (mode === 'abort') {
      await route.abort();
      return;
    }
    /*
     * A response, not a refusal. The status and the body differ; the content type
     * is an image type in both, because that is what the real failures send and
     * because a browser that was told "this is a JPEG" and handed something else
     * is exactly the case a content-type check would miss.
     */
    await route.fulfill(
      mode === 'not_found'
        ? { status: 404, contentType: 'image/jpeg', body: 'No such file.' }
        : { status: 200, contentType: 'image/jpeg', body: 'This is not a JPEG.' },
    );
  });
  return { external };
}

/**
 * Every image the browser is currently drawing its broken-file glyph for.
 *
 * `complete && naturalWidth === 0` is the DOM's own account of a failed load, and
 * it is the same for all three modes above. Asserting on it rather than on a
 * screenshot means the assertion says what it means and does not go stale when a
 * colour changes.
 */
async function brokenImages(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.images]
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src),
  );
}

async function rankedShortlist(page: Page): Promise<void> {
  /* The destination advisor (2026-10): type, answer what it asks, wait for the stored list. */
  await adviseToShortlist(page);
  await expect(page.getByTestId('advisor-shortlist')).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------

test('NO EXTERNAL REQUEST DURING RENDER', async ({ page }) => {
  /**
   * The rule the whole slice rests on: an image *identity* is resolved once, by
   * a server action, and written down. A render reads rows.
   *
   * Without this, the natural implementation resolves per card — which means one
   * request per destination per view, on every refresh and every back button,
   * from every visitor. Wikimedia names that pattern explicitly and asks clients
   * not to build it; the fact that it would also be slow is the least of it.
   */
  const { external } = await sealOff(page);
  await rankedShortlist(page);

  const afterRanking = external.length;
  await page.reload();
  await expect(page.getByTestId('advisor-shortlist')).toBeVisible();

  // A re-render added no lookups of any kind.
  const added = external.slice(afterRanking);
  const lookups = added.filter((url) => url.includes('/w/api.php'));
  expect(lookups, `render made image lookups: ${lookups.join(', ')}`).toEqual([]);

  // And no render, first or subsequent, ever asked a wiki anything.
  const wikis = external.filter((url) => /wikidata\.org|wikimedia\.org\/w\/|wikipedia\.org/.test(url));
  expect(wikis, `a wiki API was called during render: ${wikis.join(', ')}`).toEqual([]);
});

test('a destination without a photograph says so on a real map, never an empty or invented frame', async ({ page }) => {
  await sealOff(page);
  await rankedShortlist(page);

  /*
   * The advisor's rule: a card shows a credited photograph of the destination's
   * own Wikidata item, or a locator — the place's real coordinate on a world
   * map, captioned "No photograph yet". Never an empty frame, and never an
   * abstract graphic dressed as a picture of the place.
   */
  const picks = page.getByTestId('advisor-pick');
  const total = await picks.count();
  expect(total).toBe(3);
  for (let index = 0; index < total; index += 1) {
    const pick = picks.nth(index);
    const photographs = await pick.locator('figure').count();
    const locators = await pick.getByText('No photograph yet').count();
    expect(photographs + locators, `pick ${index} drew no image slot`).toBeGreaterThan(0);
    if (locators > 0) {
      await expect(pick.getByRole('img', { name: /on a world map/ })).toBeVisible();
      expect(await pick.locator('img').count(), `pick ${index} has a photo inside its locator`).toBe(0);
    }
  }
});

/**
 * THE THREE WAYS A PHOTOGRAPH FAILS, AND THE ONE THING THE TRAVELLER SEES.
 *
 * One body, three modes, because the modes are not interchangeable to a browser
 * and this suite previously only ever exercised one of them. The graphic drawn
 * *behind* the `<img>` was believed to be the whole mechanism; it is not. A
 * browser handed a failing image paints its broken-file glyph over whatever is
 * underneath, in all three modes, and the only thing that stops it is not having
 * the element there — which is what `DestinationImage` now does on `error` and on
 * a load that had already failed before hydration.
 *
 * `not_found` is not hypothetical. Wikimedia deletes files after upload, and when
 * one goes every stored `thumbnailUrl` pointing at it answers 404 while the row
 * in `destination_images` still says there is a picture.
 */
for (const mode of ['abort', 'not_found', 'corrupt'] as const) {
  test(`an image that cannot load never becomes a broken rectangle (${mode})`, async ({ page }) => {
    await sealOff(page, mode);
    await rankedShortlist(page);

    /* V11 §A2 — the featured card is where a destination is argued for and pictured. */
    const detail = page.getByTestId('advisor-pick').filter({ has: page.locator('figure') }).first();
    await expect(detail).toBeVisible();

    const hero = detail.locator('figure').first();
    await expect(hero).toBeVisible();
    // The frame still occupies space and still has something drawn in it, with
    // every byte of the photograph refused at the network layer.
    const box = await hero.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(40);

    /*
     * The assertion the old version of this test was missing. It checked that the
     * frame had height and that any `<img>` was decorative — both of which are
     * true of a frame displaying the browser's broken-file glyph, which is what
     * this page was actually showing.
     */
    expect(
      await brokenImages(page),
      'the browser is drawing its broken-file glyph over the fallback graphic',
    ).toEqual([]);

    // Any <img> that did render is decorative — the name is in the heading beside
    // it, and an alt string here would have every screen reader say it twice.
    for (const image of await page.locator('figure img').all()) {
      expect(await image.getAttribute('alt')).toBe('');
    }

    /*
     * The credit survives the failure, because it follows the *record* rather
     * than the load: attribution is owed for the file this product chose to
     * publish, and a dropped connection is not a licence event. It is also what
     * keeps the attribution assertions below testable at all, since every image
     * in this suite fails by design.
     */
    await expect(page.getByRole('link', { name: /Wikimedia Commons/ }).first()).toBeVisible();
  });
}

test('attribution is keyboard reachable, and names the licence', async ({ page }) => {
  await sealOff(page);
  await rankedShortlist(page);

  /*
   * The credit is a real link rather than a tooltip or a `title` attribute. That
   * is the difference between an attribution a keyboard or touch user can reach
   * and one that only exists for somebody with a mouse hovering in the right
   * place.
   */
  const credit = page.getByRole('link', { name: /Wikimedia Commons/ }).first();
  await expect(credit).toBeVisible();
  await expect(credit).toHaveAttribute('href', /commons\.wikimedia\.org/);

  // The words are the stored ones: a creator and a named licence.
  await expect(credit).toContainText(/Creative Commons Attribution/);

  // Reachable by tabbing, from the top of the document, without a mouse.
  await page.locator('body').press('Tab');
  let reached = false;
  for (let press = 0; press < 80 && !reached; press += 1) {
    reached = await credit.evaluate((element) => element === document.activeElement);
    if (!reached) await page.keyboard.press('Tab');
  }
  expect(reached, 'the photo credit was not reachable by keyboard').toBe(true);
});

test('an artifact with no imagery still renders every card', async ({ page }) => {
  /**
   * Imagery is an **additive** table with no version gate: a trip compiled
   * before this slice existed has no rows in `destination_images`, and that is
   * the same state as a destination whose only candidate file was refused.
   *
   * So the compatibility case is observable on this page rather than needing an
   * old artifact rebuilt: the cards that have no stored photograph carry their
   * full name, their band, their coverage and their reasons, exactly as they did
   * before there was such a thing as an image record.
   */
  await sealOff(page);
  await rankedShortlist(page);

  const rows = page.getByTestId('advisor-pick');
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    // Every card has a name and its three actions, photograph or not. A card
    // that lost its content because it lost its picture would fail here.
    await expect(row.getByRole('heading', { level: 3 })).not.toBeEmpty();
    await expect(row.getByRole('button', { name: /Plan a trip to/ })).toBeVisible();
  }

  // And the journey onward is unaffected: choosing still produces a trip.
  await page.getByRole('button', { name: /Plan a trip to/ }).first().click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });
});
