import {
  COMPILATION_PHASES,
  COMPILATION_PHASE_DETAIL,
  COMPILATION_PHASE_LABELS,
  STAGE_PHASE,
  stageDefinition,
  type CompilationPhase,
} from './stages';
import type { StageRecord } from './compilation';

/**
 * TWENTY-NINE ROWS OF BUILD LOG, GROUPED INTO SOMETHING A TRAVELLER CAN READ.
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
 *
 * The phase vocabulary and the stage→phase map used to be declared here, by
 * hand, beside a second hand-keyed label map in `compilation.ts`. Both now come
 * from `STAGE_REGISTRY` — see `schemas/stages.ts` for the ordering defect that
 * separation caused, in which `groupStages` sent a finished phase back to
 * running because two stages executed one phase ahead of where they were mapped.
 *
 * ---
 *
 * WHAT THIS MODULE IS, BEYOND PROGRESS.
 *
 * It is the place a **derived display value** is computed and constrained. Not
 * only progress: `observedDurationMs` and `MAX_PLAUSIBLE_STAGE_MS` are already
 * here and neither is about a phase — both are rules about what a screen is
 * allowed to claim it measured. The same rules kept escaping into components,
 * and each escape cost a traveller something specific:
 *
 * - a duration read off the wrong clock rendered "roughly 0s–0s to go";
 * - a build span with no ceiling rendered "312m in total, measured" for a job
 *   that had been reclaimed hours after it stopped;
 * - a 0–1 heuristic rendered as `83`, an integer with a precision nobody has;
 * - a count derived from one board rendered beside a different board.
 *
 * All four are the same defect wearing different clothes: a number computed in a
 * component, from whatever that component happened to be holding, with no stated
 * rule about when it may not be shown. Every derivation below is pure, is tested
 * in `progress.test.ts`, and refuses rather than guesses.
 */

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
   * What the phase is doing right now, in the traveller's words.
   *
   * Absent while a `technicalOnly` stage is running. "Finding who publishes
   * this" and "Choosing what is worth researching" are true, useful to an
   * operator, and not the sentence somebody waiting for a trip should be reading
   * — so the phase falls back to its own detail line and the stage stays in the
   * disclosure, where an operator can still see it.
   */
  currentWork?: string;
  /**
   * The most recent meaningful thing this phase produced.
   *
   * A real outcome with a number in it, taken from the last finished stage the
   * registry marks `exposesResult` — never a stage name dressed up as progress,
   * and never a plumbing count. `linking_sources` finishing with "412 records
   * matched across sources" is not what the *shaping* card should say it
   * achieved.
   */
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

    /*
     * The label of the running stage, unless it is plumbing.
     *
     * The registry decides. A `technicalOnly` stage is still listed, still
     * labelled and still timed — it just does not get to be the sentence
     * somebody reads while they wait.
     */
    const runningDefinition = running ? stageDefinition(running.stage) : null;
    const runningLabel =
      runningDefinition && !runningDefinition.technicalOnly ? runningDefinition.label : null;

    /*
     * Only stages the registry says may expose a result.
     *
     * Without the filter the phase card headlines whatever finished last, which
     * for *shaping* is `linking_sources` — "412 records matched across sources".
     * That is an operator's sentence. The traveller's sentence for that phase is
     * what `expanding_region` produced, and it is one row further back.
     */
    const finished = records.filter(
      (record) => record.outcome !== undefined && stageDefinition(record.stage)?.exposesResult,
    );
    const latest = finished[finished.length - 1];

    /*
     * The observed clock where there is one, the injected one otherwise.
     *
     * `startedAt`/`finishedAt` come from the compiler's *injected* clock, which
     * advances a fixed step per stage so that two runs of the same inputs
     * produce byte-identical artifacts. That is worth keeping and it is not a
     * duration: read as one it made every phase report zero seconds.
     *
     * A job row recorded since the split carries the real pair beside it. An
     * older row carries only the injected one, and falls back to what it has —
     * which reads as a very fast build rather than as a crash.
     */
    const started = records
      .map((record) => Date.parse(record.observedStartedAt ?? record.startedAt ?? ''))
      .filter((value) => !Number.isNaN(value));
    const ended = records
      .map((record) => Date.parse(record.observedFinishedAt ?? record.finishedAt ?? ''))
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
      ...(runningLabel === null ? {} : { currentWork: runningLabel }),
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
 * The longest a single stage is believed to be able to take.
 *
 * An hour. Anything above it is not a slow stage, it is a clock that moved —
 * a suspended laptop, a resumed container — and treating it as a measurement
 * would put a four-hour outlier into the history every later estimate is drawn
 * from.
 */
export const MAX_PLAUSIBLE_STAGE_MS = 3_600_000;

