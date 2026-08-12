'use client';

import { useEffect, useState } from 'react';
import {
  AVAILABILITY_AFTER,
  groupStages,
  observedDurationMs,
  stageLabel,
  summaryVersion,
  type PhaseProgress,
  type RemainingEstimate,
  type StageRecord,
} from '@sidequest/core';
import { Badge, Panel, cx } from './ui';
import { formatElapsed, formatTimeAgo } from '@/lib/format/elapsed';

/**
 * TWENTY-SIX ROWS, GROUPED INTO FIVE THINGS A TRAVELLER CAN READ.
 *
 * The screen this replaces rendered every compilation stage as a flat list, so
 * somebody waiting several minutes for their trip watched "Matching records
 * across sources" and "Working out who to believe" scroll past with no idea
 * which of them mattered, how much was left, or whether anything had gone wrong.
 *
 * Four changes, each answering a specific complaint:
 *
 * - **Five phases**, named for what the traveller is getting rather than for the
 *   module doing it. The stages are still there, behind a disclosure, because an
 *   operator debugging a thin region needs exactly that list.
 * - **Elapsed time per phase**, computed from stage timestamps rather than a
 *   client timer, so a refresh does not restart it and two tabs agree.
 * - **What is already inspectable**, so a wait has a floor of usefulness.
 * - **A remaining range, only once there is something to extrapolate from.**
 *   Never a percentage. Several of these stages take as long as somebody else's
 *   server takes, and a bar moving at a rate nobody can predict is a lie told
 *   with an animation.
 *
 * ## What this screen is allowed to say about time
 *
 * | Shown | Source | When |
 * | --- | --- | --- |
 * | total elapsed | the job's `startedAt` | immediately, from the first paint |
 * | per-phase elapsed | observed stage timestamps | as soon as one stage in the phase has started |
 * | per-stage duration | `observedDurationMs` | once the stage has finished, in the disclosure |
 * | reused work | the `reusing_shared_claims` outcome | once that stage has finished |
 * | remaining range | bucketed history, ≥5 comparable builds | almost never, and that is correct |
 *
 * And what it is never allowed to say: a percentage, a negative duration, a
 * fabricated range, or "roughly 0s–0s to go" — which it did say, in production,
 * for every build, because the only clock it had advanced one millisecond per
 * stage. Every rule above exists because of that one sentence.
 */

/**
 * The smallest a control on this screen may be.
 *
 * WCAG 2.5.5's 44 px. A `<summary>` is a control — it is the only way into the
 * stage list an operator is looking for — and a line of 14 px text is about
 * twenty pixels of target.
 *
 * Padding rather than a flex box: a summary is a `display: list-item`, and
 * making it flex removes the disclosure triangle in every WebKit-derived
 * browser. A 44 px target that no longer looks like a control is not a fix.
 */
const MIN_TARGET_SUMMARY = 'min-h-11 py-3';

const PHASE_TONE: Record<PhaseProgress['status'], 'pine' | 'blue' | 'amber' | 'neutral' | 'clay'> = {
  done: 'pine',
  running: 'blue',
  waiting: 'neutral',
  partial: 'amber',
  failed: 'clay',
};

const PHASE_LABEL: Record<PhaseProgress['status'], string> = {
  done: 'Done',
  running: 'Working',
  waiting: 'Waiting',
  partial: 'Partly done',
  failed: 'Failed',
};

/**
 * WHAT A PHASE IS CALLED WHEN NOTHING IS RUNNING ANY MORE.
 *
 * `groupStages` reads stage records, and a stage record cannot know whether the
 * process that wrote it is still alive. So a build whose machine went away left
 * two phases reading `running` for ever, and this component rendered them as
 * "Working" — present tense, breathing animation, clock ticking — eight and a
 * half days after the last heartbeat.
 *
 * The tense is decided here, from the job's liveness, because that is the only
 * layer that has both facts. `waiting` becomes "Never started" rather than
 * "Waiting", which is the difference between a queue and an abandonment.
 */
const STOPPED_PHASE_LABEL: Record<PhaseProgress['status'], string> = {
  done: 'Done',
  running: 'Stopped part-way',
  waiting: 'Never started',
  partial: 'Partly done',
  failed: 'Failed',
};

