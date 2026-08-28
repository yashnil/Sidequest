import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILATION_ERROR_COPY, type StageRecord } from '@sidequest/core';
import {
  CATALOGUE_UNREACHABLE_MESSAGE,
  compilationVerdict,
  PACK_UNAVAILABLE_OUTCOME,
  TIME_CEILING_DETAIL_PREFIX,
  TIME_CEILING_MESSAGE,
  packNeverRead,
} from './verdict';

/**
 * THE VERDICT-MAPPING SEAM, WHERE TWO LIVE FAILURES MISSTATED THEIR CAUSE.
 *
 * Job 3baa4f3d (Osaka, 2026-08-25) failed `coverage_insufficient` after the
 * data catalogue went unreachable for 1.6 seconds — its own stage records say
 * "The data catalogue did not answer" — and the traveller read "There is not
 * enough here to plan on", a permanent claim about the destination, with no
 * retry. The identical scope fingerprint succeeded seven hours later with 7005
 * records. Jobs cb08dd94, 3db198e9, 6c69d632 and 9b159cb1 were killed by the
 * worker's wall clock and coded `budget_exhausted`, so travellers read "We ran
 * out of lookups" over a stage row saying "Stopped at the overall time
 * ceiling" on the same screen, and were denied the retry a warm evidence store
 * makes cheap.
 *
 * Every assertion below fails against the version that shipped those screens.
 */

const OSAKA_OUTAGE_STAGES: StageRecord[] = [
  { stage: 'partitioning_scope', status: 'done', outcome: '9 areas to read' },
  {
    stage: 'building_region_pack',
    status: 'skipped',
    outcome: PACK_UNAVAILABLE_OUTCOME,
    note: 'The data catalogue did not answer.',
  },
  {
    stage: 'resolving_source_release',
    status: 'skipped',
    outcome: 'no release could be pinned',
    note: 'The data catalogue did not answer.',
  },
  { stage: 'discovering_candidates', status: 'done', outcome: '0 candidates from 6 searches' },
  {
    stage: 'classifying',
    status: 'failed',
    note: 'We could not find anything here we could describe well enough to plan around.',
  },
];

/** The same terminal code over a pack that really was read: honest thin ground. */
const THIN_GROUND_STAGES: StageRecord[] = [
  { stage: 'partitioning_scope', status: 'done', outcome: '2 areas to read' },
  {
    stage: 'building_region_pack',
    status: 'done',
    outcome: '14 records from release 2026-07-23.0',
  },
  { stage: 'discovering_candidates', status: 'done', outcome: '3 candidates from 6 searches' },
  {
    stage: 'classifying',
    status: 'failed',
    note: 'We could not find anything here we could describe well enough to plan around.',
  },
];

