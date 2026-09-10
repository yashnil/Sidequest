import { describe, expect, it } from 'vitest';
import { buildBookingProgress } from './booking-progress';
import type { BookingItem } from './booking';

function item(patch: Partial<BookingItem>): BookingItem {
  return { id: patch.id ?? 'b', title: patch.title ?? 'x', kind: 'accommodation', necessity: 'required', priority: 'book_soon', reason: 'because', travelerAction: 'Book it', capacityEvidence: 'unknown', status: 'open', ...patch } as BookingItem;
}

describe('booking progress', () => {
  it('counts the stays by base, the transport and the operated experiences, and names the next thing to do', () => {
    const items: BookingItem[] = [
      item({ id: 'booking:stays', title: 'Stays', group: 'stays', memberIds: ['s1', 's2', 's3', 's4'], priority: 'book_first' }),
      item({ id: 's1', title: 'Furano', group: 'stays', status: 'booked' }),
      item({ id: 's2', title: 'Sounkyo', group: 'stays', status: 'booked' }),
      item({ id: 's3', title: 'Kawayu', group: 'stays' }),
      item({ id: 's4', title: 'Kushiro', group: 'stays' }),
      item({ id: 'car', title: 'Rental car', kind: 'rental_vehicle', status: 'booked' }),
      item({ id: 'guide', title: 'Daisetsuzan guide', kind: 'tour_guide', priority: 'book_first' }),
      item({ id: 'dinner', title: 'A dinner', kind: 'restaurant', necessity: 'optional', priority: 'can_wait' }),
    ];
    const progress = buildBookingProgress(items);
    expect(progress.critical).toBe(6);
    expect(progress.arranged).toBe(3);
    expect(progress.summary).toBe('3 of 6 things this trip depends on are arranged.');
    expect(progress.groups.map((g) => [g.id, g.done, g.total])).toEqual([['stays', 2, 4], ['transport', 1, 1], ['experiences', 0, 1]]);
    expect(progress.nextAction?.title).toBe('Daisetsuzan guide');
  });
  it('says so when everything is arranged, and when nothing needs booking', () => {
    expect(buildBookingProgress([item({ id: 'a', status: 'booked' })]).summary).toMatch(/All 1 things/);
    expect(buildBookingProgress([item({ id: 'a', necessity: 'optional', priority: 'can_wait' })]).summary).toMatch(/Nothing here needs booking/);
  });
});
