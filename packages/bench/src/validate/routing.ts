import { consecutivePairs, fastestPossibleMinutes, haversineKm } from '../geometry';
import { NEUTRAL_THRESHOLDS, type BenchmarkGroundTruth } from '../ground-truth';
import { type BenchFinding } from '../schemas/finding';
import { type BenchmarkPlan, type PlanBlock, type PlanDay } from '../schemas/plan';
import {
  clockLabel,
  dayLabel,
  displayNameOf,
  entityIdOf,
  isTravel,
  report,
  safeArray,
  subjectOf,
  timesOf,
  travelBlocks,
  travelMinutesOf,
  unresolved,
  venueIdOf,
  type CheckContext,
} from './context';

/**
 * Can a person actually get between the things this plan puts in a day?
 *
 * The checks here are the ones with teeth, because geography does not negotiate.
 * Everything that asserts impossibility is `critical` and everything that asserts
 * a *preference* was broken — a daily travel cap the traveller set — is `major`,
 * and the line between the two is whether the finding would still hold for a
 * traveller who had said nothing about how far they were willing to go.
 *
 * The lower-bound rule is the important one. Where nobody measured a route, a
 * great-circle line at an implausibly fast ground speed is used in one direction
 * only: exceeding it proves the leg cannot be done in the time the plan allows,
 * and falling under it proves nothing at all. A validator that turned the lower
 * bound into an estimate would be inventing travel times and grading plans
 * against its own invention.
 */

export function checkRouting(
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const days = safeArray(plan.days);

  days.forEach((day, index) => {
    const previous = index > 0 ? days[index - 1] : undefined;
    findings.push(...checkDaySegments(day, truth, ctx));
    findings.push(...checkDayEndpoints(day, ctx));
    findings.push(...checkTransfer(day, previous, truth, ctx));
    findings.push(...checkBase(day, previous, ctx));
    findings.push(...checkDailyBudgets(day, previous, truth, ctx));
  });

  return findings;
}

/* ------------------------------------------------------------------ *
 * Stops and legs
 * ------------------------------------------------------------------ */

interface Stop {
  block: PlanBlock;
  index: number;
  entityId: string | null;
}

function activityStops(day: PlanDay): Stop[] {
  const stops: Stop[] = [];
  safeArray(day.blocks).forEach((block, index) => {
    if (block.kind !== 'activity') return;
    stops.push({ block, index, entityId: entityIdOf(block) });
  });
  return stops;
}

/**
 * Measured minutes for a leg, or nothing.
 *
 * There is deliberately no fallback: a pair no routing engine answered for is
 * unmeasured, and every caller here handles that as `unknown` rather than
 * reaching for a substitute.
 */
function measured(truth: BenchmarkGroundTruth, from: string, to: string): number | null {
  const minutes = truth.routeMinutes(from, to);
  return typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : null;
}

/**
 * The distance between two inventory entries, taken from ground truth rather
 * than from the plan's own coordinates — a plan that mis-stated a latitude would
 * otherwise be able to talk its way out of an impossible jump.
 */
function groundDistanceKm(
  truth: BenchmarkGroundTruth,
  from: string,
  to: string,
): number | null {
  const direct = truth.straightLineKm(from, to);
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const a = truth.place(from);
  const b = truth.place(to);
  if (!a || !b) return null;
  if (!Number.isFinite(a.latitude) || !Number.isFinite(b.latitude)) return null;
  return haversineKm(a, b);
}

/* ------------------------------------------------------------------ *
 * Segments between consecutive stops
 * ------------------------------------------------------------------ */

function checkDaySegments(
  day: PlanDay,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const stops = activityStops(day);

  for (const [from, to] of consecutivePairs(stops)) {
    findings.push(...checkSegmentPresence(day, from, to, ctx));
    findings.push(...checkRouteAvailability(day, from, to, truth, ctx));
    findings.push(...checkJump(day, from, to, truth, ctx));
  }

  return findings;
}

/**
 * Two different places in a row and nothing in between that moves anybody.
 *
 * Critical, because a day that teleports has not accounted for the hours it
 * actually costs and every downstream total is wrong by that much.
 *
 * A joining block counts wherever it sits in the day, not only between the two
 * stops. Blocks are read in clock order, and a plan that gave its travel legs no
 * clock times would otherwise be charged for a defect it does not have.
 */
