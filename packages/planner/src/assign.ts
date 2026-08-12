import { isMeaningfullyBetter, type TravelerProfile } from '@sidequest/core';
import { clusterByTravelTime, type TravelTimeMatrix, tryLeg } from '@sidequest/geo';
import type { AccessUnit } from './access';
import type { PlannedDay } from './windows';
import type { PlanningCandidate } from './types';

export interface DayAssignment {
  day: PlannedDay;
  candidates: PlanningCandidate[];
}

/**
 * A set of candidates that must travel together.
 *
 * Two independent reasons to bind places into one unit, and both are needed:
 *
 * - `Place.accessGroup` — "these have to happen on the same day". One road, one
 *   fee, one long drive out and back. Minaret Vista and Devils Postpile qualify
 *   even though you reach them by different means.
 * - `AccessUnit` — "these share one entry sequence". Devils Postpile and Rainbow
 *   Falls are one boarding; splitting them would pay for the shuttle twice.
 *
 * Clustering uses the coarser of the two, so a shared access sequence can never
 * be broken across days by a geographic decision.
 */
interface PlanningUnit {
  key: string;
  members: PlanningCandidate[];
  /** The member nearest base; the unit is clustered as if it were this place. */
  representativeId: string;
  maxDriveMinutes: number;
  topPriority: number;
}

