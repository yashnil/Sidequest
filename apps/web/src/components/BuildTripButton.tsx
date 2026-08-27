'use client';

import { useState, useTransition } from 'react';
import {
  mayShowItinerary,
  PLANNER_READINESS_LEVEL_LABELS,
  PLANNER_REMEDY_LABELS,
  ruledOutRemedies,
  suggestedRemedies,
  type PlannerReadiness,
} from '@sidequest/core';
import { buttonClass, ErrorNote, Panel } from './ui';
import { buildItineraryAction } from '@/app/(product)/trips/[id]/itinerary/actions';

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
}: {
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

  function build() {
    setError(null);
    onReadiness?.(null);
    startTransition(async () => {
      const result = await buildItineraryAction(tripId);
      // On success this redirects and never returns.
      if (!result.ok) {
        setError(result.error ?? 'We could not build your trip just then.');
        onReadiness?.(result.readiness ?? null);
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={build}
        disabled={pending || includedCount === 0}
        className={buttonClass('primary')}
        aria-describedby={includedCount === 0 ? 'build-hint' : undefined}
      >
        {pending ? 'Building your trip…' : hasItinerary ? 'Rebuild my trip' : 'Build my trip'}
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
        {pending ? 'Building your trip. This takes a few seconds.' : ''}
      </p>
      {includedCount === 0 ? (
        <p id="build-hint" className="mt-2 text-sm text-ink-muted">
          Include at least one place first, or use auto-pick.
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

  return (
    <div data-testid="planner-readiness">
      <Panel className="mt-4 border-amber bg-amber-soft p-4 sm:p-5">
      {/*
        AN H2, BECAUSE THIS IS THE FIRST HEADING UNDER THE PAGE'S H1.

        It was an `h3`, and it renders inside the board's toolbar — which sits
        above every board group. So the Discovery Board's outline went h1 → h3 →
        h2, a skipped level at exactly the moment a screen-reader user most needs
        to navigate by heading: the build has just refused and the explanation is
        the thing they are looking for. Nothing about the panel's visual weight
        changes; `text-lg` is stated, not inherited from the tag.
      */}
      {/*
        THE HEADING HAS TO MATCH WHETHER A PLAN EXISTS.

        This panel is shown for every level except `ready`, and since readiness
        learned to judge completeness that includes plans which were built and
        are too thin to be a trip — a six-day trip holding one stop is now
        `insufficient` rather than a cheerful `ready_with_cautions`. Heading that
        "We did not build a plan" over a board whose itinerary link works is the
        same class of contradiction the level was fixed to remove.

        `mayShowItinerary` is the one place the "is there a plan at all" rule
        lives, so the heading reads it rather than inventing a second test.
      */}
      <h2 className="font-display text-lg text-ink">
        {mayShowItinerary(readiness)
          ? 'Your plan is thinner than your trip'
          : 'We did not build a plan'}
      </h2>
      <p className="text-xs uppercase tracking-[0.12em] text-ink-faint" data-testid="readiness-level">
        {PLANNER_READINESS_LEVEL_LABELS[readiness.level]}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink">{readiness.summary}</p>

      {/*
        WHAT IS ACTUALLY UNRESOLVED.

        The funnel below diagnoses a plan that lost stops. It says nothing at all
        about the other refusal — a plan where every stop was scheduled and the
        days themselves do not work — because every gate in it reads healthy.
        These are those errors, named, so the panel cannot head itself "we did
        not build a plan" and then list six things that all went fine.
      */}
      {readiness.unresolvedIssues.length > 0 ? (
        <ul className="mt-3 space-y-1.5" data-testid="readiness-unresolved">
          {readiness.unresolvedIssues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="flex gap-2 text-sm">
              <span aria-hidden="true" className="text-clay">
                ▲
              </span>
              <span className="text-ink-muted">
                {issue.dayNumber === undefined ? '' : `Day ${issue.dayNumber}: `}
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        The funnel, gate by gate. The *shape* of the loss is the diagnosis:
        "nine picked, nine reachable, none scheduled" and "nine picked, none
        with a travel time" are different problems with opposite answers, and a
        single sentence cannot tell them apart.
      */}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <Count label="On the board" value={readiness.funnel.considered} />
        <Count label="You picked" value={readiness.funnel.selected} />
        <Count label="Measurable" value={readiness.funnel.eligible} />
        <Count label="Way in" value={readiness.funnel.accessFeasible} />
        <Count label="Open" value={readiness.funnel.hoursFeasible} />
        <Count label="Scheduled" value={readiness.funnel.scheduled} />
      </dl>

      {unresolvedNotes(readiness).length > 0 ? (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-[0.12em] text-ink-faint">
            What we could not establish
          </p>
          <ul className="mt-2 space-y-1 text-sm text-ink-muted">
            {unresolvedNotes(readiness).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {readiness.dominantBlockers.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-[0.12em] text-ink-faint">What blocked them</p>
          <ul className="mt-2 space-y-1 text-sm text-ink">
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
          <p className="text-xs uppercase tracking-[0.12em] text-ink-faint">What would help</p>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {helps.map((entry) => (
              <li key={entry.remedy}>
                <strong>{PLANNER_REMEDY_LABELS[entry.remedy]}.</strong> {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {ruledOut.length > 0 ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
            What would not help
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-ink-muted">
            {ruledOut.map((entry) => (
              <li key={entry.remedy}>
                <strong>{PLANNER_REMEDY_LABELS[entry.remedy]}.</strong> {entry.detail}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      </Panel>
    </div>
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

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="text-lg text-ink">{value}</dd>
    </div>
  );
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
};