const STOPPED_PHASE_TONE: Record<PhaseProgress['status'], 'pine' | 'blue' | 'amber' | 'neutral' | 'clay'> = {
  done: 'pine',
  running: 'amber',
  waiting: 'neutral',
  partial: 'amber',
  failed: 'clay',
};

/**
 * THE ONE COMPILER NOUN THAT REACHES THE PRIMARY CARD.
 *
 * A stage's outcome is written by the compiler and rendered here verbatim,
 * which is right — the stage counted it and a second count composed on the way
 * to the screen is a second thing that can disagree. But two of those sentences
 * carry the word §26 names first in its list of vocabulary that must not appear
 * in primary UI: "4 candidate bases across 7 areas", "158 candidates from 6
 * searches". A traveller waiting for their trip does not have a candidate set.
 *
 * Deliberately a substitution of one word rather than a rewrite of the
 * sentence: the count, the units and the claim are the compiler's and must
 * survive intact. The same discipline as `travellerVoice` in `plan-language`,
 * which exists for the same reason on a different surface.
 *
 * Anything it does not recognise passes through unchanged, because an
 * unrecognised outcome is still a true sentence.
 */
function travellerOutcome(text: string): string {
  return text
    .replace(/\bcandidate bases\b/g, 'possible bases')
    .replace(/\bcandidates\b/g, 'places found')
    .replace(/\bcandidate\b/g, 'place');
}

/**
 * ONE PHASE IS HAPPENING. THE REST ARE PAST OR PENDING.
 *
 * A compilation is a sequential narrative and the screen is the narrative's
 * only telling, so two phases badged "Working" at once — with two breathing
 * labels and two blue borders — is not a small inaccuracy, it is the screen
 * contradicting the thing it exists to explain. A reviewer found three at once
 * on a live build.
 *
 * The cause is upstream of the badge and cannot be fixed by it: `groupStages`
 * reads stage rows, and a stage that started and never wrote a finish stays
 * `running` for ever — an abandoned attempt the compiler has already moved past.
 * A stage record cannot know that; the ordered list of phases can, because the
 * compiler runs them in order. So the furthest-along running phase is the one
 * happening now, and any earlier phase still claiming to run is what it actually
 * is: started, unfinished, moved past.
 *
 * Nothing is hidden — the stage rows are all still in the disclosure with their
 * own statuses, which is where an operator looks for exactly this.
 */
function narrateOneAtATime(phases: PhaseProgress[]): PhaseProgress[] {
  let lastRunning = -1;
  phases.forEach((phase, index) => {
    if (phase.status === 'running') lastRunning = index;
  });
  if (lastRunning < 0) return phases;
  return phases.map((phase, index) =>
    phase.status === 'running' && index !== lastRunning
      ? { ...phase, status: 'partial' as const }
      : phase,
  );
}

