import { describe, expect, it } from 'vitest';
import { itineraryItemSchema, formatTimelineMinute, MINUTES_PER_DAY, TIMELINE_MINUTE_LIMIT } from '@sidequest/core';
import { timelineClock } from '@/components/hub/plan-format';
import { compactWarnings } from '@/components/ItineraryView';

/**
 * V11 §1 — A MEASURED DURATION SURVIVES A DAY THAT OVERRUNS.
 *
 * The defect, exactly: an item's three time fields were
 *
 *     startMinute:     clamp(clock)
 *     endMinute:       clamp(clock + duration)
 *     durationMinutes: clamp(clock + duration) - clamp(clock)
 *
 * and `clamp` bounded at 24:00. Once the running clock passed midnight both
 * ends landed on 1440 and the subtraction produced **zero**, so a real journey
 * reached a founder's plan as "0 min Walk to Karakol · base to base measured"
 * and the quality audit reported `no_zero_minute_travel` against a schedule
 * nobody could read.
 *
 * The fix is the representation, not a floor: position and duration are
 * separate facts, an item's minutes are *timeline* minutes that may run into
 * the next day, and the end follows from the duration rather than the duration
 * from two bounded ends.
 *
 * These tests drive the schema and the formatter, which is where the invariant
 * actually lives — `durationMinutes === endMinute - startMinute` is a schema
 * refinement, so an item that violates it cannot be constructed at all.
 */

function item(startMinute: number, durationMinutes: number, kind: 'travel' | 'activity' = 'travel') {
  return itineraryItemSchema.parse({
    id: 'x',
    kind,
    title: 'A leg',
    startMinute,
    endMinute: startMinute + durationMinutes,
    durationMinutes,
    reason: 'why',
    weatherSensitive: false,
    ...(kind === 'travel'
      ? { travel: { fromId: 'a', toId: 'b', fromName: 'A', toName: 'B', mode: 'walk', provenance: 'measured', minutes: durationMinutes, km: null, role: 'transfer' } }
      : {}),
  });
}

describe('V11 §1 — the seven shapes a day can put a leg in', () => {
  it('a normal in-day leg keeps its duration', () => {
    expect(item(9 * 60, 45).durationMinutes).toBe(45);
  });

  it('a leg that CROSSES midnight keeps its whole duration', () => {
    /* Starts 23:30, runs 90 minutes. Both ends used to clamp to 24:00 → 0. */
    const leg = item(23 * 60 + 30, 90);
    expect(leg.durationMinutes).toBe(90);
    expect(leg.startMinute).toBe(1410);
    expect(leg.endMinute).toBe(1500);
  });

  it('a leg that BEGINS after the nominal day end keeps its duration', () => {
    const leg = item(MINUTES_PER_DAY + 30, 55);
    expect(leg.durationMinutes).toBe(55);
    expect(leg.startMinute).toBeGreaterThan(MINUTES_PER_DAY);
  });

  it('a multi-hour overrun keeps its duration', () => {
    const leg = item(22 * 60, 6 * 60);
    expect(leg.durationMinutes).toBe(360);
    expect(leg.endMinute - leg.startMinute).toBe(360);
  });

  it('a truly zero-duration same-place transition stays expressible and stays zero', () => {
    /* This is the one legitimate zero, and it must remain distinguishable from the destroyed one. */
    const leg = item(10 * 60, 0);
    expect(leg.durationMinutes).toBe(0);
    expect(leg.startMinute).toBe(leg.endMinute);
  });

  it('an operator-timed leg keeps its duration past midnight', () => {
    const leg = itineraryItemSchema.parse({
      id: 'x',
      kind: 'travel',
      title: 'Night crossing',
      startMinute: 23 * 60,
      endMinute: 23 * 60 + 420,
      durationMinutes: 420,
      reason: 'why',
      weatherSensitive: false,
      travel: { fromId: 'a', toId: 'b', fromName: 'A', toName: 'B', mode: 'ferry', provenance: 'official', minutes: 420, km: null, role: 'transfer' },
    });
    expect(leg.durationMinutes).toBe(420);
  });

  it('an unknown leg carries its allowance as a real duration, not a zero', () => {
    const leg = itineraryItemSchema.parse({
      id: 'x',
      kind: 'travel',
      title: 'Travel to somewhere',
      startMinute: MINUTES_PER_DAY - 10,
      endMinute: MINUTES_PER_DAY - 10 + 120,
      durationMinutes: 120,
      reason: 'why',
      weatherSensitive: false,
      travel: { fromId: 'a', toId: 'b', fromName: 'A', toName: 'B', mode: 'drive', provenance: 'unmeasured', minutes: null, km: null, role: 'transfer', unmeasuredReason: 'provider_unavailable' },
      timing: { precision: 'band', allowanceMinutes: 120 },
    });
    expect(leg.durationMinutes).toBe(120);
  });

  it('refuses a position beyond the representable timeline rather than silently folding it', () => {
    expect(() => item(TIMELINE_MINUTE_LIMIT + 1, 10)).toThrow();
  });

  it('still refuses an item whose duration disagrees with its ends', () => {
    expect(() =>
      itineraryItemSchema.parse({ id: 'x', kind: 'travel', title: 'A leg', startMinute: 600, endMinute: 700, durationMinutes: 0, reason: 'why', weatherSensitive: false }),
    ).toThrow();
  });
});

describe('V11 §1 — a time past midnight reads as past midnight', () => {
  it('wraps the clock and says that it wrapped', () => {
    expect(formatTimelineMinute(9 * 60)).toEqual({ text: '09:00', nextDay: false });
    expect(formatTimelineMinute(25 * 60)).toEqual({ text: '01:00', nextDay: true });
    expect(formatTimelineMinute(MINUTES_PER_DAY)).toEqual({ text: '00:00', nextDay: true });
  });

  it('marks an overrun time in the traveller-facing clock', () => {
    expect(timelineClock(9 * 60 + 7, 'later')).not.toMatch(/\+1/);
    expect(timelineClock(25 * 60 + 7, 'later')).toMatch(/\+1$/);
  });

  it('does not mark an ordinary evening time', () => {
    expect(timelineClock(23 * 60 + 30, 'later')).toBe('23:30');
  });
});

/**
 * V11 §21 — ONE SENTENCE FOR A DAY, INSTEAD OF A BADGE PER KIND.
 *
 * The founder's day views carried two chips saying the same thing two ways —
 * "3 still being checked" and "2 legs not yet timed" — on top of per-row
 * epistemic badges. Both chips are about one fact: Sidequest has not finished.
 */
describe('V11 §21 — a day says its uncertainty once', () => {
  it('folds the two counts into a single sentence', () => {
    const { badges } = compactWarnings([
      '3 stops on this day have not been fully verified',
      '2 travel legs on this day are unmeasured',
    ]);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.label).toBe('2 journey times still being worked out and 3 places still being located');
  });

  it('carries no chip at all on a day with nothing outstanding', () => {
    expect(compactWarnings([]).badges).toEqual([]);
    expect(compactWarnings(['You move from one base to another today.']).badges).toEqual([]);
  });

  it('keeps an unrelated warning as its own sentence', () => {
    const { badges, sentences } = compactWarnings(['1 travel leg on this day is unmeasured', 'This day runs past your usual end.']);
    expect(badges).toHaveLength(1);
    expect(sentences).toHaveLength(1);
  });

  it('keeps the precise wording available behind the sentence', () => {
    const { badges } = compactWarnings(['3 stops on this day have not been fully verified']);
    expect(badges[0]!.title).toMatch(/3 stops/);
  });
});
