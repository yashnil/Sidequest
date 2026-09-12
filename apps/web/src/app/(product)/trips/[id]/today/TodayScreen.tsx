'use client';

import Link from 'next/link';
import { formatMinuteOfDay, type FactObservation, type TodayView, type TripNodeState } from '@sidequest/core';
import { ASK_OPEN_EVENT } from '@/components/hub/HubShell';
import { STATE_WORDS } from '@/components/hub/HumanWords';
import { OfflineSnapshot } from '@/components/OfflineSnapshot';
import { Badge, cx } from '@/components/ui';
import type { TodayDirections, TodayReservation } from './today-view-model';

/**
 * V9 §8 — THE DAY-OF SCREEN.
 *
 * One column, phone first, centred on a desktop. In order of what matters
 * before the next leg: NOW · NEXT with when to leave and on what basis, the
 * directions link, the reservation, the weather, the fallback, what changed
 * today, then the timeline with its done state. Every control clears 48 px.
 * No planner chrome: one "Back to trip" link and one "Change today" button
 * that opens Ask Sidequest with the day pre-filled — never sent on its own,
 * because a change is the traveller's sentence, not Sidequest's.
 *
 * Client only for the button and the offline indicator; every fact here was
 * derived on the server from persisted state.
 */
export interface TodayScreenProps {
  tripId: string;
  destination: string;
  today: TodayView;
  firstDate: string;
  lastDate: string;
  dayCount: number;
  timeZone: string | null;
  state: TripNodeState | null;
  directions: TodayDirections | null;
  reservation: TodayReservation | null;
  changed: readonly FactObservation[];
}

const BIG_LINK = 'pressable inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine';

function leaveWord(minutesFromNow: number): string {
  if (minutesFromNow <= -1) return `${Math.abs(minutesFromNow)} min ago`;
  if (minutesFromNow === 0) return 'now';
  if (minutesFromNow < 60) return `in ${minutesFromNow} min`;
  const h = Math.floor(minutesFromNow / 60);
  const m = minutesFromNow % 60;
  return `in ${h} h${m > 0 ? ` ${m} min` : ''}`;
}

