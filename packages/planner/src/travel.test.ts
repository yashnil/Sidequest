import { describe, expect, it } from 'vitest';
import {
  buildTravelerProfile,
  defaultAnswers,
  type TransitEvidence,
  type TravelerProfile,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';
import {
  countsTowardRoadDistance,
  dailyCapFor,
  permittedModesFor,
  reachFromBase,
  resolveLeg,
  transitModeOf,
  travelBucketFor,
  travelKnowledgeFor,
} from './travel';

/**
 * WHAT THIS SUITE IS FOR.
 *
 * One rule, stated three ways, because it is the rule the whole pass exists to
 * enforce: a duration measured for one mode may never answer for another, and a
 * duration measured for one pair may never answer for another pair.
 *
 * Everything here is built by hand rather than compiled, because the point is to
 * put the two networks in deliberate disagreement — a walk that is quick where
 * the train is slow, and a train that is quick where the walk is an hour — and
 * then check which number comes out. A fixture where both networks say the same
 * thing cannot fail any of these tests.
 */

function profileWith(overrides: Partial<TravelerProfile['transport']>): TravelerProfile {
  const base = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 3 }), {
    travelerNeeds: [],
    tripDays: 3,
  });
  return { ...base, transport: { ...base.transport, ...overrides } };
}

/*
 * Two different tolerances, deliberately.
 *
 * They were both 20, and so was the fixture in the end-to-end suite — which
 * meant the constant `20` could have been hard-coded into `travelKnowledgeFor`
 * in place of the traveller's own answer and nothing anywhere would have gone
 * red. The rule the module calls first in its ordering was not bound to the
 * statement it claims to read.
 */
const CAR_FREE = profileWith({
  willDrive: false,
  maxDailyDriveMinutes: 0,
  maxAccessWalkMinutes: 14,
});
const STRIDER = profileWith({ willDrive: false, maxAccessWalkMinutes: 55 });
const DRIVER = profileWith({ willDrive: true, maxAccessWalkMinutes: 20 });
const NO_BUSES = profileWith({
  willDrive: false,
  willUseShuttles: false,
  maxAccessWalkMinutes: 14,
});

/**
 * A pedestrian matrix in which every pair is a different length.
 *
 * `hotel → market` is a stroll, `hotel → museum` is the better part of an hour,
 * and `market → museum` is different again — so a leg that quotes the wrong pair
 * quotes a number that appears nowhere near it.
 */
function footMatrix(): TravelTimeMatrix {
  return {
    mode: 'foot',
    ids: ['hotel', 'market', 'museum', 'tower'],
    minutes: [
      [0, 12, 52, 71],
      [12, 0, 44, 63],
      [52, 44, 0, 27],
      [71, 63, 27, 0],
    ],
    km: [
      [0, 0.9, 4.1, 5.6],
      [0.9, 0, 3.4, 5.0],
      [4.1, 3.4, 0, 2.1],
      [5.6, 5.0, 2.1, 0],
    ],
    provenance: { kind: 'measured', note: 'Measured on the pedestrian network.', source: 'test' },
  };
}

function roadMatrix(): TravelTimeMatrix {
  return { ...footMatrix(), mode: 'car' };
}

function journey(
  fromId: string,
  toId: string,
  minutes: number,
  rideMode: 'subway' | 'bus' | 'ferry' = 'subway',
): TransitEvidence['journeys'][number] {
  return {
    fromId,
    toId,
    status: 'measured',
    minutes,
    transfers: 1,
    walkingMinutes: 6,
    legs: [
      { mode: 'walk', minutes: 3 },
      { mode: rideMode, minutes: minutes - 6 },
      { mode: 'walk', minutes: 3 },
    ],
    requestBasis: {
      kind: 'depart_at',
      instant: '2026-08-12T08:30:00.000Z',
      timeZone: 'Europe/Lisbon',
    },
    source: 'test-transit',
    retrievedAt: '2026-08-01T00:00:00.000Z',
    detail: 'Measured against published timetables.',
  };
}

function evidence(
  journeys: TransitEvidence['journeys'],
): TransitEvidence {
  return {
    journeys,
    provider: 'test-transit',
    requested: journeys.length,
    measured: journeys.filter((entry) => entry.status === 'measured').length,
  };
}

