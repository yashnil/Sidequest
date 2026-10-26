import type { TripLedger } from '@sidequest/core';
import { PAID_WORD, REFUNDABLE_WORD, formatMoney } from './booking-copy';
import { FigureRow, RailSection } from './views/ViewHead';

/**
 * V9 §16 — PLANNED VERSUS COMMITTED.
 *
 * Three figures and the lines behind them: the estimated range the budget
 * already carries (a range, never a quote), what the traveller said they have
 * paid or put a deposit on, and the major costs still to arrange. Nothing here
 * invents precision: a booking with no amount adds nothing, and a line without
 * a paid state says so.
 */
export function LedgerCard({ ledger, index = 'Money' }: { ledger: TripLedger; /** The rail's margin label on the Book view. */ index?: string }) {
  const { estimated, committed, remainingMajor, lines, otherCurrencies } = ledger;
  return (
    <section aria-labelledby="book-ledger" data-testid="ledger">
      <RailSection index={index} title="Where the money stands" headingId="book-ledger" quiet blurb={ledger.note}>
        <FigureRow
          className="mt-5"
          figures={[
            {
              label: 'Estimated trip',
              testId: 'ledger-estimated',
              value: (
                <>
                  <span className="type-figure block">{estimated ? `${formatMoney(estimated.low, estimated.currency)}–${formatMoney(estimated.high, estimated.currency)}${estimated.perPerson ? ' pp' : ''}` : 'Not estimated'}</span>
                  <span className="type-meta block font-sans">a range, not a quote</span>
                </>
              ),
            },
            {
              label: 'Already committed',
              testId: 'ledger-committed',
              value: (
                <>
                  <span className="type-figure block">{committed ? formatMoney(committed.amount, committed.currency) : 'Nothing yet'}</span>
                  <span className="type-meta block font-sans">
                    {committed ? `${committed.count} ${committed.count === 1 ? 'booking' : 'bookings'} with an amount` : 'no booking carries an amount'}
                    {otherCurrencies.length > 0 ? ` · plus ${otherCurrencies.map((c) => formatMoney(c.amount, c.currency)).join(', ')}` : ''}
                  </span>
                </>
              ),
            },
            {
              label: 'Major costs remaining',
              testId: 'ledger-remaining',
              value: <span className="block text-base">{remainingMajor.length > 0 ? remainingMajor.join(' + ') : 'Nothing major left to arrange'}</span>,
            },
          ]}
        />
        {lines.length > 0 ? (
          <ul className="ruled mt-4 text-sm" data-testid="ledger-lines">
            {lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5" data-testid="ledger-line" data-paid={line.paid}>
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
      </RailSection>
    </section>
  );
}
