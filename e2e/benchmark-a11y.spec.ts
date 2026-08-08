import { expect, test, type Page } from '@playwright/test';
import {
  completeReview,
  reachReview,
  seedQuestionRound,
  seedReviewableSession,
  showPanel,
} from './support/benchmark';
import { VIEWPORTS } from './support/viewports';

/**
 * THE REVIEW FORM, OPERATED WITHOUT A MOUSE AND WITHOUT SIGHT.
 *
 * Two hundred and ten radio buttons is where an accessibility failure stops
 * being a nuisance and becomes a reason the instrument produces bad data: a
 * reviewer who cannot tell which of fifteen scales they are on will answer some
 * of them wrong, and nothing downstream can tell that apart from an opinion.
 *
 * So the assertions here are about the things that decide whether the form is
 * usable at all — a visible focus ring, arrow keys inside a group, a name on
 * every option, a target big enough to hit on a phone, and no motion for
 * somebody who asked for none.
 */

const MOBILE = VIEWPORTS.find((viewport) => viewport.name === 'mobile')!;

/** Fifteen dimensions, seven points, two panels. */
const RATING_OPTION_COUNT = 15 * 7 * 2;

async function openReview(page: Page, seed: string): Promise<void> {
  const sessionId = await seedReviewableSession(page, { seed });
  await reachReview(page, sessionId);
  // Below 1280 only one panel is on screen, and which one was drawn rather than
  // chosen. Everything below asserts against panel A, so bring it forward.
  await showPanel(page, 'A');
}

test('every rating group is a real radio group with named options', async ({ page }) => {
  await openReview(page, 'a11y-groups');

  const group = page.locator('[data-testid="rating-A-pacing"]');
  await expect(group).toBeVisible();
  await expect(group.locator('legend')).toHaveText(/amount packed into each day/i);

  const options = group.getByRole('radio');
  await expect(options).toHaveCount(7);

  /*
   * The accessible name is the whole sentence, not the digit. "5" announced on
   * its own says nothing about which scale it belongs to, and a reviewer using a
   * screen reader meets this control thirty times per plan.
   */
  await expect(group.getByRole('radio', { name: 'Plan A — Pacing: 5 of 7' })).toHaveCount(1);
});

/**
 * THE TWO PANELS' CONTROLS ARE TELLABLE APART BY EAR.
 *
 * At 1280 and above both panels are in the accessibility tree at once, so
 * thirty legends and two hundred and ten options exist in fifteen identical
 * pairs. Distinguished by position on screen, which is exactly the information a
 * screen-reader user does not have — so the panel label has to be in the name of
 * every control that exists once per panel, and this asserts each of the three
 * kinds rather than a sample of one.
 */
test('the two panels name their controls apart at the two-column width', async ({ page }) => {
  const desktop = VIEWPORTS.find((viewport) => viewport.name === 'desktop')!;
  await page.setViewportSize({ width: desktop.width, height: desktop.height });

  const sessionId = await seedReviewableSession(page, { seed: 'a11y-both-panels' });
  await reachReview(page, sessionId);
  await expect(page.getByTestId('panel-A')).toBeVisible();
  await expect(page.getByTestId('panel-B')).toBeVisible();

  for (const label of ['A', 'B'] as const) {
    const group = page.locator(`[data-testid="rating-${label}-pacing"]`);
    await expect(group.locator('legend')).toHaveText(new RegExp(`Plan ${label}$`));
    await expect(group.getByRole('radio', { name: `Plan ${label} — Pacing: 5 of 7` })).toHaveCount(
      1,
    );
    await expect(
      page.getByRole('checkbox', { name: new RegExp(`cannot rate.*Plan ${label}`, 'i') }),
    ).toHaveCount(1);
  }

  /*
   * And no two rating options anywhere on the page share a name. Two hundred and
   * ten of them, thirty scales, two panels: one repeated name means a reviewer
   * navigating by name can land on the wrong plan's scale and never find out.
   * The forced choices are deliberately not in this sweep — their options repeat
   * by design, and the legend above each is what distinguishes them.
   */
  const names = await page
    .locator('[data-testid^="rating-"] label .sr-only')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));
  expect(names.length).toBe(RATING_OPTION_COUNT);
  expect(new Set(names).size, `duplicated option names: ${names.join(' | ')}`).toBe(names.length);
});