describe('choosing a mode for one leg', () => {
  it('walks a short hop rather than boarding a train to go two streets', () => {
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('hotel', 'market', 16)]),
    );
    const resolved = resolveLeg(knowledge, 'hotel', 'market', 'walk');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('walk');
    expect(resolved.rule).toBe('walk_within_tolerance');
    // The walk's own cell, not the journey's duration.
    expect(resolved.minutes).toBe(12);
  });

  it('rides a long pair rather than walking it, and quotes the timetable', () => {
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('hotel', 'museum', 18)]),
    );
    const resolved = resolveLeg(knowledge, 'hotel', 'museum', 'walk');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('rail');
    expect(resolved.rule).toBe('transit_measured');
    expect(resolved.minutes).toBe(18);
    // Not the 52-minute walk that the matrix would happily have supplied.
    expect(resolved.minutes).not.toBe(52);
    expect(resolved.provenance).toBe('official');
    expect(resolved.basis?.timeZone).toBe('Europe/Lisbon');
  });

  /**
   * The substitution, stated as the test that would catch it.
   *
   * A journey exists for `hotel → museum` and *not* for `hotel → tower`. If a
   * lookup ever widened to "any measured journey", or fell back to the reverse
   * direction, this leg would come back as an eighteen-minute ride between two
   * points nobody asked a timetable about.
   */
  it('never answers one pair with another pair’s journey', () => {
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('hotel', 'museum', 18)]),
    );
    const resolved = resolveLeg(knowledge, 'hotel', 'tower', 'walk');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(71);
  });

  it('never answers a leg with the reverse journey’s duration', () => {
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('hotel', 'museum', 18)]),
    );
    const resolved = resolveLeg(knowledge, 'museum', 'hotel', 'walk');

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // A timetable is not symmetric. The return was not bought, so the walk it is.
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(52);
  });

  /**
   * The defect that shipped: a car-free traveller measured on the road network.
   *
   * The matrix here is a road matrix — which is a state a real compilation can
   * reach, because the pedestrian graph is retried on roads when it comes back
   * empty. Those minutes must not become this traveller's leg under any label.
   */
  it('refuses a road duration for a traveller with no car', () => {
    const knowledge = travelKnowledgeFor(roadMatrix(), CAR_FREE, null);
    const resolved = resolveLeg(knowledge, 'hotel', 'museum', 'drive');

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.conflict).toBe(true);
    expect(resolved.reason).toBe('mode_not_routed');
  });

  it('gives a driver the road, and never the pedestrian network', () => {
    const onRoad = travelKnowledgeFor(roadMatrix(), DRIVER, null);
    const resolved = resolveLeg(onRoad, 'hotel', 'museum', 'drive');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('drive');
    expect(resolved.minutes).toBe(52);

    // A pedestrian matrix cannot answer a driving leg, whoever is asking.
    const onFoot = travelKnowledgeFor(footMatrix(), DRIVER, null);
    expect(resolveLeg(onFoot, 'hotel', 'museum', 'drive').ok).toBe(false);
  });

  it('keeps "no service runs here" apart from "nothing could measure it"', () => {
    const knowledge = travelKnowledgeFor(
      { ...footMatrix(), ids: ['hotel'], minutes: [[0]], km: [[0]] },
      CAR_FREE,
      evidence([
        {
          fromId: 'hotel',
          toId: 'museum',
          status: 'no_route',
          requestBasis: {
            kind: 'depart_at',
            instant: '2026-08-12T08:30:00.000Z',
            timeZone: 'Europe/Lisbon',
          },
          source: 'test-transit',
          retrievedAt: '2026-08-01T00:00:00.000Z',
          detail: 'No public transport runs between these two on this day.',
        },
      ]),
    );

    const answered = resolveLeg(knowledge, 'hotel', 'museum', 'walk');
    expect(answered.ok).toBe(false);
    if (answered.ok) return;
    expect(answered.reason).toBe('no_route_found');

    const unasked = resolveLeg(knowledge, 'hotel', 'tower', 'walk');
    expect(unasked.ok).toBe(false);
    if (unasked.ok) return;
    expect(unasked.reason).toBe('mode_not_routed');
  });

  it('takes the quicker of two measured options once a walk is too long', () => {
    // The train is slower than the walk here, and the walk is over tolerance.
    // Picking the train because "this is a transit city" would be picking a mode
    // on reputation rather than on a measurement.
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('museum', 'tower', 40)]),
    );
    const resolved = resolveLeg(knowledge, 'museum', 'tower', 'walk');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(27);
  });

  it('refuses to name a vehicle when the journey has no ride in it', () => {
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([
        {
          ...journey('hotel', 'museum', 18),
          legs: [{ mode: 'walk', minutes: 18 }],
        },
      ]),
    );
    const resolved = resolveLeg(knowledge, 'hotel', 'museum', 'walk');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Falls back to the measured walk rather than inventing a train or a bus.
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(52);
  });


  it('reads the traveller\u2019s own walking limit, not a constant', () => {
    // The same pair, the same evidence, two travellers. `hotel -> market` is a
    // 12-minute walk: inside one tolerance and outside the other, so the mode
    // that comes back has to be different.
    const evidenceFor = () => evidence([journey('hotel', 'market', 9)]);
    const impatient = travelKnowledgeFor(footMatrix(), profileWith({ willDrive: false, maxAccessWalkMinutes: 5 }), evidenceFor());
    const walker = travelKnowledgeFor(footMatrix(), STRIDER, evidenceFor());

    const ridden = resolveLeg(impatient, 'hotel', 'market', 'walk');
    expect(ridden.ok && ridden.mode).toBe('rail');
    const walked = resolveLeg(walker, 'hotel', 'market', 'walk');
    expect(walked.ok && walked.mode).toBe('walk');
    expect(walked.ok && walked.rule).toBe('walk_within_tolerance');
  });

  it('will not put a traveller on a bus they asked us to leave out', () => {
    // The validator refuses a plan containing one, so choosing it here would
    // schedule a leg and then have the whole trip refused for containing it.
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      NO_BUSES,
      evidence([journey('hotel', 'museum', 18, 'bus')]),
    );
    const resolved = resolveLeg(knowledge, 'hotel', 'museum', 'walk');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(52);

    // The same traveller may still take a train: nothing asked them about one.
    const byRail = travelKnowledgeFor(
      footMatrix(),
      NO_BUSES,
      evidence([journey('hotel', 'museum', 18, 'subway')]),
    );
    expect(resolveLeg(byRail, 'hotel', 'museum', 'walk').ok && true).toBe(true);
    const rail = resolveLeg(byRail, 'hotel', 'museum', 'walk');
    expect(rail.ok && rail.mode).toBe('rail');
  });

  it('names the vehicle carrying the most of a multi-ride journey', () => {
    // Nine minutes of bus and twenty-five of rail is "by train". The fixtures
    // all had exactly one ride, so `rides[0]` would have passed every one.
    const busThenRail: TransitEvidence['journeys'][number] = {
      ...journey('hotel', 'museum', 40),
      legs: [
        { mode: 'walk', minutes: 3 },
        { mode: 'bus', minutes: 9 },
        { mode: 'rail', minutes: 25 },
        { mode: 'walk', minutes: 3 },
      ],
    };
    expect(transitModeOf(busThenRail)).toBe('rail');
    expect(
      transitModeOf({
        ...busThenRail,
        legs: [
          { mode: 'rail', minutes: 4 },
          { mode: 'bus', minutes: 30 },
        ],
      }),
    ).toBe('public_bus');
  });

  it('breaks a tie by an explicit order rather than by which option was pushed first', () => {
    // Equal durations, past this traveller's walking tolerance so the
    // walk-first rule does not short-circuit, and the matrix option is pushed
    // first. Without the tie-break the walk would win by array position — the
    // matrix answering a pair a timetable also answered, decided by nothing.
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('hotel', 'museum', 52)]),
    );
    const resolved = resolveLeg(knowledge, 'hotel', 'museum', 'walk');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.minutes).toBe(52);
    expect(resolved.mode).toBe('rail');
    expect(resolved.rule).toBe('transit_measured');
  });

  it('names the vehicle the journey is mostly spent on', () => {
    expect(transitModeOf(journey('a', 'b', 20, 'bus'))).toBe('public_bus');
    expect(transitModeOf(journey('a', 'b', 20, 'ferry'))).toBe('ferry');
    expect(transitModeOf(journey('a', 'b', 20, 'subway'))).toBe('rail');
    expect(
      transitModeOf({ ...journey('a', 'b', 20), legs: [{ mode: 'walk', minutes: 20 }] }),
    ).toBeNull();
  });
});

