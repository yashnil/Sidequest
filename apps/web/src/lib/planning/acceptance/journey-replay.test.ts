import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveAffordances,
  journeyBadge,
  journeyFromSegment,
  journeyLineKind,
  journeyWords,
  screenProposedMode,
  travelModeFromDraft,
  travelModeOfSegment,
  type DestinationQuestionContext,
  type DestinationTrait,
  type Journey,
  type ModeStatus,
  type ModeWorldInput,
  type TravelReality,
  type TravelSegment,
} from '@sidequest/core';

/**
 * V12.1 §52 §53 — THE FIVE LIVE TRIPS, REPLAYED THROUGH THE JOURNEY MODEL.
 *
 * ── WHY THESE FILES AND NOT FIXTURES ────────────────────────────────────────
 *
 * Every trip here was composed by a real model call and persisted in full:
 * Kyrgyzstan and the Canadian Rockies from V11 §S, and Peru, the Maldives and
 * Rwanda from V12 §55–§57. Their day rows are on disk, legs and all, which means
 * this replays **what actually shipped** rather than what a fixture author
 * believed shipped. §52 and §53 both ask for exactly that, and neither costs a
 * model call: the itinerary is already written.
 *
 * ── WHAT IS BEING ASSERTED ──────────────────────────────────────────────────
 *
 * Not that the plans changed — they did not; the stored rows are untouched. That the
 * **reading** of them changed:
 *
 *   Rockies      three ferry legs in a landlocked mountain park are refused
 *   Kyrgyzstan   the horse stage and the 4x4 legs stop being "private transfer"
 *                and "drive", and the expedition modes survive
 *   Iceland      a self-drive plan stays a self-drive plan
 *   Peru         bus and rail are scheduled journeys, not untimed road legs
 *   Maldives     the boat and the flight are operator and air, not ferries and
 *                a modelling gap
 *   Rwanda       the guide's transfers are operator-set, not unknown
 *
 * and that nothing in any of them regressed into a sentence §19 forbids.
 */

const DUMPS = '.claude-private/artifacts';

interface StoredDay {
  day_number: number;
  items: { kind: string; item_json: { travel?: TravelSegment; title?: string } }[];
}

function legsOf(dump: string): TravelSegment[] {
  const days = JSON.parse(readFileSync(`${DUMPS}/${dump}/days.json`, 'utf8')) as StoredDay[];
  return days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.item_json.travel).map((item) => item.item_json.travel!));
}

function journeysOf(dump: string): Journey[] {
  return legsOf(dump).map((segment) => journeyFromSegment(segment, { routeCritical: segment.role === 'transfer' }));
}

function world(traits: DestinationTrait[], modes: Partial<Record<string, ModeStatus>> = {}): ModeWorldInput {
  const basis = Object.fromEntries(traits.map((trait) => [trait, `Screened: ${trait}.`])) as DestinationQuestionContext['basis'];
  const reality =
    Object.keys(modes).length > 0
      ? ({ version: 1, countryCode: 'ZZ', modes: Object.entries(modes).map(([mode, status]) => ({ mode, status, scope: 'all', authority: 'compiled', asOf: '2026-01-01' })) } as unknown as TravelReality)
      : null;
  return { affordances: deriveAffordances({ destination: { traits, basis }, reality }), reality };
}

const FORBIDDEN = [/\ballowance\b/i, /provider/i, /\bunmeasured\b/i, /evidence insufficient/i, /not routed/i, /operator-timed/i];

/** Every replayed trip has to clear this. */
function assertTravellerSafe(journeys: readonly Journey[]): void {
  for (const journey of journeys) {
    const words = journeyWords(journey);
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(words.headline), `"${words.headline}" (${journey.origin.name} → ${journey.destination.name})`).toBe(false);
    }
    /* And never a duration for a journey nobody could time. */
    if (journey.truth === 'unknown') expect(journey.minutes, `${journey.origin.name} → ${journey.destination.name}`).toBeNull();
  }
}

