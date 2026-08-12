/**
 * WHAT THE BUILD FOUND, RE-DERIVED AT RENDER SO A STORED SENTENCE CANNOT LIE.
 *
 * A live artifact rendered this, verbatim, on the screen a traveller reaches
 * before the questionnaire:
 *
 * ```text
 * WALKING TIMES    Good   Measured road times across 26 points.
 * PUBLIC TRANSPORT Good   Measured road times across 26 points.
 * DRIVING TIMES    Not relevant here   No driving is planned here.
 * ```
 *
 * Three rows contradicting each other about the same trip. The compiler that
 * wrote them has since been repaired — it grades public transport on transit
 * evidence and names the matrix's own network — but a coverage report is
 * **stored inside the artifact**, so every region compiled before the repair
 * still carries those sentences and always will. Rebuilding is the only thing
 * that would change them, and rebuilding costs money.
 *
 * So the fix has to happen where the report is read. This re-derives the three
 * routing rows from two facts the same artifact carries and cannot fake — the
 * matrix's declared mode, and whether any transit journey was actually measured
 * — and refuses the stored grade whenever the artifact itself cannot support
 * it. A road matrix can no longer appear under a walking or a public-transport
 * heading, whatever any row says, because those two headings are no longer
 * allowed to read the matrix at all.
 *
 * Everything outside routing passes through untouched. This is a guard against
 * one specific class of stored contradiction, not a second grading system.
 */

import type { CoverageDimension, CoverageLevel, CoverageReport } from '@sidequest/core';

export interface RoutingTruth {
  /** The network the stored travel-time matrix actually measured. */
  matrixMode: 'car' | 'foot' | 'transit' | null;
  /** How many public-transport journeys came back from a timetable provider. */
  transitMeasured: number;
  /** How many were asked for. Zero means nobody was asked, not "none exist". */
  transitRequested: number;
}

type Dimension = CoverageReport['dimensions'][number];

/**
 * The sentence a routing row is allowed to carry, given what was measured.
 *
 * Null means "the stored row is consistent with the artifact, leave it alone".
 */
function routingOverride(
  dimension: CoverageDimension,
  truth: RoutingTruth,
  /**
   * Whether this trip is planned around a car, read off the artifact's own
   * driving row.
   *
   * It decides whether an unmeasured walking time is a *gap* or simply not
   * relevant, and the difference matters: on a car trip nobody walks between
   * stops, so "Not relevant here" is correct and an amber row would be noise.
   * On a car-free trip walking is how the traveller gets everywhere, so the
   * same missing measurement is a real gap and must not be filed under "not
   * relevant" — which is what the stored row's own level would have done.
   */
  drivingPlanned: boolean,
): { level: CoverageLevel; detail: string } | null {
  if (dimension === 'road_routing') {
    if (truth.matrixMode === 'car') return null;
    return {
      /*
       * `not_applicable` rather than `unavailable`: a car-free trip has no
       * driving gap, and grading it as a gap puts an amber row on a report that
       * is otherwise clean. See `COVERAGE_LEVELS` on why that distinction is
       * load-bearing.
       */
      level: 'not_applicable',
      detail: 'This trip is not planned around a car, so no driving times were measured.',
    };
  }

  if (dimension === 'walking_routing') {
    if (truth.matrixMode === 'foot') return null;
    return {
      level: drivingPlanned ? 'not_applicable' : 'unavailable',
      detail:
        truth.matrixMode === 'car'
          ? 'Travel times here were measured by road. Walking between stops was not timed separately.'
          : 'No walking times were measured for this trip.',
    };
  }

  if (dimension === 'transit_routing') {
    /*
     * The one dimension a matrix may never grade. A matrix has a single mode,
     * so a transit answer can only come from `transitEvidence` — and every
     * artifact compiled before that field existed has none, which is exactly
     * the case that used to borrow the road sentence.
     */
    if (truth.transitMeasured > 0) return null;
    return {
      level: 'unavailable',
      detail:
        truth.transitRequested > 0
          ? 'We asked about public transport and no timetable came back, so those journeys are unverified.'
          : 'Nothing in this build can check timetables, so public transport times here are unverified.',
    };
  }

  return null;
}

