import { describe, expect, it } from 'vitest';
import { carFreeMoveFor, walkEndOf, walkNotes } from './planner-composer';
import type { PlannerBase, StructurePlan } from './structure-planner';

const bed = (id: string, name: string, lat: number, lng: number): PlannerBase => ({ id, name, why: '', coordinates: { lat, lng }, fromDate: '2027-03-20', toDate: '2027-03-22', nights: 2, transferMinutesFromPrevious: 0 });
const day = (dayNumber: number, baseId: string, relocation: boolean, walkEnd: { lat: number; lng: number; name?: string }) =>
  ({ dayNumber, baseId, relocation, stops: [{ candidate: { id: 'walk', name: 'Nakahechi stage', coordinates: { lat: 33.78, lng: 135.45 }, walkEnd }, slot: 'day' }] }) as unknown as StructurePlan['days'][number];

describe('one-way walks on the day', () => {
  it('reads the end from the scan’s tags', () => {
    expect(walkEndOf(['kind:day_hike', 'walk:point_to_point', 'walk-end:33.81,135.52', 'walk-end-name:Chikatsuyu'])).toEqual({ walkEnd: { lat: 33.81, lng: 135.52, name: 'Chikatsuyu' } });
    expect(walkEndOf(['walk:point_to_point_unplaced'])).toEqual({});
  });

  it('on a move day that ends at the new bed, without a car: bags go ahead, no return', () => {
    const plan = { days: [day(2, 'chikatsuyu', true, { lat: 33.81, lng: 135.52, name: 'Chikatsuyu' })] } as unknown as StructurePlan;
    const [note] = walkNotes({ plan, bases: [bed('chikatsuyu', 'Chikatsuyu', 33.812, 135.521)], carAvailable: false });
    expect(note!.code).toBe('walk_luggage');
    expect(note!.note).toMatch(/send your bags ahead/);
  });

  it('elsewhere, without a car: the way back to the bed, estimated, with the last departure to check', () => {
    const plan = { days: [day(2, 'hongu', false, { lat: 33.81, lng: 135.52, name: 'Chikatsuyu' })] } as unknown as StructurePlan;
    const [note] = walkNotes({ plan, bases: [bed('hongu', 'Hongū', 33.84, 135.77)], carAvailable: false });
    expect(note!.code).toBe('walk_return');
    expect(note!.note).toMatch(/back to Hongū \(about \d+ min by road, estimated\); check the last departure/);
  });

  it('on a driving trip, even beside the bed: back to the car at the start', () => {
    const plan = { days: [day(2, 'chikatsuyu', true, { lat: 33.81, lng: 135.52, name: 'Chikatsuyu' })] } as unknown as StructurePlan;
    const [note] = walkNotes({ plan, bases: [bed('chikatsuyu', 'Chikatsuyu', 33.812, 135.521)], carAvailable: true });
    expect(note!.code).toBe('walk_return');
    expect(note!.note).toMatch(/back to the car/);
  });
});

describe('a car-free move says how it is made', () => {
  const tokyo = { lat: 35.6896, lng: 139.7006 };
  const kyoto = { lat: 35.0037, lng: 135.7788 };
  it('a long hop where high-speed rail is the backbone is a high-speed train; elsewhere a train', () => {
    expect(carFreeMoveFor(tokyo, kyoto, 'JP')).toEqual({ how: 'high_speed_rail', when: 'start' });
    expect(carFreeMoveFor(tokyo, kyoto, 'IS')).toEqual({ how: 'rail', when: 'start' });
    expect(carFreeMoveFor(tokyo, { lat: 35.45, lng: 139.63 }, 'JP')).toEqual({ how: 'rail', when: 'start' });
  });
  it('a hop across town, or an unplaced bed, states nothing', () => {
    expect(carFreeMoveFor(tokyo, { lat: 35.69, lng: 139.705 }, 'JP')).toBeNull();
    expect(carFreeMoveFor(undefined, kyoto, 'JP')).toBeNull();
  });
});
