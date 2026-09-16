import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessWalk, journeyFromSegment, travelModeOfSegment, walkPurposeOf, type TravelSegment, type WalkContext } from '@sidequest/core';
import type { MobilityPattern } from '@sidequest/core';

/**
 * V12.2 §17 §18 §19 §20 — THE OTHER FOUR LIVE TRIPS, RE-JUDGED. NO MODEL CALL.
 *
 * The Greek trip is the one that carried the defect; these four are the ones
 * that must not acquire one. A correctness pass that fixes a bad trip by
 * damaging four good ones has not fixed anything, and the walking rule is
 * exactly the kind of change that can do it: a trek stage, a horse crossing and
 * a lodge transfer are all "long movements on foot or on rough ground" to a rule
 * that only counts kilometres.
 *
 * Each trip is replayed at the decision layer against its real recorded legs,
 * with the mobility pattern it actually had.
 */

const ROOT = '.claude-private/artifacts';

interface StoredDay {
  day_number: number;
  items: { kind: string; item_json: { travel?: TravelSegment } }[];
}

function legsOf(dump: string): { day: number; travel: TravelSegment }[] {
  const days = JSON.parse(readFileSync(`${ROOT}/${dump}/days.json`, 'utf8')) as StoredDay[];
  return days.flatMap((day) => day.items.filter((i) => i.kind === 'travel' && i.item_json.travel).map((i) => ({ day: day.day_number, travel: i.item_json.travel! })));
}

function walkContext(travel: TravelSegment, pattern: MobilityPattern, maxWalkMinutes = 25): WalkContext {
  return { segment: travel, straightLineKm: travel.estimate?.straightLineKm ?? null, mobilityPattern: pattern, maxWalkMinutes };
}

/** Every walk the new rule would strip of its figure, given what this trip could substitute. */
function refused(dump: string, pattern: MobilityPattern, substitutable: boolean): string[] {
  return legsOf(dump)
    .filter(({ travel }) => travel.mode === 'walk')
    .filter(({ travel }) => assessWalk(walkContext(travel, pattern), substitutable).verdict === 'refuse')
    .map(({ day, travel }) => `day ${day} ${travel.fromName} → ${travel.toName}`);
}

describe('§17 — the Canadian Rockies', () => {
  const DUMP = 'v11/live/rockies-dump';
  const legs = legsOf(DUMP);

  it('has no walking leg to lose in the first place', () => {
    /* A hire-car trip: 27 legs, not one of them on foot. The walking rule cannot touch it. */
    expect(legs.filter((l) => l.travel.mode === 'walk')).toHaveLength(0);
    expect(refused(DUMP, 'self_drive', true)).toEqual([]);
  });

  it('keeps its car semantics: every leg is a drive or a refused crossing', () => {
    const modes = new Set(legs.map((l) => travelModeOfSegment(l.travel)));
    expect(modes.has('drive')).toBe(true);
    expect(modes.has('rail')).toBe(false);
    expect(modes.has('flight')).toBe(false);
  });

  it('still carries the three phantom ferries as the recorded input they are', () => {
    /* V12.1's screen refuses these; the dump is the before-state and says so. */
    expect(legs.filter((l) => l.travel.mode === 'ferry')).toHaveLength(3);
  });

  it('keeps its one measured drive measured', () => {
    const measured = legs.filter((l) => l.travel.provenance === 'measured');
    expect(measured).toHaveLength(1);
    expect(journeyFromSegment(measured[0]!.travel).truth).toBe('measured');
  });
});

describe('§18 — Kyrgyzstan', () => {
  const DUMP = 'v11/live/kyrgyzstan-dump';
  const legs = legsOf(DUMP);

  it('does not turn a single expedition leg into a taxi', () => {
    /* The test this whole file exists for: a trek trip must survive a walking rule. */
    expect(refused(DUMP, 'trail', true)).toEqual([]);
  });

  it('keeps the horse stage a horse stage', () => {
    const horse = legs.find((l) => l.travel.hint === 'horse')!;
    expect(travelModeOfSegment(horse.travel)).toBe('horse');
    /* And it is never assessed as a walk at all, because it is not one. */
    expect(horse.travel.mode).toBe('private_transfer');
  });

  it('keeps the four four-wheel-drive legs', () => {
    expect(legs.filter((l) => l.travel.hint === 'four_wheel_drive')).toHaveLength(4);
  });

  it('reads its walking legs as short approaches, not as trek stages to protect', () => {
    /* None is over the ceiling, so the classification never has to matter here. */
    const walks = legs.filter((l) => l.travel.mode === 'walk');
    expect(walks.length).toBeGreaterThan(0);
    for (const { travel } of walks) expect((travel.estimate?.straightLineKm ?? 0)).toBeLessThanOrEqual(3);
  });

  it('preserves the base sequence', () => {
    const transfers = legs.filter((l) => l.travel.role === 'transfer');
    expect(transfers.length).toBeGreaterThan(0);
    for (const { travel } of transfers) expect(travel.fromName).not.toBe(travel.toName);
  });
});

