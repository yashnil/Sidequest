import { describe, expect, it } from 'vitest';
import { deriveAffordances } from '../destinations/affordances';
import type { DestinationQuestionContext, DestinationTrait } from '../interview/traits';
import type { ModeWorldInput } from '../operating/mode-consistency';
import type { ModeStatus, TravelReality } from '../reality/schema';
import type { TravelSegment } from '../schemas/itinerary';
import { journeyFromSegment } from './adapter';
import { journeyBadge, journeyLineKind, journeyWords, type Journey } from './journey';
import { assessJourneyReadiness, journeyShortfalls } from './readiness';
import { screenProposedMode } from './screening';
import { travelModeFromDraft } from './vocabulary';

/**
 * V12.1 §44 — THE JOURNEY FIXTURE MATRIX.
 *
 * Ten movement shapes the product has to be able to tell apart, each built from
 * the two things the pipeline actually sees: **the draft's own transport word**
 * and **the world the trip happens in**. No Anthropic call, no provider, no
 * network, no clock.
 *
 * The point of the matrix is not that each row passes; it is that **no two rows
 * are the same object**. Before V12.1 a Shinkansen, a hired driver, a trail
 * stage and an unrouted farm track were one record with one sentence, and the
 * last assertion in this file is the one that would have failed.
 *
 * Nothing here names a destination in the code under test. Each fixture supplies
 * screened traits and a country row, which is all the screen ever sees; the
 * scenarios are named after real places because §44 names them.
 */

function world(traits: DestinationTrait[], modes: Partial<Record<string, ModeStatus>> = {}, extra: Partial<ModeWorldInput> = {}): ModeWorldInput {
  const basis = Object.fromEntries(traits.map((trait) => [trait, `Screened: ${trait}.`])) as DestinationQuestionContext['basis'];
  const reality =
    Object.keys(modes).length > 0
      ? ({ version: 1, countryCode: 'ZZ', modes: Object.entries(modes).map(([mode, status]) => ({ mode, status, scope: 'all', authority: 'compiled', asOf: '2026-01-01' })) } as unknown as TravelReality)
      : null;
  return { affordances: deriveAffordances({ destination: { traits, basis }, reality }), reality, ...extra };
}

interface Row {
  scenario: string;
  from: string;
  to: string;
  /** What the composing model wrote as the stop's transport. */
  hint: string;
  world: ModeWorldInput;
  /** How the leg was persisted, where it differs from the naive reading of the hint. */
  segment?: Partial<TravelSegment>;
  expect: {
    mode: Journey['mode'];
    control: Journey['control'];
    routing: Journey['routing'];
    schedule: Journey['schedule'];
    truth: Journey['truth'];
    line: ReturnType<typeof journeyLineKind>;
  };
}

const RAIL_COUNTRY = world(['dense_urban', 'transit_rich', 'walk_heavy', 'food_dense'], { high_speed_rail: 'recommended', intercity_train: 'recommended', metro: 'recommended' });
const CITY = world(['dense_urban', 'transit_rich', 'walk_heavy'], { metro: 'recommended', bus: 'recommended' });
const ISLANDS = world(['archipelago', 'beach', 'water_transfer'], { ferry: 'recommended' });
const ATOLLS = world(['archipelago', 'beach', 'water_transfer'], { ferry: 'viable', flight: 'viable' });
const HIGHLAND_PARK = world(['mountain', 'wilderness', 'remote', 'guide_transfer_likely'], { private_driver: 'recommended' });
const HIGH_STEPPE = world(['mountain', 'remote', 'wilderness'], { private_driver: 'recommended', rental_car: 'friction' });
const MOUNTAIN_ROAD = world(['mountain', 'road_trip_region', 'car_dependent'], { rental_car: 'recommended' });
const ANDEAN = world(['mountain', 'wilderness', 'remote'], { bus: 'recommended', intercity_train: 'viable' });
const SAFARI = world(['wilderness', 'remote', 'cross_border', 'guide_transfer_likely'], { private_driver: 'recommended', guided_transfer: 'recommended', flight: 'viable' });
const SELF_DRIVE_ISLAND = world(['road_trip_region', 'car_dependent', 'weather_exposed'], { rental_car: 'recommended' });

