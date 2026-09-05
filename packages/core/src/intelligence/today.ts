import { z } from 'zod';
import type { Itinerary, ItineraryDay, ItineraryItem } from '../schemas/itinerary';
import type { BookedPlanItem } from './booking';
import type { DayResilience } from './resilience';

/**
 * TODAY MODE: THE SAME PLAN, READ FOR THE DAY IT IS.
 *
 * Decided from the destination-local date alone — no location tracking. Shown
 * only while the trip is active. Everything here is derived; nothing is
 * fetched.
 */
export const todayViewSchema = z.object({
  active: z.boolean(),
  localDate: z.string().min(1),
  dayNumber: z.number().int().min(1).optional(),
  theme: z.string().min(1).optional(),
  baseName: z.string().min(1).optional(),
  nowMinute: z.number().int().min(0).max(1440),
  current: z.object({ id: z.string().min(1), title: z.string().min(1), startMinute: z.number().int(), endMinute: z.number().int(), kind: z.string().min(1) }).optional(),
  next: z.object({ id: z.string().min(1), title: z.string().min(1), startMinute: z.number().int(), endMinute: z.number().int(), kind: z.string().min(1) }).optional(),
  nextTransport: z.object({ title: z.string().min(1), startMinute: z.number().int(), minutes: z.number().int().nullable(), mode: z.string().min(1), basis: z.string().min(1) }).optional(),
  bookedToday: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), startTime: z.string().optional(), location: z.string().optional() })).default([]),
  weather: z.object({ summary: z.string().min(1), kind: z.string().min(1), cautions: z.array(z.string().min(1)).default([]) }).optional(),
  criticalWarnings: z.array(z.string().min(1)).default([]),
  flexAlternatives: z.array(z.string().min(1)).default([]),
  fallback: z.string().min(1).optional(),
  stops: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), startMinute: z.number().int(), endMinute: z.number().int(), placeId: z.string().optional(), done: z.boolean() })).default([]),
});
export type TodayView = z.infer<typeof todayViewSchema>;

/** The destination-local calendar date and minute for an instant. */
export function localClock(instant: Date, timeZone: string | undefined): { date: string; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
  } catch {
    const iso = instant.toISOString();
    return { date: iso.slice(0, 10), minute: instant.getUTCHours() * 60 + instant.getUTCMinutes() };
  }
}

function brief(item: ItineraryItem) {
  return { id: item.id, title: item.title, startMinute: item.startMinute, endMinute: item.endMinute, kind: item.kind };
}

export function buildTodayView(input: { itinerary: Itinerary; booked: readonly BookedPlanItem[]; backups: readonly DayResilience[]; now: Date; timeZone?: string; warnings?: readonly string[] }): TodayView {
  const { date, minute } = localClock(input.now, input.timeZone);
  const day: ItineraryDay | undefined = input.itinerary.days.find((d) => d.date === date);
  if (!day) return todayViewSchema.parse({ active: false, localDate: date, nowMinute: minute });
  const timed = day.items.filter((i) => i.kind !== 'free_time' && i.kind !== 'rest');
  const current = timed.find((i) => i.startMinute <= minute && i.endMinute > minute);
  const next = timed.find((i) => i.startMinute > minute && (i.kind === 'activity' || i.kind === 'meal'));
  const nextTravel = day.items.find((i) => i.kind === 'travel' && i.travel && i.startMinute >= minute);
  const resilience = input.backups.find((b) => b.dayNumber === day.dayNumber);
  return todayViewSchema.parse({
    active: true,
    localDate: date,
    dayNumber: day.dayNumber,
    theme: day.theme,
    baseName: day.baseName,
    nowMinute: minute,
    ...(current ? { current: brief(current) } : {}),
    ...(next ? { next: brief(next) } : {}),
    ...(nextTravel?.travel ? { nextTransport: { title: nextTravel.title, startMinute: nextTravel.startMinute, minutes: nextTravel.travel.minutes, mode: nextTravel.travel.mode, basis: nextTravel.travel.basis ?? (nextTravel.travel.provenance === 'measured' ? 'static' : nextTravel.travel.provenance) } } : {}),
    bookedToday: input.booked.filter((b) => b.status === 'booked' && (b.date === date || (b.type === 'lodging' && b.date && b.endDate && b.date <= date && date <= b.endDate))).map((b) => ({ id: b.id, title: b.title, ...(b.startTime ? { startTime: b.startTime } : {}), ...(b.location ? { location: b.location } : {}) })),
    weather: { summary: day.weather.summary, kind: day.weather.evidence, cautions: day.weather.cautions },
    criticalWarnings: [...day.warnings.filter((w) => /booked|leave-by|closed|permit/i.test(w)), ...(input.warnings ?? [])].slice(0, 4),
    flexAlternatives: resilience?.flexItems ?? [],
    ...(resilience?.fallback ? { fallback: `${resilience.fallback.name} — if ${resilience.fallback.trigger.toLowerCase()}` } : {}),
    stops: day.items.filter((i) => i.kind === 'activity').map((i) => ({ id: i.id, title: i.title, startMinute: i.startMinute, endMinute: i.endMinute, ...(i.placeId ? { placeId: i.placeId } : {}), done: i.endMinute <= minute })),
  });
}
