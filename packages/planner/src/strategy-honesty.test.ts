import { describe, expect, it } from 'vitest';
import type { ItineraryDay, TransitEvidence } from '@sidequest/core';
import {
  TRANSIT_CITY_ACCESS,
  TRANSIT_CITY_REGION,
  transitCityTraveler,
} from '@sidequest/core/testing';
import { buildTransportStrategy } from './strategy';

/**
 * "WALKABLE" IS A VERDICT THE EVIDENCE HAS TO EARN.
 *
 * The audited live artifact: headline "Walk the whole way", transitSummary
 * "Everything here is walkable from your base" — asserted over a region whose
 * own evidence held eighty-four railway stations and a transit record reading
 * `{requested: 0, measured: 0, absence: 'unsupported'}`. The sentences were
 * derived from the matrix mode and the authored service list, neither of which
 * knows whether scheduled transport was ever looked at.
 *
 * The contract: when the trip leaned on scheduled transport and none of it
 * could be measured, every walking-first claim says the honest version — the
 * product's existing sentence for exactly this state — and the walkable
 * verdict is only spoken where nothing contradicts it.
 */

/** A walking-only day, in the minimal shape the strategy actually reads. */
function walkingDay(dayNumber: number, walkMinutes: number): ItineraryDay {
  return {
    dayNumber,
    date: `2026-08-1${dayNumber}`,
    baseId: 'tc-base',
    baseName: 'Two Rivers',
    theme: 'fixture',
    intensity: 'moderate',
    window: { startMinute: 540, endMinute: 1140, usableMinutes: 600 },
    items: [],
    totals: {
      activityMinutes: 120,
      travelMinutes: walkMinutes,
      driveMinutes: 0,
      transitMinutes: 0,
      walkMinutes,
      waitMinutes: 0,
      unverifiedMinutes: 0,
      freeMinutes: 0,
      travelKm: 0,
    },
    transport: {
      primaryMode: 'walk',
      modes: walkMinutes > 0 ? ['walk'] : [],
      serviceIds: [],
      parkingNotes: [],
      accessNotes: [],
      verifyBeforeTravel: [],
    },
    availability: { flexiblePlaceIds: [], cautions: [], verifyBeforeTravel: [], bookings: [] },
    weather: {
      evidence: 'unavailable',
      summary: 'fixture',
      precipitationProbabilityPercent: null,
      decisions: [],
      cautions: [],
      backups: [],
      provider: 'none',
      attribution: 'fixture',
    },
    food: { summary: 'fixture', slots: [], remote: false, notes: [], reservations: [] },
    warnings: [],
  } as unknown as ItineraryDay;
}

function strategyWith(transit?: TransitEvidence) {
  return buildTransportStrategy({
    days: [walkingDay(1, 130), walkingDay(2, 0)],
    profile: transitCityTraveler(),
    region: TRANSIT_CITY_REGION,
    dataset: TRANSIT_CITY_ACCESS,
    unscheduled: [],
    matrixNote: 'Measured against the pedestrian network.',
    matrixProvenance: 'measured',
    matrixMode: 'foot',
    ...(transit ? { transit } : {}),
  });
}

const UNVERIFIED: TransitEvidence = {
  journeys: [],
  requested: 0,
  measured: 0,
  absence: 'unsupported',
};

describe('the transport strategy over unmeasured scheduled transport', () => {
  it('never claims the ground is walkable when transit went unmeasured', () => {
    const strategy = strategyWith(UNVERIFIED);
    expect(strategy.transitSummary).not.toMatch(/walkable/i);
    expect(strategy.transitSummary).toMatch(/not verified/i);
    expect(strategy.transitSummary).toMatch(/on foot/);
  });

  it('headline says on-foot-for-now, not walk-the-whole-way', () => {
    const strategy = strategyWith(UNVERIFIED);
    expect(strategy.headline).not.toMatch(/whole way/i);
    expect(strategy.headline).toMatch(/not verified/i);
  });

  it('the rationale attributes the walking to the measurement gap, not the ground', () => {
    const strategy = strategyWith(UNVERIFIED);
    const rationale = strategy.rationale.join(' ');
    expect(rationale).not.toMatch(/within walking distance/i);
    expect(rationale).toMatch(/not verified/i);
  });

  it('budget-exhausted transit is the same honesty case', () => {
    const strategy = strategyWith({ ...UNVERIFIED, absence: 'budget_exhausted' });
    expect(strategy.transitSummary).not.toMatch(/walkable/i);
    expect(strategy.headline).not.toMatch(/whole way/i);
  });

  it('a trip that never leaned on transit keeps the walkable verdict', () => {
    const strategy = strategyWith(undefined);
    expect(strategy.headline).toBe('Walk the whole way');
    expect(strategy.transitSummary).toBe('Everything here is walkable from your base.');
  });

  it('a provider that was asked and holds nothing keeps the walking verdict too', () => {
    /* The closest thing to "there is no network" a build can attest. */
    const strategy = strategyWith({ ...UNVERIFIED, absence: 'out_of_coverage' });
    expect(strategy.headline).toBe('Walk the whole way');
    expect(strategy.transitSummary).toBe('Everything here is walkable from your base.');
  });
});
