'use client';

import { useState, useTransition } from 'react';
import {
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
  storedReadiness,
}: {
  tripId: string;
  hasItinerary: boolean;
  includedCount: number;
  /**
   * Why the last attempt refused, read from the database by the page.
   *
   * Without this the explanation lives only in a server action's return value,
   * which a refresh throws away — leaving somebody looking at a board and a
   * button that appears to do nothing. A refusal is a finding, and a finding
   * that does not survive a reload is not much of one.
   */
  storedReadiness?: PlannerReadiness | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<PlannerReadiness | null>(
    storedReadiness && storedReadiness.funnel.scheduled === 0 ? storedReadiness : null,
  );
  const [pending, startTransition] = useTransition();

  function build() {
    setError(null);
    setReadiness(null);
    startTransition(async () => {
      const result = await buildItineraryAction(tripId);
      // On success this redirects and never returns.
      if (!result.ok) {
        setError(result.error ?? 'We could not build your trip just then.');
        setReadiness(result.readiness ?? null);
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
      {includedCount === 0 ? (
        <p id="build-hint" className="mt-2 text-sm text-ink-muted">
          Include at least one place first, or use auto-pick.
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {readiness ? <PlannerReadinessPanel readiness={readiness} /> : null}
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
function PlannerReadinessPanel({ readiness }: { readiness: PlannerReadiness }) {
  const helps = suggestedRemedies(readiness);
  const ruledOut = ruledOutRemedies(readiness);

  return (
    <div data-testid="planner-readiness">
      <Panel className="mt-4 border-amber bg-amber-soft p-4 sm:p-5">
      <h3 className="font-display text-lg text-ink">We did not build a plan</h3>
      <p className="text-xs uppercase tracking-[0.12em] text-ink-faint" data-testid="readiness-level">
        {PLANNER_READINESS_LEVEL_LABELS[readiness.level]}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink">{readiness.summary}</p>

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
  exceeds_daily_travel: 'further to reach and return than you will drive in a day',
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
