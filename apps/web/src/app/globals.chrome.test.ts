import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE HEADER'S HEIGHT, AND THE TOKEN THAT CLAIMS TO BE IT.
 *
 * `--chrome-height` exists so that six sticky and scroll-margin sites — the
 * itinerary's day rail and jump nav, the board's action bar and its analysis
 * rail — can be pinned under the product header without repeating a pixel
 * value. It is a *measurement of another file*, and nothing measured it.
 *
 * It went wrong exactly the way an unmeasured measurement does. The token said
 * 57px, derived in its own comment as `py-3.5` + a `text-xl` line box +
 * `border-b`. Then a separate accessibility fix gave the "New trip" link
 * `min-h-11` — 44px of target, WCAG 2.5.5 — and since the header row is
 * `items-center`, its height became max(28, 44) = 44 and the header became
 * 73px. A reviewer measured 73 at 390x664, 390x844, 1024x768 and 1440x900, and
 * a 16px slice of the day rail and the action bar under the header at all four.
 * One accessibility fix silently invalidated the other and every test stayed
 * green.
 *
 * So the token is derived here from `ProductChrome.tsx`'s own class names,
 * which is the closest a unit test can get to the runtime measurement. It is
 * deliberately *not* a copy of the number: change the padding, add a taller
 * control, drop the border, and this recomputes and disagrees.
 *
 * A browser-side assertion is still worth having and is a separate thing — one
 * line in a Playwright spec comparing `header.getBoundingClientRect().height`
 * with the resolved custom property. This test is what catches the drift at the
 * moment somebody edits the class, without a build or a server.
 */

const CHROME = readFileSync(
  new URL('../components/ProductChrome.tsx', import.meta.url).pathname,
  'utf8',
);
const CSS = readFileSync(new URL('./globals.css', import.meta.url).pathname, 'utf8');

/** Tailwind's spacing scale: one step is 0.25rem. */
const STEP_REM = 0.25;

/** The line box of `text-xl` in this Tailwind version, in rem. */
const TEXT_XL_LINE_BOX_REM = 1.75;

/** Every `rem` term inside a `calc()`, summed. `1px` terms are counted separately. */
function resolveTokenRem(name: string): { rem: number; px: number } {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  expect(match, `--${name} must be declared in globals.css`).not.toBeNull();
  const expression = match![1]!;
  const rem = [...expression.matchAll(/([\d.]+)rem/g)].reduce(
    (total, term) => total + Number(term[1]),
    0,
  );
  const px = [...expression.matchAll(/([\d.]+)px/g)].reduce(
    (total, term) => total + Number(term[1]),
    0,
  );
  return { rem, px };
}

describe('--chrome-height is the height of the chrome', () => {
  it('equals the header ProductChrome actually renders', () => {
    /*
     * The header's own inner row: the flex container that holds the wordmark
     * and the "New trip" link. Its vertical padding and its tallest child are
     * the whole of the height.
     */
    const paddingStep = /className="mx-auto flex max-w-[^\s"]+[^"]*\bpy-([\d.]+)\b/.exec(CHROME);
    expect(paddingStep, 'the header row must declare its vertical padding as py-*').not.toBeNull();
    const paddingRem = Number(paddingStep![1]) * STEP_REM * 2;

    /*
     * The tallest control in the row. `min-h-11` is the WCAG 2.5.5 target on
     * the "New trip" link; anything taller added later wins, which is precisely
     * the change that broke the token last time.
     */
    const controlSteps = [...CHROME.matchAll(/\bmin-h-(\d+)\b/g)].map((match) => Number(match[1]));
    expect(controlSteps.length, 'ProductChrome must size its controls with min-h-*').toBeGreaterThan(
      0,
    );
    const tallestControlRem = Math.max(...controlSteps) * STEP_REM;

    // The wordmark is `text-xl`, so its line box is the floor on the row height
    // even if every control were removed.
    const rowRem = Math.max(tallestControlRem, TEXT_XL_LINE_BOX_REM);

    // `border-b` on the header element itself.
    const borderPx = /<header className="[^"]*\bborder-b\b/.test(CHROME) ? 1 : 0;

    const token = resolveTokenRem('chrome-height');
    expect(
      token.rem,
      `--chrome-height declares ${token.rem}rem; ProductChrome renders ${paddingRem}rem of padding ` +
        `around a ${rowRem}rem row, which is ${paddingRem + rowRem}rem`,
    ).toBeCloseTo(paddingRem + rowRem, 5);
    expect(token.px, '--chrome-height must include the header’s bottom border').toBe(borderPx);
  });

  /**
   * And the reason the token has to be right: it is what a focused control is
   * scrolled clear of.
   */
  it('is what the scrolling root pads its top by', () => {
    expect(CSS).toMatch(/scroll-padding-top:\s*var\(--chrome-height\)/);
    expect(CSS, 'the bottom-pinned board bar needs its own clearance').toMatch(
      /scroll-padding-bottom:/,
    );
  });
});
