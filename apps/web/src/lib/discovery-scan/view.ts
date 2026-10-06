import 'server-only';
import { SCAN_STAGES, SCAN_STAGE_LABELS, scanView, type ScanCounters, type ScanStage, type ScanView } from '../db/scan-repository';
import { getGenerationProgress } from '../db/generation-progress-repository';
import { isBuildFailureCause } from '../planning/build-failure';
import type { BuildFailureCause } from '../planning/build-failure';

/**
 * V1 CONVERGENCE — THE DISCOVERY SCAN AS A TRAVELLER MAY SEE IT.
 *
 * One projection of the durable scan row, shared by the polling route, the
 * discover page's first paint and the start action, so the three can never
 * disagree. Only what a traveller can use leaves here: the stage in words,
 * real counts as sentences, elapsed time, and a failure as a heading, a
 * sentence and whether trying again can help. Never a provider name, a model
 * id, an environment variable or an internal failure detail — the reference is
 * the only thing that points at the log line.
 */

export interface ScanFailureCopy {
  kind: string;
  heading: string;
  message: string;
  retryable: boolean;
  /** The opaque reference tied to one server log line; null when nothing was recorded (a lost scan). */
  ref: string | null;
}

export interface TravellerScanView {
  state: ScanView['state'];
  stage: ScanStage | null;
  /** The current stage in the traveller's words; null before any scan. */
  label: string | null;
  stages: { id: ScanStage; label: string }[];
  /** Stages already passed, in order. */
  reached: ScanStage[];
  /** What the scan has actually counted so far, as sentences. Nothing estimated, nothing rounded. */
  lines: string[];
  counters: Required<Pick<ScanCounters, 'proposed' | 'placed'>> & { bases: number; unplaced: number; timed: number };
  elapsedSeconds: number;
  /** The traveller asked for the build to follow the scan and it has not started yet. */
  autoBuildPending: boolean;
  /** The build this scan asked for has been started; the screen should follow it. */
  autoBuildStarted: boolean;
  failure: ScanFailureCopy | null;
}

/** Mirrors `run.ts#ScanFailureKind`; declared here so the polling route never imports the scan's providers. */
export type ScanFailureKind = BuildFailureCause | 'destination_unplaced' | 'nothing_placed';

const NOTHING_LOST = 'Your answers are saved';

const SCAN_FAILURE_COPY: Record<ScanFailureKind, Omit<ScanFailureCopy, 'kind' | 'ref'>> = {
  composer_not_configured: {
    retryable: false,
    heading: 'This site can’t search for places right now.',
    message: `Sidequest isn’t able to look for places here at the moment, so no search was started. ${NOTHING_LOST}, and any trip already built still opens.`,
  },
  provider_auth_failure: {
    retryable: false,
    heading: 'Sidequest can’t reach its research right now.',
    message: `The service that suggests places turned this site’s request away, and trying again won’t change that until it is fixed on our side. ${NOTHING_LOST}.`,
  },
  provider_quota_or_limit: {
    retryable: true,
    heading: 'Sidequest is busy right now.',
    message: `Too many searches were running at once, so this one didn’t finish. ${NOTHING_LOST} — wait a few minutes and try again.`,
  },
  provider_timeout: {
    retryable: true,
    heading: 'The search took too long.',
    message: `Sidequest stopped waiting before it had a list of places. ${NOTHING_LOST} — trying again usually works.`,
  },
  provider_unavailable: {
    retryable: true,
    heading: 'Sidequest’s research didn’t answer.',
    message: `It looks like a brief outage. ${NOTHING_LOST} — try again in a minute.`,
  },
  invalid_model_response: {
    retryable: true,
    heading: 'Sidequest couldn’t finish this search.',
    message: `The list of places that came back wasn’t usable, so we didn’t show it to you. ${NOTHING_LOST} — trying again runs a fresh search.`,
  },
  internal_generation_error: {
    retryable: true,
    heading: 'Sidequest couldn’t finish this search.',
    message: `Something went wrong on our side while building your board. ${NOTHING_LOST} — you can try again.`,
  },
  must_do_conflict: {
    retryable: false,
    heading: 'Your must-dos can’t all fit in this trip.',
    message: `Two or more of the things you said you must do can’t share these dates. ${NOTHING_LOST} — change or drop one and search again.`,
  },
  planner_refused: {
    retryable: true,
    heading: 'Sidequest couldn’t build a board from what it found.',
    message: `There wasn’t enough to plan from. ${NOTHING_LOST} — try a more specific place name, or plan without the board.`,
  },
  destination_unplaced: {
    retryable: true,
    heading: 'We couldn’t place this destination on the map.',
    message: 'We couldn’t place enough of this destination on the map to build a board. Try a more specific place name, or plan without the board.',
  },
  nothing_placed: {
    retryable: true,
    heading: 'We couldn’t place enough of this destination.',
    message: 'We couldn’t place enough of this destination on the map to build a board. Try a more specific place name, or plan without the board.',
  },
};

