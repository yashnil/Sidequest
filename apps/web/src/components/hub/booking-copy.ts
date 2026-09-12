import { BOOKING_PRIORITIES, type BookedItemType, type BookedPlanItem, type BookingItem, type BookingItemKind, type BookingPriority, type BookingResolution } from '@sidequest/core';

/**
 * V9 §5 — THE WORDS THE BOOK VIEW USES.
 *
 * One table for everything the booking surfaces say, so the row on Prepare,
 * the row on Book, the import review and the ledger all use the same word
 * for the same fact. Traveller language only; nothing here names a table, a
 * provider or a field.
 */
export const PRIORITY_GROUPS: readonly { priority: BookingPriority; title: string; blurb: string }[] = [
  { priority: 'book_first', title: 'Book first', blurb: 'The trip depends on these and they have fixed dates, limited capacity or long lead times.' },
  { priority: 'book_soon', title: 'Book soon', blurb: 'Not urgent, but the good options go.' },
  { priority: 'can_wait', title: 'Can wait', blurb: 'Bookable close to the day, or from the destination.' },
  { priority: 'keep_flexible', title: 'Keep flexible', blurb: 'Weather, energy or crowds decide these. Do not lock them in early.' },
];

/** The booked-fact type a need of each kind becomes when the traveller marks it booked. */
export const BOOKED_TYPE_FOR_KIND: Record<BookingItemKind, BookedItemType> = {
  accommodation: 'lodging',
  flight: 'flight',
  train: 'train',
  ferry: 'ferry',
  park_entry: 'activity',
  timed_entry: 'activity',
  permit: 'activity',
  tour_guide: 'activity',
  restaurant: 'restaurant',
  event: 'event',
  rental_vehicle: 'rental_car',
  shuttle: 'transfer',
  internal_transfer: 'transfer',
  cruise: 'activity',
  programme: 'activity',
};

export const STATUS_WORD: Record<BookingItem['status'], string> = {
  open: 'Need to book',
  booked: 'Booked',
  soft_hold: 'Held',
  not_needed: 'Not needed',
};

export const PAID_WORD: Record<NonNullable<BookedPlanItem['paid']> | 'unknown', string> = {
  paid: 'Paid',
  deposit: 'Deposit paid',
  unpaid: 'Not paid yet',
  unknown: 'Payment not recorded',
};

export const REFUNDABLE_WORD: Record<NonNullable<BookedPlanItem['refundable']>, string> = {
  refundable: 'Refundable',
  non_refundable: 'Non-refundable',
  unknown: 'Refund terms not recorded',
};

export const SOURCE_WORD: Record<NonNullable<BookedPlanItem['source']> | 'typed', string> = {
  typed: 'Added by you',
  marked: 'Marked booked from the plan',
  imported: 'From a confirmation you imported',
};

export const CONFIDENCE_WORD: Record<'high' | 'medium' | 'low', string> = {
  high: 'Sure',
  medium: 'Likely',
  low: 'Check this',
};

/** The review screen's label for each extracted field. */
export const IMPORT_FIELD_LABEL: Record<string, string> = {
  type: 'Kind of booking',
  title: 'What was booked',
  provider: 'Booked with',
  date: 'Date',
  endDate: 'Until',
  startTime: 'Starts',
  endTime: 'Ends',
  timeZone: 'Time zone',
  timeZoneHint: 'Time zone',
  location: 'Where',
  confirmationRef: 'Confirmation reference',
  cost: 'Amount',
  cancellationDeadline: 'Free cancellation until',
  cancellation: 'Cancellation',
  travellers: 'Travellers covered',
};

export function formatMoney(amount: number, currency: string): string {
  const rounded = Math.round(amount);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(rounded);
  } catch {
    return `${currency} ${rounded.toLocaleString('en')}`;
  }
}

/** The Book-first priorities in display order, typed once. */
export const PRIORITY_ORDER: readonly BookingPriority[] = BOOKING_PRIORITIES;

/** A need the traveller said they will not book — a skipped row reads under the disclosure, never in a priority group. */
export function isSkipped(need: Pick<BookingItem, 'id'>, resolutions: readonly BookingResolution[]): boolean {
  return resolutions.some((r) => r.bookingItemId === need.id && r.resolution === 'skipped');
}

/** The traveller's own note on a skipped need, when they left one. */
export function skipNote(need: Pick<BookingItem, 'id'>, resolutions: readonly BookingResolution[]): string | undefined {
  return resolutions.find((r) => r.bookingItemId === need.id && r.resolution === 'skipped')?.note;
}

/** One line for a booked fact's terms: what was paid, whether it comes back, who it covers. */
export function bookedTermsLine(item: Pick<BookedPlanItem, 'paid' | 'refundable' | 'travelerIds' | 'cancellationDeadline'>, partySize?: number): string {
  const parts: string[] = [];
  if (item.paid) parts.push(PAID_WORD[item.paid]);
  if (item.refundable && item.refundable !== 'unknown') parts.push(REFUNDABLE_WORD[item.refundable]);
  if (item.cancellationDeadline) parts.push(`Free cancellation until ${item.cancellationDeadline}`);
  if (item.travelerIds && item.travelerIds.length > 0) parts.push(`Covers ${item.travelerIds.length} ${item.travelerIds.length === 1 ? 'traveller' : 'travellers'}${partySize && partySize > item.travelerIds.length ? ` of ${partySize}` : ''}`);
  return parts.join(' · ');
}
