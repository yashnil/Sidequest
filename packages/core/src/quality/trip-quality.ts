import type { Itinerary } from '../schemas/itinerary';
import type { StructuralMetrics } from './metrics';
import type { Chapter, Stay } from '../experience/chapters';
import type { RouteCompleteness } from '../feasibility/readiness-requirements';

/**
 * V11 §2 — THE TRIP QUALITY REPORT.
 *
 * Deterministic, internal by default, and **never one number**. §2 is explicit:
 * "Do not reduce travel taste to one opaque score", and "Do not expose a 73/100
 * trip score unless product research proves that helps". So every dimension
 * stands on its own, each with a verdict, a figure a person could check by hand,
 * and one sentence.
 *
 * Its job is to catch a bad plan *before* the traveller sees it. Both founder
 * trips would have failed several dimensions here while heading themselves
 * "Ready, with cautions" and "Needs a decision":
 *
 *   Canadian Rockies — routeCoherence weak (day 4 drives the parkway twice),
 *                      signatureStrength weak (a riverside stroll leads the list),
 *                      routeCriticalPlacement weak (a base 200 km out)
 *   Kyrgyzstan       — baseEfficiency weak (seven bases, a duplicate, a camp),
 *                      transportConsistency weak (a bus on a private-driver trip),
 *                      measurementIntegrity weak (7 of 29 legs, one of them 87 hours)
 *
 * ## The rule that shapes every dimension
 *
 * `unknown` is a verdict. A dimension nobody could measure says so and is left
 * out of every count of what is weak — the same discipline `schemas/shortlist.ts`
 * applies to ranking, and for the same reason: "we could not measure the legs"
 * and "the legs are bad" are different sentences about different things.
 */

export const TRIP_QUALITY_DIMENSIONS = [
  'routeCoherence',
  'geographicProgression',
  'baseEfficiency',
  'chapterRhythm',
  'recoveryPlacement',
  'signatureStrength',
  'experientialDiversity',
  'transportConsistency',
  'measurementIntegrity',
  'routeCriticalPlacement',
  'temporalFeasibility',
  'uncertaintyBurden',
] as const;
export type TripQualityDimension = (typeof TRIP_QUALITY_DIMENSIONS)[number];

export const TRIP_QUALITY_LABELS: Record<TripQualityDimension, string> = {
  routeCoherence: 'Route coherence',
  geographicProgression: 'Geographic progression',
  baseEfficiency: 'Base efficiency',
  chapterRhythm: 'Chapter and rhythm',
  recoveryPlacement: 'Recovery placement',
  signatureStrength: 'Signature experiences',
  experientialDiversity: 'Experiential diversity',
  transportConsistency: 'Transport-mode consistency',
  measurementIntegrity: 'Measurement integrity',
  routeCriticalPlacement: 'Route-critical placement',
  temporalFeasibility: 'Temporal feasibility',
  uncertaintyBurden: 'Uncertainty carried by the traveller',
};

export type QualityVerdict = 'strong' | 'adequate' | 'weak' | 'unknown';

export interface TripQualityFinding {
  dimension: TripQualityDimension;
  label: string;
  verdict: QualityVerdict;
  /** The figure the verdict rests on, as a person would check it. Absent when unknown. */
  figure?: string;
  /** One sentence. Internal prose: precise, not traveller copy. */
  detail: string;
}

export interface TripQualityReport {
  version: 1;
  findings: TripQualityFinding[];
  /** Dimensions that came out weak. The list a build should be stopped and looked at over. */
  weak: TripQualityDimension[];
  /** Dimensions nothing could measure. Never counted as passes. */
  unmeasured: TripQualityDimension[];
}

export interface TripQualityInput {
  itinerary: Pick<Itinerary, 'days' | 'package' | 'transportStrategy'>;
  metrics?: StructuralMetrics | null;
  stays?: readonly Stay[];
  chapters?: readonly Chapter[];
  completeness?: RouteCompleteness | null;
  /** Great-circle excess per day, from the spatial-order compiler: `{ dayNumber, excessRatio }`. */
  dayExcess?: readonly { dayNumber: number; excessRatio: number }[];
  /** Modes the plan actually uses, and the one its own thesis names. */
  transport?: { declared: string | null; used: readonly string[] } | null;
  /** Measurements refused as implausible during the build. */
  implausibleMeasurements?: number;
}

