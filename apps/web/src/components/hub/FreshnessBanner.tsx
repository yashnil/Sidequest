'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useReducedMotion } from 'motion/react';
import { summariseObservations, type FactObservation, type VolatileFact } from '@sidequest/core';
import { buttonClass, cx } from '@/components/ui';
import { acknowledgeChangeAction, recheckStaleFactsAction } from '@/lib/execution/recheck-actions';

/**
 * V9 §9 — "N THINGS CHANGED SINCE THIS TRIP WAS PLANNED".
 *
 * Mounted at the top of the Trip view, and only on the owner's page — the
 * shared copy never mounts it, which is what keeps a reader with a link from
 * spending a request on somebody else's trip. On mount, when something stale
 * and answerable is due and no check ran in the last six hours, it asks the
 * recheck action once (a ref holds the guard across React's development
 * double-invoke). It then lists every unacknowledged change with two
 * responses: propose a change through Ask Sidequest, or say "Got it". It
 * never edits the plan, and a failed check is silent — the plan is unchanged,
 * and nothing on screen claims otherwise.
 */
export const RECHECK_AFTER_HOURS = 6;

/** The DOM event the hub's Ask trigger raises; equal to `HubShell.ASK_OPEN_EVENT` (asserted in the banner's test). */
const ASK_OPEN = 'sidequest:ask-open';

export interface FreshnessBannerProps {
  tripId: string;
  observations: readonly FactObservation[];
  volatile: readonly VolatileFact[];
  /** ISO instant of the last recheck, or null. */
  lastCheckedAt: string | null;
  headline: string | null;
  /** The render instant, so the six-hour rule is judged against one clock. Defaults to the browser's now. */
  now?: number;
}

/** Whether a mount should ask: something due and answerable, and no check inside the window. */
export function shouldRecheck(input: { lastCheckedAt: string | null; volatile: readonly VolatileFact[]; now: number }): boolean {
  if (!input.volatile.some((f) => f.stale && f.recheckable)) return false;
  if (!input.lastCheckedAt) return true;
  const then = Date.parse(input.lastCheckedAt);
  if (Number.isNaN(then)) return true;
  return input.now - then >= RECHECK_AFTER_HOURS * 3_600_000;
}

/** The Ask Sidequest request a change proposes. Deterministic from the observation; never a model. */
export function proposalFor(observation: FactObservation): string {
  const day = observation.dayNumbers[0];
  const where = day ? `Day ${day}` : 'The plan';
  if (observation.kind === 'forecast') {
    /* The reading is "condition, low–high °C, N% chance of rain": wet is judged on the condition word and the chance, never on the phrase "chance of rain". */
    const current = observation.current ?? '';
    const condition = current.split(',')[0] ?? '';
    const chance = Number.parseInt(/(\d+)% chance/.exec(current)?.[1] ?? '', 10);
    const wet = /rain|shower|drizzle|thunder|storm|snow|sleet|hail/i.test(condition) || (Number.isFinite(chance) && chance >= 50);
    return wet ? `${where} now expects ${observation.current ?? 'rain'}: swap the outdoor blocks for the indoor backup and keep the rest of the day.` : `${where}'s forecast changed to ${observation.current ?? 'different weather'}: reconsider the outdoor blocks for that day.`;
  }
  if (observation.kind === 'hours' || observation.kind === 'status') {
    return `${observation.summary} Move it to a time it is open, or replace it on ${day ? `day ${day}` : 'that day'}.`;
  }
  return `${observation.summary} Adjust ${day ? `day ${day}` : 'the plan'} for it.`;
}

export function FreshnessBanner(props: FreshnessBannerProps) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState<FactObservation[]>(() => summariseObservations(props.observations).changed);
  /* Decided once, from the props the server rendered, so the "checking" line is on screen from the first paint rather than after an effect. */
  const [checking, setChecking] = useState(() => shouldRecheck({ lastCheckedAt: props.lastCheckedAt, volatile: props.volatile, now: props.now ?? Date.now() }));
  const [pending, startTransition] = useTransition();
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current || !checking) return;
    asked.current = true;
    let cancelled = false;
    recheckStaleFactsAction(props.tripId)
      .then((result) => {
        if (cancelled || !result.ok) return;
        setOpen(result.observations.filter((o) => o.changed && !o.acknowledgedAt));
      })
      .catch(() => {
        /* Silent by design: the plan is unchanged and nothing claims otherwise. */
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.tripId, checking]);

  const headline = summariseObservations(open).headline;
  if (!headline && !checking) return null;

  return (
    <section className={cx('card mt-6 p-4 sm:p-5', !reduced && 'enter')} data-testid="freshness-banner" aria-live="polite" aria-label="What changed since this trip was planned">
      {headline ? <p className="type-body font-semibold text-ink">{headline}</p> : null}
      {checking ? (
        <p className="type-small text-ink-muted" data-testid="freshness-checking">
          Checking what changed…
        </p>
      ) : null}
      {open.length > 0 ? (
        <ul className="mt-3 grid gap-3">
          {open.map((observation) => (
            <li key={observation.id} className="rounded-[var(--radius-card)] bg-paper-sunk/60 p-3" data-testid="freshness-change" data-kind={observation.kind} data-day={observation.dayNumbers[0] ?? ''}>
              <p className="type-small text-ink">{observation.summary}</p>
              <p className="type-meta mt-1">Your plan has not been changed. Choose what to do.</p>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClass('secondary', 'sm')}
                  data-testid="freshness-propose"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(ASK_OPEN, { detail: { request: proposalFor(observation), dayNumber: observation.dayNumbers[0] ?? null } }));
                  }}
                >
                  Propose a change
                </button>
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  data-testid="freshness-acknowledge"
                  disabled={pending}
                  onClick={() => {
                    startTransition(async () => {
                      const result = await acknowledgeChangeAction(props.tripId, observation.id);
                      if (result.ok) setOpen((current) => current.filter((o) => o.id !== observation.id));
                    });
                  }}
                >
                  Got it
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