describe('V11 founder trips, replayed (§53)', () => {
  describe('the Canadian Rockies', () => {
    const legs = legsOf('v11/live/rockies-dump');
    const journeys = journeysOf('v11/live/rockies-dump');

    it('still loads every leg it shipped with', () => {
      expect(legs).toHaveLength(27);
      expect(journeys).toHaveLength(27);
    });

    it('preserves the three phantom ferry legs in the stored plan, unchanged', () => {
      /* The defect is the *input* to this test. Nothing rewrites the stored row. */
      const ferries = legs.filter((leg) => leg.mode === 'ferry');
      expect(ferries).toHaveLength(3);
      expect(ferries.every((leg) => leg.hint === 'boat')).toBe(true);
    });

    it('refuses every one of them against the screened ground', () => {
      /* Screened as a mountain road-trip region that depends on a car, with no water among the traits. */
      const rockies = world(['mountain', 'road_trip_region', 'car_dependent'], { rental_car: 'recommended' });
      for (const leg of legs.filter((entry) => entry.hint === 'boat')) {
        const verdict = screenProposedMode(travelModeFromDraft(leg.hint), { world: rockies });
        expect(verdict.ok, `${leg.fromName} → ${leg.toName}`).toBe(false);
        expect(verdict.refusedBy).toBe('world');
      }
    });

    it('would refuse the leg between a lake and its own lakeshore on geometry alone', () => {
      const shore = legs.find((leg) => leg.fromName === leg.toName || /lakeshore/i.test(leg.toName));
      expect(shore, 'the Lake Louise lakeshore leg is in this dump').toBeTruthy();
      const verdict = screenProposedMode('boat', { world: world(['mountain', 'road_trip_region']), straightLineKm: 0.6 });
      expect(verdict.ok).toBe(false);
    });

    it('keeps the one measured drive a measured drive', () => {
      const measured = journeys.filter((journey) => journey.truth === 'measured');
      expect(measured).toHaveLength(1);
      expect(measured[0]!.mode).toBe('drive');
      expect(journeyBadge(measured[0]!)).toBeNull();
    });

    it('never puts a forensic word in front of a traveller', () => assertTravellerSafe(journeys));
  });

  describe('Kyrgyzstan', () => {
    const legs = legsOf('v11/live/kyrgyzstan-dump');
    const journeys = journeysOf('v11/live/kyrgyzstan-dump');

    it('still loads every leg it shipped with', () => {
      expect(journeys).toHaveLength(28);
    });

    it('recovers the horse stage the persisted label had folded into a private transfer', () => {
      const horse = legs.find((leg) => leg.hint === 'horse');
      expect(horse, 'the horse leg is in this dump').toBeTruthy();
      expect(horse!.mode).toBe('private_transfer');
      /* Stored as a private transfer; read as a horse. */
      expect(travelModeOfSegment(horse!)).toBe('horse');
      const journey = journeyFromSegment(horse!);
      expect(journey.routing).toBe('trail');
      expect(journeyLineKind(journey)).toBe('trail');
    });

    it('recovers the four-wheel-drive legs the persisted label had folded into ordinary driving', () => {
      const rough = legs.filter((leg) => leg.hint === 'four_wheel_drive');
      expect(rough.length).toBe(4);
      for (const leg of rough) {
        expect(leg.mode).toBe('drive');
        expect(travelModeOfSegment(leg)).toBe('four_wheel_drive');
      }
    });

    it('keeps the expedition modes rather than flattening them to road travel', () => {
      const modes = new Set(journeys.map((journey) => journey.mode));
      expect(modes.has('horse')).toBe(true);
      expect(modes.has('four_wheel_drive')).toBe(true);
      /* And nothing gained a mode the trip never used. */
      expect(modes.has('ferry')).toBe(false);
      expect(modes.has('rail')).toBe(false);
      expect(modes.has('flight')).toBe(false);
    });

    it('never claims a train on ground that screened as roads and high pasture', () => {
      const steppe = world(['mountain', 'remote', 'wilderness', 'car_dependent'], { private_driver: 'recommended', rental_car: 'friction' });
      expect(screenProposedMode('rail', { world: steppe }).ok).toBe(false);
      expect(screenProposedMode('ferry', { world: steppe }).ok).toBe(false);
      /* And the modes it does use are never refused. */
      for (const mode of ['drive', 'four_wheel_drive', 'horse', 'private_transfer', 'walk', 'trail'] as const) {
        expect(screenProposedMode(mode, { world: steppe }).ok, mode).toBe(true);
      }
    });

    it('never puts a forensic word in front of a traveller', () => assertTravellerSafe(journeys));
  });

  describe('Iceland, self-drive', () => {
    it('stays a self-drive plan: no mode the trip does not use is admitted', () => {
      /* Screened as a weather-exposed road-trip region that depends on a car. */
      const iceland = world(['road_trip_region', 'car_dependent', 'weather_exposed'], { rental_car: 'recommended', self_drive: 'recommended' });
      for (const mode of ['drive', 'walk', 'four_wheel_drive'] as const) expect(screenProposedMode(mode, { world: iceland }).ok, mode).toBe(true);
      /* Nothing screened here says trains, so a rail leg would be a journey nobody can take. */
      expect(screenProposedMode('rail', { world: iceland }).ok).toBe(false);
    });

    it('keeps a coastal drive a drive rather than reading the sea beside it as a crossing', () => {
      const iceland = world(['road_trip_region', 'car_dependent', 'weather_exposed'], { rental_car: 'recommended' });
      expect(screenProposedMode('ferry', { world: iceland }).ok).toBe(false);
    });
  });
});

