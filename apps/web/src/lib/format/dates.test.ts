import { describe, expect, it } from 'vitest';
import { formatDay, formatDayRange, formatMonthName } from './dates';

/**
 * THE TEST THAT KEEPS A CALENDAR DATE OFF THE TIMELINE.
 *
 * The two defects this module exists to stop are both invisible in the
 * developer's own timezone, which is why they survived: `new Date('2026-10-12')`
 * renders as the 11th anywhere west of Greenwich, and an unreadable string
 * renders as `Invalid Date`. Neither is reproducible by reading the code in
 * London, so both are asserted here instead.
 */
describe('a stored date becomes a date a person reads', () => {
  it('never shifts the day, whatever the reader clock is set to', () => {
    // Asserted as a literal rather than against a Date: the point is that no
    // instant is ever constructed, so there is nothing for a zone to move.
    expect(formatDay('2026-10-12')).toBe('Oct 12, 2026');
    expect(formatDay('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDay('2026-12-31')).toBe('Dec 31, 2026');
  });

  it('states the year once inside a month and repeats the month across one', () => {
    expect(formatDayRange('2026-10-12', '2026-10-18')).toBe('Oct 12–18, 2026');
    expect(formatDayRange('2026-10-30', '2026-11-03')).toBe('Oct 30 – Nov 3, 2026');
  });

  it('states both years when a trip crosses one', () => {
    expect(formatDayRange('2026-12-30', '2027-01-03')).toBe('Dec 30, 2026 – Jan 3, 2027');
  });

  it('collapses a single-day range rather than repeating the date', () => {
    expect(formatDayRange('2026-10-12', '2026-10-12')).toBe('Oct 12, 2026');
  });

  it('hands back what it was given rather than rendering Invalid Date', () => {
    // A row written by an older build, or hand-edited. The raw value is at
    // least true; `NaN` and `Invalid Date` are not.
    expect(formatDay('not a date')).toBe('not a date');
    expect(formatDay('2026-13-01')).toBe('2026-13-01');
    expect(formatDayRange('', '')).not.toMatch(/Invalid|NaN/);
  });

  it('names a month somebody chose rather than numbering it', () => {
    expect(formatMonthName(10)).toBe('October');
  });
});