describe('a transient catalogue outage is told as an outage, never as a verdict about the destination', () => {
  it('turns coverage_insufficient over an unread pack into a retryable statement about our sources', () => {
    const verdict = compilationVerdict({
      errorCode: 'coverage_insufficient',
      errorDetail: 'We could not find anything here we could describe well enough to plan around.',
      stages: OSAKA_OUTAGE_STAGES,
    });
    expect(verdict.cause).toBe('catalogue_unreachable');
    expect(verdict.retryable).toBe(true);
    expect(verdict.message).toBe(CATALOGUE_UNREACHABLE_MESSAGE);
    // The destination claim must be gone entirely, not merely softened.
    expect(verdict.message).not.toContain('not enough here');
    // …and the sentence must not blame the place at all: it names the source.
    expect(verdict.message.toLowerCase()).toContain('says nothing about your destination');
  });

  it('keeps the destination verdict, non-retryable, when the pack was genuinely read and the ground is thin', () => {
    /*
     * The control that keeps the branch honest: "your destination is thin" is
     * a claim this product is entitled to make only when it actually read the
     * ground. A verdict that turned *every* coverage failure retryable would
     * offer a retry that fails identically — the same dishonesty mirrored.
     */
    const verdict = compilationVerdict({
      errorCode: 'coverage_insufficient',
      stages: THIN_GROUND_STAGES,
    });
    expect(verdict.cause).toBe('coverage_insufficient');
    expect(verdict.retryable).toBe(false);
    expect(verdict.message).toBe(COMPILATION_ERROR_COPY.coverage_insufficient);
  });

  it('does not mistake a deployment with no pack provider configured for an outage', () => {
    /*
     * `compileRegion` writes the pack stage as skipped in two situations with
     * two different outcomes: `'no regional place data'` when the provider
     * answered "unavailable" (weather — retry honestly offered) and
     * `'no regional place data configured'` when no provider exists at all
     * (configuration — a retry fails identically until an operator acts). The
     * classifier keys on the exact outcome so the second can never buy the
     * first's retry button.
     */
    const configured: StageRecord[] = [
      {
        stage: 'building_region_pack',
        status: 'skipped',
        outcome: 'no regional place data configured',
        note: 'No regional place data is configured for this build, so the map layer was not read.',
      },
    ];
    expect(packNeverRead(configured)).toBe(false);
    const verdict = compilationVerdict({ errorCode: 'coverage_insufficient', stages: configured });
    expect(verdict.cause).toBe('coverage_insufficient');
    expect(verdict.retryable).toBe(false);
  });

  it('pins the stage outcome the compiler actually writes on the unavailable branch', () => {
    /*
     * The classifier reads a literal another package writes. If the compiler
     * rewords its unavailable-branch outcome, `packNeverRead` silently stops
     * firing and every catalogue outage regresses to the destination verdict —
     * so the contract is asserted against the compiler's own source, and a
     * reword breaks this named test instead of the traveller's screen.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const compileSource = readFileSync(
      resolve(here, '../../../../..', 'packages/compiler/src/compile.ts'),
      'utf8',
    );
    expect(compileSource).toContain(`outcome: '${PACK_UNAVAILABLE_OUTCOME}',`);
    // And the no-provider branch stays distinguishable from it.
    expect(compileSource).toContain(`outcome: '${PACK_UNAVAILABLE_OUTCOME} configured',`);
  });
});

describe('a wall-clock time-ceiling abort is told as running out of time, with the retry it deserves', () => {
  it('turns the worker’s deadline kill into honest copy and a retry offer', () => {
    const verdict = compilationVerdict({
      errorCode: 'budget_exhausted',
      errorDetail: `${TIME_CEILING_DETAIL_PREFIX}: the build ran past 12m and its grace period without reaching a checkpoint.`,
      stages: [],
    });
    expect(verdict.cause).toBe('time_ceiling');
    expect(verdict.retryable).toBe(true);
    expect(verdict.message).toBe(TIME_CEILING_MESSAGE);
    // The lookup claim — the wrong cause — must not appear.
    expect(verdict.message).not.toContain('lookups');
    // The honest offer: nothing was lost, the next attempt continues.
    expect(verdict.message).toContain('ran out of time');
    expect(verdict.message).toMatch(/next attempt|try again/i);
  });

  it('keeps a genuinely exhausted lookup ledger non-retryable, in its own words', () => {
    /*
     * The other half of the same code. A per-trip lookup budget that was
     * actually consumed is deterministic — a retry re-spends and fails the
     * same way — so the honest screen keeps the original sentence and no
     * button.
     */
    const verdict = compilationVerdict({
      errorCode: 'budget_exhausted',
      errorDetail: 'The lookup budget for this trip was consumed before research finished.',
      stages: [],
    });
    expect(verdict.cause).toBe('budget_exhausted');
    expect(verdict.retryable).toBe(false);
    expect(verdict.message).toBe(COMPILATION_ERROR_COPY.budget_exhausted);
  });

  it('the worker writes the exact detail prefix the classifier reads', () => {
    /*
     * Writer and reader share one constant, and this proves the worker did not
     * drift off it — replacing the import with a hand-typed string that later
     * diverges is the quiet way to neuter the branch.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const workerSource = readFileSync(join(here, 'worker/main.ts'), 'utf8');
    expect(workerSource).toContain('TIME_CEILING_DETAIL_PREFIX');
    expect(workerSource).toContain("from '../verdict'");
    // No second copy of the sentence that could drift from the constant.
    expect(workerSource).not.toContain("detail: 'Stopped at the overall time ceiling");
  });
});

describe('both render paths speak through the verdict, not past it', () => {
  /*
   * THE NEUTER-PROOF. The classifier being correct is worthless if a render
   * path reverts to indexing `COMPILATION_ERROR_COPY` by code — that is
   * exactly the shipped defect. Both the server render and the poll must call
   * `compilationVerdict`, and neither may reach the copy table directly.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = resolve(here, '../..');

  it.each([
    ['the plan page (first paint)', 'app/(product)/trips/[id]/plan/page.tsx'],
    ['the snapshot poll', 'app/(product)/trips/[id]/plan/actions.ts'],
  ])('%s derives failure copy and retryability from compilationVerdict', (_name, path) => {
    const source = readFileSync(join(webRoot, path), 'utf8');
    expect(source).toContain('compilationVerdict(');
    expect(source, 'failure copy must not be looked up by code alone').not.toContain(
      'COMPILATION_ERROR_COPY[',
    );
    expect(source, 'retryability must not be decided by the code alone').not.toContain(
      'isRetryable(',
    );
  });
});

describe('a build the traveller stopped themselves', () => {
  /**
   * A ONE-WAY DOOR, WITH THE HOMEPAGE POINTING AT IT.
   *
   * Pressing "Stop this build" left the plan screen on its `compiling` step
   * with no retry control at all: `isRetryable('cancelled_by_user')` is false —
   * correctly, since it answers whether a *failure* was transient, and a
   * cancellation is not a failure — and the screen was reading that answer to
   * decide whether to offer the button. Meanwhile the trip list labelled the
   * same trip "You stopped this" and offered "Pick it up again", linking to the
   * screen that could not do it. `retryCompilationAction` accepts a cancelled
   * job already; only the button was missing.
   */
  it('is offered again, because stopping is not failing', () => {
    const verdict = compilationVerdict({ errorCode: 'cancelled_by_user', stages: [] });
    expect(verdict.cause).toBe('cancelled_by_user');
    expect(verdict.retryable).toBe(true);
    expect(verdict.message).toBe(COMPILATION_ERROR_COPY.cancelled_by_user);
  });

  it('leaves a genuinely terminal verdict alone', () => {
    /*
     * The control. Nothing here may turn a real refusal into an invitation to
     * press the same button and spend again for the same answer.
     */
    const verdict = compilationVerdict({ errorCode: 'coverage_insufficient', stages: THIN_GROUND_STAGES });
    expect(verdict.retryable).toBe(false);
  });
});