describe('V12 live trips, replayed (§52)', () => {
  describe('Peru — a backpacking route', () => {
    const journeys = journeysOf('v12/live/backpacking-dump');

    it('still loads every leg it shipped with', () => {
      expect(journeys).toHaveLength(33);
    });

    it('reads its buses and trains as scheduled journeys rather than untimed road legs', () => {
      const bus = journeys.filter((journey) => journey.mode === 'bus');
      const rail = journeys.filter((journey) => journey.mode === 'rail');
      /* Six the draft hinted, plus one persisted as `public_bus` with no hint of its own. */
      expect(bus.length).toBe(7);
      expect(rail.length).toBe(2);
      for (const journey of bus) expect(journey.control).toBe('timetable_controlled');
      for (const journey of rail) {
        expect(journey.control).toBe('timetable_controlled');
        expect(journey.routing).toBe('timetable');
        expect(journeyLineKind(journey)).toBe('rail');
      }
    });

    it('tells the rail legs apart from the bus legs and from the walks', () => {
      const headlines = new Set(journeys.map((journey) => journeyWords(journey).headline));
      expect(headlines.size).toBeGreaterThanOrEqual(3);
    });

    it('never invents a departure time for a train whose timetable nobody read', () => {
      for (const journey of journeys.filter((entry) => entry.mode === 'rail' && entry.truth === 'unknown')) {
        const words = journeyWords(journey);
        expect(words.headline).toMatch(/schedule to confirm/i);
        expect(words.headline).not.toMatch(/\d{1,2}[:.]\d{2}/);
      }
    });

    it('never puts a forensic word in front of a traveller', () => assertTravellerSafe(journeys));
  });

  describe('the Maldives — a resort week', () => {
    const legs = legsOf('v12/live/resort-dump');
    const journeys = journeysOf('v12/live/resort-dump');

    it('still loads every leg it shipped with', () => {
      expect(journeys).toHaveLength(20);
    });

    it('reads the operator boats as the operator’s own journeys', () => {
      const boats = journeys.filter((journey) => journey.mode === 'boat');
      expect(boats.length).toBe(2);
      for (const journey of boats) {
        expect(journey.control).toBe('operator_controlled');
        expect(journey.truth).toBe('operator_set');
        expect(journeyLineKind(journey)).toBe('water');
        expect(journeyWords(journey).headline).toMatch(/arranged/i);
      }
    });

    it('reads the flight as a flight rather than as a modelling gap', () => {
      /* Stored as `mode: "unsupported"` — the value that made a flight and "we do not model this" the same object. */
      const stored = legs.find((leg) => leg.hint === 'flight');
      expect(stored!.mode).toBe('unsupported');
      const journey = journeyFromSegment(stored!);
      expect(journey.mode).toBe('flight');
      expect(journey.control).toBe('air');
      expect(journeyLineKind(journey)).toBe('air');
    });

    it('keeps the ferries it has, because this ground depends on crossing water', () => {
      const atolls = world(['archipelago', 'beach', 'water_transfer'], { ferry: 'viable' });
      expect(screenProposedMode('ferry', { world: atolls }).ok).toBe(true);
      expect(screenProposedMode('boat', { world: atolls }).ok).toBe(true);
    });

    it('never puts a forensic word in front of a traveller', () => assertTravellerSafe(journeys));
  });

  describe('Rwanda — a guided wildlife trip', () => {
    const legs = legsOf('v12/live/wildlife-dump');
    const journeys = journeysOf('v12/live/wildlife-dump');

    it('still loads every leg it shipped with', () => {
      expect(journeys).toHaveLength(23);
    });

    it('reads the guide’s transfers as the operator’s own timing rather than as an unknown', () => {
      const transfers = journeys.filter((journey) => journey.mode === 'operator_transfer');
      expect(transfers.length).toBe(2);
      for (const journey of transfers) {
        expect(journey.truth).toBe('operator_set');
        expect(journey.booking).toBe('operator');
        expect(journeyWords(journey).headline).toMatch(/arranged/i);
      }
    });

    it('recovers the four-wheel-drive legs from a persisted plain "drive"', () => {
      const rough = legs.filter((leg) => leg.hint === 'four_wheel_drive');
      expect(rough.length).toBe(5);
      for (const leg of rough) expect(travelModeOfSegment(leg)).toBe('four_wheel_drive');
    });

    it('never gains water on ground screened as inland wilderness', () => {
      const inland = world(['wilderness', 'remote', 'mountain', 'guide_transfer_likely'], { private_driver: 'recommended', guided_transfer: 'recommended' });
      expect(screenProposedMode('ferry', { world: inland }).ok).toBe(false);
      expect(screenProposedMode('private_transfer', { world: inland }).ok).toBe(true);
      expect(screenProposedMode('operator_transfer', { world: inland }).ok).toBe(true);
    });

    it('never puts a forensic word in front of a traveller', () => assertTravellerSafe(journeys));
  });
});

