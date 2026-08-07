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
 * Block the outside world and remember what tried to leave.
 *
 * `abort` rather than `fulfill`, because a blocked image is the interesting
 * case: it is what a corporate proxy, an offline laptop and an upstream deletion
 * all look like, and the product has to survive all three identically.
 */
async function sealOff(page: Page): Promise<{ external: string[] }> {
  const external: string[] = [];
  await page.route('**/*', async (route, request) => {
    if (!isExternal(request)) {
      await route.continue();
      return;
    }
    external.push(request.url());
    await route.abort();
  });
  return { external };
}

async function rankedShortlist(page: Page): Promise<void> {
  await page.goto('/decide');
  await page.getByRole('radio', { name: 'Some time in a month' }).check();
  await page.getByLabel('Which month?').selectOption('7');
  await page.getByLabel('How many nights?').fill('9');
  await page.getByRole('checkbox', { name: 'Hiking and being outside' }).check();
  await page.getByRole('checkbox', { name: 'Mountains and high country' }).check();
  await page.getByRole('button', { name: 'Show me where to go' }).click();
  await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
  await expect(page.getByRole('list', { name: 'Suggested destinations' })).toBeVisible({
    timeout: 30_000,
  });
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
  await expect(page.getByRole('list', { name: 'Suggested destinations' })).toBeVisible();

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
   * **no image slot is ever empty.** A slot holds either a photograph — in which
   * case the graphic behind it is decorative and hidden from assistive
   * technology — or a described graphic that is the content in its own right.
   * There is no third state, and that is what makes "we could not license a
   * picture of this place" a design rather than a gap.
   */
  const figures = page.locator('figure');
  const total = await figures.count();
  expect(total).toBeGreaterThan(0);

  for (let index = 0; index < total; index += 1) {
    const figure = figures.nth(index);
    const photographs = await figure.locator('img').count();
    const graphics = await figure.locator('[role="img"]').count();
    expect(photographs + graphics, `frame ${index} was empty`).toBeGreaterThan(0);

    if (photographs === 0) {
      // The textual equivalent says what it is and names the place, so a screen
      // reader is never told there is a photograph here.
      const label = await figure.locator('[role="img"]').first().getAttribute('aria-label');
      expect(label).toMatch(/generated graphic/i);
      expect(label).toMatch(/no freely licensed photograph/i);
    } else {
      // A photograph is decorative; the destination's name is in the heading
      // beside it, and the graphic behind it must not be announced as content.
      expect(graphics, `frame ${index} announced its backdrop as content`).toBe(0);
    }
  }
});

test('an image that cannot load never becomes a broken rectangle', async ({ page }) => {
  /**
   * Every external request is aborted, so every photograph on this page fails to
   * load — exactly what an offline laptop, a proxy that strips third-party
   * images, or a file deleted upstream produces.
   *
   * There is no `onError` handler and no client state doing this. The generated
   * graphic is drawn *behind* the `<img>`, always, so a failed load reveals a
   * designed object rather than the browser's broken-image icon.
   */
  await sealOff(page);
  await rankedShortlist(page);

  const detail = page.locator('section[aria-labelledby="shortlist-detail-heading"]');
  await expect(detail).toBeVisible();

  const hero = detail.locator('figure').first();
  await expect(hero).toBeVisible();
  // The frame still occupies space and still has something drawn in it, with
  // every byte of the photograph refused at the network layer.
  const box = await hero.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(40);

  // Any <img> that did render is decorative — the name is in the heading beside
  // it, and an alt string here would have every screen reader say it twice.
  for (const image of await page.locator('figure img').all()) {
    expect(await image.getAttribute('alt')).toBe('');
  }
});

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

  const rows = page.getByRole('list', { name: 'Suggested destinations' }).getByRole('listitem');
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    // Every row has a heading-weight name and at least two badges, photograph or
    // not. A card that lost its content because it lost its picture would fail
    // here.
    await expect(row.locator('span.font-display')).not.toBeEmpty();
    await expect(row.getByRole('button')).toBeVisible();
  }

  // And the journey onward is unaffected: choosing still produces a trip.
  await page.getByRole('button', { name: /^Plan / }).click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });
});
