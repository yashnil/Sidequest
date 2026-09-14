import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, defaultAnswers, type CalendarFact, type Trip } from '@sidequest/core';
import { compileQuality } from './quality-compiler';
import { reconcileTripDraft } from './reconcile';
import { boardWorld, draftOf } from './acceptance/harness';
import { tripDraftSchema } from './trip-draft';

/**
 * V12 §26 — the date-specific calendar check, inside the compiler that runs on
 * every build.
 *
 * The V11 live Kyrgyzstan trip is the case this exists for: a "Sunday-style
 * bazaar" landed on a Sunday and **nothing verified it**. The model happened to
 * be right, which is not the same as the plan being checked. These tests prove
 * the check now exists, that it reports rather than repairs, and that it stays
 * *skipped* — never silently passed — where no calendar was loaded.
 */

const NOW = new Date('2026-09-12T12:00:00Z');

/* 2026-08-12 is a Wednesday; the trip runs Wed–Sat, so a Sunday market cannot fit. */
async function plan() {
  const context = boardWorld({ basics: { startDate: '2026-08-12', endDate: '2026-08-15' } });
  const draft = tripDraftSchema.parse(
    draftOf({
      bases: [{ id: 'town', name: 'Mammoth Lakes', nights: 3 }],
      days: [
        { base: 'town', anchors: [{ name: 'Sunday animal market', category: 'market', minutes: 90 }] },
        { base: 'town', anchors: [{ name: 'Convict Lake', category: 'water', minutes: 90 }] },
        { base: 'town', anchors: [] },
        { base: 'town', anchors: [] },
      ],
    }),
  );
  const result = await reconcileTripDraft({ draft, context });
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: 4 });
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 4 });
  const trip: Trip = { id: 'calendar', basics: context.basics, status: 'planned', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  return { itinerary: result.itinerary, draft, trip, profile, dayOrders: result.dayOrders };
}

const sundayOnly: CalendarFact = {
  id: 'market',
  kind: 'market_day',
  subject: 'Sunday animal market',
  daysOfWeek: [0],
  available: true,
  authority: 'official_current',
  freshness: 'stable_reference',
  sourceName: 'The market authority',
  checkedAt: '2026-09-01',
  note: 'The animal market runs on Sunday mornings only.',
};

describe('V12 §26 — a stop on a day its own calendar refuses', () => {
  it('is skipped, not passed, when no calendar was loaded', async () => {
    const input = await plan();
    const { report } = compileQuality(input);
    expect(report.skipped.map((entry) => entry.check)).toContain('date_specific_calendar');
    expect(report.issues.map((issue) => issue.check)).not.toContain('date_specific_calendar');
  });

  it('names the stop, the day, and that no day of this trip works', async () => {
    const input = await plan();
    const { report } = compileQuality({ ...input, calendarFacts: [sundayOnly] });
    expect(report.skipped.map((entry) => entry.check)).not.toContain('date_specific_calendar');
    const found = report.issues.filter((issue) => issue.check === 'date_specific_calendar');
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/Sunday animal market is planned for day 1/);
    expect(found[0]!.detail).toMatch(/no day of this trip does/);
    expect(found[0]!.travellerNote).toMatch(/Sunday mornings only/);
    /* Reported, never repaired: the plan still holds the stop. */
    expect(input.itinerary.days[0]!.items.some((item) => item.title === 'Sunday animal market')).toBe(true);
  });

  it('says nothing when the stop is on a day its calendar allows', async () => {
    const input = await plan();
    const alwaysOpen: CalendarFact = { ...sundayOnly, id: 'open', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], note: 'Open every day.' };
    const { report } = compileQuality({ ...input, calendarFacts: [alwaysOpen] });
    expect(report.issues.filter((issue) => issue.check === 'date_specific_calendar')).toHaveLength(0);
  });

  it('raises a question rather than an issue when only a name said so', async () => {
    const input = await plan();
    const fromName: CalendarFact = { ...sundayOnly, id: 'name', authority: 'inferred_from_name', note: 'Its name says Sunday. Nobody has confirmed that.' };
    const { report } = compileQuality({ ...input, calendarFacts: [fromName] });
    const issues = report.issues.filter((issue) => issue.check === 'date_specific_calendar');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('caution');
  });
});
