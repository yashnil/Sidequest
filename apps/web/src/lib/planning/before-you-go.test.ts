import { describe, expect, it } from 'vitest';
import { beforeYouGoFor } from './planner-composer';
import type { PlannerCandidate } from './structure-planner';

const stop = (id: string, booking: PlannerCandidate['booking']) => ({ id, name: id, booking }) as PlannerCandidate;

describe('before you go, from the plan', () => {
  it('names the stops to book, the seasonal checks and the car — never a rule about entry', () => {
    const lines = beforeYouGoFor({
      scheduled: [stop('Fiery Furnace', 'required'), stop('Jet Boat', 'recommended'), stop('Mesa Arch', 'none')],
      carAvailable: true,
      seasonal: new Map([['Mesa Arch', 'The road can close after snow.']]),
    });
    expect(lines.join('\n')).toMatch(/Book ahead — entry needs a reservation: Fiery Furnace/);
    expect(lines.join('\n')).toMatch(/Worth booking ahead: Jet Boat/);
    expect(lines.join('\n')).toMatch(/Mesa Arch: The road can close after snow/);
    expect(lines.join('\n')).toMatch(/hire car/);
    expect(lines[0]).toMatch(/Check the official entry requirements/);
  });

  it('says nothing about a car on a car-free trip, and no booking line when nothing needs one', () => {
    const lines = beforeYouGoFor({ scheduled: [stop('Park', 'none')], carAvailable: false, seasonal: new Map() });
    expect(lines.join('\n')).not.toMatch(/car|Book/);
  });
});