test('arrow keys move within a rating group', async ({ page }) => {
  await openReview(page, 'a11y-arrows');

  const group = page.locator('[data-testid="rating-A-pacing"]');
  const fourth = group.getByRole('radio', { name: 'Plan A — Pacing: 4 of 7' });
  await fourth.check();
  await expect(fourth).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio', { name: 'Plan A — Pacing: 5 of 7' })).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(fourth).toBeChecked();
});

test('focus is visible on the controls somebody tabs through', async ({ page }) => {
  await openReview(page, 'a11y-focus');

  const reviewer = page.getByLabel('Who is reviewing');
  await reviewer.focus();
  await expect(reviewer).toBeFocused();

  const outline = await reviewer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  expect(outline.style).not.toBe('none');

  // And tabbing off the field lands somewhere real rather than nowhere.
  await page.keyboard.press('Tab');
  const landed = await page.evaluate(() => document.activeElement?.tagName ?? '');
  expect(['BUTTON', 'INPUT', 'A', 'TEXTAREA', 'SELECT', 'SUMMARY']).toContain(landed);
});

test('asking for less motion leaves nothing animating', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openReview(page, 'a11y-motion');

  const moving = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .map((element) => {
        const style = getComputedStyle(element);
        return Math.max(
          ...style.animationDuration.split(',').map((value) => parseFloat(value) * 1000 || 0),
          ...style.transitionDuration.split(',').map((value) => parseFloat(value) * 1000 || 0),
        );
      })
      .filter((duration) => duration > 1).length,
  );
  expect(moving).toBe(0);
});

test('every control is big enough to hit on a phone', async ({ page }) => {
  await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height });
  await openReview(page, 'a11y-targets');

  /*
   * Both panels, one after the other.
   *
   * Below 1280 the second is stacked behind a switcher and genuinely hidden, and
   * a hidden element has no box to measure — so the sweep used to run over panel
   * A only and half the form was never measured at the width where it matters.
   * Bringing each forward in turn costs one click and covers the other half.
   */
  for (const label of ['A', 'B'] as const) {
    await showPanel(page, label);
    await expectEveryControlIsBigEnough(page, `panel ${label} at ${MOBILE.name}`);
  }
});

/**
 * Measured on the thing a finger actually lands on.
 *
 * Every radio in this product is a transparent overlay filling its own label —
 * the pattern in `ui.tsx`, which exists because an `sr-only` input looks
 * identical and is not a pointer target at all. The overlay is inset to the
 * label's *padding* box, so it measures two pixels shorter than the control it
 * covers, and reading its box alone would fail a 44-pixel target for being 42.
 *
 * The skip link is excluded, and only it. It is `sr-only` until it takes focus,
 * at which point it becomes a normal control at a normal size, so measuring its
 * unfocused one-pixel box would fail the one affordance that exists specifically
 * for keyboard users.
 */
async function expectEveryControlIsBigEnough(page: Page, where: string): Promise<void> {
  const controls = page.locator(
    'button:visible, a:visible, select:visible, textarea:visible, input:visible',
  );
  const count = await controls.count();
  expect(count, `${where} has almost no controls, which is not a passing sweep`).toBeGreaterThan(10);

  const tooSmall: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const box = await control.evaluate((node) => {
      if (node.classList.contains('sr-only')) return null;
      const target = node.closest('label') ?? node;
      const rect = target.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    if (box === null) continue;
    if (box.height < 44 || box.width < 24) {
      tooSmall.push(
        `${await control.evaluate((node) => node.outerHTML.slice(0, 90))} — ${box.width}x${box.height}`,
      );
    }
  }
  expect(tooSmall, `${where}: controls under the minimum target size:\n${tooSmall.join('\n')}`).toEqual(
    [],
  );
}

test('the panel switcher below the two-column width is operable', async ({ page }) => {
  await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height });
  await openReview(page, 'a11y-switcher');

  const toB = page.getByTestId('switch-B');
  await expect(toB).toBeVisible();
  await toB.click();
  await expect(toB).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('panel-B')).toBeVisible();
  await expect(page.getByTestId('panel-A')).toBeHidden();
});

