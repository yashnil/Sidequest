import { describe, expect, it } from 'vitest';
import { assessOperational, operationalWindowsOn, type OperationalEvidence } from './operational-evidence';

const NOW = new Date('2026-08-01T09:00:00Z');
const daysUntil = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - NOW.getTime()) / 86_400_000);
// Tue–Sun 10:00–17:00, closed Monday. 2026-08-12 is a Wednesday, 2026-08-10 a Monday.
const weekly = [2, 3, 4, 5, 6, 0].map((day) => ({ day, openMinute: 600, closeMinute: 1020 }));
const regular: OperationalEvidence = { provider: 'google-places', providerRef: 'ChIJ-museum', checkedAt: '2026-08-01T09:00:00.000Z', status: 'operational', hoursBasis: 'regular', weekly, attribution: 'Place data © Google' };

describe('LIVE WORLD V1 closure — operational evidence semantics', () => {
  it('A. a venue open at the planned time is retained, confirmed, with a recheck when the visit is far out', () => {
    const near = assessOperational({ evidence: regular, placeClass: 'business_venue', date: '2026-08-05', startMinute: 660, endMinute: 780, daysUntil: daysUntil('2026-08-05') });
    expect(near.outcome).toBe('open_at_time');
    expect(near.contradiction).toBe(false);
    expect(near.persisted.recheck).toBe(false);
    const far = assessOperational({ evidence: regular, placeClass: 'business_venue', date: '2026-09-09', startMinute: 660, endMinute: 780, daysUntil: daysUntil('2026-09-09') });
    expect(far.outcome).toBe('open_at_time');
    expect(far.persisted.recheck).toBe(true);
    expect(far.persisted.note).toMatch(/check again/);
  });
  it('B. a visit before opening is a minimal correction (arrive at opening); on a closed weekday it is closed on that date', () => {
    const early = assessOperational({ evidence: regular, placeClass: 'business_venue', date: '2026-08-12', startMinute: 480, endMinute: 600, daysUntil: daysUntil('2026-08-12') });
    expect(early.outcome).toBe('opens_later');
    expect(early.window).toEqual({ openMinute: 600, closeMinute: 1020 });
    expect(early.contradiction).toBe(true);
    const monday = assessOperational({ evidence: regular, placeClass: 'business_venue', date: '2026-08-10', daysUntil: daysUntil('2026-08-10') });
    expect(monday.outcome).toBe('closed_on_date');
    expect(monday.contradiction).toBe(true);
    expect(operationalWindowsOn(regular, '2026-08-10')).toEqual([]);
  });
  it('C. permanently closed is the one status that contradicts outright', () => {
    const closed = assessOperational({ evidence: { ...regular, status: 'closed_permanently' }, placeClass: 'business_venue', date: '2026-08-12', daysUntil: 11 });
    expect(closed.outcome).toBe('closed_permanently');
    expect(closed.contradiction).toBe(true);
    expect(closed.persisted.recheck).toBe(false);
  });
  it('D. open ground never asks for hours, and unknown hours are not closed', () => {
    const trail = assessOperational({ evidence: null, placeClass: 'open_ground', date: '2026-08-12', daysUntil: 11 });
    expect(trail.outcome).toBe('not_applicable');
    expect(trail.persisted.recheck).toBe(false);
    const unknown = assessOperational({ evidence: { ...regular, hoursBasis: 'none', weekly: undefined }, placeClass: 'business_venue', date: '2026-08-12', daysUntil: 11 });
    expect(unknown.outcome).toBe('hours_unknown');
    expect(unknown.contradiction).toBe(false);
    expect(unknown.persisted.note).toMatch(/not the same as closed/);
  });
  it('E. a provider that did not answer leaves the stop unverified, never closed', () => {
    const out = assessOperational({ evidence: { ...regular, status: 'unknown', hoursBasis: 'none', weekly: undefined, unavailableReason: 'timeout' }, placeClass: 'business_venue', date: '2026-08-12', daysUntil: 11 });
    expect(out.outcome).toBe('unavailable');
    expect(out.contradiction).toBe(false);
    expect(out.persisted.note).toMatch(/timeout/);
  });
  it('F. present-tense evidence is never a promise about a future date: current hours are reference only, temporary closure is a recheck', () => {
    const current = assessOperational({ evidence: { ...regular, hoursBasis: 'current' }, placeClass: 'business_venue', date: '2026-10-12', startMinute: 660, endMinute: 780, daysUntil: daysUntil('2026-10-12') });
    expect(current.outcome).toBe('hours_unknown');
    expect(current.contradiction).toBe(false);
    expect(current.persisted.recheck).toBe(true);
    const temp = assessOperational({ evidence: { ...regular, status: 'closed_temporarily' }, placeClass: 'business_venue', date: '2026-10-12', daysUntil: daysUntil('2026-10-12') });
    expect(temp.outcome).toBe('closed_temporarily_now');
    expect(temp.contradiction).toBe(false);
    expect(temp.persisted.note).toMatch(/nothing certain/);
    // Nothing persisted carries an hours value.
    expect(JSON.stringify(current.persisted)).not.toMatch(/openMinute|weekly|600|1020/);
  });
});
