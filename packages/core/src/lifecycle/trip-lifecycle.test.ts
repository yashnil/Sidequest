import { describe, expect, it } from 'vitest';
import { dashboardSectionFor, inferLifecycle, overrideRefusal, readLifecycle } from './trip-lifecycle';

const NOW = new Date('2026-09-10T00:00:00Z');
const trip = (patch: Partial<{ startDate: string; endDate: string; status: 'draft' | 'profiled' | 'discovering' | 'planned'; lifecycleOverride: 'idea' | 'planning' | 'ready' | 'booked' | 'traveling' | 'past' | 'archived'; archivedAt: string }> = {}) => ({
  basics: { startDate: patch.startDate ?? '2027-06-13', endDate: patch.endDate ?? '2027-06-20' } as never,
  status: patch.status ?? 'draft',
  ...(patch.lifecycleOverride ? { lifecycleOverride: patch.lifecycleOverride } : {}),
  ...(patch.archivedAt ? { archivedAt: patch.archivedAt } : {}),
});

describe('the trip lifecycle', () => {
  it('is inferred from the calendar, bookings, the itinerary and the profile, in that order', () => {
    expect(inferLifecycle({ trip: trip(), itineraryStatus: null, bookedTypes: [], hasProfile: false, now: NOW })).toBe('idea');
    expect(inferLifecycle({ trip: trip(), itineraryStatus: null, bookedTypes: [], hasProfile: true, now: NOW })).toBe('planning');
    expect(inferLifecycle({ trip: trip(), itineraryStatus: 'needs_decision', bookedTypes: [], hasProfile: true, now: NOW })).toBe('planning');
    expect(inferLifecycle({ trip: trip(), itineraryStatus: 'ready_with_cautions', bookedTypes: [], hasProfile: true, now: NOW })).toBe('ready');
    expect(inferLifecycle({ trip: trip(), itineraryStatus: 'ready', bookedTypes: ['lodging'], hasProfile: true, now: NOW })).toBe('booked');
    expect(inferLifecycle({ trip: trip(), itineraryStatus: 'ready', bookedTypes: ['restaurant'], hasProfile: true, now: NOW })).toBe('ready');
    expect(inferLifecycle({ trip: trip({ startDate: '2026-09-08', endDate: '2026-09-12' }), itineraryStatus: null, bookedTypes: [], hasProfile: false, now: NOW })).toBe('traveling');
    expect(inferLifecycle({ trip: trip({ startDate: '2026-08-01', endDate: '2026-08-05' }), itineraryStatus: 'ready', bookedTypes: ['flight'], hasProfile: true, now: NOW })).toBe('past');
  });
  it('booked needs a booked stay or way there; the calendar is never overridable; archived is a flag', () => {
    expect(overrideRefusal('booked', { trip: trip(), itineraryStatus: 'ready', bookedTypes: [], hasProfile: true, now: NOW })).toMatch(/booked stay/);
    expect(overrideRefusal('booked', { trip: trip(), itineraryStatus: 'ready', bookedTypes: ['train'], hasProfile: true, now: NOW })).toBeNull();
    expect(overrideRefusal('planning', { trip: trip({ startDate: '2026-08-01', endDate: '2026-08-05' }), itineraryStatus: null, bookedTypes: [], hasProfile: false, now: NOW })).toMatch(/already ended/);
    const refused = readLifecycle({ trip: trip({ lifecycleOverride: 'booked' }), itineraryStatus: 'ready', bookedTypes: [], hasProfile: true, now: NOW });
    expect(refused.lifecycle).toBe('ready');
    expect(refused.overrideRefused).toBe(true);
    expect(readLifecycle({ trip: trip({ archivedAt: '2026-09-01' }), itineraryStatus: 'ready', bookedTypes: ['lodging'], hasProfile: true, now: NOW }).lifecycle).toBe('archived');
    expect(dashboardSectionFor('traveling')).toBe('upcoming');
    expect(dashboardSectionFor('ready')).toBe('planning');
  });
});
