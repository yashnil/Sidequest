import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Itinerary, ItineraryDay } from '@sidequest/core';
import { planTrip } from '@sidequest/planner';
import { transitBlindScenario } from '../../../../packages/planner/src/testing/transit-blind-city';
import { ItineraryView } from './ItineraryView';
import { roundedDuration } from './plan-language';
import { formatMinutes } from '@/lib/format';

/*
 * The per-stop menu lives beside the server actions it calls, so importing it
 * would open a database. Nothing below presses anything; what is under test is
 * the document.
 */
vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({
  EaseDayButton: () => null,
  PrintExpand: () => null,
  StopEditMenu: () => null,
}));
vi.mock('./PrintButton', () => ({ PrintButton: () => null }));

/**
 * THE SCREEN THE REVIEWER ACTUALLY READ.
 *
 * Two reviewers found this independently and both quoted strings, not fields:
 * a chip reading WALK beside a row titled "Travel to X"; a day header reading
 * "2 hr travelling · 2 hr on foot"; a split line reading "2 hr walking there";
 * a sequence strip reading "walk → visit → walk back". Every one of those is a
 * journey the product had just said it could not price, described five separate
 * ways as time on the traveller's feet — against the twenty-five minutes they
 * answered.
 *
 * The previous pass fixed the row title and nothing else, and its tests passed,
 * because every one of them asserted on the model. This file is the coverage
 * that was missing: the real planner's output, through the real component, read
 * back as text. Nothing here hand-builds a day or a leg.
 */