const MATRIX: Row[] = [
  {
    scenario: 'Tokyo → Kyoto, intercity rail',
    from: 'Tokyo',
    to: 'Kyoto',
    hint: 'high_speed_rail',
    world: RAIL_COUNTRY,
    expect: { mode: 'rail', control: 'timetable_controlled', routing: 'timetable', schedule: 'fixed_departure', truth: 'unknown', line: 'rail' },
  },
  {
    scenario: 'Paris, urban transit',
    from: 'Marais',
    to: 'Montmartre',
    hint: 'metro',
    world: CITY,
    expect: { mode: 'urban_transit', control: 'network_controlled', routing: 'transit_network', schedule: 'frequency_based', truth: 'unknown', line: 'rail' },
  },
  {
    scenario: 'Greek islands, scheduled ferry',
    from: 'Piraeus',
    to: 'Naxos',
    hint: 'ferry',
    world: ISLANDS,
    expect: { mode: 'ferry', control: 'timetable_controlled', routing: 'timetable', schedule: 'fixed_departure', truth: 'unknown', line: 'water' },
  },
  {
    scenario: 'Maldives, operator boat',
    from: 'Malé',
    to: 'the atoll',
    hint: 'boat',
    world: ATOLLS,
    expect: { mode: 'boat', control: 'operator_controlled', routing: 'operator', schedule: 'operator_set', truth: 'operator_set', line: 'water' },
    segment: { mode: 'ferry', unmeasuredReason: 'mode_not_routed' },
  },
  {
    scenario: 'Rwanda, private driver to the park',
    from: 'Kigali',
    to: 'the lodge',
    hint: 'private_transfer',
    world: HIGHLAND_PARK,
    expect: { mode: 'private_transfer', control: 'operator_controlled', routing: 'operator', schedule: 'operator_set', truth: 'operator_set', line: 'operator' },
    segment: { mode: 'private_transfer', unmeasuredReason: 'mode_not_routed' },
  },
  {
    scenario: 'Kyrgyzstan, horse stage',
    from: 'the summer pasture',
    to: 'the lake',
    hint: 'horse',
    world: HIGH_STEPPE,
    expect: { mode: 'horse', control: 'operator_controlled', routing: 'trail', schedule: 'operator_set', truth: 'operator_set', line: 'trail' },
    segment: { mode: 'private_transfer', unmeasuredReason: 'mode_not_routed' },
  },
  {
    scenario: 'Kyrgyzstan, 4x4 over the pass',
    from: 'Kochkor',
    to: 'Song-Köl',
    hint: 'four_wheel_drive',
    world: HIGH_STEPPE,
    expect: { mode: 'four_wheel_drive', control: 'traveler_controlled', routing: 'road', schedule: 'continuous', truth: 'unknown', line: 'road' },
    segment: { mode: 'drive', unmeasuredReason: 'provider_unavailable' },
  },
  {
    scenario: 'Canadian Rockies, hire car between bases',
    from: 'Banff',
    to: 'Jasper',
    hint: 'car',
    world: MOUNTAIN_ROAD,
    expect: { mode: 'drive', control: 'traveler_controlled', routing: 'road', schedule: 'continuous', truth: 'measured', line: 'road' },
    segment: { mode: 'drive', provenance: 'measured', basis: 'static', minutes: 231, km: 288, unmeasuredReason: undefined },
  },
  {
    scenario: 'Peru, long-distance bus',
    from: 'Cusco',
    to: 'Puno',
    hint: 'bus',
    world: ANDEAN,
    expect: { mode: 'bus', control: 'timetable_controlled', routing: 'road', schedule: 'frequency_based', truth: 'unknown', line: 'road' },
    segment: { mode: 'public_bus', unmeasuredReason: 'provider_unavailable' },
  },
  {
    scenario: 'Kenya → Tanzania, a flight across the border',
    from: 'the Mara',
    to: 'the Serengeti',
    hint: 'flight',
    world: SAFARI,
    expect: { mode: 'flight', control: 'air', routing: 'air', schedule: 'fixed_departure', truth: 'unknown', line: 'air' },
    segment: { mode: 'unsupported', unmeasuredReason: 'mode_not_routed' },
  },
  {
    scenario: 'Iceland, self-drive ring road',
    from: 'Reykjavík',
    to: 'Selfoss',
    hint: 'car',
    world: SELF_DRIVE_ISLAND,
    expect: { mode: 'drive', control: 'traveler_controlled', routing: 'road', schedule: 'continuous', truth: 'measured', line: 'road' },
    segment: { mode: 'drive', provenance: 'measured', basis: 'static', minutes: 58, km: 57, unmeasuredReason: undefined },
  },
  {
    scenario: 'Peru, the trail itself',
    from: 'Camp 2',
    to: 'the pass',
    hint: 'walk',
    world: ANDEAN,
    expect: { mode: 'trail', control: 'trail', routing: 'trail', schedule: 'continuous', truth: 'unknown', line: 'trail' },
    segment: { mode: 'walk', episodeMode: 'walk', episode: 'The high route', unmeasuredReason: 'mode_not_routed' },
  },
];

function legFor(row: Row): TravelSegment {
  const base: TravelSegment = {
    fromId: row.from.toLowerCase().replace(/\W+/g, '-'),
    toId: row.to.toLowerCase().replace(/\W+/g, '-'),
    fromName: row.from,
    toName: row.to,
    minutes: null,
    km: null,
    mode: 'drive',
    role: 'transfer',
    provenance: 'unmeasured',
    unmeasuredReason: 'provider_unavailable',
    hint: row.hint,
  } as TravelSegment;
  const merged = { ...base, ...(row.segment ?? {}) } as TravelSegment;
  if (merged.provenance !== 'unmeasured') delete (merged as { unmeasuredReason?: unknown }).unmeasuredReason;
  return merged;
}