/**
 * How long one stage really took, or nothing.
 *
 * Only ever from the *observed* pair. `startedAt`/`finishedAt` come from the
 * compiler's injected clock — one step per stage — and reading them as a
 * duration is precisely the defect that had every stage claiming a millisecond
 * and the progress screen offering "roughly 0s–0s to go". A record with no
 * observed pair returns null, and the screen renders nothing rather than a zero.
 *
 * Negative and absurd spans return null too. A clock that went backwards over a
 * stage — an NTP correction mid-build, a container resumed on a different host —
 * produces a duration nobody should see and no history should learn from, and
 * `-4s` on a progress row is a more alarming bug than a missing figure.
 */
export function observedDurationMs(record: StageRecord): number | null {
  if (!record.observedStartedAt || !record.observedFinishedAt) return null;
  const started = Date.parse(record.observedStartedAt);
  const finished = Date.parse(record.observedFinishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) return null;
  const span = finished - started;
  if (!Number.isFinite(span) || span < 0 || span > MAX_PLAUSIBLE_STAGE_MS) return null;
  return span;
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
 * HOW MUCH LONGER — AND USUALLY, HONESTLY, NO ANSWER.
 *
 * The version this replaces multiplied *this run's* median stage duration by the
 * *count* of stages left. That is wrong twice over, and only one of the two was
 * the fabricated clock.
 *
 * The second error survives any clock: it treats the twenty-six stages as
 * exchangeable draws from one distribution. `partitioning_scope` is arithmetic
 * on the order of a millisecond and `retrieving_pages` fetches up to ninety
 * pages over somebody else's network. Estimating the verifying phase from four
 * stages that did no I/O under-predicts by an order of magnitude — which is why
 * this function now needs *history*, bucketed, and refuses without it.
 *
 * `estimateRemainingFrom` in `schemas/timing.ts` is that estimator. What remains
 * here is the honest default: no history, no estimate, and the screen renders
 * silence rather than a number nobody should act on.
 */
export function estimateRemaining(): null {
  return null;
}

// ---------------------------------------------------------------------------
// Version-keyed summaries
// ---------------------------------------------------------------------------

/**
 * THE IDENTITY A DERIVED SUMMARY IS KEYED TO.
 *
 * The defect this exists for: a board is versioned and immutable, a traveller's
 * marks are not, and every count on the screen was computed from whichever of
 * the two the component happened to be holding. A rebuild replaced the cards and
 * left the counts; a second tab moved the marks and left the first tab's total.
 * Both render an account of one artifact beside a different artifact, and
 * neither looks wrong — a number is a number.
 *
 * So every derived summary in this product carries the version of the thing it
 * describes, computed here, from the same call that computed the number. The two
 * cannot disagree because they are one value. A component renders the version
 * beside the count (`data-board-version`) so that "these describe the same
 * board" is checkable from outside rather than asserted in a comment.
 *
 * Length-prefixed before hashing, so `['ab', 'c']` and `['a', 'bc']` are
 * different identities. A plain join by a separator is one identifier containing
 * that separator away from two boards sharing a version.
 */
export function summaryVersion(parts: readonly (string | number | null | undefined)[]): string {
  /*
   * FNV-1a over the length-prefixed parts.
   *
   * A short, stable, purely-derived string. Stable matters more than it looks:
   * the same board must produce the same version on a server render, on a client
   * re-render and after a refresh, or "the count and the board agree" would be a
   * property that only holds until somebody reloads.
   */
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = part === null || part === undefined ? '' : String(part);
    const chunk = `${text.length}:${text}`;
    for (let index = 0; index < chunk.length; index += 1) {
      hash ^= chunk.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Counts of what a traveller has said, about the board actually on screen.
 *
 * `S` is the decision vocabulary of whichever board is asking — the provisional
 * board's intents and the final board's selection statuses are different
 * vocabularies over the same shape, and one function over both is what stops the
 * two screens from disagreeing about how a count is arrived at.
 */
export interface SelectionSummary<S extends string> {
  /** The board these counts describe. Rendered beside them, never separately. */
  boardVersion: string;
  /** Cards on the displayed board. */
  onBoard: number;
  /** How many *displayed* cards carry each status. Zero for an absent status. */
  counts: Record<S, number>;
  /** Displayed cards the traveller has said anything about. */
  decided: number;
  /**
   * Marks about places that are **not** on the displayed board.
   *
   * Kept and reported rather than silently folded into the totals, because they
   * are the exact quantity that made a stale count look plausible: a mark made
   * on board v1 about a card that v2 dropped is still a real thing somebody
   * said, and it is not a fact about the board they are looking at. A screen may
   * show this in a labelled history view; it may not add it to "3 marked".
   */
  carriedOver: number;
}

/**
 * Summarise decisions **against one board version**.
 *
 * The rule in one line: a count describes the cards in front of the traveller,
 * and nothing else. Everything the old components did wrong follows from having
 * broken it — they counted the values of a selection map, which outlives the
 * board it was made on, is shared across board versions by design, and grows
 * every time somebody marks a card that a later build removes.
 */
export function summariseSelections<S extends string>(input: {
  boardVersion: string;
  /** The ids actually rendered, in the order they are rendered. */
  cardIds: readonly string[];
  /** The decision vocabulary, so an absent status reports `0` rather than nothing. */
  statuses: readonly S[];
  selections: Readonly<Record<string, S | undefined>>;
}): SelectionSummary<S> {
  const counts = Object.fromEntries(input.statuses.map((status) => [status, 0])) as Record<S, number>;
  const onBoard = new Set(input.cardIds);

  let decided = 0;
  for (const id of onBoard) {
    const status = input.selections[id];
    if (status === undefined) continue;
    if (!(status in counts)) continue;
    counts[status] += 1;
    decided += 1;
  }

  let carriedOver = 0;
  for (const [id, status] of Object.entries(input.selections)) {
    if (status === undefined) continue;
    if (onBoard.has(id)) continue;
    carriedOver += 1;
  }

  return { boardVersion: input.boardVersion, onBoard: onBoard.size, counts, decided, carriedOver };
}

// ---------------------------------------------------------------------------
// A measured build span, or an honest refusal
// ---------------------------------------------------------------------------

/**
 * The longest a whole build is believed to be able to take.
 *
 * Two hours, against a one-hour ceiling for any single stage. Above it the pair
 * of timestamps is not a slow build — it is a job that was reclaimed, a process
 * that was suspended, or a clock that moved between the start stamp and the
 * finish stamp. "312m in total, measured" reached a screen from exactly that,
 * and the word doing the damage is *measured*: it invites somebody to conclude
 * the pipeline is five hours slow.
 */
export const MAX_PLAUSIBLE_BUILD_MS = 2 * MAX_PLAUSIBLE_STAGE_MS;

/**
 * Below this, a build is reported in words rather than in seconds.
 *
 * A synthetic world compiles in under a second, and `Math.round(ms / 1000)`
 * turns that into `0s`. "0s in total, measured" is the same sentence family as
 * "roughly 0s–0s to go": a figure that rounds to nothing, presented as a
 * measurement, on a screen that just finished doing several seconds of work.
 */
export const MIN_REPORTABLE_BUILD_MS = 1_000;

export type ObservedSpan =
  /** A real span, inside both bounds. Render the figure. */
  | { kind: 'measured'; ms: number }
  /** Real, and shorter than the smallest figure worth printing. */
  | { kind: 'under_a_second' }
  /** Past the ceiling. Render the reason, never the number as a duration. */
  | { kind: 'not_a_measurement'; ms: number }
  /** No observed pair at all. Render nothing. */
  | { kind: 'unmeasured' };

/**
 * What a build's observed start-to-finish span is allowed to be presented as.
 *
 * Four answers rather than a number-or-null, because the three non-numeric cases
 * are different things to say. "We did not measure this" and "the clock says
 * five hours, which is not a duration" are not the same admission, and folding
 * them together is how the second one gets rendered as the first.
 */
export function classifyObservedSpan(ms: number | null | undefined): ObservedSpan {
  if (ms === null || ms === undefined) return { kind: 'unmeasured' };
  if (!Number.isFinite(ms) || ms < 0) return { kind: 'unmeasured' };
  if (ms > MAX_PLAUSIBLE_BUILD_MS) return { kind: 'not_a_measurement', ms };
  if (ms < MIN_REPORTABLE_BUILD_MS) return { kind: 'under_a_second' };
  return { kind: 'measured', ms };
}

// ---------------------------------------------------------------------------
// A weighted 0–1 heuristic, as a band
// ---------------------------------------------------------------------------

/**
 * A NORMALISED HEURISTIC IS A BAND, NEVER AN INTEGER.
 *
 * `Math.round(value * 100)` reached the shortlist's own disclosure — the one
 * whose component header says, in those words, that rendering "83" would be a
 * precision the inputs do not have. Four bands, because four is roughly as many
 * distinctions as a weighted sum of partly-unmeasured dimensions can carry, and
 * because a reader can hold four words and cannot usefully compare 71 with 76.
 *
 * The basis clause still travels beside it. The band says how strongly the
 * dimension argued; the basis says what it was computed from. Neither is a
 * number somebody will subtract from another number.
 */
export const MEASURE_BANDS = ['strong', 'good', 'middling', 'weak'] as const;
export type MeasureBand = (typeof MEASURE_BANDS)[number];

export const MEASURE_BAND_LABELS: Record<MeasureBand, string> = {
  strong: 'Strong',
  good: 'Good',
  middling: 'Middling',
  weak: 'Weak',
};

export function measureBand(value: number): MeasureBand {
  if (!Number.isFinite(value)) return 'weak';
  const clamped = Math.min(1, Math.max(0, value));
  if (clamped >= 0.75) return 'strong';
  if (clamped >= 0.55) return 'good';
  if (clamped >= 0.35) return 'middling';
  return 'weak';
}