describe('what a traveller is allowed on', () => {
  it('gates driving on the traveller’s own answer, never on the data', () => {
    expect(permittedModesFor(DRIVER).has('drive')).toBe(true);
    expect(permittedModesFor(CAR_FREE).has('drive')).toBe(false);
    // Walking is always available; the tolerance bounds how far, not whether.
    expect(permittedModesFor(CAR_FREE).has('walk')).toBe(true);
  });
});

describe('which budget a leg’s minutes belong to', () => {
  /**
   * The rule the layout and the validator share.
   *
   * They used to hold a copy each and the copies disagreed, so a `drive` leg
   * with a stated allowance was riding in one and driving in the other.
   */
  it('charges only time at the wheel to driving', () => {
    expect(travelBucketFor('drive', 'approach')).toBe('drive');
    expect(travelBucketFor('rail', 'ride')).toBe('transit');
    expect(travelBucketFor('public_bus', 'ride')).toBe('transit');
    expect(travelBucketFor('walk', 'walk')).toBe('walk');
    expect(travelBucketFor('shuttle', 'wait')).toBe('wait');
    // Waiting is waiting whatever you are waiting for — but a drive is never a wait.
    expect(travelBucketFor('drive', 'wait')).toBe('drive');
  });

  it('keeps road distance to the road', () => {
    expect(countsTowardRoadDistance('drive')).toBe(true);
    expect(countsTowardRoadDistance('rail')).toBe(false);
    expect(countsTowardRoadDistance('walk')).toBe(false);
  });
});