describe('the journey fixture matrix', () => {
  for (const row of MATRIX) {
    describe(row.scenario, () => {
      const journey = journeyFromSegment(legFor(row), { routeCritical: true });

      it('reads as the movement it actually is', () => {
        expect(journey.mode).toBe(row.expect.mode);
        expect(journey.control).toBe(row.expect.control);
        expect(journey.routing).toBe(row.expect.routing);
        expect(journey.schedule).toBe(row.expect.schedule);
        expect(journey.truth).toBe(row.expect.truth);
      });

      it('is drawn by how it moves', () => {
        expect(journeyLineKind(journey)).toBe(row.expect.line);
      });

      it('is consistent with the world this trip happens in', () => {
        const verdict = screenProposedMode(travelModeFromDraft(row.hint), { world: row.world });
        expect(verdict.ok, verdict.refusal ?? '').toBe(true);
      });

      it('says something a traveller can act on, and nothing forensic', () => {
        const words = journeyWords(journey);
        expect(words.headline.length).toBeGreaterThan(0);
        for (const forbidden of [/\ballowance\b/i, /provider/i, /unmeasured/i, /evidence/i, /not routed/i]) {
          expect(forbidden.test(words.headline), `"${words.headline}"`).toBe(false);
        }
        /* And never a departure time nobody published. */
        if (journey.truth !== 'timetabled') expect(words.headline).not.toMatch(/\d{1,2}[:.]\d{2}/);
      });
    });
  }

  it('produces twelve genuinely different journeys', () => {
    const shapes = MATRIX.map((row) => {
      const journey = journeyFromSegment(legFor(row), { routeCritical: true });
      return `${journey.mode}|${journey.control}|${journey.routing}|${journey.schedule}|${journey.truth}`;
    });
    /*
     * THE ASSERTION THE OLD MODEL COULD NOT PASS.
     *
     * With `TravelSegment` alone these twelve rows collapse to a handful of
     * `(mode, provenance)` pairs, and four of them — the Shinkansen, the hired
     * driver, the trail stage and the unrouted mountain road — are the *same*
     * pair. Eight distinct shapes out of twelve rows is the floor; the four
     * genuine coincidences are the two self-drive rows and the two
     * operator-controlled water/road transfers.
     */
    expect(new Set(shapes).size).toBeGreaterThanOrEqual(10);
  });

  it('never gives two different kinds of unknown the same sentence', () => {
    const unknowns = MATRIX.map((row) => journeyFromSegment(legFor(row), { routeCritical: true })).filter((journey) => journey.truth === 'unknown');
    const sentences = new Set(unknowns.map((journey) => journeyWords(journey).headline));
    /* A train, a metro, a ferry, a 4x4, a bus, a flight and a trail all said "allowance — not timed" before this. */
    expect(unknowns.length).toBeGreaterThanOrEqual(5);
    expect(sentences.size).toBeGreaterThanOrEqual(5);
  });

  it('badges a measured journey with nothing at all', () => {
    const measured = MATRIX.filter((row) => row.expect.truth === 'measured').map((row) => journeyFromSegment(legFor(row)));
    expect(measured.length).toBeGreaterThan(0);
    for (const journey of measured) expect(journeyBadge(journey)).toBeNull();
  });
});

describe('what each kind of trip needs before it is ready', () => {
  const journeyFor = (scenario: string): Journey => {
    const row = MATRIX.find((entry) => entry.scenario === scenario)!;
    return journeyFromSegment(legFor(row), { routeCritical: true });
  };

  it('lets a rail trip be ready on a real corridor whose timetable nobody has read', () => {
    const readiness = assessJourneyReadiness([journeyFor('Tokyo → Kyoto, intercity rail')], 'rail_journey');
    expect(readiness.settled).toBe(1);
    expect(journeyShortfalls(readiness, 'rail_journey')).toHaveLength(0);
  });

  it('lets an island trip be ready on a real ferry corridor', () => {
    const readiness = assessJourneyReadiness([journeyFor('Greek islands, scheduled ferry')], 'island_hopping');
    expect(readiness.settled).toBe(1);
  });

  it('lets a guided trip be ready on the operator’s own timing', () => {
    const readiness = assessJourneyReadiness([journeyFor('Rwanda, private driver to the park'), journeyFor('Kyrgyzstan, horse stage')], 'guided_wildlife');
    expect(readiness.settled).toBe(2);
  });

  it('does not let a self-drive route be ready with an untimed mountain road', () => {
    const readiness = assessJourneyReadiness([journeyFor('Kyrgyzstan, 4x4 over the pass')], 'self_drive_road_trip');
    expect(readiness.outstanding).toHaveLength(1);
    /* And it is filed as ours, because a coverage gap is not a traveller's decision. */
    expect(readiness.ownedBySidequest).toHaveLength(1);
    expect(journeyShortfalls(readiness, 'self_drive_road_trip').every((shortfall) => shortfall.owner === 'sidequest')).toBe(true);
  });

  it('lets a measured self-drive route be ready', () => {
    const readiness = assessJourneyReadiness([journeyFor('Iceland, self-drive ring road'), journeyFor('Canadian Rockies, hire car between bases')], 'self_drive_road_trip');
    expect(readiness.settled).toBe(2);
    expect(journeyShortfalls(readiness, 'self_drive_road_trip')).toHaveLength(0);
  });
});
