import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE ONE GUARD A PIXEL TEST CANNOT BE.
 *
 * `visual.spec.ts` screenshots every surface, and what it *asserts* is console
 * errors and horizontal overflow — the images are captured for a person to look
 * at. A colour that fails a contrast ratio produces a perfectly clean screenshot
 * and a perfectly clean assertion, so a regression in this token is invisible to
 * every test in the repository and to most reviewers: the difference between
 * 3.5:1 and 4.5:1 is not something you see, it is something you measure.
 *
 * So this measures it. The tokens are parsed out of the stylesheet — not
 * duplicated here, because a copy would go on passing after the stylesheet
 * moved — and every text token is checked against every surface it is used on,
 * in both themes.
 *
 * WCAG 2.2 SC 1.4.3 (Contrast (Minimum)): 4.5:1 for body text, 3:1 for large
 * text, where "large" means 24px regular or 18.66px bold. Nothing in this
 * product uses `--color-ink-faint` above 12px, so the body-text floor applies
 * to all of it, and the worst pairing — the provisional board's 11px summary on
 * `bg-paper-sunk` — is the reason this file exists.
 */

const STYLESHEET = new URL('./globals.css', import.meta.url).pathname;
const CSS = readFileSync(STYLESHEET, 'utf8');

/** WCAG's body-text floor. Not a preference. */
const BODY_TEXT_MINIMUM = 4.5;

/**
 * The three paper surfaces text is set on, and the three inks set on them.
 *
 * Every combination, rather than the ones we currently ship: a token that passes
 * on two surfaces and fails on the third is one refactor away from being wrong,
 * and the refactor will not mention colour.
 */
const SURFACES = ['paper', 'paper-raised', 'paper-sunk'] as const;
const INKS = ['ink', 'ink-muted', 'ink-faint'] as const;

/**
 * The light-theme block is everything before the dark-mode media query; the dark
 * block is inside it. Parsed rather than assumed so that moving a token between
 * the two is caught here instead of shipping.
 */
function themeBlocks(): { light: string; dark: string } {
  const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark)');
  expect(darkStart, 'globals.css must declare a dark theme').toBeGreaterThan(-1);
  return { light: CSS.slice(0, darkStart), dark: CSS.slice(darkStart) };
}

function tokenIn(block: string, name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
  expect(match, `--color-${name} must be declared as a six-digit hex`).not.toBeNull();
  return match![1]!;
}

/** sRGB relative luminance, WCAG 2.x definition. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe('text tokens clear the WCAG body-text floor', () => {
  it('computes a known ratio correctly', () => {
    // Black on white is exactly 21:1, which is the sanity check on the maths
    // above — a ratio function that is subtly wrong would pass every assertion
    // below by being uniformly generous.
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  for (const [theme, block] of Object.entries(themeBlocks())) {
    for (const ink of INKS) {
      for (const surface of SURFACES) {
        it(`${theme}: --color-${ink} on --color-${surface}`, () => {
          const measured = ratio(tokenIn(block, ink), tokenIn(block, surface));
          expect(
            measured,
            `--color-${ink} on --color-${surface} in ${theme} measures ${measured.toFixed(2)}:1; ` +
              `every use of these tokens is 11px or 12px, so ${BODY_TEXT_MINIMUM}:1 applies`,
          ).toBeGreaterThanOrEqual(BODY_TEXT_MINIMUM);
        });
      }
    }
  }

  /**
   * The token has a job as well as a floor.
   *
   * "Faint" that is no fainter than "muted" is not a fix, it is a flattening —
   * the three inks carry a hierarchy, and the cheapest way to pass a contrast
   * check is to destroy it. This asserts the ordering survives the repair.
   */
  it('keeps the ink hierarchy intact', () => {
    for (const [theme, block] of Object.entries(themeBlocks())) {
      const paper = tokenIn(block, 'paper');
      const [ink, muted, faint] = INKS.map((name) => ratio(tokenIn(block, name), paper)) as [
        number,
        number,
        number,
      ];
      expect(ink, `${theme}: --color-ink must be the strongest`).toBeGreaterThan(muted);
      expect(muted, `${theme}: --color-ink-muted must sit above --color-ink-faint`).toBeGreaterThan(
        faint,
      );
    }
  });
});