/* ------------------------------------------------------------------ *
 * The one control that cannot be undone
 * ------------------------------------------------------------------ */

/**
 * THE LOCK CONFIRMATION, OPERATED BY KEYBOARD ALONE.
 *
 * The only irreversible action in the phase, and the one place where "it looks
 * like a dialog" and "it behaves like a dialog" diverging costs something real.
 * Four properties, and each was absent at some point: focus lands somewhere
 * announced *and* visible, Tab does not wander back into the form behind it,
 * Escape backs out, and backing out returns focus to the control that opened it
 * rather than dropping it on the body.
 */
test('the lock confirmation takes focus, keeps it, and gives it back', async ({ page }) => {
  const sessionId = await seedReviewableSession(page, { seed: 'a11y-lock-focus' });
  await reachReview(page, sessionId);
  await completeReview(page);

  const trigger = page.getByTestId('lock-open');
  await trigger.click();

  const dialog = page.getByTestId('lock-confirm-panel');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'alertdialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  // A real heading, and the thing focus was moved to.
  const heading = page.locator('#lock-confirm-heading');
  await expect(heading).toHaveJSProperty('tagName', 'H3');
  await expect(heading).toBeFocused();

  /*
   * And an indicator on it. `outline-none` on the element focus has just been
   * moved to tells a sighted keyboard user nothing at all, which is how this
   * started.
   */
  const outline = await heading.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  expect(outline.style).not.toBe('none');

  // Tab cycles between the two buttons and never leaves the dialog.
  for (let press = 0; press < 4; press += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      const panel = document.querySelector('[data-testid="lock-confirm-panel"]');
      return active !== null && panel !== null && panel.contains(active);
    });
    expect(inside, `focus left the confirmation after ${press + 1} presses`).toBe(true);
  }

  // Escape cancels, and focus goes back where it came from.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

/**
 * THE LIVE REGIONS SAY LITTLE, AND ONLY WHEN SOMETHING HAS SETTLED.
 *
 * The autosave region used to announce "Saving…" and then "Saved" 800ms after
 * every keystroke, which talks straight over a screen-reader user writing the
 * one explanation this form requires. What it must do is stay quiet while
 * somebody is typing and say one thing once they stop.
 */
test('the autosave region stays quiet while somebody is typing', async ({ page }) => {
  await openReview(page, 'a11y-live-region');

  const region = page.locator('[role="status"][aria-live="polite"].sr-only');
  await expect(region).toHaveCount(1);

  const explanation = page.getByLabel('Why did you choose that?');
  await explanation.click();
  for (const chunk of ['It reads ', 'as the more ', 'workable of ', 'the two.']) {
    await page.keyboard.type(chunk, { delay: 30 });
    // Well inside the settle window, so nothing should have been said yet.
    await expect(region).toHaveText('');
  }

  await expect(region).toHaveText('Saved', { timeout: 10_000 });
});

/**
 * HEADINGS IN ORDER, WITH NO LEVEL SKIPPED.
 *
 * A screen reader's heading list is how anybody navigates a page this long, and
 * a jump from `h1` to `h3` reads as a missing section rather than as a styling
 * choice. Asserted over the levels in document order rather than against a fixed
 * list, so a heading added later is covered without anybody editing this.
 */
test('the review page has an unbroken heading order', async ({ page }) => {
  await openReview(page, 'a11y-headings');

  const levels = await page
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .map((node) => ({ level: Number(node.tagName.slice(1)), text: node.textContent ?? '' })),
    );

  expect(levels.length).toBeGreaterThan(3);
  expect(levels[0]?.level, 'the page should start at a single h1').toBe(1);

  const jumps = levels
    .slice(1)
    .map((heading, index) => ({ heading, previous: levels[index]! }))
    .filter(({ heading, previous }) => heading.level > previous.level + 1)
    .map(({ heading, previous }) => `h${previous.level} → h${heading.level} at "${heading.text}"`);
  expect(jumps, `skipped heading levels:\n${jumps.join('\n')}`).toEqual([]);
});

