import type { BookingItem } from './booking';

/**
 * BOOKING PROGRESS — "6 OF 8 CRITICAL ITEMS ARRANGED", AND WHAT TO DO NEXT.
 *
 * V6 §27. The booking list already knows what the trip depends on; this reads
 * it as a checklist a traveller can finish. Critical means the plan needs it
 * (`required`, or `book_first`/`book_soon` priority); the stays group counts
 * once per base, not once per group. The next action is the first critical
 * item nobody has arranged, in priority order — a question the Trip Hub can
 * answer in one line.
 */

export interface BookingProgressGroup {
  id: 'stays' | 'transport' | 'experiences' | 'meals';
  title: string;
  items: { id: string; title: string; done: boolean; priority: BookingItem['priority']; dayNumber?: number }[];
  done: number;
  total: number;
}

export interface BookingProgress {
  critical: number;
  arranged: number;
  groups: BookingProgressGroup[];
  /** The one thing to do next, or null when everything critical is arranged. */
  nextAction: { id: string; title: string; why: string; travelerAction: string } | null;
  summary: string;
}

const PRIORITY_RANK: Record<BookingItem['priority'], number> = { book_first: 0, book_soon: 1, can_wait: 2, keep_flexible: 3 };

function groupOf(kind: BookingItem['kind']): BookingProgressGroup['id'] {
  switch (kind) {
    case 'accommodation':
      return 'stays';
    case 'flight':
    case 'train':
    case 'ferry':
    case 'rental_vehicle':
    case 'shuttle':
    case 'internal_transfer':
      return 'transport';
    case 'restaurant':
      return 'meals';
    default:
      return 'experiences';
  }
}

export function isCriticalBooking(item: BookingItem): boolean {
  if (item.status === 'not_needed') return false;
  return item.necessity === 'required' || item.priority === 'book_first' || item.priority === 'book_soon';
}

export function buildBookingProgress(items: readonly BookingItem[]): BookingProgress {
  /* The stays summary row stands for its members; count the members, not the summary. */
  const concrete = items.filter((item) => !(item.group === 'stays' && item.memberIds && item.memberIds.length > 0));
  const critical = concrete.filter(isCriticalBooking);
  const groups: BookingProgressGroup[] = (['stays', 'transport', 'experiences', 'meals'] as const).map((id) => ({
    id,
    title: id === 'stays' ? 'Stays' : id === 'transport' ? 'Transport' : id === 'experiences' ? 'Experiences' : 'Meals',
    items: [],
    done: 0,
    total: 0,
  }));
  for (const item of critical) {
    const group = groups.find((g) => g.id === groupOf(item.kind))!;
    const done = item.status === 'booked';
    group.items.push({ id: item.id, title: item.title, done, priority: item.priority, ...(item.dayNumber ? { dayNumber: item.dayNumber } : {}) });
    group.total += 1;
    if (done) group.done += 1;
  }
  for (const group of groups) group.items.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dayNumber ?? 99) - (b.dayNumber ?? 99));
  const arranged = critical.filter((item) => item.status === 'booked').length;
  const next = [...critical].filter((item) => item.status !== 'booked').sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dayNumber ?? 99) - (b.dayNumber ?? 99))[0] ?? null;
  const summary =
    critical.length === 0
      ? 'Nothing here needs booking ahead.'
      : arranged === critical.length
        ? `All ${critical.length} things this trip depends on are arranged.`
        : `${arranged} of ${critical.length} things this trip depends on ${arranged === 1 ? 'is' : 'are'} arranged.`;
  return {
    critical: critical.length,
    arranged,
    groups: groups.filter((g) => g.total > 0),
    nextAction: next ? { id: next.id, title: next.title, why: next.reason, travelerAction: next.travelerAction } : null,
    summary,
  };
}
