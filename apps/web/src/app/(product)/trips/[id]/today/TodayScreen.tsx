'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatMinuteOfDay, NEXT_ACTION_KIND_WORD, type FactObservation, type NextActions, type TodayView, type TripNodeState } from '@sidequest/core';
import { ASK_OPEN_EVENT } from '@/components/hub/HubShell';
import { splitDayTheme } from '@/components/hub/hero-stats';
import { STATE_WORDS } from '@/components/hub/HumanWords';
import { OfflineSnapshot } from '@/components/OfflineSnapshot';
import { Badge, cx } from '@/components/ui';
import type { TodayDirections, TodayReservation } from './today-view-model';
import { countdownWords, daysBetween, longDate, prepActions, type FirstDayPreview } from './today-before';

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
  /** Day one, for the screen before the trip. */
  firstDay?: FirstDayPreview | null;
  /** The deterministic next actions — the same ones the hub shows. */
  nextActions?: NextActions | null;
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
    if (today.localDate < props.firstDate) return <BeforeTrip {...props} back={back} />;
    return (
      <main className="mx-auto w-full max-w-md px-5 pb-16 pt-8" data-testid="today-page" data-active="false">
        <p className="eyebrow">Today</p>
        <h1 className="mt-2 font-display text-3xl leading-tight text-ink">Not travelling today</h1>
        <p className="mt-3 type-body text-ink-muted" data-testid="today-inactive">
          {props.destination} ended on {longDate(props.lastDate)}.
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
          <p className="sheet-label text-ink-muted">
            Day {today.dayNumber} of {props.dayCount}
            {today.baseName ? ` · ${today.baseName}` : ''}
          </p>
          <h1 className="mt-2 font-display text-[2.4rem] leading-[1.02] font-light tracking-[-0.025em] text-ink">{today.theme ?? 'Today'}</h1>
          <p className="coordbar mt-2 text-ink-muted">
            {today.localDate} · {formatMinuteOfDay(today.nowMinute)}
            {props.timeZone ? ` · ${props.timeZone.replace(/_/g, ' ')}` : ' · UTC'}
          </p>
        </div>
        {stateWord ? <Badge tone={stateWord.tone}>{stateWord.label}</Badge> : null}
      </header>

      {/*
        NOW · NEXT — the two facts a traveller opens their phone for, set like a
        departure board: the night ground, the next place large, the time to
        leave as the biggest figure on the screen.
      */}
      <section className="survey-night -mx-5 mt-6 px-5 py-6 text-bone" aria-label="Now and next">
        <p className="sheet-label text-[var(--color-glacier)]">Now</p>
        <p className="mt-1 font-display text-xl leading-snug text-bone/85" data-testid="today-now">
          {today.current ? `${today.current.title} · until ${formatMinuteOfDay(today.current.endMinute)}` : 'Nothing scheduled right now.'}
        </p>
        <p className="sheet-label mt-5 text-[var(--color-glacier)]">Next</p>
        <p className="mt-1 font-display text-[1.85rem] leading-[1.08] font-light tracking-[-0.015em] text-bone" data-testid="today-next">
          {today.next ? `${today.next.title} · ${formatMinuteOfDay(today.next.startMinute)}` : 'Nothing more today.'}
        </p>
        {today.leaveBy ? (
          /* V9.1 §10 — the figure, how far off it is, and its basis in one short sentence beneath, at the operational size. */
          <p className="mt-5 flex flex-wrap items-baseline gap-x-3 border-t border-white/12 pt-4 text-sm text-bone" data-testid="today-leave-by" data-basis={today.leaveBy.basis}>
            <span className="sheet-label basis-full text-[var(--color-glacier)]">Leave by</span>
            <span className="font-mono text-[3.25rem] leading-none font-medium tracking-[-0.02em] text-flare">{today.leaveBy.time}</span>
            <span className="type-small text-bone/75">{leaveWord(today.leaveBy.minutesFromNow)}</span>
            <span className="basis-full pt-1 type-small text-bone/65" data-testid="today-leave-by-basis">
              {today.leaveBy.basisNote}
            </span>
          </p>
        ) : today.nextTransport ? (
          <p className="mt-3 type-small text-bone/70" data-testid="today-leg">
            {today.nextTransport.title}: {today.nextTransport.minutes !== null ? `about ${today.nextTransport.minutes} min` : 'not yet timed — allow a margin'}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {/* V9.1 §10 — directions are the one accent action on this screen; everything else is ink or outlined. */}
          {props.directions ? (
            <a href={props.directions.google} target="_blank" rel="noreferrer noopener" className={cx(BIG_LINK, 'bg-flare text-night')} data-testid="today-directions" data-mode={props.directions.mode}>
              {props.directions.label}
            </a>
          ) : null}
          {props.directions ? (
            <a href={props.directions.apple} target="_blank" rel="noreferrer noopener" className={cx(BIG_LINK, 'border border-white/25 text-bone')} data-testid="today-directions-apple">
              Apple Maps
            </a>
          ) : null}
        </div>
        {props.reservation ? (
          <div className="mt-5 border-l-2 border-[var(--color-glacier)] pl-3.5" data-testid="today-reservation">
            <p className="sheet-label text-[var(--color-glacier)]">Booked</p>
            <p className="mt-0.5 text-sm font-medium text-bone">
              {props.reservation.title}
              {props.reservation.startTime ? ` · ${props.reservation.startTime}` : ''}
            </p>
            {props.reservation.location ? <p className="type-small text-bone/70">{props.reservation.location}</p> : null}
            {props.reservation.confirmationRef ? (
              <details className="mt-1 print:hidden">
                <summary className="min-h-11 cursor-pointer list-none type-small text-bone/70 hover:text-bone [&::-webkit-details-marker]:hidden">Show the reference</summary>
                <p className="type-figure text-base text-bone" data-testid="today-reservation-ref">
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
        <button type="button" onClick={change} aria-haspopup="dialog" className={cx(BIG_LINK, 'bg-ink text-paper')} data-testid="today-change">
          Change today
        </button>
        {back}
      </div>

      <section className="mt-8" aria-labelledby="today-timeline-heading">
        <h2 id="today-timeline-heading" className="sheet-label text-ink">
          The day
        </h2>
        <ol className="ruled mt-3 border-y border-ink" data-testid="today-timeline">
          {today.stops.map((stop) => (
            <li key={stop.id} className={cx('flex min-h-12 items-center gap-3 py-3', stop.done && 'text-ink-faint')} data-testid="today-stop" data-done={stop.done ? 'true' : 'false'}>
              <span aria-hidden="true" className={cx('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs leading-none', stop.done ? 'border-pine bg-pine text-paper' : today.current?.id === stop.id ? 'border-accent bg-flare text-night' : 'border-ink-faint')}>
                {stop.done ? '✓' : ''}
              </span>
              <span className="type-figure w-14 shrink-0 text-sm">{formatMinuteOfDay(stop.startMinute)}</span>
              <span className={cx('min-w-0 flex-1 font-display text-[1.05rem]', stop.done ? 'line-through' : 'text-ink')}>{stop.title}</span>
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

const KIND_CHIP: Record<string, string> = {
  decide: 'bg-clay text-paper',
  book: 'bg-flare text-night',
  verify: 'bg-amber text-paper',
  prepare: 'bg-ink text-paper',
  recheck: 'bg-slate-blue text-paper',
  travel: 'bg-pine text-paper',
};

function dueLabel(due: string | undefined): string | null {
  if (!due) return null;
  const then = Date.parse(`${due}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return `by ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(then))}`;
}

/**
 * THE SCREEN BEFORE THE TRIP.
 *
 * A countdown, day one at a glance and what is left to do — every fact read
 * from the persisted plan and the deterministic next actions (`today-before`).
 * The words "Not travelling today" stay, because they are still true, and the
 * page still becomes the day-of screen on the first morning.
 */
function BeforeTrip(props: TodayScreenProps & { back: ReactNode }) {
  const { tripId, today, firstDay } = props;
  const days = daysBetween(today.localDate, props.firstDate);
  const actions = prepActions(props.nextActions ?? null, tripId);
  const remaining = props.nextActions ? Math.max(0, props.nextActions.actions.filter((a) => a.kind !== 'travel').length - actions.length) + props.nextActions.remaining : 0;
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-16 pt-6 sm:pt-10" data-testid="today-page" data-active="false" data-before="true">
      <section className="survey-night topo relative -mx-5 overflow-hidden px-5 py-7 text-bone sm:mx-0 sm:rounded-[18px] sm:px-8 sm:py-9 [--topo-opacity:0.08]" aria-labelledby="today-before-heading">
        <p className="sheet-label text-[var(--color-glacier)]">Today · before you go</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <h1 id="today-before-heading" className="font-display text-[2.4rem] leading-[1.02] font-light tracking-[-0.025em] text-bone sm:text-[3rem]">
              {props.destination}
            </h1>
            <p className="mt-3 max-w-[40ch] type-body text-bone/75" data-testid="today-inactive">
              Not travelling today. The trip starts on <span className="text-bone">{longDate(props.firstDate)}</span>, and this page becomes your day-of screen that morning.
            </p>
          </div>
          {days !== null && days > 0 ? (
            <p className="flex shrink-0 flex-col items-start rounded-[14px] border border-white/12 bg-night/50 px-5 py-4 backdrop-blur-sm" data-testid="today-countdown">
              <span className="font-mono text-[10px] font-semibold tracking-[0.14em] text-bone/60 uppercase">{countdownWords(days)}</span>
              <span className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-[3.75rem] leading-none font-light text-bone">{days}</span>
                <span className="text-sm text-bone/70">{days === 1 ? 'day to go' : 'days to go'}</span>
              </span>
              <span className="mt-1 text-[12px] text-bone/60">
                {props.dayCount} {props.dayCount === 1 ? 'day' : 'days'} · ends {longDate(props.lastDate).replace(/ \d{4}$/, '')}
              </span>
            </p>
          ) : null}
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href={`/trips/${tripId}/itinerary#days`} className={cx(BIG_LINK, 'bg-bone text-night hover:bg-white')} data-testid="today-open-plan">
            Open the plan
          </Link>
          <Link href={`/trips/${tripId}/pack`} className={cx(BIG_LINK, 'border border-white/25 text-bone hover:bg-white/10')} data-testid="today-open-pack">
            Take it with you
          </Link>
        </div>
      </section>

      <div className="mt-8 grid gap-8 sm:grid-cols-2">
        {firstDay ? (
          <section aria-labelledby="today-first-day" data-testid="today-first-day">
            <p className="sheet-label text-ink-muted">
              Day {firstDay.dayNumber} · {longDate(firstDay.date).replace(/ \d{4}$/, '')}
            </p>
            <h2 id="today-first-day" className="mt-1.5 font-display text-2xl leading-tight text-ink">
              {splitDayTheme(firstDay.theme).title}
            </h2>
            {splitDayTheme(firstDay.theme).places ? <p className="mt-1 type-small text-ink-muted">{splitDayTheme(firstDay.theme).places}</p> : null}
            <ol className="ruled mt-4 border-y border-rule">
              {firstDay.stops.map((stop, index) => (
                <li key={`${stop.title}-${index}`} className="flex min-h-12 items-center gap-3 py-2.5">
                  <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-flare font-mono text-[11px] font-semibold text-night">
                    {index + 1}
                  </span>
                  {firstDay.timing !== 'band' ? (
                    <span className="type-figure w-14 shrink-0 text-sm text-ink-muted">
                      {firstDay.timing === 'estimated' ? '≈' : ''}
                      {formatMinuteOfDay(stop.startMinute)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 font-display text-[1.05rem] text-ink">{stop.title}</span>
                </li>
              ))}
              {firstDay.stopCount === 0 ? <li className="py-3 type-small text-ink-muted">Nothing planned beyond arriving.</li> : null}
              <li className="flex min-h-12 items-center gap-3 py-2.5 text-ink-muted">
                <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border border-ink-faint text-[11px]">
                  ⌂
                </span>
                <span className="type-small">
                  Sleep in <span className="text-ink">{firstDay.baseName}</span>
                </span>
              </li>
            </ol>
            {firstDay.stopCount > firstDay.stops.length ? <p className="mt-2 type-meta">+ {firstDay.stopCount - firstDay.stops.length} more on the day</p> : null}
            <Link href={`/trips/${tripId}/itinerary#day-${firstDay.dayNumber}`} className="mt-3 inline-flex min-h-11 items-center type-small font-medium text-accent-strong underline underline-offset-4">
              See day {firstDay.dayNumber} in full
            </Link>
          </section>
        ) : null}

        <section aria-labelledby="today-prep" data-testid="today-prep">
          <p className="sheet-label text-ink-muted">Before you go</p>
          <h2 id="today-prep" className="mt-1.5 font-display text-2xl leading-tight text-ink">
            {actions.length === 0 ? 'Nothing needs you right now' : actions.length === 1 ? 'One thing left to do' : `${actions.length} things to do next`}
          </h2>
          {actions.length > 0 ? (
            <ol className="mt-4 divide-y divide-rule border-y border-rule">
              {actions.map((action) => (
                <li key={action.id}>
                  <Link href={action.link} className="pressable group flex items-start gap-3 py-3.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine" data-testid="today-prep-action" data-kind={action.kind}>
                    <span className={cx('mt-0.5 inline-flex h-6 shrink-0 items-center rounded-sm px-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase', KIND_CHIP[action.kind])}>{NEXT_ACTION_KIND_WORD[action.kind]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium leading-snug text-ink group-hover:underline group-hover:underline-offset-4">{action.title}</span>
                      <span className="mt-0.5 line-clamp-2 block type-small text-ink-muted">{action.why}</span>
                      {dueLabel(action.due) ? <span className="mt-1 block type-meta text-amber">{dueLabel(action.due)}</span> : null}
                    </span>
                    <span aria-hidden="true" className="mt-0.5 text-ink-faint transition-transform group-hover:translate-x-0.5">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 type-small text-ink-muted">Everything the trip depends on is settled or waiting on nobody.</p>
          )}
          {remaining > 0 ? (
            <Link href={`/trips/${tripId}/itinerary#prepare`} className="mt-3 inline-flex min-h-11 items-center type-small font-medium text-accent-strong underline underline-offset-4">
              {remaining} more in Prepare
            </Link>
          ) : null}
        </section>
      </div>

      <div className="mt-10">{props.back}</div>
    </main>
  );
}
