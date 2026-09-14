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
  await page.goto('/decide');
  /*
   * V11 §A1 — the intake asks one question at a time, in the order that changes
   * the ranking most, and stops as soon as it can rank. Two answers is enough,
   * which is why the primary action appears here rather than a third question.
   */
  await page.getByRole('radio', { name: 'Some time in a month' }).check();
  await page.getByLabel('Which month?').selectOption('7');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Hiking and being outside' }).check();
  await page.getByRole('checkbox', { name: 'Mountains and high country' }).check();
  await page.getByRole('button', { name: 'One more question' }).click();
  await page.getByRole('spinbutton', { name: 'Nights away' }).fill('9');
  await page.getByRole('button', { name: 'Show me where to go' }).click();
  await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
  await expect(page.getByTestId('shortlist-featured')).toBeVisible({ timeout: 30_000 });
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
  await expect(page.getByTestId('shortlist-featured')).toBeVisible();

  // A re-render added no lookups of any kind.
  const added = external.slice(afterRanking);
  const lookups = added.filter((url) => url.includes('/w/api.php'));
  expect(lookups, `render made image lookups: ${lookups.join(', ')}`).toEqual([]);

  // And no render, first or subsequent, ever asked a wiki anything.
  const wikis = external.filter((url) => /wikidata\.org|wikimedia\.org\/w\/|wikipedia\.org/.test(url));
  expect(wikis, `a wiki API was called during render: ${wikis.join(', ')}`).toEqual([]);
});

test('destination fallback renders as a designed graphic, never an absence', async ({ page }) => {
  await sealOff(page);
  await rankedShortlist(page);

  /*
   * The invariant, asserted over every frame rather than over a lucky one:
   * **no image slot is ever empty, and nothing announces a photograph that is not
   * there.** A slot draws either a photograph over the graphic — in which case
   * the graphic is decorative and hidden from assistive technology — or the
   * graphic alone.
   *
   * The emptiness half is a *rendered* check rather than an element count. It
   * used to be `img + [role=img] > 0`, which was satisfied by an `<img>` the
   * browser had already given up on: with every request refused, the count said
   * "not empty" while the frame held the broken-file glyph. A box with height is
   * the thing the traveller can actually see.
   */
  const figures = page.locator('figure');
  const total = await figures.count();
  expect(total).toBeGreaterThan(0);

  let announced = 0;

  for (let index = 0; index < total; index += 1) {
    const figure = figures.nth(index);
    const box = await figure.boundingBox();
    expect(box?.height ?? 0, `frame ${index} drew nothing`).toBeGreaterThan(10);

    const photographs = await figure.locator('img').count();
    const graphics = await figure.locator('[role="img"]').count();

    if (graphics > 0) {
      announced += 1;
      // The textual equivalent says what it is and names the place, so a screen
      // reader is never told there is a photograph here.
      const label = await figure.locator('[role="img"]').first().getAttribute('aria-label');
      expect(label).toMatch(/generated graphic/i);
      expect(label).toMatch(/no freely licensed photograph/i);
      /*
       * And it is never said over a photograph. A candidate we *did* licence a
       * file for keeps its graphic decorative whether or not the bytes arrived —
       * "no freely licensed photograph was available" is false about it, and a
       * network failure does not make it true.
       */
      expect(photographs, `frame ${index} announced its backdrop as content`).toBe(0);
    }
  }

  /*
   * The fallback path has to be exercised for the rules above to mean anything.
   * The fixture resolver refuses a share of its subjects on purpose, for exactly
   * this reason.
   */
  expect(announced, 'no frame fell back, so the fallback rules asserted nothing').toBeGreaterThan(0);
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
    const detail = page.getByTestId('shortlist-featured-card').first();
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

  const rows = page.getByTestId('shortlist-featured-card');
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    // Every card has a name and its three actions, photograph or not. A card
    // that lost its content because it lost its picture would fail here.
    await expect(row.getByRole('heading', { level: 3 })).not.toBeEmpty();
    await expect(row.getByRole('button', { name: 'Plan this' })).toBeVisible();
  }

  // And the journey onward is unaffected: choosing still produces a trip.
  await page.getByRole('button', { name: 'Plan this' }).first().click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });
});