export function CompilationProgress({
  stages,
  failed,
  live,
  startedAt,
  stoppedAt,
  estimate,
  reusedSummary,
}: {
  stages: StageRecord[];
  failed: boolean;
  /**
   * Whether a process is still working on this, right now.
   *
   * The single fact that decides tense, motion and whether the clock runs.
   * Derived by the caller from the job state after abandonment has been folded
   * in — a row saying `running` with a cold heartbeat is not live, and a row
   * saying `partial` is finished whatever its stage records still claim.
   */
  live: boolean;
  /** When the job began, so the header clock survives a refresh. */
  startedAt?: string;
  /**
   * The last sign of life, for a build that is no longer one.
   *
   * Used instead of the running clock: "stopped 8 days ago" is what somebody
   * needs in order to decide whether to start it again, and a live-ticking
   * elapsed counter on a dead job is the specific lie this replaced.
   */
  stoppedAt?: string;
  /**
   * A remaining range, or nothing.
   *
   * Nothing is the expected value and renders as silence. The estimator refuses
   * without at least five comparable builds in the same bucket — see
   * `estimateRemainingFrom` — and a screen that filled the gap with a guess is
   * exactly what this component is a rewrite of.
   */
  estimate?: RemainingEstimate | null;
  /** What this build did not have to buy, in the reusing stage's own words. */
  reusedSummary?: string;
}) {
  /*
   * One second-resolution clock for the whole panel.
   *
   * A `Date` in state rather than `Date.now()` inline, so every phase renders
   * against the same instant — otherwise two phases computed a millisecond apart
   * can disagree about which second it is, and the numbers flicker.
   */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    /*
     * The clock runs only while something is running.
     *
     * `failed` alone was not enough: a job left at `partial` is finished and is
     * not failed, so the interval kept ticking against a `startedAt` from last
     * week and the header rendered `12458m 52s`.
     */
    if (!live) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const phases = narrateOneAtATime(groupStages(stages, now));

  /*
   * The identity of the run this panel is describing.
   *
   * Every figure here — the phase counts, the elapsed clock, the estimate, the
   * reuse sentence — is derived from one snapshot, and the stamp says which. It
   * is not defensive decoration: `PlanFlow` used to hold a polled snapshot in
   * state that outlived the props around it, so this panel could describe one
   * run inside a page describing another, and nothing on screen said so.
   */
  const progressVersion = summaryVersion([
    startedAt,
    stages.length,
    ...stages.map((record) => `${record.stage}:${record.status}`),
  ]);

  /*
   * Elapsed from the first paint, and never negative.
   *
   * `startedAt` is the job row's, so a refresh does not restart the clock and
   * two tabs agree. The clamp is not defensive noise: the server stamps the job
   * and the browser reads its own clock, so a machine a few seconds behind the
   * server produces a negative span on the first tick, and `-3s` on a progress
   * screen looks like a much worse bug than it is.
   */
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const totalElapsed = Number.isNaN(startedMs)
    ? null
    : Math.max(0, Math.round((now.getTime() - startedMs) / 1000));

  /*
   * A stopped build reports when it stopped, not how long it has been stopped.
   *
   * The two are different sentences and only one of them is useful: "9 days"
   * beside a phase card reads as a duration the build took, which is what
   * `12458m 52s` was mistaken for. `formatTimeAgo` makes it a moment.
   */
  const stoppedAgo = live ? null : formatTimeAgo(stoppedAt ?? startedAt, now);

  const inspectable = phases
    .filter((phase) => phase.status === 'done' || phase.status === 'partial')
    .map((phase) => AVAILABILITY_AFTER[phase.phase])
    .filter((entry): entry is string => Boolean(entry));

  /*
   * WHAT THE STAGE NOTES BECAME.
   *
   * Each phase card used to carry every warning its stages had emitted, in
   * amber, under the progress line. On a real build that was eleven sentences —
   * "217 pairs look alike and could not be confirmed as the same place, so both
   * were kept", "847 more records of kinds this trip already has enough of were
   * left out" — stacked in front of somebody who only wanted to know whether to
   * keep waiting. They are engineering observations and they belong with the
   * other engineering observations, which is the disclosure below, where
   * `StageDisclosure` already renders every one of them against its own stage.
   *
   * Counted rather than deleted. A warning silently removed from a screen is a
   * worse outcome than a warning in the wrong place, so the count stays visible
   * and says where they went.
   */
  const noteCount = phases.reduce((total, phase) => total + phase.notes.length, 0);

  return (
    /*
     * NO `aria-busy` HERE, AND THAT IS THE CORRECTION.
     *
     * An earlier version put `aria-busy` on this container to say "still
     * working". It is an ancestor of the phase-label live region below, and
     * `aria-busy="true"` on a live region *or any ancestor of one* tells
     * assistive technology to hold changes back until it clears. It would have
     * been true for the entire build — precisely the window in which the stage
     * announcements are the only thing a screen-reader user has — so the
     * attribute added to help would have silenced several minutes of progress
     * and then delivered it in one burst at the end.
     *
     * The live region below already carries the state in words, which is the
     * version that cannot backfire.
     */
    <div
      className="space-y-4"
      data-testid="compilation-progress"
      data-progress-version={progressVersion}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        {/*
          PRESENT TENSE ONLY WHILE SOMETHING IS ACTUALLY HAPPENING.

          "Shaping the region" over a build that died last week is the whole
          defect in one line, and it is worse than a wrong number because it is
          the sentence somebody reads while deciding whether to keep waiting.
        */}
        <span className="text-ink-muted" aria-live="polite">
          {live
            ? (phases.find((phase) => phase.status === 'running')?.label ?? 'Getting started…')
            : failed
              ? 'This build stopped before it finished.'
              : // Not "finished": a run left at `partial` did not finish, and
                // saying it did is the same overclaim in a quieter voice.
                'Nothing is running on this now.'}
        </span>
        {/*
          Elapsed, and an estimate only when one has been earned.

          There was an estimate once, computed by multiplying this run's median
          stage duration by the number of stages left — from a clock that
          reported one millisecond per stage. It rendered "roughly 0s–0s to go".
          Both halves were wrong: the clock, and the model that treats
          `partitioning_scope` and `retrieving_pages` as the same kind of thing.

          What is here now is history, bucketed by how much ground the build
          covers, whether it is buying or reusing, and whether the run is already
          degraded — and it renders nothing at all until at least five comparable
          builds exist. Nothing is the expected output for a long time.
        */}
        <span className="text-ink-faint" data-testid="progress-elapsed" data-progress-version={progressVersion}>
          {live
            ? totalElapsed !== null
              ? formatElapsed(totalElapsed)
              : null
            : (stoppedAgo ?? null)}
          {estimate && live ? (
            <span data-testid="progress-estimate" data-progress-version={progressVersion}>
              {' · roughly '}
              {formatElapsed(estimate.lowSeconds)}–{formatElapsed(estimate.highSeconds)} to go,
              from {estimate.runs} similar {estimate.runs === 1 ? 'build' : 'builds'}
            </span>
          ) : null}
        </span>
      </div>

      {/*
        What this build did not have to buy.

        The reusing stage counts it and this repeats its sentence rather than
        composing a second one — two counts of the same thing is two things that
        can disagree, and the one on screen would be the one nobody could trace.
      */}

      <ol className="space-y-2.5">
        {phases.map((phase) => (
          <li key={phase.phase}>
            <Panel
              className={cx(
                'p-4 transition-colors',
                /*
                 * The blue edge means "this is the one happening now". On a
                 * build that stopped it was drawn round two phases at once,
                 * which is the border version of the "Working" badge.
                 */
                live && phase.status === 'running' ? 'border-slate-blue' : '',
                !live && phase.status === 'running' ? 'border-amber' : '',
                phase.status === 'failed' ? 'border-clay' : '',
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Badge tone={(live ? PHASE_TONE : STOPPED_PHASE_TONE)[phase.status]}>
                  {(live ? PHASE_LABEL : STOPPED_PHASE_LABEL)[phase.status]}
                </Badge>
                <span
                  className={cx(
                    'min-w-0 flex-1 font-medium text-ink',
                    live && phase.status === 'running' ? 'breathing' : '',
                  )}
                >
                  {phase.label}
                </span>
                {/*
                  A COUNT WITH ITS UNIT, AND NO ELAPSED A PART CANNOT HAVE HAD.

                  This read `5/6 · 9 days` on four consecutive rows of a live
                  six-night build. Both halves were wrong for the same reason:
                  a bare fraction names no denominator, so nobody outside the
                  team can say what six of anything is; and the elapsed comes
                  from stage timestamps, which on a resumed or previously
                  abandoned run are older than the build the traveller is
                  watching — so a *part* of the build claimed nine days while
                  the whole of it had run for two minutes.

                  A part cannot be longer than the whole, and that is a check
                  the page can actually make, so it makes it.
                */}
                <span className="shrink-0 text-xs text-ink-faint">
                  {phase.done} of {phase.total} steps
                  {phase.elapsedSeconds !== undefined &&
                  phase.elapsedSeconds > 1 &&
                  (totalElapsed === null || phase.elapsedSeconds <= totalElapsed)
                    ? ` · ${formatElapsed(phase.elapsedSeconds)}`
                    : ''}
                </span>
              </div>

              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                {travellerOutcome(
                  live && phase.status === 'running' && phase.currentWork
                    ? phase.currentWork
                    : (phase.latestOutcome ?? phase.detail),
                )}
              </p>
            </Panel>
          </li>
        ))}
      </ol>

      {noteCount > 0 ? (
        <p className="text-xs text-ink-faint" data-testid="progress-note-count">
          {noteCount} note{noteCount === 1 ? '' : 's'} about how this build read the data —
          in the details below.
        </p>
      ) : null}

      {/*
        "Ready to look at already" is a statement about a wait — it exists so
        that several minutes of waiting has a floor of usefulness. There is no
        wait on a build that stopped, and its entries are written in the present
        continuous ("as each one lands"), which on a dead build is the same
        tense error the badges had.
      */}
      {live && inspectable.length > 0 ? (
        <Panel className="border-dashed p-4">
          <p className="text-sm font-medium text-ink">Ready to look at already</p>
          <ul className="mt-1.5 space-y-0.5 text-sm text-ink-muted">
            {inspectable.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <StageDisclosure stages={stages} {...(reusedSummary ? { reusedSummary } : {})} />

      {/*
        The reassurance is only true while the build is alive. Telling somebody
        their dead build "carries on and picks up where it left off" is the
        sentence that keeps them waiting for a thing that has already stopped.
      */}
      {live ? (
        <p className="text-xs leading-relaxed text-ink-faint">
          You can close this page. The build carries on and picks up where it left off when you come
          back — nothing here depends on the browser staying open. There is no percentage on
          purpose: several of these steps take as long as somebody else&rsquo;s server takes.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a stage with no registry entry is called on screen.
 *
 * Unreachable through the typed path — `StageRecord.stage` is the registry's
 * union — and here anyway, because a stored job row is JSON and a row written by
 * a build that knew a stage this build does not is exactly how a raw identifier
 * reaches a screen. It says nothing rather than saying an identifier.
 */
const UNREGISTERED_STAGE = 'A step of the build';

/**
 * EVERY STAGE, WITH THE TIME IT ACTUALLY TOOK.
 *
 * Extracted so it can be rendered in two places, and the second place is the
 * point. A fixture build finishes in about a second, so the progress screen —
 * where this used to live exclusively — is on screen for less time than it takes
 * to read, and the record of what the build did disappeared with it.
 *
 * The brief asks for completed real durations and reused work to be *shown*, not
 * merely measured. A record that only exists while you are waiting for it is not
 * showing anything: the question "why did that take four minutes" is one people
 * ask afterwards.
 */
export function StageDisclosure({
  stages,
  reusedSummary,
}: {
  stages: StageRecord[];
  /**
   * What this build did not have to buy, in the reusing stage's own words.
   *
   * Here rather than on the primary card, where it used to sit. It is cache
   * accounting — "0 of 8 already answered, 0 facts reused" is what a real build
   * rendered — and §26 puts that vocabulary out of primary UI. A traveller
   * waiting for a holiday cannot act on it, and stated as a saving made entirely
   * of noughts it is not even good news. It is genuinely useful to an operator,
   * which is what this disclosure is for.
   */
  reusedSummary?: string;
}) {
  return (
    <details data-testid="technical-stages">
        <summary
          className={cx(
            MIN_TARGET_SUMMARY,
            'cursor-pointer text-sm text-ink-muted underline underline-offset-4',
          )}
        >
          Technical details — every stage
        </summary>
        <Panel className="mt-2.5 p-4">
          <ol className="space-y-2">
            {stages.map((stage) => {
              /*
               * The measured duration, or nothing at all.
               *
               * `observedDurationMs` returns null for a stage with no observed
               * pair, for a clock that went backwards over it, and for anything
               * longer than an hour. All three render as an absent figure rather
               * than as `0s` or `-4s`: this list is what an operator reads to
               * find the slow stage, and a fabricated zero in it would send them
               * looking in the wrong place.
               */
              const measured = observedDurationMs(stage);
              return (
                <li key={stage.stage} className="flex items-baseline gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-ink-faint">{stage.status}</span>
                  <span className="min-w-0 flex-1">
                    {/*
                      The registry's label, or an honest placeholder — never the
                      identifier. `stepLabel`'s old fallback was
                      `replaceAll('_', ' ')`, which put `reusing shared claims`
                      in front of a traveller.
                    */}
                    <span className="text-ink">{stageLabel(stage.stage) ?? UNREGISTERED_STAGE}</span>
                    {measured !== null ? (
                      <span className="ml-2 text-xs text-ink-faint">
                        {formatElapsed(Math.round(measured / 1000))}
                      </span>
                    ) : null}
                    {stage.outcome ? (
                      <span className="block text-xs text-ink-muted">{stage.outcome}</span>
                    ) : null}
                    {stage.note ? (
                      <span className="block text-xs text-amber">{stage.note}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
          {reusedSummary ? (
            <p className="mt-3 border-t border-rule pt-3 text-xs text-ink-muted" data-testid="progress-reused">
              Already held, so nothing was bought for it: {reusedSummary}
            </p>
          ) : null}
        </Panel>
    </details>
  );
}