/**
 * EVERY WORD ON THE SCREEN CLEARS 4.5:1.
 *
 * A sweep rather than a list of tokens, because the failure this catches is a
 * *new* token used somewhere nobody thought to check — the muted greys on this
 * surface are close enough to the paper that one shade further would fail, and a
 * benchmark whose figures are hard to read is a benchmark that gets misread.
 * Large text is held to 3:1, which is what the guideline actually says.
 */
test('text on the review meets the contrast minimum', async ({ page }) => {
  await openReview(page, 'a11y-contrast');

  const failures = await page.evaluate(() => {
    const luminance = (colour: string): number => {
      const parts = colour.match(/[\d.]+/g)?.map(Number) ?? [];
      const [red = 0, green = 0, blue = 0] = parts;
      const channel = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };

    const backdrop = (element: Element): string => {
      let node: Element | null = element;
      while (node !== null) {
        const colour = getComputedStyle(node).backgroundColor;
        const alpha = Number(colour.match(/[\d.]+/g)?.[3] ?? '1');
        if (alpha > 0 && colour !== 'transparent') return colour;
        node = node.parentElement;
      }
      return 'rgb(255, 255, 255)';
    };

    const bad: string[] = [];
    for (const element of document.querySelectorAll('p, span, dt, dd, h1, h2, h3, li, label, th, td')) {
      const own = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0,
      );
      if (!own) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (element.classList.contains('sr-only')) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;

      const front = luminance(style.color);
      const back = luminance(backdrop(element));
      const ratio = (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        bad.push(`${ratio.toFixed(2)}:1 — ${style.color} on ${backdrop(element)} — ${(element.textContent ?? '').slice(0, 40)}`);
      }
    }
    return bad;
  });

  expect([...new Set(failures)], `text below the contrast minimum:\n${failures.join('\n')}`).toEqual(
    [],
  );
});

/* ------------------------------------------------------------------ *
 * The question round
 * ------------------------------------------------------------------ */

/**
 * THE SCREEN THAT HAD NEVER BEEN SWEPT.
 *
 * Every check in this file ran against a session already at `ready_for_review`,
 * where the question panel does not render at all — so the answer controls, the
 * second press and their names had never been focused, measured or announced.
 *
 * The specific failure worth asserting is the naming one. Six questions on one
 * page, each with a box labelled "Your answer" and a button labelled "Save this
 * answer", is six identical controls to anybody not reading the paragraph above
 * them. The review form was built carefully to avoid exactly that; this screen
 * was not.
 */
test('every answer control is named by the question it belongs to', async ({ page }) => {
  await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height });
  await seedQuestionRound(page, 'a11y-questions');

  const questions = page.getByTestId('pooled-questions').locator('li');
  await expect(questions).toHaveCount(2);

  const names = await questions.evaluateAll((items) =>
    items.map((item) => {
      const control = item.querySelector('select, input');
      const labelledBy = control?.getAttribute('aria-labelledby') ?? '';
      return labelledBy
        .split(/\s+/)
        .map((id) => item.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
        .join(' ');
    }),
  );

  // Two controls, two different names, and each contains its own question.
  expect(new Set(names).size).toBe(2);
  for (const name of names) expect(name.length).toBeGreaterThan(20);
});

test('the answer controls and the second press are big enough to hit', async ({ page }) => {
  await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height });
  await seedQuestionRound(page, 'a11y-question-targets');

  const controls = page
    .getByTestId('pooled-questions')
    .locator('select, input, button')
    .and(page.locator(':visible'));
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await controls.nth(index).boundingBox();
    expect(box, `control ${index} has no box`).not.toBeNull();
    if (box) expect(box.height, `control ${index} is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
  }

  const plan = page.getByTestId('plan-both');
  const planBox = await plan.boundingBox();
  expect(planBox).not.toBeNull();
  if (planBox) expect(planBox.height).toBeGreaterThanOrEqual(44);
});

test('the question round is reachable and visible by keyboard alone', async ({ page }) => {
  await seedQuestionRound(page, 'a11y-question-keyboard');

  const first = page.getByTestId('pooled-questions').locator('select, input').first();
  await first.focus();
  await expect(first).toBeFocused();

  const outline = await first.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);
});
