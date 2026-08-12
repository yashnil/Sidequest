import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
   * THE BADGE TONES, ON THE SOFT SURFACES THEY ARE SET ON.
   *
   * Phase 15D's reviewer measured the pairs a person cannot: every badge in the
   * product renders its tone colour at 11px on the matching soft surface, and
   * amber — the tone that carries the entire warning channel, "Booking needed",
   * "Shut some of your days", "Recheck hours" — measured 4.20:1, the only
   * failing tone. The ink-on-paper loop above never touched these pairs, so the
   * failure was invisible to every test in the repository.
   */
  const TONES = [
    ['pine', 'pine-soft'],
    ['amber', 'amber-soft'],
    ['slate-blue', 'slate-blue-soft'],
    ['clay', 'clay-soft'],
  ] as const;
  for (const [theme, block] of Object.entries(themeBlocks())) {
    for (const [tone, soft] of TONES) {
      it(`${theme}: --color-${tone} on --color-${soft}`, () => {
        const measured = ratio(tokenIn(block, tone), tokenIn(block, soft));
        expect(
          measured,
          `--color-${tone} on --color-${soft} in ${theme} measures ${measured.toFixed(2)}:1; ` +
            `badges render this pair at 11px, so ${BODY_TEXT_MINIMUM}:1 applies`,
        ).toBeGreaterThanOrEqual(BODY_TEXT_MINIMUM);
      });
    }
  }

  /**
   * THE EVIDENCE STATES, WHICH THE BADGE LOOP ABOVE DID NOT COVER.
   *
   * `EvidenceBadge` is a second badge family with its own four tone pairs —
   * `bg-provisional-soft text-provisional` and the rest — rendered at the same
   * 11px as `Badge`, on the Discovery Board, on the progress screen and on every
   * card that carries a claim about how much we know. It is the channel that
   * carries "Provisional", "Checking", "Sources disagree": the words that decide
   * whether a traveller trusts a line, and the ones a low-contrast pair makes
   * hardest to read.
   *
   * The `TONES` loop above never touched them, so the whole family was
   * unmeasured. `provisional` on `provisional-soft` measures 4.54:1 in the light
   * theme — clearing the floor by four hundredths, which is exactly the margin
   * that a well-meant palette tweak erases without anybody noticing.
   */
  const EVIDENCE_TONES = [
    ['provisional', 'provisional-soft'],
    ['verifying', 'verifying-soft'],
    ['verified', 'verified-soft'],
    ['conflicted', 'conflicted-soft'],
  ] as const;
  for (const [theme, block] of Object.entries(themeBlocks())) {
    for (const [tone, soft] of EVIDENCE_TONES) {
      it(`${theme}: --color-${tone} on --color-${soft}`, () => {
        const measured = ratio(tokenIn(block, tone), tokenIn(block, soft));
        expect(
          measured,
          `--color-${tone} on --color-${soft} in ${theme} measures ${measured.toFixed(2)}:1; ` +
            `evidence badges render this pair at 11px, so ${BODY_TEXT_MINIMUM}:1 applies`,
        ).toBeGreaterThanOrEqual(BODY_TEXT_MINIMUM);
      });
    }
  }

  /**
   * THE ACCENTS ON PAPER, WHICH ARE NOT BADGES AT ALL.
   *
   * `text-pine` on a paper surface is the product's link and inline-action
   * colour — "Move my trip to August", "Make it 8 nights", the homepage's own
   * "pick up one of your trips" — and `text-amber` on paper is how a caution
   * reads when it is a line of prose rather than a badge. Neither pair has a
   * soft ground behind it, so neither was covered by the loops above, and both
   * are set at 12–14px.
   *
   * `pine-strong` is included because `Choice` uses it for a selected option's
   * label, which is a piece of state a traveller has to be able to read at a
   * glance to know what they picked.
   */
  const ACCENTS = ['pine', 'pine-strong', 'amber', 'slate-blue', 'clay'] as const;
  for (const [theme, block] of Object.entries(themeBlocks())) {
    for (const accent of ACCENTS) {
      for (const surface of SURFACES) {
        it(`${theme}: --color-${accent} on --color-${surface}`, () => {
          const measured = ratio(tokenIn(block, accent), tokenIn(block, surface));
          expect(
            measured,
            `--color-${accent} on --color-${surface} in ${theme} measures ${measured.toFixed(2)}:1; ` +
              `accents are set as prose and inline actions at 12–14px, so ${BODY_TEXT_MINIMUM}:1 applies`,
          ).toBeGreaterThanOrEqual(BODY_TEXT_MINIMUM);
        });
      }
    }
  }

  /**
   * INK ON THE SOFT GROUNDS — THE ONE CROSS PRODUCT THE FOUR LOOPS ABOVE MISS.
   *
   * Each of those loops was written in response to a specific failure, so what
   * they cover is a union of four incidents rather than a product of two axes.
   * The gap a reviewer found by computing it: **no loop pairs an ink token with
   * a soft ground**, and the product paints that pair constantly —
   * `text-ink-muted` inside `bg-amber-soft` and `bg-clay-soft` is how every
   * caution box in the itinerary and on the board is set.
   *
   * `ink` and `ink-muted` clear the floor comfortably on all eight (worst
   * measured: 6.17:1, muted on clay-soft in light). `ink-faint` does **not** —
   * see the assertion below it, which is the other half of this fix.
   */
  const SOFT_GROUNDS = [
    'pine-soft',
    'amber-soft',
    'slate-blue-soft',
    'clay-soft',
    'provisional-soft',
    'verifying-soft',
    'verified-soft',
    'conflicted-soft',
  ] as const;
  for (const [theme, block] of Object.entries(themeBlocks())) {
    for (const ink of ['ink', 'ink-muted'] as const) {
      for (const ground of SOFT_GROUNDS) {
        it(`${theme}: --color-${ink} on --color-${ground}`, () => {
          const measured = ratio(tokenIn(block, ink), tokenIn(block, ground));
          expect(
            measured,
            `--color-${ink} on --color-${ground} in ${theme} measures ${measured.toFixed(2)}:1; ` +
              `soft grounds carry prose at 12–14px, so ${BODY_TEXT_MINIMUM}:1 applies`,
          ).toBeGreaterThanOrEqual(BODY_TEXT_MINIMUM);
        });
      }
    }
  }

  /**
   * AND THE PAIR THAT WOULD FAIL, FORBIDDEN RATHER THAN REPAIRED.
   *
   * `--color-ink-faint` on a soft ground measures **3.93:1** at worst (dark, on
   * pine-soft and verified-soft) and 4.45:1 at best-of-the-failures (light, on
   * clay-soft) — every combination is under the floor, in both themes. Nothing
   * in the product currently sets it, which is the only reason a rendered sweep
   * of six routes came back clean.
   *
   * Two ways to close that. Lightening `--color-ink-faint` until it clears a
   * soft ground would move the token that is *already correct* on the three
   * paper surfaces it is actually used on, to satisfy a combination nothing
   * ships — and it would compress the three-step ink hierarchy the test below
   * exists to protect. So the pair is forbidden instead, and the ban is a scan
   * rather than a comment: a comment is what the four loops above already had.
   *
   * Deliberately a source scan and not a rendered sweep. A rendered sweep can
   * only see the markup a fixture happens to produce, and this failure is
   * latent by definition — it is one `className` away, on a page nobody has
   * built yet.
   */
  it('never sets faint ink on a soft ground', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(new URL('..', import.meta.url).pathname)) {
      const text = readFileSync(file, 'utf8');
      /*
       * Class lists as they are written here: a quoted string, or a template
       * literal, holding both tokens. `cx()` composition across arguments is
       * not caught, and that is an accepted false-negative — the guard is worth
       * having for the common form and a stricter one would fail on strings
       * that never meet at runtime.
       */
      for (const match of text.matchAll(/['"`]([^'"`\n]*text-ink-faint[^'"`\n]*)['"`]/g)) {
        if (/bg-[a-z-]+-soft/.test(match[1]!)) {
          offenders.push(`${file.split('/apps/web/')[1]}: ${match[1]!.trim().slice(0, 120)}`);
        }
      }
    }
    expect(
      offenders,
      'faint ink on a soft ground measures 3.93–4.45:1 in the two themes — under the 4.5 floor. ' +
        'Use --color-ink-muted on soft grounds (6.17:1 at worst), or raise --color-ink-faint here first',
    ).toEqual([]);
  });

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

/**
 * Every `.ts`/`.tsx` under `apps/web/src`, so the scan above cannot miss a file
 * by living in a directory nobody thought to list.
 */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      found.push(path);
    }
  }
  return found;
}
