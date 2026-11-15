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
    expect(report.verdict).not.toBe('feasible');
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

describe('a trail stage nobody can walk as written (2026-11)', () => {
  it('is a decision the traveller owns, so the trip is never Ready around it', () => {
    const report = buildFeasibilityReport({ itinerary: withNotes([{ dayNumber: 4, code: 'trail_unresolved', note: 'Col A → Col B is a long day for this party: about 9 h of walking. Nowhere to sleep was found on the way to break it.' }]) });
    const item = report.items.find((i) => i.dayNumber === 4)!;
    expect(item).toMatchObject({ area: 'physical', severity: 'dependency' });
    expect(item.owner).toBeUndefined();
    expect(report.verdict).toBe('unresolved_major_dependency');
  });

  it('a stage covered the usual other way is a caution to confirm', () => {
    const report = buildFeasibilityReport({ itinerary: withNotes([{ dayNumber: 4, code: 'trail_alternative', note: 'Col A → Col B: take the bus instead.' }]) });
    expect(report.items.find((i) => i.dayNumber === 4)?.severity).toBe('caution');
    expect(report.verdict).toBe('feasible_with_cautions');
  });
});

describe('the traveller’s daily travel limit (2026-11)', () => {
  const withLimit = (hard: boolean) =>
    ({
      days: [],
      issues: [],
      unscheduled: [],
      transportStrategy: { primaryMode: 'drive' },
      package: {
        verification: { unverified: 0 },
        planning: {
          dayNotes: [],
          travelLimit: {
            version: 1,
            limitMinutes: 240,
            hard,
            daysOver: 1,
            days: [{ dayNumber: 4, travelMinutes: 370, cause: 'transfer' }],
            choices: hard
              ? [
                  { dayNumber: 4, kind: 'accept_long_day', label: 'Accept about 6 h 10 of travel on day 4', detail: 'x' },
                  { dayNumber: 4, kind: 'add_night', label: 'Add a night in Midtown', detail: 'x', subject: 'Midtown' },
                ]
              : [],
          },
        },
      },
    }) as unknown as Itinerary;

  it('over the traveller’s own limit, the day is a choice they make, with the choices named', () => {
    const report = buildFeasibilityReport({ itinerary: withLimit(true) });
    const item = report.items.find((i) => i.dayNumber === 4)!;
    expect(item.severity).toBe('dependency');
    expect(item.detail).toMatch(/over the 240 a day you set\. Choose: Accept about 6 h 10 of travel on day 4; Add a night in Midtown\./);
    expect(report.verdict).toBe('unresolved_major_dependency');
  });

  it('over Sidequest’s own default, it is a caution, stated', () => {
    const report = buildFeasibilityReport({ itinerary: withLimit(false) });
    expect(report.items.find((i) => i.dayNumber === 4)).toMatchObject({ severity: 'caution' });
    expect(report.verdict).toBe('feasible_with_cautions');
  });
});