describe('how far a place is before the scheduler runs', () => {
  /**
   * THE GAP THIS CLOSES.
   *
   * Every pre-scheduler reach test read `place.travelFromBase.driveMinutes` — a
   * figure the compiler fills from *whatever mode the matrix was*, under a name
   * that says driving. On a car-free trip it held walking minutes, so the
   * arrival bound pushed a metro-reachable museum most of an hour into the day
   * and the round-trip refusal compared that walk against `maxDailyDriveMinutes`,
   * which is zero for a non-driver.
   */
  it('reaches a stop by the measured train, not by the hour-long walk', () => {
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('hotel', 'museum', 18), journey('museum', 'hotel', 21)]),
    );
    const reached = reachFromBase(knowledge, 'hotel', 'museum');

    expect(reached.ok).toBe(true);
    if (!reached.ok) return;
    expect(reached.mode).toBe('rail');
    // Its own pair, each way — never the 52-minute walk, never one leg doubled.
    expect(reached.outMinutes).toBe(18);
    expect(reached.backMinutes).toBe(21);
    expect(reached.roundTripMinutes).toBe(39);
    // And not a minute of it at a wheel, so no driving budget is touched.
    expect(reached.driveMinutes).toBe(0);
  });

  it('still refuses a long walk nobody can shorten', () => {
    // Same traveller, same matrix, no timetable for this pair. The walk stands,
    // and a round trip of two and a half hours is past what they said they would
    // travel in a day — which is the honest refusal, in the right mode.
    // A stated travelling limit, so the refusal turns on the traveller's own
    // answer rather than on whatever the default happens to be.
    const homebody = profileWith({
      willDrive: false,
      maxDailyDriveMinutes: 0,
      maxDailyTransportMinutes: 120,
      maxAccessWalkMinutes: 14,
    });
    const knowledge = travelKnowledgeFor(footMatrix(), homebody, evidence([]));
    const reached = reachFromBase(knowledge, 'hotel', 'tower');

    expect(reached.ok).toBe(true);
    if (!reached.ok) return;
    expect(reached.mode).toBe('walk');
    expect(reached.roundTripMinutes).toBe(142);
    expect(reached.driveMinutes).toBe(0);
    // Past the travelling budget they stated, and no driving budget involved.
    expect(reached.roundTripMinutes).toBeGreaterThan(120);
  });

  it('never lets a road matrix reach a traveller with no car', () => {
    const knowledge = travelKnowledgeFor(roadMatrix(), CAR_FREE, null);
    const reached = reachFromBase(knowledge, 'hotel', 'museum');

    expect(reached.ok).toBe(false);
    if (reached.ok) return;
    expect(reached.conflict).toBe(true);
  });

  it('leaves a driving trip exactly as it was', () => {
    const knowledge = travelKnowledgeFor(roadMatrix(), DRIVER, null);
    const reached = reachFromBase(knowledge, 'hotel', 'museum');

    expect(reached.ok).toBe(true);
    if (!reached.ok) return;
    expect(reached.mode).toBe('drive');
    expect(reached.outMinutes).toBe(52);
    expect(reached.roundTripMinutes).toBe(104);
    // All of it at a wheel, for a journey made at one.
    expect(reached.driveMinutes).toBe(104);
  });

  it('never charges a transit journey to the driving budget', () => {
    const knowledge = travelKnowledgeFor(
      footMatrix(),
      CAR_FREE,
      evidence([journey('hotel', 'museum', 18), journey('museum', 'hotel', 21)]),
    );
    const reached = reachFromBase(knowledge, 'hotel', 'museum');
    expect(reached.ok).toBe(true);
    if (!reached.ok) return;
    expect(reached.mode).not.toBe('drive');
    expect(reached.driveMinutes).toBe(0);
    expect(dailyCapFor(knowledge, reached.mode)).toBe(
      CAR_FREE.transport.maxDailyTransportMinutes,
    );
    // Zero is what a non-driver's wheel budget is, and it must bound nothing here.
    expect(CAR_FREE.transport.maxDailyDriveMinutes).toBe(0);
  });

  it('charges only the driving half of a mixed round trip to the wheel', () => {
    /*
     * Out on a measured train, back on the road because no return journey was
     * bought. The day still puts somebody at a wheel, so the driving cap is the
     * one that applies — reading the cap off the *outbound* mode alone would
     * bound an hour of driving by the travelling budget instead.
     */
    const knowledge = travelKnowledgeFor(
      roadMatrix(),
      DRIVER,
      evidence([journey('hotel', 'museum', 18)]),
    );
    const reached = reachFromBase(knowledge, 'hotel', 'museum');

    expect(reached.ok).toBe(true);
    if (!reached.ok) return;
    expect(reached.outMinutes).toBe(18);
    expect(reached.backMinutes).toBe(52);
    // Out by train, back on the road. Seventy minutes of travel, of which
    // fifty-two are at a wheel — and reporting all seventy as driving is what
    // put a false quantity and a false remedy in front of a traveller.
    expect(reached.roundTripMinutes).toBe(70);
    expect(reached.driveMinutes).toBe(52);
  });
});

