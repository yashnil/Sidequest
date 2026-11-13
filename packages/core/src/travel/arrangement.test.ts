import { describe, expect, it } from 'vitest';
import { arrangementDisagreements, decideTripArrangement, themeForLegs, type TripArrangementDay } from './arrangement';

const days = (shapes: readonly Partial<TripArrangementDay>[]): TripArrangementDay[] => shapes.map((s, i) => ({ dayNumber: i + 1, hints: [], ...s }));

describe('decideTripArrangement', () => {
  it('lets a stated arrangement decide, and records prose that contradicts it', () => {
    const a = decideTripArrangement({ driving: 'rental_self_drive', transportText: ['A driver-guide runs the overland legs.'], days: days([{}, {}]) });
    expect(a).toMatchObject({ primary: 'self_drive', selfDrive: true, evidence: 'stated', selfDriveDays: [1, 2] });
    expect(a.conflicts).toHaveLength(1);
    expect(decideTripArrangement({ driving: 'private_driver', days: days([{ hints: ['car'] }]) })).toMatchObject({ primary: 'private_driver', selfDrive: false, vehicle: 'private_transfer' });
    expect(decideTripArrangement({ driving: 'operator_transfer', days: days([{}]) })).toMatchObject({ primary: 'operator', selfDrive: false });
    expect(decideTripArrangement({ driving: 'none', willDrive: true, days: days([{ hints: ['car'] }]) })).toMatchObject({ primary: 'public_transport', selfDrive: false });
  });

  it('reads an operator from the plan’s own transport prose, over 4x4 hints and a traveller who would drive', () => {
    const a = decideTripArrangement({
      willDrive: true,
      transportText: ['A single operator driver-guide runs the overland legs in a 4x4, with one internal flight from the plains back to the gateway.'],
      days: days([{ theme: 'Arrival' }, { hints: ['four_wheel_drive'] }, { theme: 'Fly to the plains', hints: ['four_wheel_drive'], roadTransfer: true }, { theme: 'Final game drive, fly back to the gateway' }, { theme: 'Departure' }]),
    });
    expect(a).toMatchObject({ primary: 'operator', selfDrive: false, evidence: 'text', vehicle: 'four_wheel_drive', flights: true, flightDays: [] });
    /* Day 3 is a road relocation, so its "fly" is wrong rather than a flight to book; day 4 has no road move and the prose states the flight. */
    expect(a.statedFlightDays).toEqual([4]);
  });

  it('reads an operator from operator-run episodes when nothing outside them is self-driven', () => {
    const a = decideTripArrangement({
      willDrive: true,
      days: days([{ hints: ['walk'] }, { hints: ['four_wheel_drive'] }, { hints: ['four_wheel_drive'] }, {}]),
      episodes: [{ dayNumbers: [2, 3], kind: 'safari', mode: 'four_wheel_drive', timing: 'operator' }],
    });
    expect(a).toMatchObject({ primary: 'operator', evidence: 'episodes', operatorDays: [2, 3], selfDrive: false });
  });

  it('is mixed when a car is named outside an operator-run episode, and rents only for those days', () => {
    const a = decideTripArrangement({
      willDrive: true,
      days: days([{ hints: ['car'] }, { hints: ['four_wheel_drive'] }, { hints: ['four_wheel_drive'] }, { hints: ['car'] }]),
      episodes: [{ dayNumbers: [2, 3], kind: 'safari', mode: 'four_wheel_drive', timing: 'operator' }],
    });
    expect(a).toMatchObject({ primary: 'mixed', selfDrive: true, selfDriveDays: [1, 4] });
  });

  it('never makes a train trip a self-drive trip because the traveller would drive', () => {
    const a = decideTripArrangement({ willDrive: true, transportText: ['By train between the towns.'], days: days([{ hints: ['rail'] }, { hints: ['walk', 'bus'] }]) });
    expect(a).toMatchObject({ primary: 'public_transport', selfDrive: false });
  });

  it('keeps a self-drive reading where the plan drives, and treats a guided extra as a tour', () => {
    expect(decideTripArrangement({ willDrive: true, transportText: ['Self-drive loop by rental car; one guided boat tour.'], days: days([{ hints: ['car'] }]) })).toMatchObject({ primary: 'self_drive', selfDrive: true });
    expect(decideTripArrangement({ willDrive: true, days: days([{ hints: ['car'] }]) })).toMatchObject({ primary: 'self_drive', evidence: 'hints' });
    expect(decideTripArrangement({ willDrive: false, days: days([{ hints: ['car'] }]) })).toMatchObject({ primary: 'transfers', selfDrive: false });
    expect(decideTripArrangement({ willDrive: true, days: days([{ legModes: ['drive'] }]) })).toMatchObject({ primary: 'self_drive', evidence: 'legs' });
    expect(decideTripArrangement({ days: days([{}]) })).toMatchObject({ primary: 'public_transport', evidence: 'default', selfDrive: false });
  });

  it('counts a structured flight day, and never the flight home', () => {
    const a = decideTripArrangement({ driving: 'none', days: days([{ hints: ['flight'] }, {}, { theme: 'Fly home' }]) });
    expect(a).toMatchObject({ flights: true, flightDays: [1], statedFlightDays: [] });
  });
});

describe('themeForLegs', () => {
  it('says drive where the day’s move is a road leg, and leaves every other title alone', () => {
    expect(themeForLegs('Fly to the plains', { hasFlightLeg: false, roadTransfer: true })).toBe('Drive to the plains');
    expect(themeForLegs('Morning flight, then flying over the lakes', { hasFlightLeg: false, roadTransfer: true })).toBe('Morning drive, then driving over the lakes');
    expect(themeForLegs('Fly to the plains', { hasFlightLeg: true, roadTransfer: true })).toBe('Fly to the plains');
    expect(themeForLegs('Final game drive, fly back', { hasFlightLeg: false, roadTransfer: false })).toBe('Final game drive, fly back');
    expect(themeForLegs('Butterfly garden', { hasFlightLeg: false, roadTransfer: true })).toBe('Butterfly garden');
  });
});

describe('arrangementDisagreements', () => {
  it('reports a rental, a car budget, a permit and rental advice on a trip nobody drives, and an unbooked flight', () => {
    const problems = arrangementDisagreements(
      { primary: 'operator', selfDrive: false, flightDays: [], statedFlightDays: [5] },
      {
        bookings: [{ kind: 'rental_vehicle', title: 'Rental car for the whole trip' }],
        budgetCategories: ['car_fuel_tolls_parking'],
        readinessKinds: ['driving_document'],
        advice: ['Reserve the hire car early.'],
        days: [{ dayNumber: 4, theme: 'Fly to the plains', hasFlightLeg: false, roadTransfer: true }],
      },
    );
    expect(problems).toHaveLength(6);
  });

  it('is quiet when the surfaces agree', () => {
    expect(arrangementDisagreements({ primary: 'self_drive', selfDrive: true, flightDays: [], statedFlightDays: [] }, { bookings: [{ kind: 'rental_vehicle', title: 'Rental car' }], budgetCategories: ['car_fuel_tolls_parking'], readinessKinds: ['driving_document'] })).toEqual([]);
  });
});
