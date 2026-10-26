'use client';

import { useRef, useState, useTransition } from 'react';
import {
  mayShowItinerary,
  PLANNER_READINESS_LEVEL_LABELS,
  PLANNER_REMEDY_LABELS,
  ruledOutRemedies,
  suggestedRemedies,
  type PlannerReadiness,
} from '@sidequest/core';
import { buttonClass, cx, ErrorNote } from './ui';
import { ArrowRightIcon } from './board/icons';
import { buildItineraryAction } from '@/app/(product)/trips/[id]/itinerary/actions';
import { callAction, newBuildKey } from './client-action';

/**
 * The primary action on the board. `useTransition` gives a real pending state and
 * the disabled button prevents a second submission — building twice would replace
 * the itinerary mid-write for no reason.
 */
export function BuildTripButton({
  tripId,
  hasItinerary,
  includedCount,
  onReadiness,
  className,
}: {
  /** Extra classes for the button itself, so the action bar can size it. */
  className?: string;
  tripId: string;
  hasItinerary: boolean;
  includedCount: number;
  /**
   * WHERE THE REFUSAL IS RENDERED IS THE CALLER'S PROBLEM, NOT THIS BUTTON'S.
   *
   * This component used to own the explanation panel as well as the button, and
   * that was fine until the board's toolbar became sticky: a seven-hundred-pixel
   * panel inside a bar pinned to the top of the viewport covered half the board,
   * on every scroll position, until the traveller acted on it. The panel is the
   * most important thing on the screen when it exists and it still must not be
   * the only thing on the screen.
   *
   * So the button reports the refusal upwards and the board decides where it
   * goes — which is below the bar, in the flow, where a long explanation can be
   * as long as it needs to be. `null` clears a previous refusal, which is what
   * a fresh attempt means.
   */
  onReadiness?: (readiness: PlannerReadiness | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /* One key per press, reused by a retry of the same press, so the server attaches instead of building twice. */
  const key = useRef<string | null>(null);

  function build() {
    setError(null);
    onReadiness?.(null);
    key.current ??= newBuildKey();
    const buildKey = key.current;
    startTransition(async () => {
      /*
       * V1 convergence — the action records a durable run and redirects to the
       * build screen, which shows progress and returns to the itinerary. It
       * never awaits the generation, so a dropped request loses nothing.
       */
      const outcome = await callAction(() => buildItineraryAction(tripId, buildKey));
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      if (!outcome.value.ok) {
        key.current = null;
        setError(outcome.value.error ?? 'We could not build your trip just then.');
        onReadiness?.(outcome.value.readiness ?? null);
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={build}
        disabled={pending}
        className={cx(buttonClass('accent'), 'whitespace-nowrap', className)}
        aria-describedby={includedCount === 0 ? 'build-hint' : undefined}
      >
        {pending ? 'Starting…' : hasItinerary ? 'Rebuild my trip' : 'Build my trip'}
        {pending ? (
          <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-night/30 border-t-night" />
        ) : (
          <ArrowRightIcon className="h-4 w-4" />
        )}
      </button>
      {/*
        THE ONLY ANNOUNCEMENT OF A MULTI-SECOND OPERATION.

        The button disabled itself and changed its own label, which reaches
        nobody: a disabled control can lose focus, so the changed label may never
        be read, and there is no other signal that anything is happening. A
        traveller pressing this waits several seconds with no feedback at all.

        `role="status"` outside the button, so it is announced whatever focus
        does, and empty when idle so it says nothing on arrival.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? 'Starting your build.' : ''}
      </p>
      {includedCount === 0 ? (
        <p id="build-hint" className="mt-1.5 text-xs text-ink-muted max-sm:sr-only">
          Nothing picked yet? That’s fine — we’ll plan from your answers.
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

/**
 * WHY NOTHING COULD BE PLANNED, WHERE THE TRAVELLER CAN DO SOMETHING ABOUT IT.
 *
 * On the board rather than on the itinerary page, deliberately: the itinerary
 * page has nothing on it in this state — that is the whole point — and the
 * controls that would change the outcome are the selections, the questionnaire
 * and the region, all of which are reachable from here.
 *
 * The counts are shown as a funnel because the shape of the loss *is* the
 * diagnosis. "Nine picked, nine reachable, none scheduled" and "nine picked,
 * none reachable" are different problems with different answers, and a single
 * sentence cannot tell them apart.
 */
export function PlannerReadinessPanel({ readiness }: { readiness: PlannerReadiness }) {
  const helps = suggestedRemedies(readiness);
  const ruledOut = ruledOutRemedies(readiness);
  const notes = unresolvedNotes(readiness);
  const shown = mayShowItinerary(readiness);
  const tone = readinessTone(readiness);
  const { funnel } = readiness;
  /* What each gate is counted against: the picks, or — with nothing picked — the board the build chose from. */
  const gateBase = funnel.selected > 0 ? funnel.selected : funnel.considered;

  return (
    <section
      data-testid="planner-readiness"
      aria-labelledby="planner-readiness-heading"
      className={cx(
        'board-readiness mb-6 overflow-hidden rounded-[18px] border bg-paper-raised',
        tone === 'clay' ? 'border-clay/40' : tone === 'amber' ? 'border-amber/35' : 'border-ink/12',
      )}
    >
      <div className="p-4 sm:p-5">
        {/*
          AN H2, BECAUSE THIS IS THE FIRST HEADING UNDER THE PAGE'S H1.

          It renders above every board group, so an h3 here would skip a level at
          exactly the moment a screen-reader user most needs to navigate by
          heading: the build has just refused and the explanation is the thing
          they are looking for.

          THE HEADING HAS TO MATCH WHETHER A PLAN EXISTS. `mayShowItinerary` is
          the one place the "is there a plan at all" rule lives, so the heading
          reads it rather than inventing a second test.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            aria-hidden="true"
            className={cx('h-2.5 w-2.5 shrink-0 rounded-full', tone === 'clay' ? 'bg-clay' : tone === 'amber' ? 'bg-amber' : 'bg-pine')}
          />
          <h2 id="planner-readiness-heading" className="font-display text-lg leading-snug text-ink">
            {readinessHeading(readiness, shown)}
          </h2>
          <span
            className={cx(
              'ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-medium',
              tone === 'clay' ? 'bg-clay-soft text-clay' : tone === 'amber' ? 'bg-amber-soft text-amber' : 'bg-pine-soft text-pine',
            )}
            data-testid="readiness-level"
          >
            {PLANNER_READINESS_LEVEL_LABELS[readiness.level]}
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{readiness.summary}</p>

        {/*
          THE FUNNEL'S TWO ENDS, AS TILES.

          What was picked and what made it into the plan are the two numbers a
          traveller reads first; the gates between them are one press away
          below, because the *shape* of the loss is the diagnosis when there is
          a loss, and noise when there is not.
        */}
        <dl className="mt-4 grid grid-cols-3 gap-2">
          <Tile label="On the board" value={funnel.considered} />
          <Tile label="You picked" value={funnel.selected} />
          <Tile label="Scheduled" value={funnel.scheduled} emphasis={funnel.scheduled < funnel.selected ? tone : 'pine'} />
        </dl>

        {/*
          WHAT IS ACTUALLY UNRESOLVED — in the open, because these are the
          problems: a plan where every stop was scheduled and the days
          themselves do not work reads healthy in every gate of the funnel.
        */}
        {readiness.unresolvedIssues.length > 0 ? (
          <ul className="mt-4 space-y-1.5" data-testid="readiness-unresolved">
            {readiness.unresolvedIssues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="flex gap-2 text-sm">
                <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-clay" />
                <span className="text-ink">
                  {issue.dayNumber === undefined ? '' : <strong className="font-medium">Day {issue.dayNumber}: </strong>}
                  {issue.message}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {readiness.dominantBlockers.length > 0 ? (
          <div className="mt-4">
            <p className="text-[12px] font-medium text-ink-muted">What kept places out</p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink">
              {readiness.dominantBlockers.map((entry) => (
                <li key={entry.reasonCode}>
                  <strong>{entry.count}</strong>{' '}
                  {entry.count === 1 ? 'place' : 'places'} — {BLOCKER_LABELS[entry.reasonCode]}
                  {entry.examples.length > 0 ? (
                    <span className="text-ink-muted"> ({entry.examples.join(', ')})</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {helps.length > 0 ? (
          <div className="mt-4">
            <p className="text-[12px] font-medium text-ink-muted">What would help</p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink">
              {helps.map((entry) => (
                <li key={entry.remedy}>
                  <strong>{PLANNER_REMEDY_LABELS[entry.remedy]}.</strong> {entry.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <details className="group border-t border-ink/10">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-[13px] font-medium text-ink-muted hover:text-ink sm:px-5 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">›</span>
          See every check
          {notes.length > 0 ? (
            <span className="text-ink-faint">
              · {notes.length} {notes.length === 1 ? 'thing' : 'things'} we couldn’t confirm
            </span>
          ) : null}
        </summary>
        <div className="space-y-4 px-4 pb-4 sm:px-5">
          {/*
            The funnel, gate by gate, in plain words. "Nine picked, nine with
            travel times, none scheduled" and "nine picked, none with a travel
            time" are different problems with opposite answers.
          */}
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Gate label="Have travel times" value={funnel.eligible} of={gateBase} />
            <Gate label="Have a way in" value={funnel.accessFeasible} of={gateBase} />
            <Gate label="Open on your dates" value={funnel.hoursFeasible} of={gateBase} />
            <Gate label="Fit in a day" value={funnel.scheduled} of={gateBase} />
          </ol>

          {notes.length > 0 ? (
            <div>
              <p className="text-[12px] font-medium text-ink-muted">What we couldn’t confirm</p>
              <ul className="mt-1.5 space-y-1 text-sm text-ink-muted">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {ruledOut.length > 0 ? (
            <div>
              <p className="text-[12px] font-medium text-ink-muted">What wouldn’t change this</p>
              <ul className="mt-1.5 space-y-1 text-sm text-ink-muted">
                {ruledOut.map((entry) => (
                  <li key={entry.remedy}>
                    <strong>{PLANNER_REMEDY_LABELS[entry.remedy]}.</strong> {entry.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}

type ReadinessTone = 'pine' | 'amber' | 'clay';

/**
 * How loud the panel is. A plan that exists and lost nothing it was asked for
 * is calm; one that lost stops, or exists only thinly, is amber; no plan at all
 * is clay. The words carry the meaning — the colour only sets the volume.
 */
function readinessTone(readiness: PlannerReadiness): ReadinessTone {
  if (!mayShowItinerary(readiness)) return 'clay';
  if (readiness.level !== 'ready') return 'amber';
  if (readiness.unresolvedIssues.length > 0 || readiness.funnel.scheduled < readiness.funnel.selected) return 'amber';
  return 'pine';
}

function readinessHeading(readiness: PlannerReadiness, shown: boolean): string {
  if (!shown) return 'We couldn’t build a plan yet';
  if (readiness.level === 'insufficient') return 'Your plan is thin for a trip this long';
  if (readiness.level === 'infrastructure_failure') return 'Your plan is built, but we couldn’t check everything';
  return 'Your plan is built, with a few gaps';
}

function Tile({ label, value, emphasis }: { label: string; value: number; emphasis?: ReadinessTone }) {
  return (
    <div className="min-w-0 rounded-[10px] bg-paper-sunk/60 px-3 py-2.5">
      <dt className="truncate text-[11px] font-medium text-ink-muted">{label}</dt>
      <dd
        className={cx(
          'numeral mt-0.5 font-display text-2xl leading-none font-light',
          emphasis === 'clay' ? 'text-clay' : emphasis === 'amber' ? 'text-amber' : emphasis === 'pine' ? 'text-pine' : 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Gate({ label, value, of }: { label: string; value: number; of: number }) {
  const bounded = of > 0 && value <= of;
  const ratio = bounded ? value / of : value > 0 ? 1 : 0;
  return (
    <li className="min-w-0">
      <p className="text-[12px] text-ink-muted">{label}</p>
      <p className="mt-0.5 text-sm text-ink">
        <strong className="font-medium">{value}</strong>
        {bounded ? <span className="text-ink-faint"> of {of}</span> : null}
      </p>
      <span aria-hidden="true" className="mt-1.5 block h-1 overflow-hidden rounded-full bg-ink/10">
        <span className="block h-full rounded-full bg-ink/60" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
    </li>
  );
}

/**
 * What could not be established, as distinct from what was established as "no".
 *
 * Kept apart from the blockers because they are different kinds of answer: a
 * closure is a fact about the world, and a missing travel time is a fact about
 * us. Only the second is something a rebuild might fix, and running them
 * together would make both look equally final.
 */
function unresolvedNotes(readiness: PlannerReadiness): string[] {
  const notes: string[] = [];
  const { unresolved } = readiness;
  if (unresolved.routePairs > 0) {
    notes.push(`${unresolved.routePairs} with no measured travel time.`);
  }
  if (unresolved.criticalHours > 0) {
    notes.push(`${unresolved.criticalHours} where nobody publishes opening hours.`);
  }
  if (unresolved.accessRequirements > 0) {
    notes.push(`${unresolved.accessRequirements} with no established way in.`);
  }
  if (unresolved.blockingClosures > 0) {
    notes.push(`${unresolved.blockingClosures} shut across your dates by a published closure.`);
  }
  for (const counter of unresolved.exhaustedBudgets) {
    notes.push(`This trip ran out of ${counter} before finishing.`);
  }
  return notes;
}


/**
 * The blocker codes as clauses.
 *
 * Kept beside the component rather than in the schema because these are the
 * *plural* form — "they are shut on every day of your trip" reads wrong under a
 * count, and the readiness summary already owns the singular voice.
 */
const BLOCKER_LABELS: Record<string, string> = {
  seasonally_closed: 'out of season on your dates',
  not_feasible: 'ruled out by the answers you gave',
  no_time_left: 'no day had the hours and travel budget for them',
  /*
   * Mode-neutral: this clause is rendered over a trip whose own itinerary page
   * may say "This plan assumes no car", and telling that traveller what they
   * "will drive" is the same error as offering them a bigger driving limit.
   */
  exceeds_daily_travel: 'further to reach and return than a day of this trip holds',
  exceeds_intensity: 'harder going than you asked for',
  frequency_reached: 'more of that kind of thing than you wanted',
  lower_priority: 'maybes that the definite choices crowded out',
  missing_travel_data: 'no measured travel time to them',
  access_unavailable: 'no legal way in on any day of the trip',
  service_not_operating: 'the service reaching them does not run on your days',
  missed_last_return: 'reachable, but not with a way back before the last one out',
  transport_mode_unavailable: 'need transport this trip does not have',
  closed_on_trip_dates: 'shut on every day of your trip',
  hours_do_not_fit: 'never open long enough for a visit',
  weather_incompatible: 'ruled out by the weather on every possible day',
  route_contradicted: 'the router answered that no route reaches them',
  /* V11 §20 — "our evidence" is a sentence about our machinery; a traveller wants to know what it means for them. */
  model_proposal_unintegrated: 'suggested by your plan, and we could not confirm it',
};