describe('a mode the day can no longer afford', () => {
  /**
   * The correction, and its limit.
   *
   * The ordered rules pick the quickest measured option, which is right until
   * the quickest one is a drive the traveller has no budget left for — the
   * packer then refuses the stop outright while a measured train sits in the
   * evidence, never considered, because the mode was chosen before anyone asked
   * what it would cost.
   *
   * It removes an option that cannot be paid for. It does not rank, score or
   * trade anything off.
   */
  const bothMeasured = () =>
    travelKnowledgeFor(
      { ...footMatrix(), mode: 'car' },
      profileWith({ willDrive: true, maxDailyDriveMinutes: 60, maxAccessWalkMinutes: 10 }),
      evidence([journey('hotel', 'museum', 70)]),
    );

  it('takes the quicker drive while the day can still pay for it', () => {
    const resolved = resolveLeg(bothMeasured(), 'hotel', 'museum', 'drive', { driveMinutes: 0 });
    expect(resolved.ok && resolved.mode).toBe('drive');
    expect(resolved.ok && resolved.minutes).toBe(52);
  });

  it('takes the slower measured train once the wheel budget is spent', () => {
    // 40 already driven against a 60-minute cap: another 52 does not fit, and
    // dropping the stop is a worse answer than a seventy-minute ride.
    const resolved = resolveLeg(bothMeasured(), 'hotel', 'museum', 'drive', { driveMinutes: 40 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('rail');
    expect(resolved.minutes).toBe(70);
  });

  it('still offers the drive when it is the only thing measured', () => {
    // No alternative, so an unaffordable drive is a refusal the packer should
    // make loudly rather than one this function disguises as "nothing measured".
    const onlyRoad = travelKnowledgeFor(
      { ...footMatrix(), mode: 'car' },
      profileWith({ willDrive: true, maxDailyDriveMinutes: 60, maxAccessWalkMinutes: 10 }),
      null,
    );
    const resolved = resolveLeg(onlyRoad, 'hotel', 'museum', 'drive', { driveMinutes: 55 });
    expect(resolved.ok && resolved.mode).toBe('drive');
  });
});
