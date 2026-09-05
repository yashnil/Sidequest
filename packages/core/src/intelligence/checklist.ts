import { z } from 'zod';
import type { BookingItem } from './booking';
import type { TripReadinessPacket } from './readiness';
import type { PackingIntelligence } from './packing';
import type { SourceClaim } from './claims';

/**
 * BEFORE YOU GO, IN THE ORDER IT HAPPENS.
 *
 * Phases exist only when the calendar leaves room for them: a trip in five
 * days has no "one month out". Every item answers why, when, from where, done,
 * and whether it blocks.
 */
export const CHECKLIST_PHASES = ['do_now', 'do_before_booking', 'book_first', 'one_month_out', 'one_week_out', 'day_before', 'keep_offline'] as const;
export const checklistPhaseSchema = z.enum(CHECKLIST_PHASES);
export type ChecklistPhaseCode = z.infer<typeof checklistPhaseSchema>;

export const CHECKLIST_PHASE_LABELS: Record<ChecklistPhaseCode, string> = {
  do_now: 'Do now',
  do_before_booking: 'Before you book',
  book_first: 'Book first',
  one_month_out: 'One month out',
  one_week_out: 'One week out',
  day_before: 'The day before',
  keep_offline: 'Keep digital and offline',
};

export const checklistItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  why: z.string().min(1),
  when: z.string().min(1),
  sourceName: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  blocking: z.boolean().default(false),
  kind: z.enum(['readiness', 'booking', 'packing', 'recheck', 'offline']),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const checklistPhaseGroupSchema = z.object({
  phase: checklistPhaseSchema,
  title: z.string().min(1),
  items: z.array(checklistItemSchema),
});

export const checklistIntelligenceSchema = z.object({
  phases: z.array(checklistPhaseGroupSchema),
  daysUntilTrip: z.number().int(),
});
export type ChecklistIntelligence = z.infer<typeof checklistIntelligenceSchema>;

export function buildChecklist(input: { readiness: TripReadinessPacket; bookings: readonly BookingItem[]; packing: PackingIntelligence; recheck: readonly SourceClaim[]; daysUntilTrip: number }): ChecklistIntelligence {
  const d = input.daysUntilTrip;
  const collapseMonth = d < 30;
  const collapseWeek = d < 7;
  const groups = new Map<ChecklistPhaseCode, ChecklistItem[]>();
  const put = (phase: ChecklistPhaseCode, item: ChecklistItem) => {
    let target = phase;
    if (target === 'one_month_out' && collapseMonth) target = 'do_now';
    if (target === 'one_week_out' && collapseWeek) target = 'do_now';
    if (target === 'do_before_booking' && input.bookings.every((b) => b.status !== 'open')) target = 'do_now';
    const list = groups.get(target) ?? [];
    list.push(item);
    groups.set(target, list);
  };

  for (const entry of input.readiness.entries) {
    if (entry.state === 'not_applicable') continue;
    const link = entry.links[0];
    put(entry.phase as ChecklistPhaseCode, checklistItemSchema.parse({ id: `readiness:${entry.kind}`, title: entry.action ?? entry.title, why: entry.summary, when: CHECKLIST_PHASE_LABELS[entry.phase as ChecklistPhaseCode], ...(link ? { sourceName: link.name, sourceUrl: link.url } : {}), blocking: entry.blocking, kind: 'readiness' }));
  }
  for (const booking of input.bookings) {
    if (booking.status !== 'open') continue;
    const phase: ChecklistPhaseCode = booking.priority === 'book_first' ? 'book_first' : booking.priority === 'book_soon' ? 'one_month_out' : booking.priority === 'can_wait' ? 'one_week_out' : 'day_before';
    put(phase, checklistItemSchema.parse({ id: `booking:${booking.id}`, title: booking.travelerAction, why: booking.reason, when: CHECKLIST_PHASE_LABELS[phase], ...(booking.officialSourceName ? { sourceName: booking.officialSourceName } : {}), ...(booking.officialSourceUrl ? { sourceUrl: booking.officialSourceUrl } : {}), blocking: booking.priority === 'book_first' && booking.necessity === 'required', kind: 'booking' }));
  }
  if (input.recheck.length > 0) {
    put('one_week_out', checklistItemSchema.parse({ id: 'recheck:volatile', title: `Re-check ${input.recheck.length} thing${input.recheck.length === 1 ? '' : 's'} that can change`, why: 'Forecast, hours, seasonal roads and entry rules were read when this plan was built, not today.', when: CHECKLIST_PHASE_LABELS.one_week_out, blocking: false, kind: 'recheck' }));
  }
  put('day_before', checklistItemSchema.parse({ id: 'packing:all', title: `Pack (${input.packing.items.length} items on your list)`, why: input.packing.basisNote, when: CHECKLIST_PHASE_LABELS.day_before, blocking: false, kind: 'packing' }));
  put('keep_offline', checklistItemSchema.parse({ id: 'offline:plan', title: 'Save this plan, your maps and your bookings offline', why: 'Signal fails at exactly the moment you need the address.', when: CHECKLIST_PHASE_LABELS.keep_offline, blocking: false, kind: 'offline' }));
  put('keep_offline', checklistItemSchema.parse({ id: 'offline:copies', title: 'Keep copies of your documents separate from the originals', why: 'A lost passport is survivable with a copy and the consulate address.', when: CHECKLIST_PHASE_LABELS.keep_offline, blocking: false, kind: 'offline' }));

  const phases = CHECKLIST_PHASES.filter((p) => groups.has(p)).map((p) => checklistPhaseGroupSchema.parse({ phase: p, title: CHECKLIST_PHASE_LABELS[p], items: groups.get(p)! }));
  return checklistIntelligenceSchema.parse({ phases, daysUntilTrip: d });
}
