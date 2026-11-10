import { describe, expect, it } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import { plannerUnplacedMustDos } from './planner-composer';

const itinerary = (titles: readonly string[]): Pick<Itinerary, 'days' | 'unscheduled'> => ({
  days: [{ items: titles.map((title, index) => ({ kind: 'activity', title, id: `i${index}` })) }] as unknown as Itinerary['days'],
  unscheduled: [],
});

describe('plannerUnplacedMustDos', () => {
  it('names a typed must-do that no stop matches, so it cannot vanish from the finished trip', () => {
    const out = plannerUnplacedMustDos(['Teide cable car'], itinerary(['Tenerife Castle']));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Teide cable car', wasManual: true, reasonCode: 'selection_not_on_board' });
    expect(out[0]!.suggestedRemedy).toBeTruthy();
  });

  it('stays quiet about a must-do that is on the plan', () => {
    expect(plannerUnplacedMustDos(['Tenerife Castle'], itinerary(['Tenerife Castle']))).toEqual([]);
    expect(plannerUnplacedMustDos(['the castle at Tenerife Castle'], itinerary(['Tenerife Castle']))).toEqual([]);
  });

  it('does not repeat one already listed as unscheduled, and ignores blanks', () => {
    const it2 = { ...itinerary([]), unscheduled: [{ placeId: 'x', name: 'Tenerife Castle', wasManual: true, reasonCode: 'no_time_left', reason: 'r' }] } as Pick<Itinerary, 'days' | 'unscheduled'>;
    expect(plannerUnplacedMustDos(['Tenerife Castle', '  '], it2)).toEqual([]);
  });
});
