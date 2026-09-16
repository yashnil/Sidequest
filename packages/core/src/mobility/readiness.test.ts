import { describe, expect, it } from 'vitest';
import { OPERATING_TYPES } from '../operating/model';
import { controlForMode, routingForMode, scheduleForMode, type Journey, type JourneyTruth } from './journey';
import { FAMILY_JOURNEY_REQUIREMENTS, assessJourneyReadiness, journeyIsSettled, journeyShortfalls } from './readiness';
import type { TravelMode } from './vocabulary';

function journey(mode: TravelMode, truth: JourneyTruth, over: Partial<Journey> = {}): Journey {
  return {
    version: 1,
    origin: { id: 'a', name: 'A' },
    destination: { id: 'b', name: 'B' },
    mode,
    control: controlForMode(mode),
    routing: routingForMode(mode),
    schedule: scheduleForMode(mode),
    truth,
    minutes: truth === 'unknown' || truth === 'contradicted' ? null : 120,
    km: null,
    reservation: 'unknown',
    booking: 'unknown',
    evidence: { source: 'none', freshness: 'unknown' },
    routeCritical: true,
    ...over,
  };
}

describe('mode-aware readiness', () => {
  it('has a requirement profile for every operating family', () => {
    for (const family of OPERATING_TYPES) {
      expect(FAMILY_JOURNEY_REQUIREMENTS[family]).toBeDefined();
      expect(FAMILY_JOURNEY_REQUIREMENTS[family].accepts.length).toBeGreaterThan(0);
      expect(FAMILY_JOURNEY_REQUIREMENTS[family].need.length).toBeGreaterThan(0);
    }
  });

  describe('a self-drive route', () => {
    it('is not ready with an untimed base transfer', () => {
      const readiness = assessJourneyReadiness([journey('drive', 'unknown', { unknownReason: 'outside_provider_coverage' })], 'self_drive_road_trip');
      expect(readiness.settled).toBe(0);
      expect(readiness.outstanding).toHaveLength(1);
    });

    it('is ready when the drives are measured', () => {
      const readiness = assessJourneyReadiness([journey('drive', 'measured'), journey('drive', 'measured')], 'self_drive_road_trip');
      expect(readiness.settled).toBe(2);
      expect(journeyShortfalls(readiness, 'self_drive_road_trip')).toHaveLength(0);
    });

    it('cannot use schedule-to-confirm, because a road has no timetable to fall back on', () => {
      expect(journeyIsSettled(journey('drive', 'unknown'), FAMILY_JOURNEY_REQUIREMENTS.self_drive_road_trip)).toBe(false);
    });
  });

  describe('a rail journey', () => {
    it('accepts a real corridor whose timetable nobody has read', () => {
      /* The V12 defect: 0.90 certainty meant "measured", and no road router measures a Shinkansen. */
      const readiness = assessJourneyReadiness([journey('rail', 'unknown', { unknownReason: 'no_provider_for_mode' })], 'rail_journey');
      expect(readiness.settled).toBe(1);
      expect(readiness.outstanding).toHaveLength(0);
    });

    it('accepts a read timetable outright', () => {
      expect(journeyIsSettled(journey('rail', 'timetabled'), FAMILY_JOURNEY_REQUIREMENTS.rail_journey)).toBe(true);
    });

    it('does not extend schedule-to-confirm to the taxi to the station', () => {
      /* The exemption is for journeys somebody else's schedule owns, not for every leg on the trip. */
      expect(journeyIsSettled(journey('taxi', 'unknown'), FAMILY_JOURNEY_REQUIREMENTS.rail_journey)).toBe(false);
    });
  });

  describe('an operator-led trip', () => {
    it('is ready on the operator’s own timing', () => {
      const trek = assessJourneyReadiness([journey('trail', 'operator_set'), journey('operator_transfer', 'operator_set')], 'multi_day_trek');
      expect(trek.settled).toBe(2);
      expect(journeyShortfalls(trek, 'multi_day_trek')).toHaveLength(0);
    });

    it('never asks a trek for road-measured trail legs', () => {
      expect(journeyIsSettled(journey('trail', 'operator_set'), FAMILY_JOURNEY_REQUIREMENTS.multi_day_trek)).toBe(true);
    });

    it('does not let operator_set stand in for genuinely unknown', () => {
      const readiness = assessJourneyReadiness([journey('operator_transfer', 'unknown', { control: 'traveler_controlled' })], 'guided_wildlife');
      expect(readiness.outstanding).toHaveLength(1);
    });
  });

  describe('a resort week', () => {
    it('is ready when the arrival transfer is the operator’s', () => {
      const readiness = assessJourneyReadiness([journey('boat', 'operator_set')], 'resort_stay');
      expect(readiness.settled).toBe(1);
    });
  });

  describe('island hopping', () => {
    it('accepts a real ferry corridor with no timetable read yet', () => {
      const readiness = assessJourneyReadiness([journey('ferry', 'unknown', { unknownReason: 'no_provider_for_mode' })], 'island_hopping');
      expect(readiness.settled).toBe(1);
    });

    it('is never ready with a crossing a source says is not running', () => {
      const readiness = assessJourneyReadiness([journey('ferry', 'contradicted', { contradiction: 'No winter sailings on this route.' })], 'island_hopping');
      expect(readiness.contradicted).toHaveLength(1);
      const shortfalls = journeyShortfalls(readiness, 'island_hopping');
      expect(shortfalls[0]?.requirement).toBe('journey_contradicted');
      expect(shortfalls[0]?.owner).toBe('traveler');
    });
  });

  describe('a city week', () => {
    it('is ready with an unverified transit hop', () => {
      const readiness = assessJourneyReadiness([journey('urban_transit', 'unknown', { unknownReason: 'no_provider_for_mode' })], 'urban_culture');
      expect(readiness.settled).toBe(1);
    });

    it('is ready with an estimated walk', () => {
      expect(journeyIsSettled(journey('walk', 'estimated'), FAMILY_JOURNEY_REQUIREMENTS.urban_culture)).toBe(true);
    });
  });

  describe('whose unfinished work it is (§22)', () => {
    it('files a journey no provider could time as ours, and says so', () => {
      const readiness = assessJourneyReadiness([journey('drive', 'unknown', { unknownReason: 'no_provider_for_mode' })], 'self_drive_road_trip');
      expect(readiness.ownedBySidequest).toHaveLength(1);
      const shortfalls = journeyShortfalls(readiness, 'self_drive_road_trip');
      expect(shortfalls).toHaveLength(1);
      expect(shortfalls[0]?.owner).toBe('sidequest');
      expect(shortfalls[0]?.detail).toMatch(/our unfinished work, not yours/i);
    });

    it('never asks a traveller to decide transportation because we could not route it', () => {
      const readiness = assessJourneyReadiness([journey('drive', 'unknown', { unknownReason: 'outside_provider_coverage' })], 'mountain_road_trip');
      for (const shortfall of journeyShortfalls(readiness, 'mountain_road_trip')) {
        if (shortfall.owner === 'traveler') expect(shortfall.detail).not.toMatch(/decide|choose/i);
      }
    });
  });

  it('ignores journeys the route does not rest on', () => {
    const readiness = assessJourneyReadiness([journey('walk', 'unknown', { routeCritical: false })], 'self_drive_road_trip');
    expect(readiness.total).toBe(0);
    expect(journeyShortfalls(readiness, 'self_drive_road_trip')).toHaveLength(0);
  });
});