function finding(dimension: TripQualityDimension, verdict: QualityVerdict, detail: string, figure?: string): TripQualityFinding {
  return { dimension, label: TRIP_QUALITY_LABELS[dimension], verdict, detail, ...(figure ? { figure } : {}) };
}

function unknownFinding(dimension: TripQualityDimension, why: string): TripQualityFinding {
  return { dimension, label: TRIP_QUALITY_LABELS[dimension], verdict: 'unknown', detail: why };
}

export function buildTripQualityReport(input: TripQualityInput): TripQualityReport {
  const findings: TripQualityFinding[] = [];
  const days = input.itinerary.days;
  const pkg = input.itinerary.package;

  // --- route coherence -------------------------------------------------------------------
  if (!input.dayExcess || input.dayExcess.length === 0) {
    findings.push(unknownFinding('routeCoherence', 'No day could be judged for stop order — nothing on them was placed.'));
  } else {
    const worst = [...input.dayExcess].sort((a, b) => b.excessRatio - a.excessRatio)[0]!;
    const bad = input.dayExcess.filter((day) => day.excessRatio > 0.2);
    findings.push(
      finding(
        'routeCoherence',
        bad.length === 0 ? 'strong' : worst.excessRatio > 0.5 ? 'weak' : 'adequate',
        bad.length === 0
          ? 'Every judgeable day runs its stops close to the shortest chain through them.'
          : `${bad.length} day(s) cover materially more ground than their own stops require; the worst is day ${worst.dayNumber}.`,
        `worst day ${worst.dayNumber}: ${Math.round(worst.excessRatio * 100)}% over the shortest chain`,
      ),
    );
  }

  // --- geographic progression ------------------------------------------------------------
  const placedStays = (input.stays ?? []).filter((stay) => stay.coordinates);
  if (placedStays.length < 3) {
    findings.push(unknownFinding('geographicProgression', 'Fewer than three placed stays: there is no progression to judge.'));
  } else {
    /*
     * A route that revisits an area it has already left is not automatically
     * wrong — a loop returns to its gateway by design — so this counts only
     * *interior* revisits: an area left and come back to with something else in
     * between, other than the final stay.
     */
    const keyOf = (stay: Stay) => `${Math.round(stay.coordinates!.lat * 2) / 2},${Math.round(stay.coordinates!.lng * 2) / 2}`;
    const seen = new Map<string, number>();
    let revisits = 0;
    placedStays.forEach((stay, index) => {
      const key = keyOf(stay);
      const previous = seen.get(key);
      if (previous !== undefined && index - previous > 1 && index !== placedStays.length - 1) revisits += 1;
      seen.set(key, index);
    });
    findings.push(
      finding(
        'geographicProgression',
        revisits === 0 ? 'strong' : revisits === 1 ? 'adequate' : 'weak',
        revisits === 0 ? 'The route moves through its areas once and does not double back.' : `${revisits} area(s) are returned to mid-route rather than on the way out.`,
        `${revisits} interior revisit(s) across ${placedStays.length} stays`,
      ),
    );
  }

  // --- base efficiency -------------------------------------------------------------------
  const stays = input.stays ?? [];
  if (stays.length === 0) {
    findings.push(unknownFinding('baseEfficiency', 'The plan records no stays.'));
  } else {
    const nights = stays.reduce((total, stay) => total + stay.nights, 0);
    const changes = stays.filter((stay) => stay.countsAsHotelChange).length;
    const ownOneNighters = stays.filter((stay) => stay.nights === 1 && !stay.withinExperience).length;
    const ratio = nights > 0 ? changes / nights : 0;
    findings.push(
      finding(
        'baseEfficiency',
        ratio <= 0.25 ? 'strong' : ratio <= 0.45 ? 'adequate' : 'weak',
        ratio <= 0.25
          ? 'The traveller unpacks rarely for the ground the route covers.'
          : `${changes} change(s) of hotel across ${nights} nights, ${ownOneNighters} of them one-night stays the traveller books themselves.`,
        `${changes} changes / ${nights} nights`,
      ),
    );
  }

  // --- chapter rhythm --------------------------------------------------------------------
  const chapters = input.chapters ?? [];
  if (chapters.length === 0) {
    findings.push(unknownFinding('chapterRhythm', 'No chapters were derived for this trip.'));
  } else {
    /* A trip that is all one chapter has no rhythm; a trip that is all one-day chapters has no rest. */
    const singles = chapters.filter((chapter) => chapter.dayNumbers.length === 1).length;
    const verdict: QualityVerdict = chapters.length === 1 ? 'weak' : singles / chapters.length > 0.6 ? 'weak' : chapters.length >= 3 ? 'strong' : 'adequate';
    findings.push(
      finding(
        'chapterRhythm',
        verdict,
        chapters.length === 1
          ? 'The whole trip is one undifferentiated chapter.'
          : singles / chapters.length > 0.6
            ? 'Most chapters are a single day: the trip is a sequence of moves rather than a set of places.'
            : `${chapters.length} chapters, ${chapters.map((chapter) => chapter.dayNumbers.length).join('/')} days each.`,
        `${chapters.length} chapters over ${days.length} days`,
      ),
    );
  }

  // --- recovery placement ----------------------------------------------------------------
  const expeditions = chapters.filter((chapter) => chapter.role === 'expedition');
  if (expeditions.length === 0) {
    findings.push(unknownFinding('recoveryPlacement', 'No multi-day experience on this trip, so there is nothing to recover from.'));
  } else {
    const recovered = expeditions.filter((expedition) => {
      const index = chapters.indexOf(expedition);
      const next = chapters[index + 1];
      return next !== undefined && (next.role === 'recovery' || next.role === 'finale');
    }).length;
    findings.push(
      finding(
        'recoveryPlacement',
        recovered === expeditions.length ? 'strong' : recovered > 0 ? 'adequate' : 'weak',
        recovered === expeditions.length ? 'Every demanding chapter is followed by a lighter one.' : `${expeditions.length - recovered} demanding chapter(s) run straight into another.`,
        `${recovered}/${expeditions.length} expeditions followed by recovery`,
      ),
    );
  }

  // --- signature strength ----------------------------------------------------------------
  const signatures = pkg?.signatures ?? [];
  if (signatures.length === 0) {
    findings.push(unknownFinding('signatureStrength', 'The plan names nothing it is built around.'));
  } else {
    const mean = signatures.reduce((total, signature) => total + signature.score, 0) / signatures.length;
    findings.push(
      finding(
        'signatureStrength',
        mean >= 0.55 ? 'strong' : mean >= 0.38 ? 'adequate' : 'weak',
        mean >= 0.38
          ? `The trip is built around ${signatures.map((signature) => signature.name).join(', ')}.`
          : `The strongest things this plan can name are weak for this traveller: ${signatures.map((signature) => signature.name).join(', ')}.`,
        `mean ${Math.round(mean * 100) / 100} across ${signatures.length}`,
      ),
    );
  }

  // --- experiential diversity ------------------------------------------------------------
  if (!input.metrics) {
    findings.push(unknownFinding('experientialDiversity', 'Structural metrics were not computed for this build.'));
  } else {
    const diversity = input.metrics.activityDiversity;
    findings.push(
      finding(
        'experientialDiversity',
        diversity >= 0.6 ? 'strong' : diversity >= 0.4 ? 'adequate' : 'weak',
        diversity >= 0.4 ? 'The days are made of different kinds of thing.' : 'The trip repeats one or two kinds of experience.',
        `${Math.round(diversity * 100)}% distinct categories`,
      ),
    );
  }

  // --- transport-mode consistency --------------------------------------------------------
  if (!input.transport || input.transport.declared === null) {
    findings.push(unknownFinding('transportConsistency', 'The plan does not declare how the trip moves.'));
  } else {
    /*
     * §10 — a mode the trip's own thesis does not contain, appearing in its days.
     * Walking is always allowed: every trip walks.
     */
    const declared = input.transport.declared;
    const strays = input.transport.used.filter((mode) => mode !== declared && mode !== 'walk' && mode !== 'ferry' && mode !== 'unsupported');
    findings.push(
      finding(
        'transportConsistency',
        strays.length === 0 ? 'strong' : strays.length === 1 ? 'adequate' : 'weak',
        strays.length === 0 ? `Every leg moves the way the plan says the trip moves (${declared}).` : `The plan says ${declared} and the days also use ${strays.join(', ')}.`,
        strays.length === 0 ? 'no stray modes' : `${strays.length} stray mode(s)`,
      ),
    );
  }

  // --- measurement integrity -------------------------------------------------------------
  const implausible = input.implausibleMeasurements ?? 0;
  if (!input.completeness) {
    findings.push(unknownFinding('measurementIntegrity', 'Route completeness was not computed for this build.'));
  } else {
    const { legsTimed, legsTotal } = input.completeness;
    const rate = legsTotal > 0 ? legsTimed / legsTotal : 1;
    findings.push(
      finding(
        'measurementIntegrity',
        /* A single measurement we refused to trust is worse than several we never got: one is a wrong number, the others are honest gaps. */
        implausible > 0 ? 'weak' : rate >= 0.8 ? 'strong' : rate >= 0.5 ? 'adequate' : 'weak',
        implausible > 0
          ? `${implausible} provider measurement(s) came back in a shape no journey takes and were refused.`
          : `${legsTimed} of ${legsTotal} journeys carry a time.`,
        `${legsTimed}/${legsTotal} timed, ${implausible} refused`,
      ),
    );
  }

  // --- route-critical placement ----------------------------------------------------------
  if (!input.completeness || input.completeness.routeCriticalTotal === 0) {
    findings.push(unknownFinding('routeCriticalPlacement', 'Nothing on this trip was treated as route-critical.'));
  } else {
    const { routeCriticalPlaced, routeCriticalTotal } = input.completeness;
    const rate = routeCriticalPlaced / routeCriticalTotal;
    findings.push(
      finding(
        'routeCriticalPlacement',
        rate === 1 ? 'strong' : rate >= 0.85 ? 'adequate' : 'weak',
        rate === 1 ? 'Every place the route depends on is located.' : `${routeCriticalTotal - routeCriticalPlaced} of ${routeCriticalTotal} places the route depends on are not located.`,
        `${routeCriticalPlaced}/${routeCriticalTotal}`,
      ),
    );
  }

  // --- temporal feasibility --------------------------------------------------------------
  if (!input.metrics) {
    findings.push(unknownFinding('temporalFeasibility', 'Structural metrics were not computed for this build.'));
  } else {
    const violations = input.metrics.timeWindowViolations + input.metrics.daylightViolations;
    findings.push(
      finding(
        'temporalFeasibility',
        violations === 0 ? 'strong' : violations <= 2 ? 'adequate' : 'weak',
        violations === 0 ? 'Every stop sits inside its own day and its own daylight.' : `${violations} stop(s) sit outside the hour or the light they need.`,
        `${violations} violation(s)`,
      ),
    );
  }

  // --- uncertainty burden ----------------------------------------------------------------
  const open = (pkg?.feasibility?.items ?? []).filter((item) => item.severity === 'dependency');
  const travellerOwned = open.filter((item) => item.owner !== 'sidequest').length;
  findings.push(
    finding(
      'uncertaintyBurden',
      open.length === 0 ? 'strong' : travellerOwned === 0 ? 'adequate' : travellerOwned <= 2 ? 'adequate' : 'weak',
      open.length === 0
        ? 'Nothing outstanding.'
        : travellerOwned === 0
          ? `${open.length} thing(s) outstanding, all of them Sidequest's own work rather than the traveller's.`
          : `${travellerOwned} of ${open.length} outstanding thing(s) are put to the traveller.`,
      `${travellerOwned} traveller / ${open.length - travellerOwned} Sidequest`,
    ),
  );

  return {
    version: 1,
    findings,
    weak: findings.filter((entry) => entry.verdict === 'weak').map((entry) => entry.dimension),
    unmeasured: findings.filter((entry) => entry.verdict === 'unknown').map((entry) => entry.dimension),
  };
}
