'use client';

import { useState, useTransition } from 'react';
import { buttonClass, cx } from '@/components/ui';
import { recommendLodgingAction, type LodgingActionResult } from '@/app/(product)/trips/[id]/itinerary/lodging-actions';
import type { SuggestedBooking } from './booking-links';

/**
 * NAMED PLACES TO STAY, ON A PRESS.
 *
 * A stay row used to stop at "somewhere to stay in <town>" and three generic
 * searches. This puts a small number of real, named properties under it —
 * read from open place data, ranked by what each does for this trip, each
 * with the reason in words, the tradeoff, and a search that carries the dates
 * and party. Nothing is fetched until the traveller presses; nothing is a
 * price or an availability, and the panel says so.
 *
 * The property links carry `lodging-pick-link`, never `booking-link`: the
 * stay's own dated searches stay the only `booking-link`s in the row.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
function dates(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const am = MONTHS[a.getUTCMonth()]!;
  const bm = MONTHS[b.getUTCMonth()]!;
  return am === bm ? `${a.getUTCDate()}–${b.getUTCDate()} ${am}` : `${a.getUTCDate()} ${am} – ${b.getUTCDate()} ${bm}`;
}

export function LodgingPicks({ tripId, request, place }: { tripId: string; request: NonNullable<SuggestedBooking['lodging']>; place: string }) {
  const [result, setResult] = useState<LodgingActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const picks = result?.ok ? (result.recommendations ?? []) : [];

  return (
    <div className="mt-4 border-t border-rule pt-3 print:hidden" data-testid="lodging-picks">
      {!result || !result.ok ? (
        <button
          type="button"
          disabled={pending}
          className={buttonClass('ghost', 'sm')}
          data-testid="lodging-picks-button"
          onClick={() => startTransition(async () => setResult(await recommendLodgingAction(tripId, request)))}
        >
          {pending ? 'Reading open place data…' : `Show places to stay in ${place}`}
        </button>
      ) : null}
      {result && !result.ok ? (
        <p role="alert" className="mt-2 type-small text-clay">
          {result.error}
        </p>
      ) : null}
      {result?.ok && picks.length === 0 ? (
        <p className="type-small text-ink-muted" data-testid="lodging-picks-empty">
          {result.available === false ? result.reason : `No named places to stay are recorded within ${result.radiusKm} km of ${place}. The searches above cover the area.`}
        </p>
      ) : null}
      {result?.ok && picks.length > 0 ? (
        <div data-testid="lodging-picks-results">
          <p className="sheet-label text-ink-faint">
            {picks.length === 1 ? 'One named place' : `${picks.length} named places`} for this stay
            {result.readingFor && result.readingFor.length > 0 ? <span className="normal-case tracking-normal"> · chosen for {result.readingFor.slice(0, 2).join(' and ')}</span> : null}
          </p>
          <ol className="mt-2 space-y-4">
            {picks.map((pick) => (
              <li key={pick.sourceId} className="min-w-0" data-testid="lodging-pick" data-source={pick.source}>
                <p className="font-display text-base leading-snug text-ink" translate="no">
                  {pick.name}
                  {pick.altName ? <span className="type-small text-ink-faint"> · {pick.altName}</span> : null}
                </p>
                <p className="mt-0.5 type-small text-ink-muted">
                  {pick.typeLabel}
                  {pick.stars !== undefined ? ` · ${pick.stars}★ (mapped)` : ''}
                  {pick.capacity ? ` · ${pick.capacity}` : ''} · {pick.distance}
                </p>
                {pick.why.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 type-small text-ink">
                    {pick.why.slice(0, 2).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
                {pick.tradeoffs.length > 0 ? <p className="mt-1 type-small text-ink-faint">{pick.tradeoffs.slice(0, 2).join(' ')}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {pick.links.map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className={cx('type-small underline underline-offset-4 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine', link.kind === 'booking_search' ? 'text-ink' : 'text-ink-muted')}
                      data-testid="lodging-pick-link"
                      data-kind={link.kind}
                    >
                      {link.kind === 'booking_search' && result.checkIn && result.checkOut ? `${link.label} · ${dates(result.checkIn, result.checkOut)}` : link.label}
                      <span aria-hidden="true"> ↗</span>
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ))}
                  <span className="type-meta text-ink-faint">{pick.sourceLabel}</span>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 type-meta text-ink-faint" data-testid="lodging-picks-note">
            Prices and availability are not checked. Each search opens with your dates and party; the site you book on has the real rates.
            {result.attribution && result.attribution.length > 0 ? ` Data: ${result.attribution.join(' · ')}.` : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
}
