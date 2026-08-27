import { describe, expect, it } from 'vitest';
import type { TransportMode } from '@sidequest/core';
import { TRANSIT_CITY_ACCESS } from '@sidequest/core/testing';
import { summariseDayTransport } from './access';

/**
 * A DAY'S PRIMARY MODE COMES FROM WHAT THE TRIP MAY USE, NEVER FROM A DEFAULT.
 *
 * The audited live artifact: `transport_json: { "primaryMode": "drive" }` on
 * the arrival and departure days of a trip whose traveller declared no car —
 * written by the hard-coded end of a fallback chain for days that travelled
 * nowhere at all, and by a bare `?? 'shuttle'` for days that rode a measured
 * train no authored service names.
 */

function layout(
  overrides: Partial<{
    driveMinutes: number;
    transitMinutes: number;
    walkMinutes: number;
    modes: TransportMode[];
  }> = {},
) {
  return {
    driveMinutes: 0,
    transitMinutes: 0,
    walkMinutes: 0,
    modes: [] as TransportMode[],
    ...overrides,
  };
}

const CAR_FREE: ReadonlySet<TransportMode> = new Set(['walk', 'rail', 'ferry', 'public_bus', 'shuttle']);
const WITH_CAR: ReadonlySet<TransportMode> = new Set(['walk', 'rail', 'ferry', 'drive']);

describe('the primary mode of a day', () => {
  it('an empty day on a car-free trip never claims a drive', () => {
    const summary = summariseDayTransport([], layout(), TRANSIT_CITY_ACCESS, CAR_FREE);
    expect(summary.primaryMode).not.toBe('drive');
    expect(summary.primaryMode).toBe('walk');
  });

  it('an empty day on a driving trip keeps the drive', () => {
    const summary = summariseDayTransport([], layout(), TRANSIT_CITY_ACCESS, WITH_CAR);
    expect(summary.primaryMode).toBe('drive');
  });

  it('a day riding a measured train names the train, not an invented shuttle', () => {
    const summary = summariseDayTransport(
      [],
      layout({ transitMinutes: 54, walkMinutes: 10, modes: ['rail', 'walk'] }),
      TRANSIT_CITY_ACCESS,
      CAR_FREE,
    );
    expect(summary.primaryMode).toBe('rail');
  });

  it('a walking day stays a walking day', () => {
    const summary = summariseDayTransport(
      [],
      layout({ walkMinutes: 40, modes: ['walk'] }),
      TRANSIT_CITY_ACCESS,
      CAR_FREE,
    );
    expect(summary.primaryMode).toBe('walk');
  });
});
