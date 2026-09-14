import { describe, expect, it } from 'vitest';
import { calendarConflicts, nextWorkingDate, validateOn, weekdayClaimFromName, type CalendarFact } from './trip-calendar';

const fact = (overrides: Partial<CalendarFact> & Pick<CalendarFact, 'subject'>): CalendarFact => ({
  id: overrides.id ?? `f-${overrides.subject}`,
  kind: overrides.kind ?? 'weekly_opening',
  subject: overrides.subject,
  available: overrides.available ?? true,
  authority: overrides.authority ?? 'official_current',
  freshness: overrides.freshness ?? 'stable_reference',
  sourceName: overrides.sourceName ?? 'The operator',
  checkedAt: overrides.checkedAt ?? '2026-09-01',
  note: overrides.note ?? 'A note a traveller could read.',
  ...(overrides.daysOfWeek ? { daysOfWeek: overrides.daysOfWeek } : {}),
  ...(overrides.validFrom ? { validFrom: overrides.validFrom } : {}),
  ...(overrides.validUntil ? { validUntil: overrides.validUntil } : {}),
});

/* 2026-08-08 is a Saturday; 2026-08-09 is a Sunday. */
const SATURDAY = '2026-08-08';
const SUNDAY = '2026-08-09';

describe('V12 §24 — the Kyrgyzstan case: a market that only runs on one day', () => {
  const market = fact({ subject: 'Karakol bazaar', kind: 'market_day', daysOfWeek: [0], available: true, note: 'The animal market runs on Sunday mornings only.' });

  it('accepts the day the live build actually chose', () => {
    expect(validateOn({ facts: [market], subject: 'Karakol bazaar', date: SUNDAY }).status).toBe('available');
  });

  it('refuses the Saturday the same plan could just as easily have chosen', () => {
    const verdict = validateOn({ facts: [market], subject: 'Karakol bazaar', date: SATURDAY });
    expect(verdict.status).toBe('unavailable');
    expect(verdict.status === 'unavailable' && verdict.note).toMatch(/Sunday mornings only/);
  });

  it('offers the day it would work instead, rather than only saying no', () => {
    expect(nextWorkingDate({ facts: [market], subject: 'Karakol bazaar', dates: [SATURDAY, SUNDAY] })).toBe(SUNDAY);
  });
});

describe('V12 §24 — a name is a reason to check, never a reason to move a day', () => {
  it('reads a weekday out of a name, and marks it as an inference', () => {
    const claim = weekdayClaimFromName({ subject: 'Karakol Sunday-style bazaar', checkedAt: '2026-09-01' })!;
    expect(claim.daysOfWeek).toEqual([0]);
    expect(claim.authority).toBe('inferred_from_name');
    expect(claim.note).toMatch(/Nobody has confirmed that/);
  });

  it('can only raise a question with it, never establish a closure', () => {
    const claim = weekdayClaimFromName({ subject: 'Sunday market', checkedAt: '2026-09-01' })!;
    const verdict = validateOn({ facts: [claim], subject: 'Sunday market', date: SATURDAY });
    expect(verdict.status).toBe('questionable');
    /* Which is the §24 rule: the plan is not rearranged on the strength of a name. */
    expect(verdict.status === 'questionable' && verdict.note).toMatch(/check before you rely on it/);
  });

  it('finds nothing in a name that says nothing', () => {
    expect(weekdayClaimFromName({ subject: 'Ala-Kul pass', checkedAt: '2026-09-01' })).toBeNull();
  });
});

describe('V12 §23 — effective dates, and who is allowed to establish a fact', () => {
  it('ignores a fact outside its own effective window', () => {
    const winterClosure = fact({ subject: 'Mountain pass', available: false, validFrom: '2026-11-01', validUntil: '2027-04-30', note: 'The pass is closed through the winter.' });
    expect(validateOn({ facts: [winterClosure], subject: 'Mountain pass', date: SUNDAY }).status).toBe('unknown');
    expect(validateOn({ facts: [winterClosure], subject: 'Mountain pass', date: '2026-12-20' }).status).toBe('unavailable');
  });

  it('will not let a recollection close a day, but will let an official source', () => {
    const remembered = fact({ subject: 'Museum', daysOfWeek: [1], available: false, authority: 'model_knowledge', note: 'Usually shut on Mondays.' });
    const official = fact({ subject: 'Museum', daysOfWeek: [1], available: false, authority: 'official_current', note: 'Closed every Monday.' });
    expect(validateOn({ facts: [remembered], subject: 'Museum', date: '2026-08-10' }).status).toBe('questionable');
    expect(validateOn({ facts: [official], subject: 'Museum', date: '2026-08-10' }).status).toBe('unavailable');
  });

  it('hears the confirming source first when both are present', () => {
    const remembered = fact({ id: 'a', subject: 'Museum', daysOfWeek: [1], available: false, authority: 'reference', note: 'Thought to be shut on Mondays.' });
    const official = fact({ id: 'b', subject: 'Museum', daysOfWeek: [1], available: true, authority: 'official_current', note: 'Open every day in August.' });
    expect(validateOn({ facts: [remembered, official], subject: 'Museum', date: '2026-08-10' }).status).toBe('available');
  });

  it('says nothing about a subject nobody recorded, which is not a pass', () => {
    expect(validateOn({ facts: [], subject: 'Anything', date: SUNDAY }).status).toBe('unknown');
  });
});

describe('V12 §26 — conflicts are reported, never silently repaired', () => {
  it('lists every item its own calendar disagrees with, and where it would fit', () => {
    const facts = [
      fact({ subject: 'Karakol bazaar', kind: 'market_day', daysOfWeek: [0], note: 'Sundays only.' }),
      fact({ subject: 'Ferry to the island', kind: 'ferry_season', available: false, validFrom: '2026-10-01', validUntil: '2027-03-31', note: 'The ferry does not run out of season.' }),
    ];
    const conflicts = calendarConflicts({
      facts,
      items: [
        { subject: 'Karakol bazaar', date: SATURDAY, dayNumber: 4 },
        { subject: 'Ferry to the island', date: '2026-11-02', dayNumber: 9 },
        { subject: 'Ala-Kul pass', date: SATURDAY, dayNumber: 6 },
      ],
      tripDates: [SATURDAY, SUNDAY],
    });
    expect(conflicts.map((entry) => entry.subject)).toEqual(['Karakol bazaar', 'Ferry to the island']);
    expect(conflicts[0]?.moveTo).toBe(SUNDAY);
    /* Nothing in the window works for the ferry, which is a different answer from "we do not know". */
    expect(conflicts[1]?.moveTo).toBeNull();
  });
});
