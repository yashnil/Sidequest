import { z } from 'zod';
import {
  COMPILATION_STAGE_LABELS,
  type CompilationStage,
  type StageRecord,
} from './compilation';

/**
 * TWENTY-SIX ROWS OF BUILD LOG, GROUPED INTO SOMETHING A TRAVELLER CAN READ.
 *
 * The stage vocabulary is not the problem — every one of those stages fails for
 * a different reason and an operator needs to see which. The problem is that it
 * was rendered as the *primary* progress display, so somebody waiting for their
 * trip watched "Matching records across sources" and "Working out who to
 * believe" scroll past with no idea which of them mattered or how much was left.
 *
 * So there are two views of one truth:
 *
 * - **Five phases**, named for what the traveller is getting.
 * - **The stages**, unchanged, behind a disclosure.
 *
 * The mapping is total and checked by a test: a stage with no phase would vanish
 * from the grouped view, which is worse than the flat list it replaced.
 */

export const COMPILATION_PHASES = [
  'understanding',
  'shaping',
  'finding',
  'verifying',
  'building',
] as const;
export const compilationPhaseSchema = z.enum(COMPILATION_PHASES);
export type CompilationPhase = z.infer<typeof compilationPhaseSchema>;

export const COMPILATION_PHASE_LABELS: Record<CompilationPhase, string> = {
  understanding: 'Understanding your trip',
  shaping: 'Shaping the region',
  finding: 'Finding the strongest places',
  verifying: 'Verifying what matters',
  building: 'Building the plan',
};

export const COMPILATION_PHASE_DETAIL: Record<CompilationPhase, string> = {
  understanding: 'Working out what you meant and how much ground it covers.',
  shaping: 'Reading the map data for this region and dividing it into areas.',
  finding: 'Looking for places, merging duplicates, and dropping the empty records.',
  verifying: 'Reading official pages for hours, access, cost and cautions. This is the slow part.',
  building: 'Travel times, weather points, and what we could and could not establish.',
};

export const STAGE_PHASE: Record<CompilationStage, CompilationPhase> = {
  resolving_destination: 'understanding',
  awaiting_clarification: 'understanding',
  confirming_scope: 'understanding',
  resolving_source_release: 'shaping',
  partitioning_scope: 'shaping',
  building_region_pack: 'shaping',
  linking_sources: 'shaping',
  expanding_region: 'shaping',
  discovering_candidates: 'finding',
  deduplicating: 'finding',
  classifying: 'finding',
  filtering_quality: 'finding',
  enriching_priority_candidates: 'finding',
  reusing_shared_claims: 'verifying',
  discovering_sources: 'verifying',
  retrieving_pages: 'verifying',
  extracting_facts: 'verifying',
  reconciling_facts: 'verifying',
  researching_official_constraints: 'verifying',
  resolving_hours_and_access: 'verifying',
  resolving_costs: 'verifying',
  resolving_safety: 'verifying',
  discovering_food: 'verifying',
  enriching_food: 'verifying',
  computing_travel_times: 'building',
  validating_routes: 'building',
  resolving_weather_locations: 'building',
  calculating_coverage: 'building',
  compiling: 'building',
};

export type PhaseStatus = 'waiting' | 'running' | 'done' | 'partial' | 'failed';

export interface PhaseProgress {
  phase: CompilationPhase;
  label: string;
  detail: string;
  status: PhaseStatus;
  /** Stages inside this phase that have finished, out of those it will run. */
  done: number;
  total: number;
  /**
   * The most recent meaningful thing this phase produced.
   *
   * A real outcome with a number in it, taken from the last finished stage that
   * reported one — never a stage name dressed up as progress.
   */
  currentWork?: string;
  latestOutcome?: string;
  /** Warnings from any stage in the phase. Surfaced, never buried. */
  notes: string[];
  /** Seconds this phase has been running or ran for. Measured, not predicted. */
  elapsedSeconds?: number;
  stages: StageRecord[];
}

/**
 * Group a job's stage records into the five phases.
 *
 * `elapsedSeconds` is computed from the stage timestamps rather than from a
 * client clock, so a refresh does not restart it and two tabs agree. There is
 * still no percentage anywhere: several of these stages take as long as somebody
 * else's server takes, and a bar moving at a rate nobody can predict is a lie
 * told with an animation.
 */
