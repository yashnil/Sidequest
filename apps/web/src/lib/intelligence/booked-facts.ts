import { BOOKED_ITEM_TYPE_LABELS, bookedItemBinds, type BookedPlanItem } from '@sidequest/core';

/**
 * BOOKED FACTS, COMPACTED FOR THE COMPOSER.
 *
 * The model builds around what is already booked. It receives one short line
 * per binding booking — type, name, date, time, place — and nothing else: no
 * confirmation reference, no notes, no cost. Ideas and soft holds are not
 * facts and are not sent.
 */
export function compactBookedFacts(items: readonly BookedPlanItem[]): string[] {
  return items
    .filter(bookedItemBinds)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.startTime ?? '').localeCompare(b.startTime ?? ''))
    .map((item) => {
      const label = BOOKED_ITEM_TYPE_LABELS[item.type];
      const when = item.type === 'lodging' ? `${item.date ?? '?'} to ${item.endDate ?? item.date ?? '?'}` : [item.date, item.startTime ? (item.endTime ? `${item.startTime}–${item.endTime}` : item.startTime) : null].filter(Boolean).join(' ');
      const where = item.location ? ` at ${item.location}` : '';
      return `${label}: ${item.title.replace(/[\r\n]+/g, ' ').slice(0, 80)}${where} — ${when}.`;
    })
    .slice(0, 12);
}