export function TodayScreen(props: TodayScreenProps) {
  const { today, tripId } = props;
  const back = (
    <Link href={`/trips/${tripId}/itinerary`} className={cx(BIG_LINK, 'border border-rule bg-paper-raised text-ink shadow-[var(--shadow-card)]')} data-testid="today-back">
      ← Back to trip
    </Link>
  );

  if (!today.active || !today.dayNumber) {
    return (
      <main className="mx-auto w-full max-w-md px-5 pb-16 pt-8" data-testid="today-page" data-active="false">
        <p className="eyebrow">Today</p>
        <h1 className="mt-2 font-display text-3xl leading-tight text-ink">Not travelling today</h1>
        <p className="mt-3 type-body text-ink-muted" data-testid="today-inactive">
          {today.localDate < props.firstDate ? `${props.destination} starts on ${props.firstDate}. This page wakes up on the first day.` : `${props.destination} ended on ${props.lastDate}.`}
        </p>
        <div className="mt-8">{back}</div>
      </main>
    );
  }

  const change = () => {
    const prefill = `Change today (day ${today.dayNumber}${today.theme ? `, ${today.theme}` : ''}): `;
    window.dispatchEvent(new CustomEvent(ASK_OPEN_EVENT, { detail: { request: prefill, send: false, dayNumber: today.dayNumber } }));
  };
  const stateWord = props.state ? STATE_WORDS[props.state] : null;

  return (
    <main className="mx-auto w-full max-w-md px-5 pb-20 pt-6" data-testid="today-page" data-active="true" data-day={today.dayNumber}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="eyebrow text-pine">
            Day {today.dayNumber} of {props.dayCount}
            {today.baseName ? ` · ${today.baseName}` : ''}
          </p>
          <h1 className="mt-1 font-display text-3xl leading-tight text-ink">{today.theme ?? 'Today'}</h1>
          <p className="mt-1 type-meta">
            {today.localDate} · {formatMinuteOfDay(today.nowMinute)}
            {props.timeZone ? ` · ${props.timeZone.replace(/_/g, ' ')}` : ' · UTC'}
          </p>
        </div>
        {stateWord ? <Badge tone={stateWord.tone}>{stateWord.label}</Badge> : null}
      </header>

      {/* NOW · NEXT — the two facts a traveller opens their phone for. */}
      <section className="card-raised mt-5 p-5" aria-label="Now and next">
        <p className="eyebrow">Now</p>
        <p className="mt-1 font-display text-xl leading-snug text-ink" data-testid="today-now">
          {today.current ? `${today.current.title} · until ${formatMinuteOfDay(today.current.endMinute)}` : 'Nothing scheduled right now.'}
        </p>
        <p className="eyebrow mt-4">Next</p>
        <p className="mt-1 font-display text-xl leading-snug text-ink" data-testid="today-next">
          {today.next ? `${today.next.title} · ${formatMinuteOfDay(today.next.startMinute)}` : 'Nothing more today.'}
        </p>
        {today.leaveBy ? (
          <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-sm text-ink" data-testid="today-leave-by" data-basis={today.leaveBy.basis}>
            <span className="eyebrow">Leave by</span>
            <span className="type-figure text-2xl">{today.leaveBy.time}</span>
            <span className="type-small text-ink-muted">{leaveWord(today.leaveBy.minutesFromNow)}</span>
            <span className="basis-full type-meta">{today.leaveBy.basisNote}</span>
          </p>
        ) : today.nextTransport ? (
          <p className="mt-3 type-small text-ink-muted" data-testid="today-leg">
            {today.nextTransport.title}: {today.nextTransport.minutes !== null ? `about ${today.nextTransport.minutes} min` : 'not yet timed — allow a margin'}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {props.directions ? (
            <a href={props.directions.google} target="_blank" rel="noreferrer noopener" className={cx(BIG_LINK, 'bg-ink text-paper')} data-testid="today-directions" data-mode={props.directions.mode}>
              {props.directions.label}
            </a>
          ) : null}
          {props.directions ? (
            <a href={props.directions.apple} target="_blank" rel="noreferrer noopener" className={cx(BIG_LINK, 'border border-rule bg-paper-raised text-ink')} data-testid="today-directions-apple">
              Apple Maps
            </a>
          ) : null}
        </div>
        {props.reservation ? (
          <div className="mt-4 rounded-[var(--radius-card)] border border-pine/40 bg-pine-soft/40 px-3.5 py-3" data-testid="today-reservation">
            <p className="eyebrow text-pine">Booked</p>
            <p className="mt-0.5 text-sm font-medium text-ink">
              {props.reservation.title}
              {props.reservation.startTime ? ` · ${props.reservation.startTime}` : ''}
            </p>
            {props.reservation.location ? <p className="type-small text-ink-muted">{props.reservation.location}</p> : null}
            {props.reservation.confirmationRef ? (
              <details className="mt-1 print:hidden">
                <summary className="min-h-11 cursor-pointer list-none type-small text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">Show the reference</summary>
                <p className="type-figure text-base text-ink" data-testid="today-reservation-ref">
                  {props.reservation.confirmationRef}
                </p>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>

      {today.weather ? (
        <p className="mt-4 type-small text-ink" data-testid="today-weather">
          <span className="eyebrow mr-2">Weather</span>
          {today.weather.summary}
          {today.weather.cautions.length > 0 ? <span className="text-amber"> — {today.weather.cautions.join('; ')}</span> : null}
        </p>
      ) : null}
      {today.criticalWarnings.length > 0 ? (
        <ul className="mt-3 space-y-1 type-small text-clay" data-testid="today-warnings">
          {today.criticalWarnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {today.fallback ? (
        <p className="mt-3 type-small text-ink-muted" data-testid="today-fallback">
          <span className="eyebrow mr-2">If today goes wrong</span>
          {today.fallback}
        </p>
      ) : null}
      {props.changed.length > 0 ? (
        <div className="card mt-4 border-clay/40 p-4" data-testid="today-changed">
          <p className="eyebrow text-clay">Changed since the plan was written</p>
          <ul className="mt-1.5 space-y-1 type-small text-ink">
            {props.changed.slice(0, 4).map((o) => (
              <li key={o.id}>{o.summary}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={change} className={cx(BIG_LINK, 'bg-accent text-paper')} data-testid="today-change">
          Change today
        </button>
        {back}
      </div>

      <section className="mt-8" aria-labelledby="today-timeline-heading">
        <h2 id="today-timeline-heading" className="type-section text-ink">
          The day
        </h2>
        <ol className="mt-3 divide-y divide-rule rounded-[var(--radius-card)] border border-rule bg-paper-raised" data-testid="today-timeline">
          {today.stops.map((stop) => (
            <li key={stop.id} className={cx('flex min-h-12 items-center gap-3 px-4 py-3', stop.done && 'text-ink-faint')} data-testid="today-stop" data-done={stop.done ? 'true' : 'false'}>
              <span aria-hidden="true" className={cx('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[0.7rem]', stop.done ? 'border-pine bg-pine text-paper' : today.current?.id === stop.id ? 'border-accent bg-accent text-paper' : 'border-ink-faint')}>
                {stop.done ? '✓' : ''}
              </span>
              <span className="type-figure w-14 shrink-0 text-sm">{formatMinuteOfDay(stop.startMinute)}</span>
              <span className={cx('min-w-0 flex-1 text-sm', stop.done ? 'line-through' : 'text-ink')}>{stop.title}</span>
              <span className="sr-only">{stop.done ? 'done' : today.current?.id === stop.id ? 'now' : 'to come'}</span>
            </li>
          ))}
        </ol>
        {today.flexAlternatives.length > 0 ? <p className="mt-2 type-meta">Flexible: {today.flexAlternatives.join(' · ')}</p> : null}
      </section>

      <p className="mt-6">
        <OfflineSnapshot path={`/trips/${tripId}/today`} tripId={tripId} testId="today-offline-state" />
      </p>
    </main>
  );
}
