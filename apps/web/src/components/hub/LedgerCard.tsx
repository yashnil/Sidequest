import type { TripLedger } from '@sidequest/core';
import { PAID_WORD, REFUNDABLE_WORD, formatMoney } from './booking-copy';

/**
 * V9 §16 — PLANNED VERSUS COMMITTED.
 *
 * Three figures and the lines behind them: the estimated range the budget
 * already carries (a range, never a quote), what the traveller said they have
 * paid or put a deposit on, and the major costs still to arrange. Nothing here
 * invents precision: a booking with no amount adds nothing, and a line without
 * a paid state says so.
 */
export function LedgerCard({ ledger }: { ledger: TripLedger }) {
  const { estimated, committed, remainingMajor, lines, otherCurrencies } = ledger;
  return (
    <section className="card mt-8 p-5" aria-labelledby="book-ledger" data-testid="ledger">
      <h3 id="book-ledger" className="type-section text-ink">
        Where the money stands
      </h3>
      <dl className="mt-3 grid gap-4 sm:grid-cols-3">
        <div data-testid="ledger-estimated">
          <dt className="eyebrow">Estimated trip</dt>
          <dd className="type-figure mt-1 text-lg text-ink">{estimated ? `${formatMoney(estimated.low, estimated.currency)}–${formatMoney(estimated.high, estimated.currency)}${estimated.perPerson ? ' pp' : ''}` : 'Not estimated'}</dd>
          <dd className="type-meta">a range, not a quote</dd>
        </div>
        <div data-testid="ledger-committed">
          <dt className="eyebrow">Already committed</dt>
          <dd className="type-figure mt-1 text-lg text-ink">{committed ? formatMoney(committed.amount, committed.currency) : 'Nothing yet'}</dd>
          <dd className="type-meta">
            {committed ? `${committed.count} ${committed.count === 1 ? 'booking' : 'bookings'} with an amount` : 'no booking carries an amount'}
            {otherCurrencies.length > 0 ? ` · plus ${otherCurrencies.map((c) => formatMoney(c.amount, c.currency)).join(', ')}` : ''}
          </dd>
        </div>
        <div data-testid="ledger-remaining">
          <dt className="eyebrow">Major costs remaining</dt>
          <dd className="mt-1 text-sm text-ink">{remainingMajor.length > 0 ? remainingMajor.join(' + ') : 'Nothing major left to arrange'}</dd>
        </div>
      </dl>
      {lines.length > 0 ? (
        <ul className="mt-4 divide-y divide-rule text-sm" data-testid="ledger-lines">
          {lines.map((line) => (
            <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2" data-testid="ledger-line" data-paid={line.paid}>
              <span className="text-ink">{line.title}</span>
              <span className="type-figure text-ink">{formatMoney(line.amount, line.currency)}</span>
              <span className="basis-full type-meta">
                {PAID_WORD[line.paid]} · {REFUNDABLE_WORD[line.refundable]} · {line.travellers === 'everyone' ? 'everyone' : `${line.travellers} ${line.travellers === 1 ? 'traveller' : 'travellers'}`}
                {line.date ? ` · ${line.date}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 type-meta">{ledger.note}</p>
    </section>
  );
}