function checkSegmentPresence(
  day: PlanDay,
  from: Stop,
  to: Stop,
  ctx: CheckContext,
): BenchFinding[] {
  if (from.entityId === null || to.entityId === null) {
    ctx.undecided();
    return [
      unresolved(
        'missing_travel_segment',
        subjectOf(day, { blockIndex: to.index, entityId: to.entityId }),
        `${dayLabel(day)} moves to ${displayNameOf(to.block)}, which carries no shared identity, so whether a leg is needed cannot be settled.`,
        'plan.days[].blocks[].place.entityId',
        'subject_not_in_inventory',
      ),
    ];
  }

  ctx.decided();
  if (from.entityId === to.entityId) return [];

  const between = safeArray(day.blocks)
    .slice(from.index + 1, to.index)
    .some(isTravel);
  const joining = travelBlocks(day).some(
    (block) =>
      block.travel?.from?.entityId === from.entityId && block.travel?.to?.entityId === to.entityId,
  );
  if (between || joining) return [];

  return [
    report(
      'missing_travel_segment',
      'critical',
      subjectOf(day, { blockIndex: to.index, entityId: to.entityId }),
      `${dayLabel(day)} goes from ${displayNameOf(from.block)} to ${displayNameOf(to.block)} with no journey between them.`,
      'plan.days[].blocks',
      { observed: { from: from.entityId, to: to.entityId }, expected: { travelBlock: true } },
    ),
  ];
}

function checkRouteAvailability(
  day: PlanDay,
  from: Stop,
  to: Stop,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  if (from.entityId === null || to.entityId === null) {
    ctx.undecided();
    return [
      unresolved(
        'route_time_unavailable',
        subjectOf(day, { blockIndex: to.index, entityId: to.entityId }),
        `${dayLabel(day)} has a leg whose ends are not both in the shared inventory, so no route could be looked up.`,
        'truth.routeMinutes',
        'subject_not_in_inventory',
      ),
    ];
  }
  if (measured(truth, from.entityId, to.entityId) === null) {
    ctx.undecided();
    return [
      unresolved(
        'route_time_unavailable',
        subjectOf(day, { blockIndex: to.index, entityId: to.entityId }),
        `Nobody measured the journey from ${displayNameOf(from.block)} to ${displayNameOf(to.block)}.`,
        'truth.routeMinutes',
        'no_measured_route',
        { observed: { from: from.entityId, to: to.entityId } },
      ),
    ];
  }
  ctx.decided();
  return [];
}

/**
 * A gap on the clock that is too small for the journey inside it.
 *
 * Where the leg was measured, this is arithmetic. Where it was not, the only
 * honest answer for most pairs is `unknown` — so the great-circle lower bound is
 * consulted, and it can only ever move the finding from `unknown` to `critical`,
 * never from `critical` to fine.
 */
