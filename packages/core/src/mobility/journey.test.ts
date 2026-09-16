import { describe, expect, it } from 'vitest';
import type { TravelSegment } from '../schemas/itinerary';
import { journeyFromSegment, travelModeOfSegment } from './adapter';
import {
  controlForMode,
  departureIsSomebodyElses,
  journeyNeedsTravelerAction,
  journeyWords,
  routingForMode,
  scheduleForMode,
  silenceIsMeaningless,
  type Journey,
} from './journey';
import { TRAVEL_MODES } from './vocabulary';

const leg = (over: Partial<TravelSegment> = {}): TravelSegment =>
  ({
    fromId: 'a',
    toId: 'b',
    fromName: 'Tokyo',
    toName: 'Kyoto',
    minutes: null,
    km: null,
    mode: 'rail',
    role: 'transfer',
    provenance: 'unmeasured',
    unmeasuredReason: 'mode_not_routed',
    ...over,
  }) as TravelSegment;

const journey = (over: Partial<Journey>): Journey => ({ ...journeyFromSegment(leg()), ...over });

describe('the Journey model', () => {
  it('gives every mode all three semantic axes', () => {
    for (const mode of TRAVEL_MODES) {
      expect(controlForMode(mode)).toBeDefined();
      expect(routingForMode(mode)).toBeDefined();
      expect(scheduleForMode(mode)).toBeDefined();
    }
  });

  /**
   * §3's own worked example: four journeys that must be structurally different
   * objects, not four labels on the same one.
   */
  it('makes a Shinkansen, a hire car, a hired driver and a trail stage four different things', () => {
    const shinkansen = journeyFromSegment(leg({ hint: 'high_speed_rail' }));
    const hireCar = journeyFromSegment(leg({ mode: 'drive', hint: 'car', fromName: 'Banff', toName: 'Jasper' }));
    const driver = journeyFromSegment(leg({ mode: 'private_transfer', hint: 'private_transfer', fromName: 'Karakol', toName: 'Song-Köl' }));
    const trail = journeyFromSegment(leg({ mode: 'walk', hint: 'walk', episodeMode: 'walk', fromName: 'Camp 1', toName: 'Ala-Köl' }));

    expect(shinkansen.control).toBe('timetable_controlled');
    expect(hireCar.control).toBe('traveler_controlled');
    expect(driver.control).toBe('operator_controlled');
    expect(trail.control).toBe('trail');

    expect(shinkansen.routing).toBe('timetable');
    expect(hireCar.routing).toBe('road');
    expect(driver.routing).toBe('operator');
    expect(trail.routing).toBe('trail');

    expect(shinkansen.schedule).toBe('fixed_departure');
    expect(hireCar.schedule).toBe('continuous');
    expect(driver.schedule).toBe('operator_set');
    expect(trail.schedule).toBe('continuous');

    /* And the four sentences a traveller reads are four sentences. */
    const words = [shinkansen, hireCar, driver, trail].map((entry) => journeyWords(entry).headline);
    expect(new Set(words).size).toBe(4);
  });

  it('reads the hint before the lossy persisted label', () => {
    expect(travelModeOfSegment(leg({ mode: 'private_transfer', hint: 'horse' }))).toBe('horse');
    expect(travelModeOfSegment(leg({ mode: 'drive', hint: 'four_wheel_drive' }))).toBe('four_wheel_drive');
    expect(travelModeOfSegment(leg({ mode: 'ferry', hint: 'boat' }))).toBe('boat');
    /* And falls back cleanly when there is no hint — the shape of an old stored trip. */
    expect(travelModeOfSegment({ mode: 'drive' } as TravelSegment)).toBe('drive');
  });

  it('reads an episode mode when the stop names no transport of its own', () => {
    expect(travelModeOfSegment(leg({ mode: 'walk', episodeMode: 'boat' }))).toBe('boat');
  });

  describe('truth states', () => {
    it('calls a router measurement measured', () => {
      expect(journeyFromSegment(leg({ mode: 'drive', provenance: 'measured', basis: 'static', minutes: 96, km: 120, unmeasuredReason: undefined })).truth).toBe('measured');
    });

    it('calls a published timetable timetabled', () => {
      expect(journeyFromSegment(leg({ provenance: 'official', minutes: 135, unmeasuredReason: undefined })).truth).toBe('timetabled');
      expect(journeyFromSegment(leg({ mode: 'rail', provenance: 'measured', basis: 'scheduled', minutes: 135, unmeasuredReason: undefined })).truth).toBe('timetabled');
    });

    it('calls an operator-owned movement operator_set rather than unknown', () => {
      const transfer = journeyFromSegment(leg({ mode: 'private_transfer', hint: 'guide_or_lodge_transfer', unmeasuredReason: 'mode_not_routed' }));
      expect(transfer.truth).toBe('operator_set');
      expect(transfer.booking).toBe('operator');
    });

    it('calls Sidequest’s own figure estimated', () => {
      expect(journeyFromSegment(leg({ mode: 'drive', provenance: 'estimated', estimateKind: 'geo', minutes: 80, unmeasuredReason: undefined })).truth).toBe('estimated');
    });

    it('never promotes a stand-in duration to a measurement', () => {
      /* A measured walk standing in for a rail journey is an estimate of the rail journey, whatever it measured. */
      const standIn = journeyFromSegment(leg({ mode: 'walk', provenance: 'modelled', unverifiedScheduled: true, minutes: 200, unmeasuredReason: undefined }));
      expect(standIn.truth).toBe('estimated');
    });

    it('keeps unknown separate from contradicted', () => {
      const unknown = journeyFromSegment(leg({ mode: 'ferry', hint: 'ferry', unmeasuredReason: 'mode_not_routed' }));
      expect(unknown.truth).toBe('unknown');
      expect(unknown.contradiction).toBeUndefined();

      const refused = journeyFromSegment(leg({ mode: 'ferry', hint: 'ferry' }), { contradiction: 'The operator lists no winter sailings on this route.' });
      expect(refused.truth).toBe('contradicted');
    });

    it('does not turn a provider’s no-route into a contradiction on its own', () => {
      /* V9.1: a verdict needs two resolved endpoints on the requested profile, which a stored leg cannot attest. */
      const noRoute = journeyFromSegment(leg({ mode: 'drive', hint: 'car', unmeasuredReason: 'no_route_found' }));
      expect(noRoute.truth).toBe('unknown');
      expect(noRoute.unknownReason).toBe('provider_did_not_answer');
    });

    it('records our own coverage gap as ours', () => {
      expect(journeyFromSegment(leg({ mode: 'drive', hint: 'car', unmeasuredReason: 'provider_unavailable' })).unknownReason).toBe('outside_provider_coverage');
      expect(journeyFromSegment(leg({ mode: 'ferry', hint: 'ferry' }), { providerCanMeasureMode: false }).unknownReason).toBe('no_provider_for_mode');
    });
  });

  describe('what a traveller reads (§19)', () => {
    const FORBIDDEN = [/provider unsupported/i, /\ballowance\b/i, /operator-timed/i, /evidence insufficient/i, /\bunmeasured\b/i, /not routed/i, /\bprovenance\b/i];

    it('never puts a forensic word in a headline, for any mode in any truth state', () => {
      for (const mode of TRAVEL_MODES) {
        for (const truth of ['measured', 'timetabled', 'operator_set', 'estimated', 'unknown', 'contradicted'] as const) {
          const words = journeyWords(journey({ mode, truth, control: controlForMode(mode), routing: routingForMode(mode), schedule: scheduleForMode(mode), minutes: truth === 'unknown' ? null : 95 }));
          for (const pattern of FORBIDDEN) {
            expect(pattern.test(words.headline), `${mode}/${truth} produced "${words.headline}"`).toBe(false);
          }
        }
      }
    });

    it('says “schedule to confirm” for a train nobody has timed, not “allowance”', () => {
      const words = journeyWords(journeyFromSegment(leg({ hint: 'high_speed_rail' })));
      expect(words.headline).toBe('Train · schedule to confirm');
    });

    it('says who arranges an operator journey', () => {
      const words = journeyWords(journeyFromSegment(leg({ mode: 'private_transfer', hint: 'guide_or_lodge_transfer' })));
      expect(words.headline).toMatch(/arranged/i);
    });

    it('never invents a departure time', () => {
      const words = journeyWords(journeyFromSegment(leg({ hint: 'rail' })));
      expect(words.headline).not.toMatch(/\d{1,2}[:.]\d{2}/);
      expect(words.detail ?? '').not.toMatch(/\d{1,2}[:.]\d{2}/);
    });

    it('prints a duration only when there is one', () => {
      expect(journeyWords(journeyFromSegment(leg({ mode: 'drive', hint: 'car', provenance: 'measured', basis: 'static', minutes: 135, km: 180, unmeasuredReason: undefined }))).headline).toBe('Drive · ~2h15');
    });
  });

  describe('what follows from control', () => {
    it('knows whose departure it is', () => {
      expect(departureIsSomebodyElses(journey({ control: 'timetable_controlled' }))).toBe(true);
      expect(departureIsSomebodyElses(journey({ control: 'operator_controlled' }))).toBe(true);
      expect(departureIsSomebodyElses(journey({ control: 'traveler_controlled' }))).toBe(false);
      expect(departureIsSomebodyElses(journey({ control: 'trail' }))).toBe(false);
    });

    it('knows when a road router’s silence says nothing', () => {
      expect(silenceIsMeaningless(journey({ routing: 'timetable' }))).toBe(true);
      expect(silenceIsMeaningless(journey({ routing: 'trail' }))).toBe(true);
      expect(silenceIsMeaningless(journey({ routing: 'road' }))).toBe(false);
    });

    it('never turns our own failure to measure into a traveller’s task (§22)', () => {
      const untimedDrive = journeyFromSegment(leg({ mode: 'drive', hint: 'car', unmeasuredReason: 'provider_unavailable' }));
      expect(journeyNeedsTravelerAction(untimedDrive)).toBe(false);
      const untimedTrail = journeyFromSegment(leg({ mode: 'walk', hint: 'walk', episodeMode: 'walk' }));
      expect(journeyNeedsTravelerAction(untimedTrail)).toBe(false);
    });

    it('does raise a reservation the traveller has to make', () => {
      const reserved = journeyFromSegment(leg({ hint: 'high_speed_rail' }), { reservation: 'required' });
      expect(journeyNeedsTravelerAction(reserved)).toBe(true);
    });
  });

  it('never puts water or rail kilometres on the day’s road total', () => {
    expect(journeyFromSegment(leg({ mode: 'ferry', hint: 'ferry', provenance: 'estimated', minutes: 90, km: 60, unmeasuredReason: undefined })).km).toBeNull();
    expect(journeyFromSegment(leg({ mode: 'rail', hint: 'rail', provenance: 'official', minutes: 135, km: 460, unmeasuredReason: undefined })).km).toBeNull();
    expect(journeyFromSegment(leg({ mode: 'drive', hint: 'car', provenance: 'measured', basis: 'static', minutes: 96, km: 120, unmeasuredReason: undefined })).km).toBe(120);
  });

  it('never carries a duration for a journey nobody could time', () => {
    const unknown = journeyFromSegment(leg({ hint: 'ferry' }));
    expect(unknown.minutes).toBeNull();
  });
});
