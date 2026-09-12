import { describe, expect, it } from 'vitest';
import { todayViewSchema, type BookedPlanItem, type TodayView } from '@sidequest/core';
import { todayDirections, todayReservation } from './today-view-model';

/**
 * V9 §8 — the two derivations Today adds over the hub's view model: a
 * directions link only where a position is established, and the booked fact
 * behind the next item. Pure, fixed inputs, no clock.
 */
function view(patch: Partial<TodayView>): TodayView {
  return todayViewSchema.parse({
    active: true,
    localDate: '2026-08-13',
    dayNumber: 2,
    theme: 'Lakes and a long lunch',
    nowMinute: 600,
    next: { id: 'stop-2', title: 'Convict Lake', startMinute: 660, endMinute: 780, kind: 'activity' },
    stops: [
      { id: 'stop-1', title: 'Bakery run', startMinute: 480, endMinute: 540, placeId: 'bakery', done: true },
      { id: 'stop-2', title: 'Convict Lake', startMinute: 660, endMinute: 780, placeId: 'convict-lake', done: false },
    ],
    bookedToday: [],
    ...patch,
  });
}

const COORDS = { bakery: { lat: 37.65, lng: -118.97 }, 'convict-lake': { lat: 37.59, lng: -118.86 }, base: { lat: 37.648, lng: -118.972 } };

describe('todayDirections', () => {
  it('routes the next leg between two established positions, by the leg’s mode', () => {
    const today = view({ nextTransport: { title: 'Drive to Convict Lake', startMinute: 630, minutes: 25, mode: 'drive', basis: 'static', fromId: 'bakery', toId: 'convict-lake' } });
    const directions = todayDirections(today, COORDS);
    expect(directions?.mode).toBe('driving');
    expect(directions?.google).toContain('origin=37.65');
    expect(directions?.google).toContain('destination=37.59');
    expect(directions?.label).toBe('Directions for Drive to Convict Lake');
  });

  it('falls back to the next stop’s own position when the leg has no ends', () => {
    const directions = todayDirections(view({}), COORDS);
    expect(directions?.label).toBe('Directions to Convict Lake');
    expect(directions?.google).toContain('query=37.59');
    expect(directions?.apple).toContain('Convict');
  });

  it('gives no link at all when nothing has a position — never an invented coordinate', () => {
    expect(todayDirections(view({}), {})).toBeNull();
    expect(todayDirections(view({ nextTransport: { title: 'Drive', startMinute: 630, minutes: 25, mode: 'drive', basis: 'static', fromId: 'bakery', toId: 'nowhere' } }), { bakery: COORDS.bakery })).toBeNull();
  });
});

describe('todayReservation', () => {
  const booked: BookedPlanItem[] = [
    { id: 'booked:1', type: 'activity', title: 'Convict Lake boat hire', date: '2026-08-13', startTime: '11:00', confirmationRef: 'CL-4471', status: 'booked', locked: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' } as unknown as BookedPlanItem,
    { id: 'booked:2', type: 'lodging', title: 'Hotel B by the creek', date: '2026-08-12', endDate: '2026-08-15', status: 'booked', locked: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' } as unknown as BookedPlanItem,
  ];

  it('finds the booked fact behind the next item by title and carries its reference', () => {
    const today = view({ bookedToday: [{ id: 'booked:1', title: 'Convict Lake boat hire', startTime: '11:00' }, { id: 'booked:2', title: 'Hotel B by the creek' }] });
    expect(todayReservation(today, booked)).toMatchObject({ id: 'booked:1', title: 'Convict Lake boat hire', startTime: '11:00', confirmationRef: 'CL-4471' });
  });

  it('never picks a booking that is not on today, and nothing when nothing matches', () => {
    expect(todayReservation(view({}), booked)).toBeNull();
    expect(todayReservation(view({ next: undefined }), booked)).toBeNull();
  });
});
