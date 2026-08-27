import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_SET_VERSION,
  SCHEDULED_STOP_KINDS,
  SCHEDULED_STOP_OBSERVATION_VERSION,
  scheduledNetworkFrom,
  type ClarificationSet,
  type CompiledRegion,
} from '@sidequest/core';
import { compileRegion } from './compile';
import { deriveScope } from './scope';
import { classifySourceCategory } from './backbone/taxonomy';
import {
  SYNTHETIC_WORLDS,
  fakeProviders,
  syntheticCandidate,
  type SyntheticWorldSpec,
} from './testing/fakes';
import { packBackedProviders } from './testing/pack-fakes';

/**
 * THE ARTIFACT CARRIES THE KIND-AWARE SCHEDULED-STOP OBSERVATION.
 *
 * The gap this closes, in one sentence: the verdict machinery in
 * `travel/reach.ts` refuses to soften a walking verdict unless the destination
 * evidence *observes* a scheduled network, and until this persistence existed
 * no compiled artifact recorded that observation — the stations sat in the
 * region pack, the pack is not shipped to the live path, and the artifact's own
 * gateway counts are kinds-blind (an airport and a rail station are the same
 * number). So the honest-unknown fix was dead code on every stored trip.
 *
 * Three states, all asserted here because all three are load-bearing:
 *
 *   1. a pack with stations → the artifact counts them **by kind**;
 *   2. a pack with none → the artifact persists an honest zero, which reads as
 *      'not_observed' — evidence read, nothing there;
 *   3. no pack at all → the field is absent, which reads as nobody-said, and
 *      must never be conflated with the zero.
 *
 * Offline throughout: synthetic worlds, no provider, no network, no money.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const MONTHS = [8];

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

/** The stop records the served world's pack publishes, deliberately mixed-kind. */
const SERVED_STOPS = {
  railway_station: 3,
  train_station: 1,
  bus_station: 2,
} as const;

async function compileWorld(
  spec: SyntheticWorldSpec,
  options: { throughPack?: boolean } = {},
): Promise<CompiledRegion> {
  const scope = deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: emptyClarifications(),
    nights: DATES.length,
    revision: 1,
  });
  const result = await compileRegion({
    compilationId: `stops-${spec.id}`,
    scope,
    dates: [...DATES],
    months: MONTHS,
    providers:
      options.throughPack === false ? fakeProviders(spec) : packBackedProviders(spec),
    now: NOW,
  });
  if (!result.ok) {
    throw new Error(
      `The ${spec.id} world did not compile: ${result.code} — ${result.message}.`,
    );
  }
  return result.region;
}

describe('a pack whose ground records stations', () => {
  it('persists the count by kind, not as one blind number', async () => {
    const region = await compileWorld({
      ...SYNTHETIC_WORLDS.transit_city!,
      id: 'transit-city-stops',
      scheduledStopRecords: SERVED_STOPS,
    });

    expect(
      region.scheduledStops,
      'the artifact carries no scheduled-stop observation at all',
    ).toBeDefined();
    expect(region.scheduledStops!.version).toBe(SCHEDULED_STOP_OBSERVATION_VERSION);
    /*
     * Exact by-kind equality, because kinds-blindness is the regression under
     * test: a persistence that summed these into six would pass any assertion
     * on the total and fail this one.
     */
    expect(region.scheduledStops!.byKind).toEqual({
      bus_station: 2,
      railway_station: 3,
      train_station: 1,
    });
    expect(region.scheduledStops!.total).toBe(6);
    expect(scheduledNetworkFrom(region.scheduledStops)).toBe('observed');
  });
});

describe('a pack whose ground records no station', () => {
  it('persists an honest zero rather than staying silent', async () => {
    /* `transit_city` publishes no stop records — that is its shipped shape. */
    const region = await compileWorld(SYNTHETIC_WORLDS.transit_city!);

    expect(
      region.scheduledStops,
      'a pack was read and said nothing; the zero must be written, not implied',
    ).toBeDefined();
    expect(region.scheduledStops!.byKind).toEqual({});
    expect(region.scheduledStops!.total).toBe(0);
    expect(scheduledNetworkFrom(region.scheduledStops)).toBe('not_observed');
  });
});

describe('a build with no pack to read', () => {
  it('persists nothing, so an old or packless artifact reads as nobody-said', async () => {
    const region = await compileWorld(SYNTHETIC_WORLDS.transit_city!, {
      throughPack: false,
    });

    expect(region.scheduledStops).toBeUndefined();
    expect(scheduledNetworkFrom(region.scheduledStops)).toBeNull();
  });
});

describe('the enumeration cannot drift from the taxonomy', () => {
  it('classifies every enumerated stop kind as a gateway of a scheduled sort', () => {
    /*
     * The counting rule lives in core; the vocabulary's admission table lives
     * here in the compiler. This is the tripwire that fires if the taxonomy
     * renames or refiles a kind while the counter goes on counting the old
     * word: every enumerated kind must still classify as a gateway whose
     * subrole is rail, road or water — the scheduled sorts. `gateway_air` is
     * deliberately not among them.
     */
    for (const kind of SCHEDULED_STOP_KINDS) {
      const classification = classifySourceCategory({ category: kind });
      expect(classification.role, `${kind} no longer classifies as a gateway`).toBe('gateway');
      expect(
        ['gateway_rail', 'gateway_road', 'gateway_water'],
        `${kind} classifies under a subrole the observation must not count`,
      ).toContain(classification.subrole);
    }
  });

  it('is deterministic: the same pack yields the same bytes', async () => {
    const spec: SyntheticWorldSpec = {
      ...SYNTHETIC_WORLDS.transit_city!,
      id: 'transit-city-stops-det',
      scheduledStopRecords: SERVED_STOPS,
    };
    const first = await compileWorld(spec);
    const second = await compileWorld(spec);
    expect(JSON.stringify(first.scheduledStops)).toBe(JSON.stringify(second.scheduledStops));
  });
});
