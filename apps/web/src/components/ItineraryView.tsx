import Link from 'next/link';
import {
  BOOKING_KIND_LABELS,
  formatMinuteOfDay,
  ITINERARY_STATUS_COPY,
  TRANSPORT_MODE_LABELS,
  type DailyWindow,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type TransportStrategy,
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
  travel: { rail: 'bg-slate-blue', label: '' },
  meal: { rail: 'bg-amber', label: 'Meal' },
  rest: { rail: 'bg-amber', label: 'Rest' },
  free_time: { rail: 'bg-rule', label: 'Free' },
};

/**
 * Two scales that run in opposite directions. High stress is a caution; high
 * convenience is the best outcome there is, and sharing one map painted it amber.
 */
const STRESS_TONE: Record<TransportStrategy['stress'], BadgeTone> = {
  low: 'pine',
  moderate: 'blue',
  high: 'amber',
};

const CONVENIENCE_TONE: Record<TransportStrategy['convenience'], BadgeTone> = {
  low: 'amber',
  moderate: 'blue',
  high: 'pine',
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
          {/* Every route here goes somewhere that can actually resolve it. */}
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={`/trips/${tripId}/discover`} className={buttonClass('secondary', 'sm')}>
              Change what is on the board
            </Link>
            <Link href={`/trips/${tripId}/questionnaire`} className={buttonClass('secondary', 'sm')}>
              Change how you are getting around
            </Link>
          </div>
        </Panel>
      ) : null}

      <TransportPlan strategy={itinerary.transportStrategy} />

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

      {/*
        Where the numbers came from is stated once, in the transport section that
        owns them. Repeating it here made the same disclosure appear twice on one
        page, which reads as boilerplate and gets skipped. What is left is the
        thing nothing else says: what the planner changed while building.
      */}
      {itinerary.diagnostics.revisions.length > 0 ? (
        <footer className="mt-14 border-t border-rule pt-6 text-xs leading-relaxed text-ink-faint">
          Adjusted {itinerary.diagnostics.revisions.length}{' '}
          {itinerary.diagnostics.revisions.length === 1 ? 'time' : 'times'} while planning:{' '}
          {itinerary.diagnostics.revisions.map((revision) => revision.description).join(' ')}
        </footer>
      ) : null}
    </div>
  );
}

/**
 * The trip's transportation position.
 *
 * Reads as an editorial page rather than a dashboard: a recommendation, the
 * reasoning behind it, what it costs, and what to check. The numbers are
 * deliberately coarse and the disclosure is not tucked away, because a modelled
 * drive time presented with a dashboard's confidence is worse than no number.
 */