describe('across all five, nothing regressed', () => {
  const ALL = ['v11/live/rockies-dump', 'v11/live/kyrgyzstan-dump', 'v12/live/backpacking-dump', 'v12/live/resort-dump', 'v12/live/wildlife-dump'];

  it('reads every stored leg without throwing', () => {
    let total = 0;
    for (const dump of ALL) total += journeysOf(dump).length;
    expect(total).toBe(27 + 28 + 33 + 20 + 23);
  });

  it('gives every journey a mode, a control, a routing and a truth', () => {
    for (const dump of ALL) {
      for (const journey of journeysOf(dump)) {
        expect(journey.mode, dump).toBeTruthy();
        expect(journey.control, dump).toBeTruthy();
        expect(journey.routing, dump).toBeTruthy();
        expect(journey.truth, dump).toBeTruthy();
      }
    }
  });

  it('never shows a duration for a journey nobody could time, on any of them', () => {
    for (const dump of ALL) {
      for (const journey of journeysOf(dump)) {
        if (journey.truth === 'unknown') expect(journey.minutes, dump).toBeNull();
      }
    }
  });

  it('never says a road distance for a journey that puts none on a vehicle', () => {
    for (const dump of ALL) {
      for (const journey of journeysOf(dump)) {
        if (journey.mode === 'ferry' || journey.mode === 'boat' || journey.mode === 'rail' || journey.mode === 'flight') expect(journey.km, dump).toBeNull();
      }
    }
  });
});