const LOST_COPY: Omit<ScanFailureCopy, 'ref'> = {
  kind: 'lost',
  retryable: true,
  heading: 'We lost track of this search.',
  message: `The search stopped part-way without finishing. ${NOTHING_LOST} — starting it again is safe.`,
};

function isScanFailureKind(value: unknown): value is ScanFailureKind {
  return value === 'destination_unplaced' || value === 'nothing_placed' || isBuildFailureCause(value);
}

/** The traveller's copy for a scan failure kind; anything unrecognised reads as our own error. */
export function scanFailureCopy(kind: string | null, ref: string | null = null): ScanFailureCopy {
  const known: ScanFailureKind = isScanFailureKind(kind) ? kind : 'internal_generation_error';
  return { kind: known, ref, ...SCAN_FAILURE_COPY[known] };
}

/** The real counts, as sentences, in the order the scan produces them. */
export function scanLines(counters: ScanCounters, stage: ScanStage | null): string[] {
  const lines: string[] = [];
  if (typeof counters.proposed === 'number' && counters.proposed > 0) {
    lines.push(`Proposed ${counters.proposed} ${counters.proposed === 1 ? 'place' : 'places'} that fit you${typeof counters.bases === 'number' && counters.bases > 0 ? `, around ${counters.bases} ${counters.bases === 1 ? 'base' : 'bases'}` : ''}`);
  }
  if (typeof counters.placed === 'number' && (stage === 'placing' || counters.placed > 0)) {
    lines.push(
      typeof counters.proposed === 'number' && counters.proposed > 0
        ? `Placed ${counters.placed} of them on the map`
        : `Placed ${counters.placed} on the map`,
    );
  }
  if (stage === 'timing' || stage === 'assembling' || stage === 'done') {
    if (typeof counters.timed === 'number' && counters.timed > 0) lines.push(`Timed ${counters.timed} journeys between them`);
    else if (stage === 'timing') lines.push('Timing the distances between them');
    else lines.push('Distances estimated from the map');
  }
  return lines;
}

export function travellerScanViewOf(view: ScanView, now: Date, options: { autoBuildStarted?: boolean } = {}): TravellerScanView {
  const stage = view.stage;
  const index = stage ? SCAN_STAGES.indexOf(stage) : -1;
  const started = view.startedAt ? Date.parse(view.startedAt) : NaN;
  const finished = view.finishedAt ? Date.parse(view.finishedAt) : NaN;
  const until = Number.isNaN(finished) ? now.getTime() : finished;
  const failure =
    view.state === 'failed' ? scanFailureCopy(view.failureKind, view.failureRef) : view.state === 'lost' ? { ...LOST_COPY, ref: null } : null;
  return {
    state: view.state,
    stage,
    label: stage ? SCAN_STAGE_LABELS[stage] : null,
    stages: SCAN_STAGES.filter((s) => s !== 'done').map((id) => ({ id, label: SCAN_STAGE_LABELS[id] })),
    reached: index > 0 ? SCAN_STAGES.slice(0, index) : [],
    lines: scanLines(view.counters, stage),
    counters: {
      proposed: view.counters.proposed ?? 0,
      bases: view.counters.bases ?? 0,
      placed: view.counters.placed ?? 0,
      unplaced: view.counters.unplaced ?? 0,
      timed: view.counters.timed ?? 0,
    },
    elapsedSeconds: Number.isNaN(started) ? 0 : Math.max(0, Math.round((until - started) / 1000)),
    autoBuildPending: view.autoBuild && view.state !== 'failed' && view.state !== 'lost',
    autoBuildStarted: options.autoBuildStarted ?? false,
    failure,
  };
}

/** The build key an auto-build started by this scan runs under. One per scan, so a retried hook attaches rather than duplicates. */
export function autoBuildKeyFor(scanId: string): string {
  return `scan-${scanId}`;
}

/** The traveller's view of this trip's latest scan, read from the row and the clock. */
export function travellerScanView(tripId: string, now: Date = new Date()): TravellerScanView {
  const view = scanView(tripId, now);
  let autoBuildStarted = false;
  if (view.scanId) {
    try {
      autoBuildStarted = getGenerationProgress(tripId)?.buildKey === autoBuildKeyFor(view.scanId);
    } catch {
      autoBuildStarted = false;
    }
  }
  return travellerScanViewOf(view, now, { autoBuildStarted });
}
