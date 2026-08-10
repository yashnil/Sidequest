import 'server-only';
import {
  JOURNEY_SPAN_VERSION,
  journeySpanSchema,
  stageObservationSchema,
  type JourneySpan,
  type JourneySpanKind,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * THE CLOCK THAT CROSSES SCREENS.
 *
 * `timing-repository` records what each stage of a compilation cost. This
 * records what the whole path cost, which is a different measurement with a
 * different consumer: one answers "which stage is slow", the other answers "is
 * the product fast enough to use", and neither can be derived from the other.
 *
 * Writes are best-effort and never fatal. A measurement is worth having and is
 * not worth failing a finished questionnaire or a finished plan for — the same
 * posture `recordStageObservation` and `saveWorkPlan` already take, and for the
 * same reason: an instrument that can break the thing it measures is worse than
 * no instrument.
 *
 * One row per trip per span. A traveller who re-answers the questionnaire has
 * taken a *different* amount of time to reach the same milestone, and keeping
 * both would leave the reader to guess which one "how long did this take" means.
 */
export function recordJourneySpan(span: JourneySpan): void {
  try {
    const parsed = journeySpanSchema.parse(span);
    getDb()
      .prepare(
        `INSERT INTO journey_spans (trip_id, span, duration_ms, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trip_id, span) DO UPDATE SET
           duration_ms = excluded.duration_ms,
           payload_json = excluded.payload_json,
           observed_at = excluded.observed_at`,
      )
      .run(
        parsed.tripId,
        parsed.span,
        parsed.durationMs,
        JSON.stringify(parsed),
        parsed.observedAt,
      );
  } catch (error) {
    console.error('Could not record a journey span', { span: span.span, error });
  }
}

/** Every span recorded for a trip, oldest milestone first. */
export function journeySpansFor(tripId: string): JourneySpan[] {
  const rows = getDb()
    .prepare(`SELECT payload_json FROM journey_spans WHERE trip_id = ? ORDER BY id`)
    .all(tripId) as { payload_json: string }[];
  const spans: JourneySpan[] = [];
  for (const row of rows) {
    /*
     * A row this build cannot read is skipped rather than thrown.
     *
     * The same policy the composer and the preflight take: losing one
     * measurement is cheaper than losing the screen it appears on, and a
     * diagnostic that can take down a trip page has its priorities backwards.
     */
    const parsed = journeySpanSchema.safeParse(JSON.parse(row.payload_json));
    if (parsed.success) spans.push(parsed.data);
  }
  return spans;
}

/**
 * The part of a wall-clock span this system can account for as its own work.
 *
 * Summed from the stage observations this trip's own builds wrote, preferring
 * the monotonic figure exactly as the estimator does: `performance.now()` does
 * not jump when NTP corrects the system clock, and a wall-clock span that
 * crossed a correction is the correction rather than a duration.
 *
 * Returns `null` when there is nothing to attribute, and the null is the point:
 * a zero would print as "we did no work" when the truth is that nobody measured
 * any. Callers pass it straight through to the optional `machineMs`.
 */
export function attributableWorkMs(tripId: string, sinceIso: string): number | null {
  try {
    const rows = getDb()
      .prepare(
        `SELECT o.payload_json AS payload_json
           FROM stage_observations o
           JOIN compilation_jobs j ON j.id = o.job_id
          WHERE j.trip_id = ? AND o.observed_at >= ?`,
      )
      .all(tripId, sinceIso) as { payload_json: string }[];
    if (rows.length === 0) return null;

    let total = 0;
    let counted = 0;
    for (const row of rows) {
      const parsed = stageObservationSchema.safeParse(JSON.parse(row.payload_json));
      /*
       * A row we cannot read contributes nothing and is not an error: the figure
       * it feeds is explicitly "what we can account for", not "what happened".
       */
      if (!parsed.success) continue;
      total += parsed.data.monotonicMs ?? parsed.data.durationMs;
      counted += 1;
    }
    return counted === 0 ? null : Math.round(total);
  } catch (error) {
    console.error('Could not attribute journey work', { tripId, error });
    return null;
  }
}

/** Build a span from two instants, with the bucketing a comparison needs. */
export function journeySpanOf(input: {
  tripId: string;
  span: JourneySpanKind;
  startedAt: Date;
  completedAt: Date;
  machineMs?: number | null;
  breadth?: JourneySpan['breadth'];
  shape?: JourneySpan['shape'];
}): JourneySpan {
  const durationMs = Math.max(0, input.completedAt.getTime() - input.startedAt.getTime());
  return {
    schemaVersion: JOURNEY_SPAN_VERSION,
    tripId: input.tripId,
    span: input.span,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs,
    ...(input.machineMs === null || input.machineMs === undefined
      ? {}
      : { machineMs: Math.max(0, Math.round(input.machineMs)) }),
    ...(input.breadth ? { breadth: input.breadth } : {}),
    ...(input.shape ? { shape: input.shape } : {}),
    observedAt: input.completedAt.toISOString(),
  };
}
