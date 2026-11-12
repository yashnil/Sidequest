import { describe, expect, it } from 'vitest';
import { buildFeasibilityReport } from './report';
import type { Itinerary } from '../schemas/itinerary';

const withNotes = (dayNotes: { dayNumber: number; code: string; note: string }[]) =>
  ({ days: [], issues: [], unscheduled: [], transportStrategy: { primaryMode: 'walk' }, package: { verification: { unverified: 0 }, planning: { dayNotes } } }) as unknown as Itinerary;

describe('one-way walks before "Ready"', () => {
  it('bags to send ahead are a booking the plan depends on', () => {
    const report = buildFeasibilityReport({ itinerary: withNotes([{ dayNumber: 2, code: 'walk_luggage', note: 'Nakahechi ends at Chikatsuyu, by tonight’s bed: send your bags ahead from the last place you stayed, booked in advance.' }]) });
    const item = report.items.find((i) => i.area === 'booking' && i.dayNumber === 2);
    expect(item?.severity).toBe('dependency');
    expect(report.status).not.toBe('feasible');
  });

  it('a way back to check is a caution, and an end beside the bed with no move is nothing', () => {
    const report = buildFeasibilityReport({ itinerary: withNotes([
      { dayNumber: 3, code: 'walk_return', note: 'X is one-way: it ends at Y. Take the bus or a taxi back.' },
      { dayNumber: 4, code: 'walk_luggage', note: 'Z ends at W, close to your bed in V — no transfer back needed.' },
    ]) });
    expect(report.items.find((i) => i.dayNumber === 3)?.severity).toBe('caution');
    expect(report.items.find((i) => i.dayNumber === 4)).toBeUndefined();
  });
});
