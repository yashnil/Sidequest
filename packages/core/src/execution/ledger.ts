import type { BudgetIntelligence } from '../intelligence/budget';
import type { BookedPlanItem } from '../intelligence/booking';

/**
 * V9 §16 — PLANNED VERSUS COMMITTED.
 *
 * Not a finance application: the estimated range the budget already carries,
 * the sum of what the traveller said they have paid or put a deposit on, and
 * the major categories still to arrange. Never manufactures precision — an
 * unknown line stays unknown, and a booked item without a cost adds nothing.
 */
export interface LedgerLine {
  id: string;
  title: string;
  amount: number;
  currency: string;
  paid: 'paid' | 'deposit' | 'unpaid' | 'unknown';
  refundable: 'refundable' | 'non_refundable' | 'unknown';
  travellers: 'everyone' | number;
  date?: string;
}

export interface TripLedger {
  estimated: { low: number; high: number; currency: string; perPerson: boolean } | null;
  committed: { amount: number; currency: string; count: number } | null;
  /** Booked items whose cost is in a different currency from the committed sum. */
  otherCurrencies: { currency: string; amount: number }[];
  lines: LedgerLine[];
  remainingMajor: string[];
  note: string;
}

export function buildLedger(input: { budget: BudgetIntelligence | null; booked: readonly BookedPlanItem[]; openNeeds: readonly { kind: string; title: string; necessity: string }[] }): TripLedger {
  const lines: LedgerLine[] = [];
  for (const item of input.booked) {
    if (item.status !== 'booked' || !item.cost) continue;
    lines.push({
      id: item.id,
      title: item.title,
      amount: item.cost.amount,
      currency: item.cost.currency,
      paid: item.paid ?? 'unknown',
      refundable: item.refundable ?? 'unknown',
      travellers: item.travelerIds && item.travelerIds.length > 0 ? item.travelerIds.length : 'everyone',
      ...(item.date ? { date: item.date } : {}),
    });
  }
  const committedLines = lines.filter((l) => l.paid === 'paid' || l.paid === 'deposit' || l.paid === 'unknown');
  const currencies = new Map<string, number>();
  for (const l of committedLines) currencies.set(l.currency, (currencies.get(l.currency) ?? 0) + l.amount);
  const budget = input.budget;
  /* The estimate's own currency. `displayCurrency` is a second view of the total (the destination's money), never the currency the bands are in. */
  const budgetCurrency = budget?.currency ?? committedLines[0]?.currency ?? 'USD';
  const primary = currencies.has(budgetCurrency) ? budgetCurrency : [...currencies.keys()][0] ?? budgetCurrency;
  const committed = currencies.size > 0 ? { amount: Math.round(currencies.get(primary) ?? 0), currency: primary, count: committedLines.length } : null;
  const otherCurrencies = [...currencies.entries()].filter(([c]) => c !== primary).map(([currency, amount]) => ({ currency, amount: Math.round(amount) }));

  const estimated = budget && budget.total.high > 0 ? { low: Math.round(budget.total.low), high: Math.round(budget.total.high), currency: budgetCurrency, perPerson: budget.total.perPerson } : null;

  const MAJOR: Record<string, string> = { accommodation: 'lodging', flight: 'flights', cruise: 'the cruise', programme: 'the programme', rental_vehicle: 'the car', tour_guide: 'a guide', permit: 'permits', train: 'trains', ferry: 'ferries' };
  const remainingMajor = [...new Set(input.openNeeds.filter((n) => n.necessity === 'required' && MAJOR[n.kind]).map((n) => MAJOR[n.kind]!))];
  const note = committed ? `Committed figures are what you entered; ${lines.filter((l) => l.paid === 'unknown').length > 0 ? 'lines without a paid status are counted as committed.' : 'paid and deposits are counted.'}` : 'Nothing with a cost has been marked booked yet.';
  return { estimated, committed, otherCurrencies, lines, remainingMajor, note };
}