const PLAN: Itinerary = (() => {
  const result = planTrip(transitBlindScenario('observed'));
  if (!result.ok) throw new Error(`the car-free scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

/** The page's own duration wording, so an expectation cannot round differently. */
function span(minutes: number): string {
  return formatMinutes(roundedDuration(minutes));
}

const HTML = renderToStaticMarkup(
  createElement(ItineraryView, {
    itinerary: PLAN,
    preparation: [],
    tripId: 'trip-unverified-journey',
    dateLabel: '12–15 Aug',
    renderedAt: Date.parse('2026-08-10T09:00:00.000Z'),
    coordinates: {},
  }),
);

/**
 * The document as a person reads it: markup gone, entities back, whitespace
 * collapsed. Asserting on raw markup would let a claim hide behind a tag
 * boundary, which is exactly how a rendered string escapes a test.
 */
const TEXT = HTML.replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#x2F;/g, '/')
  .replace(/\s+/g, ' ')
  .trim();

/** Every day sequence strip, by its accessible name. */
const SEQUENCES = [...HTML.matchAll(/aria-label="How this day moves: ([^"]*)"/g)].map(
  (match) => match[1]!,
);

function daysWithProxy(): ItineraryDay[] {
  return PLAN.days.filter((day) => day.totals.unverifiedMinutes > 0);
}

function walkingOnlyDays(): ItineraryDay[] {
  return PLAN.days.filter((day) => day.totals.walkMinutes > 0 && day.totals.unverifiedMinutes === 0);
}

describe('the finished document, on a trip whose scheduled journeys nobody could price', () => {
  it('is the shape both reviewers read, or it is asserting nothing', () => {
    /*
     * The fixture is only a witness while the plan actually contains both kinds
     * of leg. Without a proxy day there is no defect to catch; without a purely
     * walking day the control below is vacuous.
     */
    expect(daysWithProxy().length).toBeGreaterThan(0);
    expect(walkingOnlyDays().length).toBeGreaterThan(0);
    expect(SEQUENCES.length).toBeGreaterThan(0);
  });

  it('badges a proxy leg as an unverified journey rather than as a walk', () => {
    /*
     * The chip beside the title. It read WALK a centimetre to the right of
     * "Travel to X" — one row contradicting itself, which is how a reader
     * decides which half to believe.
     */
    expect(TEXT).toContain('Journey not verified');

    const proxies = PLAN.days
      .flatMap((day) => day.items)
      .filter((item) => item.travel?.unverifiedScheduled === true);
    expect(proxies.length).toBeGreaterThan(0);
    for (const item of proxies) {
      expect(TEXT).toContain(item.title);
      expect(item.title).not.toMatch(/^Walk /);
    }
  });

  it('puts no proxy minute into a figure the page calls time on foot', () => {
    for (const day of daysWithProxy()) {
      /*
       * The three the reviewer quoted, each against the pooled figure that
       * produced them: the day-header chip, the split line, and — because a
       * total is a total — the travelling figure itself never reappearing as a
       * walking one.
       */
      expect(TEXT).not.toContain(`${span(day.totals.travelMinutes)} on foot`);
      expect(TEXT).not.toContain(`${span(day.totals.travelMinutes)} walking there`);
      expect(TEXT).not.toContain(`${span(day.totals.unverifiedMinutes)} walking there`);
      expect(TEXT).not.toContain(`${span(day.totals.unverifiedMinutes)} on foot to`);
    }

    /* The trip-level pair, off the same day totals one surface further out. */
    const totals = PLAN.transportStrategy.totals;
    expect(totals.unverifiedMinutes).toBeGreaterThan(0);
    expect(TEXT).not.toContain(`${span(totals.walkMinutes + totals.unverifiedMinutes)} on foot`);
  });

  it('leaves no sentence anywhere on the page calling a proxy journey time on foot', () => {
    /*
     * The catch-all, and the one that would have failed on the shipped page in
     * five places at once. The measured walk is allowed to be named — it is the
     * bound, and dropping it would leave a duration with no account of itself —
     * but only inside the sentence that says what it is a bound on. Any other
     * "on foot" on this page is a claim about the traveller's feet.
     */
    const totals = PLAN.transportStrategy.totals;
    /* Every figure that is, or silently includes, a minute nobody could price. */
    const forbidden = new Set<string>([
      span(totals.unverifiedMinutes),
      span(totals.walkMinutes + totals.unverifiedMinutes),
    ]);
    for (const day of daysWithProxy()) {
      forbidden.add(span(day.totals.unverifiedMinutes));
      forbidden.add(span(day.totals.travelMinutes));
      for (const item of day.items) {
        if (item.travel?.unverifiedScheduled !== true || item.travel.minutes === null) continue;
        forbidden.add(span(item.travel.minutes));
      }
    }

    /*
     * The duration attached to the phrase, not merely near it: a page this long
     * has an activity length within a hundred characters of everything, and a
     * proximity match would fail on those instead of on the claim.
     */
    const claims = [...TEXT.matchAll(/(\d+ hr \d+ min|\d+ hr|\d+ min) on foot/g)];
    expect(claims.length).toBeGreaterThan(0);
    let caveated = 0;
    for (const claim of claims) {
      const context = TEXT.slice(Math.max(0, claim.index - 160), claim.index);
      if (/could not verify the transit route/i.test(context)) {
        caveated += 1;
        continue;
      }
      expect(
        forbidden.has(claim[1]!),
        `"${claim[0]}" bills ${claim[1]} of unpriceable journey time to the traveller's feet`,
      ).toBe(false);
    }
    /* The bound is still stated somewhere, or this test is passing on silence. */
    expect(caveated).toBeGreaterThan(0);

    /* And the panel's own walking figure counts only what was walked. */
    expect(TEXT).toContain(`On foot to reach things ${span(totals.walkMinutes)}`);
  });

  it('keeps the measured walk on the row as the stated upper bound', () => {
    const proxies = PLAN.days
      .flatMap((day) => day.items)
      .filter((item) => item.travel?.unverifiedScheduled === true);

    for (const item of proxies) {
      /* The one real number, still printed. */
      expect(TEXT).toContain(item.reason);
      expect(item.reason).toMatch(/could not verify the transit route/i);
      expect(item.reason).toMatch(/longest/);
    }
    /* And the row says which question that number answers. */
    expect(TEXT).toContain('route not verified');
    expect(TEXT).toContain('upper bound');
  });

  it('names the held time in the day breakdown and in the transport panel', () => {
    /*
     * Removing the minutes from the walking totals is only half of it: they are
     * time the traveller loses, so a surface that used to account for them has
     * to go on accounting for them, under a heading that is true.
     */
    for (const day of daysWithProxy()) {
      expect(TEXT).toContain(
        `${span(day.totals.unverifiedMinutes)} held for journeys we could not verify`,
      );
      /* The day still promotes the whole time it spends travelling. */
      expect(TEXT).toContain(`${span(day.totals.travelMinutes)} travelling`);
    }
    expect(TEXT).toContain('Held for unverified journeys');
    expect(TEXT).toContain(span(PLAN.transportStrategy.totals.unverifiedMinutes));
  });

  it('draws a proxy leg into the day sequence without a mode', () => {
    /*
     * "walk → visit → walk back" is the line a traveller reads as the thing to
     * execute, so it was an instruction to set off on foot for a journey the row
     * beneath it said nobody could price.
     */
    for (const day of daysWithProxy()) {
      const index = PLAN.days.indexOf(day);
      const sequence = SEQUENCES[index];
      if (sequence === undefined) continue;
      expect(sequence, `day ${day.dayNumber} sequence`).toContain('travel');
      if (day.totals.walkMinutes === 0) {
        expect(sequence, `day ${day.dayNumber} sequence`).not.toContain('walk');
      }
    }
  });

  it('renders a genuine walk as a walk, in every one of the same places', () => {
    /*
     * The control. Inside the traveller's own answer the walk is the journey,
     * and none of the above may touch it: same chip, same title, same walking
     * total, same step in the strip.
     */
    for (const day of walkingOnlyDays()) {
      const index = PLAN.days.indexOf(day);
      expect(TEXT).toContain(`${span(day.totals.walkMinutes)} walking there`);
      expect(SEQUENCES[index], `day ${day.dayNumber} sequence`).toContain('walk');
      for (const item of day.items) {
        if (item.travel?.mode !== 'walk') continue;
        expect(TEXT).toContain(item.title);
        expect(item.title).toMatch(/^Walk /);
      }
    }
    /* The chip vocabulary is still the mode's, on the legs that have one. */
    expect(TEXT).toContain('Walk');
    expect(TEXT).toContain('On foot to reach things');
  });
});