function TransportPlan({ strategy }: { strategy: TransportStrategy }) {
  const { totals } = strategy;

  return (
    <section className="mt-10 border-t border-rule pt-8" aria-labelledby="transport-plan">
      <h2 id="transport-plan" className="font-display text-xl text-ink">
        Getting around
      </h2>
      <p className="mt-2 max-w-2xl text-ink-muted">{strategy.headline}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Badge tone="pine">{TRANSPORT_MODE_LABELS[strategy.primaryMode]}</Badge>
        {strategy.secondaryMode ? (
          <Badge tone="blue">plus {TRANSPORT_MODE_LABELS[strategy.secondaryMode].toLowerCase()}</Badge>
        ) : (
          <Badge>no practical alternative</Badge>
        )}
        <Badge tone={STRESS_TONE[strategy.stress]}>{strategy.stress} stress</Badge>
        <Badge tone={CONVENIENCE_TONE[strategy.convenience]}>
          {strategy.convenience} convenience
        </Badge>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Metric label="At the wheel">{formatMinutes(totals.driveMinutes)}</Metric>
        <Metric label="Riding & waiting">
          {formatMinutes(totals.transitMinutes + totals.waitMinutes)}
        </Metric>
        <Metric label="On foot to reach things">{formatMinutes(totals.walkMinutes)}</Metric>
        <Metric label="Road distance">{Math.round(totals.driveKm)} km</Metric>
      </dl>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-ink">Why this way</h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {strategy.rationale.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        {strategy.tradeoffs.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium text-ink">What it costs you</h3>
            <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
              {strategy.tradeoffs.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <dl className="mt-6 space-y-3 text-sm">
        <Detail label="Parking">{strategy.parkingSummary}</Detail>
        <Detail label="Public transport">{strategy.transitSummary}</Detail>
        {strategy.withoutPrimary ? (
          <Detail label="Without a car">{strategy.withoutPrimary}</Detail>
        ) : null}
      </dl>

      {strategy.seasonalWarnings.length > 0 ? (
        <div className="mt-5 rounded-lg bg-amber-soft p-4">
          <h3 className="text-sm font-medium text-ink">Seasonal limits</h3>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-muted">
            {strategy.seasonalWarnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {strategy.verifyBeforeTravel.length > 0 ? (
        <div className="mt-3 rounded-lg border border-clay p-4">
          <h3 className="text-sm font-medium text-clay">Check these before you book</h3>
          <p className="mt-1 text-xs text-ink-faint">
            These change year to year. We have not checked today&rsquo;s conditions.
          </p>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
            {strategy.verifyBeforeTravel.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-4 text-xs leading-relaxed text-ink-faint">{strategy.dataDisclosure}</p>
    </section>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink tabular-nums">{children}</dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sm:flex sm:gap-4">
      <dt className="shrink-0 text-ink-faint sm:w-40">{label}</dt>
      <dd className="text-ink-muted">{children}</dd>
    </div>
  );
}

/**
 * The day's transport as a sequence, not a table.
 *
 * "Drive → park → shuttle → walk → back" is the thing a traveller actually has
 * to execute, and reading it as one line is worth more than four accurate
 * numbers. The numbers sit underneath for anyone who wants them.
 */
function DayTransport({ day }: { day: ItineraryDay }) {
  const sequence = accessSequence(day);
  const { totals, transport } = day;

  return (
    <div className="mt-3">
      {/*
        A real list, so a screen reader announces "list, 6 items" and reads them
        one at a time. As bare spans with an aria-hidden arrow between them the
        steps ran together into a single unpunctuated phrase.
      */}
      {sequence.length > 1 ? (
        <ol
          aria-label={`How this day moves: ${sequence.join(', then ')}`}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-muted"
        >
          {sequence.map((step, index) => (
            <li key={`${step}-${index}`} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden="true" className="text-ink-faint">
                  →
                </span>
              ) : null}
              <span className="rounded-full bg-paper-raised px-2 py-0.5">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {totals.driveMinutes > 0 ? (
          <Badge>{formatMinutes(totals.driveMinutes)} driving</Badge>
        ) : null}
        {totals.transitMinutes > 0 ? (
          <Badge tone="blue">{formatMinutes(totals.transitMinutes)} riding</Badge>
        ) : null}
        {totals.walkMinutes > 0 ? (
          <Badge tone="blue">{formatMinutes(totals.walkMinutes)} walking there</Badge>
        ) : null}
        {totals.waitMinutes > 0 ? (
          <Badge>{formatMinutes(totals.waitMinutes)} waiting</Badge>
        ) : null}
      </div>

      {transport.lastReturnNote ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{transport.lastReturnNote}</p>
      ) : null}
      {transport.parkingNotes.map((note) => (
        <p key={note} className="mt-1 text-xs leading-relaxed text-ink-faint">
          {note}
        </p>
      ))}
      {/*
        The rules' own prose — fares, boarding points, the exceptions that let you
        drive in. Folded away because it is long and only some of it applies on
        any given day, but present, because it is the part a traveller reads on
        the morning itself.
      */}
      {transport.accessNotes.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ink-faint hover:text-ink">
            How the access works ({transport.accessNotes.length})
          </summary>
          <ul className="mt-2 space-y-1 leading-relaxed text-ink-muted">
            {transport.accessNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {transport.verifyBeforeTravel.length > 0 ? (
        <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
          Check before you go: {transport.verifyBeforeTravel.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

/** Collapses the day's legs into the shape of the journey, without repeats. */
function accessSequence(day: ItineraryDay): string[] {
  const steps: string[] = [];
  const push = (label: string) => {
    if (steps[steps.length - 1] !== label) steps.push(label);
  };

  for (const item of day.items) {
    if (item.kind === 'activity') {
      push('visit');
      continue;
    }
    if (item.kind !== 'travel' || !item.travel) continue;
    const { mode, role } = item.travel;
    if (role === 'wait') push('board');
    else if (role === 'walk') push('walk');
    // "back" comes from the leg's own role, not from whether anything has been
    // visited yet — otherwise every hop between two stops reads as a return.
    else if (role === 'return') push(`${TRANSPORT_MODE_LABELS[mode].toLowerCase()} back`);
    else push(TRANSPORT_MODE_LABELS[mode].toLowerCase());
  }
  return steps;
}

/**
 * What the day's opening hours did to its shape.
 *
 * Renders nothing at all on a day where nothing had a closing time, which is
 * most of them here. When it does render, the anchor comes first: "be at this
 * one by four, everything else can move" is the sentence a traveller can act on,
 * and it beats four rows of times for them to reconcile themselves.
 */
function DayHours({ day }: { day: ItineraryDay }) {
  const { availability } = day;
  /**
   * Only the two things the day as a whole can say that a single stop cannot:
   * which stop fixes its shape, and what has to be arranged before it works.
   *
   * The cautions and the verification notes live on the stops themselves, a few
   * centimetres below. Printing them here as well put the same sentence on the
   * screen twice, which reads as a template rather than as advice — they are
   * still persisted with the plan, for the day an export or a digest needs them
   * without the timeline.
   */
  const hasSomething = availability.anchorNote !== undefined || availability.bookings.length > 0;
  if (!hasSomething) return null;

  return (
    <section className="mt-3 border-t border-rule pt-3" aria-label={`Opening hours on day ${day.dayNumber}`}>
      {availability.anchorNote ? (
        <p className="text-sm leading-relaxed text-ink-muted">{availability.anchorNote}</p>
      ) : null}

      {availability.bookings.length > 0 ? (
        <div className="mt-2 rounded-md border border-clay/40 p-2.5">
          <p className="text-xs font-medium text-clay">
            {availability.bookings.length === 1
              ? 'One thing here needs arranging'
              : `${availability.bookings.length} things here need arranging`}
          </p>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
            {availability.bookings.map((booking) => (
              <li key={booking.placeId}>
                <span className="font-medium text-ink">{booking.name}</span> —{' '}
                {BOOKING_KIND_LABELS[booking.kind].toLowerCase()}. We have not made it for you.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
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
          {day.totals.activityMinutes > 0 ? (
            <Badge>{formatMinutes(day.totals.activityMinutes)} at stops</Badge>
          ) : null}
          {day.totals.freeMinutes > 0 ? (
            <Badge>{formatMinutes(day.totals.freeMinutes)} free</Badge>
          ) : null}
        </div>

        {day.totals.travelMinutes > 0 ? <DayTransport day={day} /> : null}
        <DayHours day={day} />

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
              <TimelineRow item={item} window={day.window} />
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

function TimelineRow({ item, window }: { item: ItineraryItem; window: DailyWindow }) {
  const style = KIND_STYLE[item.kind];
  /**
   * Hours are shown only when they bear on this day. A site posted 06:00 to
   * 22:00 on a day that runs 07:30 to 19:00 has constrained nothing, and saying
   * so on every stop is how a traveller learns to skip the line that matters.
   */
  const hours =
    item.hours &&
    (item.hours.openMinute > window.startMinute ||
      item.hours.closeMinute < window.endMinute ||
      item.hours.lastAdmissionMinute !== undefined)
      ? item.hours
      : undefined;

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
          {item.travel ? (
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              {TRANSPORT_MODE_LABELS[item.travel.mode]}
            </span>
          ) : style.label ? (
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              {style.label}
            </span>
          ) : null}
          {item.physicalIntensity && item.physicalIntensity !== 'none' ? (
            <Badge>{item.physicalIntensity}</Badge>
          ) : null}
          {item.weatherSensitive ? <Badge tone="amber">Weather-dependent</Badge> : null}
          {item.booking ? (
            <Badge tone="amber">{BOOKING_KIND_LABELS[item.booking.kind]}</Badge>
          ) : null}
        </div>

        {hours ? (
          <p className="mt-1 text-xs tabular-nums text-ink-faint">
            Open {formatMinuteOfDay(hours.openMinute)}–{formatMinuteOfDay(hours.closeMinute)}
            {hours.lastAdmissionMinute !== undefined
              ? ` · arrive before ${formatMinuteOfDay(hours.lastAdmissionMinute)}`
              : ''}
            {hours.periodLabel ? ` · ${hours.periodLabel}` : ''}
          </p>
        ) : null}

        <p className="mt-1 text-sm leading-relaxed text-ink-muted">{item.reason}</p>

        {item.travel ? (
          <p className="mt-1 text-xs text-ink-faint">
            {item.travel.fromName} → {item.travel.toName}
            {item.travel.km > 0 ? ` · ${Math.round(item.travel.km)} km` : ''} ·{' '}
            {item.travel.provenance === 'official'
              ? 'published timetable'
              : `${item.travel.provenance} travel time`}
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

        {item.booking ? (
          <p className="mt-2 rounded-md border border-clay/40 p-2.5 text-xs leading-relaxed text-ink-muted">
            <span className="font-medium text-clay">You have to arrange this yourself.</span>{' '}
            {item.booking.note ?? 'We have not booked anything.'}
            {item.booking.url ? (
              <>
                {' '}
                <a
                  className="underline underline-offset-2"
                  href={item.booking.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Book with the operator
                </a>
                .
              </>
            ) : null}
          </p>
        ) : null}

        {item.daylightOnly ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Signed for daylight use only. We do not work out sunrise and sunset yet, so check how
            much light your dates give you.
          </p>
        ) : null}

        {item.verifyBeforeTravel ? (
          <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            <span className="font-medium text-ink">Check its hours.</span>{' '}
            {item.verifyBeforeTravel}
          </p>
        ) : null}

        {hours ? (
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            {hours.sourceKind === 'official' ? 'Hours from' : 'Hours written from'}{' '}
            {hours.sourceUrl ? (
              <a
                className="underline underline-offset-2"
                href={hours.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {hours.sourceName}
              </a>
            ) : (
              hours.sourceName
            )}
            {hours.lastVerified ? `, read ${hours.lastVerified}` : ', not checked against a source'}
            . We have not checked today.
          </p>
        ) : null}
      </div>
    </div>
  );
}