function checkJump(
  day: PlanDay,
  from: Stop,
  to: Stop,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const subject = subjectOf(day, { blockIndex: to.index, entityId: to.entityId });
  const leaving = timesOf(from.block);
  const arriving = timesOf(to.block);

  if (!leaving || !arriving) {
    ctx.undecided();
    return [
      unresolved(
        'impossible_jump',
        subject,
        `${dayLabel(day)} does not put clock times on both ends of this leg, so the time allowed for it is unstated.`,
        'plan.days[].blocks[].startMinute',
        'plan_omits_field',
      ),
    ];
  }
  if (from.entityId === null || to.entityId === null) {
    ctx.undecided();
    return [
      unresolved(
        'impossible_jump',
        subject,
        `${dayLabel(day)} moves between places the shared inventory does not both hold, so the distance is unknown.`,
        'truth.straightLineKm',
        'subject_not_in_inventory',
      ),
    ];
  }

  const gap = arriving.start - leaving.end;
  const minutes = measured(truth, from.entityId, to.entityId);
  if (minutes !== null) {
    ctx.decided();
    if (gap >= minutes) return [];
    return [
      report(
        'impossible_jump',
        'critical',
        subject,
        `${dayLabel(day)} leaves ${displayNameOf(from.block)} at ${clockLabel(leaving.end)} and is at ${displayNameOf(to.block)} by ${clockLabel(arriving.start)} — ${gap} min for a measured ${minutes} min journey.`,
        'truth.routeMinutes',
        { observed: { gapMinutes: gap }, expected: { measuredMinutes: minutes } },
      ),
    ];
  }

  const km = groundDistanceKm(truth, from.entityId, to.entityId);
  if (km === null) {
    ctx.undecided();
    return [
      unresolved(
        'impossible_jump',
        subject,
        `Neither a route nor a distance is on record between ${displayNameOf(from.block)} and ${displayNameOf(to.block)}.`,
        'truth.straightLineKm',
        'no_measured_route',
      ),
    ];
  }

  const floor = fastestPossibleMinutes(km, NEUTRAL_THRESHOLDS.impossibleJumpKmh);
  if (floor > gap) {
    ctx.decided();
    return [
      report(
        'impossible_jump',
        'critical',
        subject,
        `${dayLabel(day)} allows ${gap} min to cover ${Math.round(km)} km, which is impossible at ${NEUTRAL_THRESHOLDS.impossibleJumpKmh} km/h in a straight line.`,
        'geometry.fastestPossibleMinutes',
        {
          observed: { gapMinutes: gap, straightLineKm: Math.round(km) },
          expected: { atLeastMinutes: floor },
        },
      ),
    ];
  }

  // The lower bound cleared, which says nothing about the road. Unmeasured stays
  // unmeasured rather than becoming a pass it has not earned.
  ctx.undecided();
  return [
    unresolved(
      'impossible_jump',
      subject,
      `Nobody measured this leg; ${gap} min clears the straight-line floor of ${floor} min, which does not make it possible.`,
      'truth.routeMinutes',
      'no_measured_route',
      { observed: { gapMinutes: gap, straightLineFloorMinutes: floor } },
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * Travel legs against their neighbours
 * ------------------------------------------------------------------ */

/**
 * A leg that claims to start or end somewhere the day is not.
 *
 * Critical, because it is the signature of a plan assembled from parts: the
 * itinerary reads plausibly and the route it describes is not the route it
 * schedules, so every travel time on it belongs to a different journey.
 */
function checkDayEndpoints(day: PlanDay, ctx: CheckContext): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const blocks = safeArray(day.blocks);

  blocks.forEach((block, index) => {
    if (!isTravel(block) || !block.travel) return;
    const subject = subjectOf(day, { blockIndex: index });

    const before = nearestPlaced(blocks, index, -1);
    const after = nearestPlaced(blocks, index, 1);
    const statedFrom = block.travel.from?.entityId ?? null;
    const statedTo = block.travel.to?.entityId ?? null;

    const comparisons: { side: string; stated: string; neighbour: string }[] = [];
    if (statedFrom !== null && before !== null) {
      comparisons.push({ side: 'from', stated: statedFrom, neighbour: before });
    }
    if (statedTo !== null && after !== null) {
      comparisons.push({ side: 'to', stated: statedTo, neighbour: after });
    }

    if (comparisons.length === 0) {
      ctx.undecided();
      findings.push(
        unresolved(
          'travel_segment_endpoints_broken',
          subject,
          `${dayLabel(day)} has a leg with nothing identified on either end to compare it against.`,
          'plan.days[].blocks[].travel',
          statedFrom === null && statedTo === null ? 'plan_omits_field' : 'subject_not_in_inventory',
        ),
      );
      return;
    }

    ctx.decided();
    const broken = comparisons.filter((entry) => entry.stated !== entry.neighbour);
    if (broken.length === 0) return;

    const first = broken[0]!;
    findings.push(
      report(
        'travel_segment_endpoints_broken',
        'critical',
        subject,
        `${dayLabel(day)} has a leg whose "${first.side}" end is not where the day actually is at that point.`,
        'plan.days[].blocks[].travel',
        { observed: { side: first.side, stated: first.stated }, expected: { endpoint: first.neighbour } },
      ),
    );
  });

  return findings;
}

/**
 * Where the day is, immediately either side of a leg.
 *
 * It stops at the first block that names anywhere at all, even when that block
 * carries no shared identity — walking past it to the next one that does would
 * compare the leg against the wrong end of the day and manufacture a broken
 * endpoint out of a plan whose only fault was naming a place the inventory does
 * not hold. Blocks that name nowhere, such as a rest, are stepped over.
 */
function nearestPlaced(
  blocks: readonly PlanBlock[],
  from: number,
  step: 1 | -1,
): string | null {
  for (let index = from + step; index >= 0 && index < blocks.length; index += step) {
    const block = blocks[index];
    if (!block) continue;
    if (isTravel(block)) continue;
    if (!block.place && !block.meal?.venue) continue;
    return entityIdOf(block) ?? venueIdOf(block);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Bases and transfers
 * ------------------------------------------------------------------ */

function baseEntity(ctx: CheckContext, day: PlanDay | undefined): string | null {
  if (!day || typeof day.baseId !== 'string') return null;
  return ctx.baseEntityById.get(day.baseId) ?? null;
}

function isTransferDay(day: PlanDay, previous: PlanDay | undefined): boolean {
  if (!previous) return false;
  if (typeof day.baseId !== 'string' || typeof previous.baseId !== 'string') return false;
  return day.baseId !== previous.baseId;
}

/**
 * A day that does not begin and end where it sleeps.
 *
 * Major rather than critical: it is executable — somebody could carry their bag
 * around all day — but it is not the trip the traveller agreed to, and it is
 * usually the trace of a day assembled without reference to the accommodation.
 *
 * Always the *day's* base, never a trip-level one. On the day of a move, only
 * the arrival is checked, because that morning legitimately starts at the base
 * the traveller is leaving.
 */
function checkBase(day: PlanDay, previous: PlanDay | undefined, ctx: CheckContext): BenchFinding[] {
  const subject = subjectOf(day);
  const base = baseEntity(ctx, day);

  if (base === null) {
    ctx.undecided();
    return [
      unresolved(
        'base_inconsistent',
        subject,
        `${dayLabel(day)} does not say where the traveller sleeps, so its shape cannot be checked against a base.`,
        'plan.days[].baseId',
        typeof day.baseId === 'string' ? 'subject_not_in_inventory' : 'plan_omits_field',
      ),
    ];
  }

  const legs = travelBlocks(day);
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!first || !last) {
    ctx.undecided();
    return [
      unresolved(
        'base_inconsistent',
        subject,
        `${dayLabel(day)} states no journeys, so there is nothing to compare with its base.`,
        'plan.days[].blocks[].travel',
        'plan_omits_field',
      ),
    ];
  }

  const departsFrom = first.travel?.from?.entityId ?? null;
  const arrivesAt = last.travel?.to?.entityId ?? null;
  const moving = isTransferDay(day, previous);

  if (arrivesAt === null && (moving || departsFrom === null)) {
    ctx.undecided();
    return [
      unresolved(
        'base_inconsistent',
        subject,
        `${dayLabel(day)} does not say where its journeys start or finish.`,
        'plan.days[].blocks[].travel',
        'plan_omits_field',
      ),
    ];
  }

  ctx.decided();
  const wrongStart = !moving && departsFrom !== null && departsFrom !== base;
  const wrongEnd = arrivesAt !== null && arrivesAt !== base;
  if (!wrongStart && !wrongEnd) return [];

  return [
    report(
      'base_inconsistent',
      'major',
      subject,
      wrongEnd
        ? `${dayLabel(day)} finishes somewhere other than the base it sleeps at.`
        : `${dayLabel(day)} starts somewhere other than the base it slept at.`,
      'plan.days[].baseId',
      {
        observed: { departsFrom, arrivesAt },
        expected: { baseEntityId: base },
      },
    ),
  ];
}

/**
 * A change of base with no move in it.
 *
 * Critical in both directions. A day that sleeps somewhere new without a journey
 * to get there is not executable at all; a day that states a journey shorter
 * than the measured one has understated the single largest cost in the trip, and
 * every other total on that day is wrong by the difference. The tolerance is
 * published rather than tight, because rounding a two-hour drive to the nearest
 * ten minutes is not a defect.
 */
function checkTransfer(
  day: PlanDay,
  previous: PlanDay | undefined,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  if (!isTransferDay(day, previous)) return [];
  const subject = subjectOf(day);
  const to = baseEntity(ctx, day);
  const from = baseEntity(ctx, previous);

  if (from === null || to === null) {
    ctx.undecided();
    return [
      unresolved(
        'transfer_day_without_transfer',
        subject,
        `${dayLabel(day)} changes base, and at least one of the two bases carries no shared identity.`,
        'plan.bases[].place.entityId',
        'subject_not_in_inventory',
      ),
    ];
  }

  const joining = travelBlocks(day).find(
    (block) => block.travel?.from?.entityId === from && block.travel?.to?.entityId === to,
  );

  ctx.decided();
  if (!joining) {
    return [
      report(
        'transfer_day_without_transfer',
        'critical',
        subject,
        `${dayLabel(day)} sleeps somewhere new and holds no journey from the previous base to it.`,
        'plan.days[].blocks[].travel',
        { observed: { fromBase: from, toBase: to }, expected: { transferBlock: true } },
      ),
    ];
  }

  /*
   * What the day actually allows for the move, which is not the same question as
   * what it says about it. The stated duration where there is one, and otherwise
   * the slot the timeline gives the leg — a plan that books ninety minutes for
   * the transfer has allowed ninety minutes whether or not it wrote the number
   * down, and a check that could only read the written form would be undecidable
   * for whichever converter declines to state minutes on an unmeasured leg.
   */
  const allowed = travelMinutesOf(joining);
  const measuredMinutes = measured(truth, from, to);
  if (measuredMinutes === null) {
    ctx.undecided();
    return [
      unresolved(
        'transfer_understated',
        subject,
        `Nobody measured the move between these two bases, so the ${allowed ?? 'unstated'} minutes the plan allows cannot be checked.`,
        'truth.routeMinutes',
        'no_measured_route',
      ),
    ];
  }
  if (allowed === null) {
    ctx.undecided();
    return [
      unresolved(
        'transfer_understated',
        subject,
        `${dayLabel(day)} gives the move between bases neither a duration nor a slot on the clock.`,
        'plan.days[].blocks[].travel.minutes',
        'plan_omits_field',
      ),
    ];
  }

  ctx.decided();
  const shortfall = measuredMinutes - allowed;
  if (shortfall <= NEUTRAL_THRESHOLDS.travelUnderstatementToleranceMinutes) return [];
  return [
    report(
      'transfer_understated',
      'critical',
      subject,
      `${dayLabel(day)} allows ${allowed} min to move between bases; the measured journey is ${measuredMinutes} min.`,
      'truth.routeMinutes',
      { observed: { allowedMinutes: allowed, statedMinutes: joining.travel?.minutes ?? null }, expected: { measuredMinutes } },
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * Daily budgets
 * ------------------------------------------------------------------ */

/**
 * The two caps the traveller set, checked separately.
 *
 * An hour at the wheel and an hour on a train are not interchangeable, and a
 * traveller who capped their driving has not capped their willingness to be
 * carried. Major rather than critical: the day can be done, it is just more of
 * the day in transit than was asked for.
 *
 * The load falls back to the timeline rather than requiring `travel.minutes`.
 * That matters more than it looks: one converter states minutes for every leg
 * whatever their provenance, and the other drops the number on any leg nobody
 * measured, so a check gated on the field being present was a check only one of
 * the two could ever fail. A leg's cost is its stated duration or, failing that,
 * the slot the day gives it — see `travelMinutesOf` for why the stated form wins
 * where both exist — and the pair only goes undecided when a leg has neither,
 * which is a plan omitting both and is reported as such for either arm alike.
 *
 * On the day of a move the allowance is the cap plus the measured transfer.
 * Getting between two bases is the price of a multi-base trip the traveller
 * agreed to when they asked for more than one base, and charging it against the
 * same budget as the sightseeing would make every multi-base plan defective by
 * construction.
 */
function checkDailyBudgets(
  day: PlanDay,
  previous: PlanDay | undefined,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const subject = subjectOf(day);
  const legs = travelBlocks(day);
  const costed = legs.map((block) => ({ block, minutes: travelMinutesOf(block) }));
  const uncosted = costed.filter((leg) => leg.minutes === null);

  if (legs.length === 0 || uncosted.length > 0) {
    ctx.undecided();
    ctx.undecided();
    const reason =
      legs.length === 0
        ? `${dayLabel(day)} states no journeys at all, so neither travel budget has anything to measure.`
        : `${dayLabel(day)} has a journey with neither a duration nor a slot on the clock, so neither travel budget can be totalled.`;
    return [
      unresolved('daily_travel_exceeded', subject, reason, 'plan.days[].blocks[].travel.minutes', 'plan_omits_field'),
      unresolved('daily_drive_exceeded', subject, reason, 'plan.days[].blocks[].travel.minutes', 'plan_omits_field'),
    ];
  }

  const travelMinutes = costed.reduce((total, leg) => total + (leg.minutes ?? 0), 0);
  const driveMinutes = costed
    .filter((leg) => leg.block.travel?.mode === 'drive')
    .reduce((total, leg) => total + (leg.minutes ?? 0), 0);

  const movement = ctx.request?.movement;
  const transferAllowance = transferMinutesFor(day, previous, truth, ctx);
  const findings: BenchFinding[] = [];

  /*
   * A moving day whose move nobody measured is undecided, not convicted.
   *
   * See `transferMinutesFor`: charging an unmeasured transfer against the
   * sightseeing budget makes every multi-base plan defective for a reason that
   * is about base identity rather than about the plan.
   */
  const unmeasuredTransfer = transferAllowance === null;
  const allowance = transferAllowance ?? 0;

  const travelCap = movement?.maxDailyTravelMinutes;
  if (unmeasuredTransfer) {
    ctx.undecided();
    ctx.undecided();
    findings.push(
      unresolved(
        'daily_travel_exceeded',
        subject,
        `${dayLabel(day)} moves to a different base and nothing measured that journey, so what is left of the day's travel budget is unknown.`,
        'truth.routeMinutes',
        'no_measured_route',
      ),
      unresolved(
        'daily_drive_exceeded',
        subject,
        `${dayLabel(day)} moves to a different base and nothing measured that journey, so what is left of the day's driving budget is unknown.`,
        'truth.routeMinutes',
        'no_measured_route',
      ),
    );
    return findings;
  }

  if (typeof travelCap === 'number') {
    ctx.decided();
    const allowed = travelCap + allowance;
    if (travelMinutes > allowed) {
      findings.push(
        report(
          'daily_travel_exceeded',
          'major',
          subject,
          `${dayLabel(day)} spends ${travelMinutes} min getting places, past the ${travelCap} min the traveller set.`,
          'request.movement.maxDailyTravelMinutes',
          { observed: { travelMinutes }, expected: { allowedMinutes: allowed, transferAllowance: allowance } },
        ),
      );
    }
  } else {
    ctx.undecided();
    findings.push(
      unresolved(
        'daily_travel_exceeded',
        subject,
        'The traveller set no ceiling on daily travel.',
        'request.movement.maxDailyTravelMinutes',
        'request_omits_constraint',
      ),
    );
  }

  const driveCap = movement?.maxDailyDriveMinutes;
  if (typeof driveCap === 'number') {
    ctx.decided();
    const allowed = driveCap + allowance;
    if (driveMinutes > allowed) {
      findings.push(
        report(
          'daily_drive_exceeded',
          'major',
          subject,
          `${dayLabel(day)} has ${driveMinutes} min at the wheel, past the ${driveCap} min the traveller set.`,
          'request.movement.maxDailyDriveMinutes',
          { observed: { driveMinutes }, expected: { allowedMinutes: allowed, transferAllowance: allowance } },
        ),
      );
    }
  } else {
    ctx.undecided();
    findings.push(
      unresolved(
        'daily_drive_exceeded',
        subject,
        'The traveller set no ceiling on daily driving.',
        'request.movement.maxDailyDriveMinutes',
        'request_omits_constraint',
      ),
    );
  }

  return findings;
}

/**
 * THE ALLOWANCE ON A DAY THE TRAVELLER MOVES — AND WHAT TO DO WHEN NOBODY
 * MEASURED IT.
 *
 * `null` is a new third answer and it is the one that matters. The exemption
 * exists because getting between two bases is the price of a multi-base trip the
 * traveller asked for, and charging it against the sightseeing budget would make
 * every multi-base plan defective by construction. It was returning `0` whenever
 * the transfer could not be measured — which is almost always, because a base is
 * a routing node rather than a place and neither converter can usually give it a
 * shared identity. So the exemption never activated, the whole transfer drive was
 * charged against the cap, and the arm that builds multi-base trips absorbed a
 * major finding for doing what it was asked to.
 *
 * `0` now means "this is not a moving day". `null` means "it is, and nobody
 * measured the move", and the caller reports the day as undecided rather than
 * convicting it against an allowance it knows to be wrong.
 */
function transferMinutesFor(
  day: PlanDay,
  previous: PlanDay | undefined,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): number | null {
  if (!isTransferDay(day, previous)) return 0;
  const from = baseEntity(ctx, previous);
  const to = baseEntity(ctx, day);
  if (from === null || to === null) return null;
  return measured(truth, from, to) ?? null;
}