/**
 * The stored report with its routing rows made consistent with the artifact.
 *
 * Returned as a new array; the stored report is never mutated, because the same
 * object is read by the board and by anything else holding the region.
 */
export function reconcileRouting(
  dimensions: readonly Dimension[],
  truth: RoutingTruth,
): Dimension[] {
  /*
   * The compiler's own statement of whether this trip has a car in it, read
   * from the driving row rather than from the matrix — a matrix has a mode
   * whatever the trip is, and the observed defect is precisely an artifact
   * whose matrix said `car` for a trip whose driving row said no driving is
   * planned.
   */
  const drivingPlanned =
    dimensions.find((entry) => entry.dimension === 'road_routing')?.level !== 'not_applicable';

  return dimensions.map((entry) => {
    const override = routingOverride(entry.dimension, truth, drivingPlanned);
    if (!override) return entry;
    if (entry.level === override.level && entry.detail === override.detail) return entry;
    return { ...entry, level: override.level, detail: override.detail };
  });
}

/**
 * THE TWO OR THREE SENTENCES THAT REPLACED A TWENTY-THREE-ROW TABLE.
 *
 * The plan page led with every dimension graded, then repeated the weak ones
 * underneath as "What we could not do", then printed release ids and per-record
 * timestamps — about three and a half thousand pixels of it — and put the only
 * way forward at the bottom. Somebody arriving to find out whether their trip
 * is worth carrying on with had to read a build report to find out.
 *
 * What a traveller needs at this moment is two things: what we found, and the
 * one or two gaps that would actually change how they plan. A gap only changes
 * planning if it is about something they will have to work around — when places
 * open, whether they can get in, how they get about. A thin row on "dietary
 * information" is worth saying somewhere; it is not worth a headline.
 *
 * Everything else still exists, unchanged, behind one disclosure. Nothing is
 * deleted — the argument is about what leads.
 */
const PLANNING_CRITICAL: readonly CoverageDimension[] = [
  'operating_hours',
  'access_evidence',
  'temporary_access',
  'road_routing',
  'walking_routing',
  'transit_routing',
  'planner_readiness',
];

/** How a gap in each of those reads as a consequence rather than as a grade. */
const GAP_CONSEQUENCE: Partial<Record<CoverageDimension, string>> = {
  operating_hours: 'we could not confirm opening times, so check them before you set out',
  access_evidence: 'entry conditions are unpublished for most of these, so check before you go',
  temporary_access: 'seasonal closures and permits here are worth checking yourself',
  road_routing: 'driving times between stops are estimated rather than measured',
  walking_routing: 'walking times between stops are estimated rather than measured',
  transit_routing: 'public-transport times are unverified, so allow more than you think',
  planner_readiness: 'there is enough here to lay out days, but the timings will be loose',
};

export interface CoverageHeadline {
  /** What we found, in one sentence. */
  found: string;
  /** The gaps that change how somebody plans. At most two, often none. */
  gaps: string[];
  /** How many rows the full report holds, for the disclosure's own label. */
  rowCount: number;
}

export function coverageHeadline(input: {
  dimensions: readonly Dimension[];
  placeCount: number;
  areaCount: number;
  baseName: string;
}): CoverageHeadline {
  const areas = Math.max(1, input.areaCount);
  /*
   * Two counts, not three.
   *
   * The satellite count is deliberately not here. A satellite is a *grouping*
   * of places reachable from the base, so it is not a subset of the place
   * count — and a real artifact produced 24 of each, which rendered as "24
   * places, including 24 side trips" and read as an arithmetic bug. It is a
   * build statistic; it belongs in the disclosure with the other build
   * statistics, where nothing is trying to be a sentence.
   */
  const found = `We found ${input.placeCount} places worth your time around ${input.baseName}, across ${areas} area${areas === 1 ? '' : 's'}.`;

  const gaps: string[] = [];
  for (const dimension of PLANNING_CRITICAL) {
    if (gaps.length === 2) break;
    const entry = input.dimensions.find((row) => row.dimension === dimension);
    if (!entry) continue;
    if (entry.level !== 'weak' && entry.level !== 'unavailable') continue;
    const consequence = GAP_CONSEQUENCE[dimension];
    if (consequence) gaps.push(consequence);
  }

  return { found, gaps, rowCount: input.dimensions.length };
}
