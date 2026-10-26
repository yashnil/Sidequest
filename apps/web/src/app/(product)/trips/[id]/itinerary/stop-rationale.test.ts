import { describe, expect, it } from 'vitest';
import { transitBlindScenario } from '../../../../../../../../packages/planner/src/testing/transit-blind-city';
import { stopRationaleFor } from './view-model';

/**
 * THE ITINERARY ROW AND THE SIGNATURE SPREAD READ THE SAME `why`.
 *
 * When every reason a stop has was already spoken by a stop above it, the row
 * used to repeat that reason — on an open-data trip, "One of the established
 * names here" on row after row — while the stop's own description sat unused.
 */
describe('stopRationaleFor', () => {
  it('falls back to what the place is before repeating a neighbour', () => {
    const [first, second, ...rest] = transitBlindScenario('observed').candidates;
    const shared = 'A reason both stops share.';
    const candidates = [
      { ...first!, fit: { ...first!.fit, reasons: [shared] } },
      {
        ...second!,
        fit: { ...second!.fit, reasons: [shared] },
        place: { ...second!.place, shortDescription: 'Moorish castle in Lisbon. Listed as National Monument of Portugal.' },
      },
      ...rest,
    ];
    const rationale = stopRationaleFor(candidates);
    expect(rationale[first!.place.id]?.why).toBe(shared);
    expect(rationale[second!.place.id]?.why).toBe('Moorish castle in Lisbon. Listed as National Monument of Portugal.');
  });

  it('never promotes a bare label to a reason; the repeat stands where nothing else is known', () => {
    const [first, second] = transitBlindScenario('observed').candidates;
    const shared = 'A reason both stops share.';
    const rationale = stopRationaleFor([
      { ...first!, fit: { ...first!.fit, reasons: [shared] } },
      { ...second!, fit: { ...second!.fit, reasons: [shared] }, place: { ...second!.place, shortDescription: 'Fort' } },
    ]);
    expect(rationale[second!.place.id]?.why).toBe(shared);
  });
});