function buildUnits(
  candidates: readonly PlanningCandidate[],
  unitByPlaceId: ReadonlyMap<string, AccessUnit>,
): PlanningUnit[] {
  const byKey = new Map<string, PlanningCandidate[]>();
  for (const candidate of candidates) {
    const key =
      candidate.place.accessGroup?.id ??
      unitByPlaceId.get(candidate.place.id)?.key ??
      candidate.place.id;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(candidate);
    else byKey.set(key, [candidate]);
  }

  return [...byKey.entries()]
    .map(([key, members]) => {
      const sorted = [...members].sort(
        (a, b) =>
          a.travelMinutesFromBase - b.travelMinutesFromBase || a.place.id.localeCompare(b.place.id),
      );
      return {
        key,
        members: sorted,
        representativeId: sorted[0]!.place.id,
        /*
         * The furthest member, in whatever mode reaches it. Named `maxDrive`
         * historically and read as a distance ordering rather than as a budget,
         * which is why the rename below it is safe — nothing compares this to
         * `maxDailyDriveMinutes`.
         */
        maxDriveMinutes: Math.max(...sorted.map((member) => member.travelMinutesFromBase)),
        topPriority: Math.max(...sorted.map((member) => member.priority)),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Weather's entire authority over day assignment, in one function.
 *
 * It arrives *after* legality: `pool` already holds only the days on which every
 * reachable, open part of this cluster works, and every day in it is a day the
 * plan would have been happy with. So the choice here can never produce an
 * illegal itinerary — the worst it can do is pick a legal day that is slightly
 * less balanced than the one load-spreading would have chosen.
 *
 * It is also deliberately reluctant. Clustering has already spent effort making
 * each day geographically coherent, and every move trades some of that for a
 * prediction. `isMeaningfullyBetter` is the exchange rate: it takes a genuine
 * change of category — settled to showery, clear to shut-in — before anything
 * moves, so a plan cannot reshuffle over the difference between a 19% and a 21%
 * chance of rain, which is a difference no traveller could perceive and no
 * forecast could support.
 *
 * Ties fall back to the balanced choice, so identical inputs always produce the
 * identical plan.
 */
function preferByWeather(
  cluster: { placeIds: string[] },
  pool: readonly PlannedDay[],
  balanced: PlannedDay | undefined,
  weatherPreferenceFor: (placeIds: readonly string[], date: string) => number | null,
): PlannedDay | undefined {
  if (!balanced || pool.length < 2) return balanced;

  const incumbent = weatherPreferenceFor(cluster.placeIds, balanced.date);
  if (incumbent === null) return balanced;

  let best = balanced;
  let bestScore = incumbent;
  for (const day of pool) {
    const score = weatherPreferenceFor(cluster.placeIds, day.date);
    if (score === null) continue;
    // Strictly greater, so an equal score never displaces the balanced choice
    // and the comparison order cannot leak into the result.
    if (score > bestScore) {
      best = day;
      bestScore = score;
    }
  }

  return isMeaningfullyBetter(bestScore, incumbent) ? best : balanced;
}

/**
 * Below this a day cannot hold even the shortest stop plus the drive to it, so it
 * must not be handed a geographic cluster. Giving a 30-minute departure morning a
 * quarter of the trip's places strands them: they overflow into a second pass and
 * end up wherever there is room rather than where they belong.
 */
const MIN_PLANNABLE_MINUTES = 90;

/**
 * Does this traveller want their hard days kept apart?
 *
 * §9.3 lists "long hikes on consecutive days when pace says otherwise" beside
 * "a museum every day" as things personalization must not do — and the planner
 * had a per-day intensity ceiling and nothing at all between days.
 *
 * Two answers make somebody exempt, and both are the traveller saying so
 * themselves: a fast pace is a request for a full week, and a preferred
 * intensity of `strenuous` is a request for hard days. Everybody else — which is
 * most people, including the balanced-pace hiker this exists for — gets a day's
 * recovery between climbs where the trip can afford one.
 */
export function wantsStrenuousDaysApart(profile: TravelerProfile): boolean {
  return profile.pace !== 'fast' && profile.derived.preferredPhysicalIntensity !== 'strenuous';
}

/**
 * Groups places geographically and hands each group to a day.
 *
 * Three decisions carry the quality here:
 *
 * 1. Clustering runs on travel time, not straight-line distance, and on *units*
 *    rather than places — so anything behind a shared gate is guaranteed to land
 *    in the same group and therefore on the same day.
 * 2. Only days that can genuinely hold a stop take part, so a cluster is never
 *    handed to a departure morning that has half an hour in it.
 * 3. Groups are matched to days by weight: the cluster that reaches furthest from
 *    base is paired with the day that has the most hours in it. That is what stops
 *    a two-hour round trip being handed to the arrival afternoon.
 */
export function assignToDays(
  eligible: readonly PlanningCandidate[],
  days: readonly PlannedDay[],
  matrix: TravelTimeMatrix,
  /**
   * The base a given date starts from.
   *
   * A function rather than a string, because on a multi-base trip the answer
   * changes partway through — and a day clustered around the base the traveller
   * has already left is a day of impossible drives that all look reasonable
   * individually.
   */
  baseIdFor: (date: string) => string,
  unitByPlaceId: ReadonlyMap<string, AccessUnit>,
  /** Unit key → the dates a legal way in exists. Absent means unconstrained. */
  feasibleDates: ReadonlyMap<string, ReadonlySet<string>>,
  /** Place id → the dates it is open long enough to visit. Absent means unconstrained. */
  openDates: ReadonlyMap<string, ReadonlySet<string>>,
  /**
   * How much a set of places wants a date, 0–1, or null when there is nothing
   * to go on. Null is the normal answer beyond the forecast horizon and it
   * means "leave the assignment exactly as geography made it" — which is the
   * only honest thing a fortnight of past Augusts can say about next Tuesday.
   */
  weatherPreferenceFor: (placeIds: readonly string[], date: string) => number | null = () => null,
  /**
   * Whether this traveller's hard days should be kept off each other's heels.
   * See `wantsStrenuousDaysApart` — §9.3's "long hikes on consecutive days when
   * pace says otherwise".
   */
  separateStrenuousDays = false,
): DayAssignment[] {
  const usableDays = days.filter((day) => day.capacityMinutes >= MIN_PLANNABLE_MINUTES);
  if (usableDays.length === 0 || eligible.length === 0) {
    return days.map((day) => ({ day, candidates: [] }));
  }

  const units = buildUnits(eligible, unitByPlaceId);
  /*
   * Seeded on the first day's base. On a single-base trip that is the base; on
   * a multi-base one it is where the traveller starts, which is the right end
   * of the route to grow clusters outward from. Which day a cluster then lands
   * on is decided below, and *that* is where the base actually binds.
   */
  const clusters = clusterByTravelTime(
    matrix,
    units.map((unit) => unit.representativeId),
    { k: usableDays.length, baseId: baseIdFor(usableDays[0]!.date) },
  );

  const unitByRepresentative = new Map(units.map((unit) => [unit.representativeId, unit]));

  const clusterLoads = clusters.map((cluster) => {
    const members = cluster.memberIds
      .map((id) => unitByRepresentative.get(id))
      .filter((unit): unit is PlanningUnit => unit !== undefined);
    return {
      candidates: members.flatMap((unit) => unit.members),
      // The access units inside this geographic cluster, so day assignment can
      // ask "can this actually be reached on that date?".
      unitKeys: [
        ...new Set(
          members.flatMap((unit) =>
            unit.members.map((member) => unitByPlaceId.get(member.place.id)?.key ?? unit.key),
          ),
        ),
      ],
      placeIds: members.flatMap((unit) => unit.members.map((member) => member.place.id)),
      weight: members.length > 0 ? Math.max(...members.map((unit) => unit.maxDriveMinutes)) : 0,
      topPriority: members.length > 0 ? Math.max(...members.map((unit) => unit.topPriority)) : 0,
      /* One hard stop is enough to make the day a hard day. */
      strenuous: members.some((unit) =>
        unit.members.some((member) => member.place.physicalIntensity === 'strenuous'),
      ),
    };
  });

  // Heaviest cluster to the roomiest day.
  const orderedClusters = [...clusterLoads].sort(
    (a, b) => b.weight - a.weight || b.topPriority - a.topPriority,
  );
  const orderedDays = [...usableDays].sort(
    (a, b) => b.capacityMinutes - a.capacityMinutes || a.dayNumber - b.dayNumber,
  );

  const assignmentByDay = new Map<number, PlanningCandidate[]>();
  for (const day of days) assignmentByDay.set(day.dayNumber, []);

  /**
   * How much of a cluster genuinely works on a given date — counting both
   * halves of the question, because they fail independently.
   *
   * Without the access half, geography alone decides the day and a
   * shuttle-served valley lands on a Tuesday the shuttle does not run. Without
   * the hours half, a state park that shuts on Wednesdays lands on Wednesday.
   * Either way the packer then rejects it and it spills into an overflow pass,
   * by which time every other day is full of auto-picks — and a traveller's
   * hand-picked stop loses to a weekday.
   */
  const workableParts = (cluster: (typeof clusterLoads)[number], date: string) => {
    const reachableUnits = cluster.unitKeys.filter(
      (key) => feasibleDates.get(key)?.has(date) ?? true,
    ).length;
    const openPlaces = cluster.placeIds.filter(
      (placeId) => openDates.get(placeId)?.has(date) ?? true,
    ).length;
    return reachableUnits + openPlaces;
  };

  /**
   * Whether this day's base can actually reach this cluster.
   *
   * The gate that makes multi-base real. Without it the assigner is free to put
   * a stop beside the second base on a day the traveller is still at the first,
   * and every individual number stays consistent — the day just contains a
   * six-hour round trip nobody would make.
   *
   * Measured, never assumed: a pair the matrix cannot answer for is *not*
   * reachable. On a single-base trip every day has the same base and this is
   * always true, so nothing changes for the regions that already worked.
   */
  const reachableFromDayBase = (cluster: (typeof clusterLoads)[number], date: string): boolean => {
    const base = baseIdFor(date);
    if (cluster.placeIds.length === 0) return true;
    return cluster.placeIds.some((placeId) => tryLeg(matrix, base, placeId) !== null);
  };

  // Fewest clusters so far wins, and `sort` is stable, so the capacity order
  // already baked into `orderedDays` breaks every tie. Fully deterministic.
  const clustersPerDay = new Map<number, number>();
  /** Days already carrying a hard stop, so the next one can be kept off them. */
  const strenuousDays = new Set<number>();

  for (const cluster of orderedClusters) {
    /*
     * Days whose base cannot reach this cluster are removed *before* the
     * best-fit comparison, not penalised inside it — a cluster the base cannot
     * reach is not a worse choice, it is not a choice.
     */
    const candidateDays = orderedDays.filter((day) => reachableFromDayBase(cluster, day.date));
    if (candidateDays.length === 0) continue;
    const best = Math.max(...candidateDays.map((day) => workableParts(cluster, day.date)));
    const workable = candidateDays.filter((day) => workableParts(cluster, day.date) === best);

    /**
     * SPACING HARD DAYS OUT — §9.3, "long hikes on consecutive days when pace
     * says otherwise".
     *
     * `maxStrenuous` bounds effort *within* a day and nothing bounded it
     * *between* days, so a balanced-pace traveller who likes hiking was
     * perfectly likely to be handed three long climbs in a row: each day passed
     * every check it was given, and the week was punishing. Composition is a
     * property of the sequence, and nothing was looking at the sequence.
     *
     * A narrowing, not a score: days adjacent to one already carrying a hard
     * stop drop out of contention, and everything downstream — load balancing,
     * then weather — chooses among what is left, unchanged. It gives way the
     * moment it would cost the traveller a stop: if nothing non-adjacent is
     * workable, the original pool stands, because a spread-out trip that leaves
     * a lake unvisited is not the trade anybody asked for.
     */
    const spaced =
      separateStrenuousDays && cluster.strenuous
        ? workable.filter(
            (day) =>
              /*
               * The day itself as well as its neighbours: a traveller who wants
               * hard days apart has `maxStrenuous` of one, so stacking two on
               * one day is not spacing, it is one of them being dropped by the
               * packer a few steps later.
               */
              !strenuousDays.has(day.dayNumber) &&
              !strenuousDays.has(day.dayNumber - 1) &&
              !strenuousDays.has(day.dayNumber + 1),
          )
        : workable;
    const pool = spaced.length > 0 ? spaced : workable;

    const balanced = [...pool].sort(
      (a, b) => (clustersPerDay.get(a.dayNumber) ?? 0) - (clustersPerDay.get(b.dayNumber) ?? 0),
    )[0];
    const day = preferByWeather(cluster, pool, balanced, weatherPreferenceFor);
    if (!day) continue;
    clustersPerDay.set(day.dayNumber, (clustersPerDay.get(day.dayNumber) ?? 0) + 1);
    if (cluster.strenuous) strenuousDays.add(day.dayNumber);
    assignmentByDay.get(day.dayNumber)?.push(...cluster.candidates);
  }

  return days.map((day) => ({
    day,
    candidates: (assignmentByDay.get(day.dayNumber) ?? []).sort(
      (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
    ),
  }));
}