export function groupStages(stages: readonly StageRecord[], now: Date): PhaseProgress[] {
  const byPhase = new Map<CompilationPhase, StageRecord[]>();
  for (const phase of COMPILATION_PHASES) byPhase.set(phase, []);
  for (const record of stages) {
    byPhase.get(STAGE_PHASE[record.stage])?.push(record);
  }

  const phases: PhaseProgress[] = [];
  for (const phase of COMPILATION_PHASES) {
    const records = byPhase.get(phase) ?? [];
    if (records.length === 0) continue;

    const done = records.filter((record) => record.status === 'done' || record.status === 'skipped').length;
    const running = records.find((record) => record.status === 'running');
    const failed = records.find((record) => record.status === 'failed');
    const skipped = records.filter((record) => record.status === 'skipped').length;

    const status: PhaseStatus = failed
      ? 'failed'
      : running
        ? 'running'
        : done === 0
          ? 'waiting'
          : done < records.length
            ? 'running'
            : skipped > 0
              ? 'partial'
              : 'done';

    const finished = records.filter((record) => record.outcome !== undefined);
    const latest = finished[finished.length - 1];

    const started = records
      .map((record) => (record.startedAt ? Date.parse(record.startedAt) : Number.NaN))
      .filter((value) => !Number.isNaN(value));
    const ended = records
      .map((record) => (record.finishedAt ? Date.parse(record.finishedAt) : Number.NaN))
      .filter((value) => !Number.isNaN(value));

    const elapsedSeconds =
      started.length === 0
        ? undefined
        : Math.max(
            0,
            Math.round(
              ((status === 'running' ? now.getTime() : Math.max(...ended, ...started)) -
                Math.min(...started)) /
                1000,
            ),
          );

    phases.push({
      phase,
      label: COMPILATION_PHASE_LABELS[phase],
      detail: COMPILATION_PHASE_DETAIL[phase],
      status,
      done,
      total: records.length,
      ...(running ? { currentWork: COMPILATION_STAGE_LABELS[running.stage] } : {}),
      ...(latest?.outcome ? { latestOutcome: latest.outcome } : {}),
      notes: records
        .map((record) => record.note)
        .filter((note): note is string => typeof note === 'string'),
      ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
      stages: records,
    });
  }

  return phases;
}

/**
 * WHAT THE TRAVELLER CAN LOOK AT WHILE THE REST IS STILL RUNNING.
 *
 * The progressive-availability contract. A compilation used to be one long wait
 * with nothing usable until the end; these are the points at which something
 * real becomes inspectable, so the screen can say "you can look at this now"
 * rather than "still working".
 */
export const AVAILABILITY_AFTER: Partial<Record<CompilationPhase, string>> = {
  shaping: 'The region and its areas',
  finding: 'A provisional board — nothing on it is verified yet',
  verifying: 'Verified hours, access and cost, as each one lands',
  building: 'The finished board and a plan',
};

/**
 * How much longer, from what this build has actually done.
 *
 * A *range*, from measured stage durations, and only once enough of them have
 * finished to have something to extrapolate from. Returns null otherwise —
 * which the UI renders as silence rather than as a made-up minute count. The
 * single most common lie a progress screen tells is a confident estimate built
 * from nothing.
 */
export function estimateRemaining(
  phases: readonly PhaseProgress[],
  now: Date,
): { lowSeconds: number; highSeconds: number } | null {
  const finished = phases.flatMap((phase) => phase.stages).filter((record) => record.finishedAt && record.startedAt);
  if (finished.length < 4) return null;

  const durations = finished
    .map((record) => Date.parse(record.finishedAt!) - Date.parse(record.startedAt!))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (durations.length === 0) return null;

  const remaining = phases.reduce((total, phase) => total + (phase.total - phase.done), 0);
  if (remaining === 0) return null;

  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const upper = sorted[Math.floor(sorted.length * 0.9)] ?? median;

  void now;
  return {
    lowSeconds: Math.round((remaining * median) / 1000),
    highSeconds: Math.round((remaining * Math.max(upper, median)) / 1000),
  };
}
