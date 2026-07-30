import Link from 'next/link';
import {
  formatMinuteOfDay,
  ITINERARY_STATUS_COPY,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
} from '@sidequest/core';
import { Badge, Panel, buttonClass, cx, type BadgeTone } from './ui';
import { formatMinutes } from '@/lib/format';

const STATUS_TONE: Record<Itinerary['status'], BadgeTone> = {
  ready: 'pine',
  ready_with_cautions: 'amber',
  needs_decision: 'clay',
};

const KIND_STYLE: Record<ItineraryItem['kind'], { rail: string; label: string }> = {
  activity: { rail: 'bg-pine', label: '' },
  travel: { rail: 'bg-slate-blue', label: 'Drive' },
  meal: { rail: 'bg-amber', label: 'Meal' },
  rest: { rail: 'bg-amber', label: 'Rest' },
  free_time: { rail: 'bg-rule', label: 'Free' },
};

const INTENSITY_TONE: Record<ItineraryDay['intensity'], BadgeTone> = {
  light: 'blue',
  moderate: 'pine',
  intense: 'amber',
};

export function ItineraryView({
  itinerary,
  tripId,
  dateLabel,
}: {
  itinerary: Itinerary;
  tripId: string;
  dateLabel: string;
}) {
  const status = ITINERARY_STATUS_COPY[itinerary.status];
  const conflicts = itinerary.unscheduled.filter((entry) => entry.wasManual);
  const dropped = itinerary.unscheduled.filter((entry) => !entry.wasManual);
  const openIssues = itinerary.issues.filter((issue) => issue.severity !== 'info');

  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="border-b border-rule pb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Your trip</p>
        <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-5xl">
          {itinerary.baseName}
        </h1>
        <p className="mt-3 text-ink-muted">
          {dateLabel} · {itinerary.days.length} days · based in {itinerary.baseName}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[itinerary.status]}>{status.label}</Badge>
          <span className="text-sm text-ink-muted">{status.blurb}</span>
        </div>

        <p className="mt-4 text-sm text-ink-muted">{itinerary.summary}</p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href={`/trips/${tripId}/discover`} className={buttonClass('secondary', 'sm')}>
            Back to the board
          </Link>
        </div>
      </header>

      {conflicts.length > 0 ? (
        <Panel className="mt-8 border-clay p-5">
          <h2 className="font-display text-lg text-clay">
            {conflicts.length === 1 ? 'One thing you picked' : `${conflicts.length} things you picked`} could not be scheduled
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            We would rather tell you than quietly drop it or break a limit you set.
          </p>
          <ul className="mt-4 space-y-3">
            {conflicts.map((entry) => (
              <li key={entry.placeId} className="text-sm">
                <span className="font-medium text-ink">{entry.name}</span>
                <span className="block text-ink-muted">{entry.reason}</span>
                {entry.suggestedRemedy ? (
                  <span className="mt-0.5 block text-ink-faint">
                    Smallest fix: {entry.suggestedRemedy}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <ol className="mt-10 space-y-12">
        {itinerary.days.map((day) => (
          <li key={day.dayNumber}>
            <DayCard day={day} />
          </li>
        ))}
      </ol>

      {dropped.length > 0 ? (
        <section className="mt-14 border-t border-rule pt-8">
          <h2 className="font-display text-xl text-ink">Left off for room</h2>
          <p className="mt-1 text-sm text-ink-muted">
            These were on your board but there were not the hours for them. Nothing is hidden.
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {dropped.map((entry) => (
              <li key={entry.placeId} className="rounded-lg border border-rule p-3 text-sm">
                <span className="font-medium text-ink">{entry.name}</span>
                <span className="mt-0.5 block text-ink-muted">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {openIssues.length > 0 ? (
        <section className="mt-14 border-t border-rule pt-8">
          <h2 className="font-display text-xl text-ink">Worth reading</h2>
          <ul className="mt-4 space-y-2">
            {openIssues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="flex gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className={cx(issue.severity === 'error' ? 'text-clay' : 'text-amber')}
                >
                  ▲
                </span>
                <span className="text-ink-muted">{issue.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-14 border-t border-rule pt-6 text-xs leading-relaxed text-ink-faint">
        Travel times are {itinerary.diagnostics.matrixProvenance}, not measured road data.{' '}
        {itinerary.diagnostics.matrixNote}
        {itinerary.diagnostics.revisions.length > 0 ? (
          <>
            {' '}Adjusted {itinerary.diagnostics.revisions.length}{' '}
            {itinerary.diagnostics.revisions.length === 1 ? 'time' : 'times'} while planning:{' '}
            {itinerary.diagnostics.revisions.map((revision) => revision.description).join(' ')}
          </>
        ) : null}
      </footer>
    </div>
  );
}

function DayCard({ day }: { day: ItineraryDay }) {
  const isEmpty = day.totals.activityMinutes === 0;

  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-rule bg-paper-sunk p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="font-display text-2xl text-ink">
            Day {day.dayNumber}
            <span className="ml-3 text-base font-normal text-ink-faint">{day.date}</span>
          </h2>
          <span className="text-sm text-ink-muted">
            {formatMinuteOfDay(day.window.startMinute)} – {formatMinuteOfDay(day.window.endMinute)}
          </span>
        </div>
        <p className="mt-1 text-ink-muted">{day.theme}</p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone={INTENSITY_TONE[day.intensity]}>{day.intensity} day</Badge>
          {day.totals.travelMinutes > 0 ? (
            <Badge>{formatMinutes(day.totals.travelMinutes)} driving</Badge>
          ) : null}
          {day.totals.activityMinutes > 0 ? (
            <Badge>{formatMinutes(day.totals.activityMinutes)} on foot</Badge>
          ) : null}
          {day.totals.freeMinutes > 0 ? (
            <Badge>{formatMinutes(day.totals.freeMinutes)} free</Badge>
          ) : null}
        </div>

        {day.window.note ? (
          <p className="mt-3 text-sm text-ink-faint">{day.window.note}</p>
        ) : null}
      </div>

      {isEmpty ? (
        <p className="p-5 text-sm text-ink-muted">
          Nothing scheduled. On an arrival or departure day that is usually the honest answer.
        </p>
      ) : (
        <ol className="divide-y divide-rule">
          {day.items.map((item) => (
            <li key={item.id}>
              <TimelineRow item={item} />
            </li>
          ))}
        </ol>
      )}

      {day.warnings.length > 0 ? (
        <ul className="border-t border-rule bg-amber-soft/40 p-4 text-xs leading-relaxed text-ink-muted">
          {day.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

function TimelineRow({ item }: { item: ItineraryItem }) {
  const style = KIND_STYLE[item.kind];

  return (
    <div className="flex gap-3 p-4 sm:gap-4 sm:p-5">
      <div className="w-14 shrink-0 pt-0.5 text-right sm:w-16">
        <time className="block text-sm tabular-nums text-ink">
          {formatMinuteOfDay(item.startMinute)}
        </time>
        <span className="mt-0.5 block text-[11px] tabular-nums text-ink-faint">
          {formatMinutes(item.durationMinutes)}
        </span>
      </div>

      <span aria-hidden="true" className={cx('mt-1.5 w-1 shrink-0 rounded-full', style.rail)} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3
            className={cx(
              'text-ink',
              item.kind === 'activity' ? 'font-display text-lg' : 'text-sm font-medium',
            )}
          >
            {item.title}
          </h3>
          {style.label ? (
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              {style.label}
            </span>
          ) : null}
          {item.physicalIntensity && item.physicalIntensity !== 'none' ? (
            <Badge>{item.physicalIntensity}</Badge>
          ) : null}
          {item.weatherSensitive ? <Badge tone="amber">Weather-dependent</Badge> : null}
        </div>

        <p className="mt-1 text-sm leading-relaxed text-ink-muted">{item.reason}</p>

        {item.travel ? (
          <p className="mt-1 text-xs text-ink-faint">
            {item.travel.fromName} → {item.travel.toName} · {Math.round(item.travel.km)} km ·{' '}
            {item.travel.provenance} travel time
          </p>
        ) : null}

        {item.accessWarning ? (
          <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            {item.accessWarning}
          </p>
        ) : null}

        {item.seasonalNote && item.seasonalNote !== item.accessWarning ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">{item.seasonalNote}</p>
        ) : null}
      </div>
    </div>
  );
}