describe('§19 — Japan', () => {
  /*
   * The Japan draft was lost: the V12.1 live database was reset before the third
   * call, and the spec saved screenshots and the rendered day text rather than a
   * dump. What survives is `japan-days.txt`, which is what a traveller actually
   * read — and for §19's criteria that is the right artefact, because every one
   * of them is about what the plan says.
   *
   * Recorded plainly rather than worked around: the live spec should dump the
   * draft, and V12.2 changes it to do so.
   */
  const text = readFileSync(`${ROOT}/v12.1/live/japan-days.txt`, 'utf8');

  it('keeps rail as rail — and shows, from this artefact, that the row did not say so', () => {
    /*
     * The §19 criterion is met in the data: the Japan trip's three intercity
     * legs are `mode: rail`, `hint: high_speed_rail`, and V12.1's replay asserts
     * it. What this artefact shows is a **presentation** defect V12.2 fixes:
     * every untimed leg rendered as *"Travel to Kyoto · schedule to confirm"*,
     * because the reconciler titles a leg it could not time generically and the
     * row printed that title verbatim.
     *
     * So a traveller on a rail trip could not tell a Shinkansen from a taxi
     * anywhere on the plan. `travelLine` now puts the Journey's own mode back
     * into the row ("Train to Kyoto · schedule to confirm"), which is §13's
     * shape and adds no chip. This assertion records the before-state; the
     * after is covered by `ItineraryView`'s own tests.
     */
    expect(/Travel to Kyoto · schedule to confirm/.test(text)).toBe(true);
    expect(/train/i.test(text)).toBe(false);
  });

  it('leaks no car', () => {
    expect(/\bdrive\b|\brental car\b|\bhire car\b/i.test(text)).toBe(false);
  });

  it('says schedule to confirm rather than inventing a departure', () => {
    expect(/schedule to confirm/i.test(text)).toBe(true);
  });

  it('never prints a clock time against a train', () => {
    /* §12: an unverified timetable must not become a fake 10:15. */
    expect(/train[^.]{0,40}\b\d{1,2}:\d{2}\b/i.test(text)).toBe(false);
  });

  it('uses none of the forbidden forensic words', () => {
    for (const word of [/\ballowance\b/i, /operator-timed/i, /\bunmeasured\b/i, /not routed/i]) {
      expect(word.test(text), `japan-days.txt says ${String(word)}`).toBe(false);
    }
  });
});

describe('§20 — the Maldives', () => {
  const DUMP = 'v12/live/resort-dump';
  const legs = legsOf(DUMP);

  it('loses no leg to the walking rule', () => {
    expect(refused(DUMP, 'operator_transfer', false)).toEqual([]);
  });

  it('keeps the operator boats and the flight', () => {
    expect(legs.filter((l) => travelModeOfSegment(l.travel) === 'boat')).toHaveLength(2);
    expect(legs.filter((l) => travelModeOfSegment(l.travel) === 'flight')).toHaveLength(1);
  });

  it('substitutes no road mode across water', () => {
    const water = legs.filter((l) => ['boat', 'ferry'].includes(travelModeOfSegment(l.travel)));
    for (const { travel } of water) expect(['drive', 'public_bus', 'rideshare']).not.toContain(travel.mode);
  });

  it('leaves the empty time alone', () => {
    /* A resort week's open afternoons are the product; nothing here fills them. */
    expect(legs.length).toBe(20);
  });
});

describe('§21 — the corpus cases the replays do not reach', () => {
  const base = (over: Partial<TravelSegment>): TravelSegment => ({ role: 'approach', provenance: 'estimated', km: null, ...over }) as TravelSegment;

  it('a same-place leg is never judged as a walk at all', () => {
    const leg = base({ fromName: 'Naxos', toName: 'Naxos' });
    expect(assessWalk({ segment: leg, straightLineKm: 0 }, false).verdict).toBe('plausible');
  });

  it('a three-kilometre luggage transfer is refused', () => {
    expect(assessWalk({ segment: base({ role: 'transfer' }), straightLineKm: 3 }, false).verdict).toBe('refuse');
  });

  it('an eight-kilometre intentional hike is kept', () => {
    expect(walkPurposeOf({ segment: base({ episode: 'Ala-Köl', episodeMode: 'walk' }) })).toBe('activity_walk');
    expect(assessWalk({ segment: base({ episode: 'Ala-Köl', episodeMode: 'walk' }), straightLineKm: 8, mobilityPattern: 'trail' }, false).verdict).toBe('plausible');
  });
});
