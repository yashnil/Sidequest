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
  nextTransport: z.object({ title: z.string().min(1), startMinute: z.number().int(), minutes: z.number().int().nullable(), mode: z.string().min(1), basis: z.string().min(1), fromId: z.string().optional(), toId: z.string().optional() }).optional(),
  /**
   * V9 §8 — WHEN TO LEAVE FOR THE NEXT THING.
   *
   * The next item's start minus the leg that reaches it, only when that leg
   * was measured or estimated; a leg nobody could time gives no leave-by, and
   * the basis is always named so a static road time is never read as live
   * traffic. `minutesFromNow` is negative once the moment has passed.
   */
  leaveBy: z.object({ minute: z.number().int().min(0).max(1440), time: z.string().min(1), minutesFromNow: z.number().int(), basis: z.string().min(1), basisNote: z.string().min(1), legMinutes: z.number().int().min(0) }).optional(),
  bookedToday: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), type: z.string().min(1).optional(), placeId: z.string().optional(), startTime: z.string().optional(), location: z.string().optional() })).default([]),
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

/**
 * V9.1 §9 — TODAY ON THE DAY'S OWN CLOCK.
 *
 * `timeZone` is the trip's wall clock. `zonesByBaseId`, when given, names
 * the civil zone of each base, and a day is judged against its own base's
 * clock: a trip that sleeps in Denver and then Los Angeles is on Denver time
 * until the night it moves. The day is found by asking, for each day, "is it
 * this date where that day's base is?" — so a day is never picked under one
 * zone and clocked under another. Without `zonesByBaseId` the behaviour is
 * exactly the old one.
 */
export function buildTodayView(input: { itinerary: Itinerary; booked: readonly BookedPlanItem[]; backups: readonly DayResilience[]; now: Date; timeZone?: string; zonesByBaseId?: Readonly<Record<string, string>>; warnings?: readonly string[] }): TodayView {
  const zoneOf = (d: ItineraryDay): string | undefined => input.zonesByBaseId?.[d.baseId] ?? input.timeZone;
  const day: ItineraryDay | undefined = input.itinerary.days.find((d) => localClock(input.now, zoneOf(d)).date === d.date);
  const { date, minute } = localClock(input.now, day ? zoneOf(day) : input.timeZone);
  if (!day) return todayViewSchema.parse({ active: false, localDate: date, nowMinute: minute });
  const timed = day.items.filter((i) => i.kind !== 'free_time' && i.kind !== 'rest');
  const current = timed.find((i) => i.startMinute <= minute && i.endMinute > minute);
  const next = timed.find((i) => i.startMinute > minute && (i.kind === 'activity' || i.kind === 'meal'));
  const nextTravel = day.items.find((i) => i.kind === 'travel' && i.travel && i.startMinute >= minute);
  const resilience = input.backups.find((b) => b.dayNumber === day.dayNumber);
  /* The leg that reaches the next item: the last travel item before it, when it was timed. */
  const legBeforeNext = next ? [...day.items].reverse().find((i) => i.kind === 'travel' && i.travel && i.endMinute <= next.startMinute && i.startMinute >= (current?.endMinute ?? 0) - 1) : undefined;
  const legBasis = legBeforeNext?.travel ? (legBeforeNext.travel.basis ?? (legBeforeNext.travel.provenance === 'measured' ? 'static' : legBeforeNext.travel.provenance)) : null;
  const legMinutes = legBeforeNext?.travel?.minutes ?? null;
  const leaveBy = next && legBeforeNext && legMinutes !== null && legBasis !== 'unmeasured'
    ? (() => {
        const leaveMinute = Math.max(0, next.startMinute - legMinutes);
        const basisNote = legBasis === 'traffic_aware' ? `About ${legMinutes} min with live traffic.` : legBasis === 'scheduled' ? `About ${legMinutes} min on the timetable.` : legBasis === 'estimated' ? `About ${legMinutes} min, Sidequest’s own estimate — allow a margin.` : `About ${legMinutes} min by road, measured without traffic — allow a margin.`;
        return { minute: leaveMinute, time: `${String(Math.floor(leaveMinute / 60) % 24).padStart(2, '0')}:${String(leaveMinute % 60).padStart(2, '0')}`, minutesFromNow: leaveMinute - minute, basis: legBasis ?? 'estimated', basisNote, legMinutes };
      })()
    : null;
  return todayViewSchema.parse({
    active: true,
    localDate: date,
    dayNumber: day.dayNumber,
    theme: day.theme,
    baseName: day.baseName,
    nowMinute: minute,
    ...(current ? { current: brief(current) } : {}),
    ...(next ? { next: brief(next) } : {}),
    ...(nextTravel?.travel ? { nextTransport: { title: nextTravel.title, startMinute: nextTravel.startMinute, minutes: nextTravel.travel.minutes, mode: nextTravel.travel.mode, basis: nextTravel.travel.basis ?? (nextTravel.travel.provenance === 'measured' ? 'static' : nextTravel.travel.provenance), fromId: nextTravel.travel.fromId, toId: nextTravel.travel.toId } } : {}),
    ...(leaveBy ? { leaveBy } : {}),
    bookedToday: input.booked.filter((b) => b.status === 'booked' && (b.date === date || (b.type === 'lodging' && b.date && b.endDate && b.date <= date && date <= b.endDate))).map((b) => ({ id: b.id, title: b.title, type: b.type, ...(b.placeId ? { placeId: b.placeId } : {}), ...(b.startTime ? { startTime: b.startTime } : {}), ...(b.location ? { location: b.location } : {}) })),
    weather: { summary: day.weather.summary, kind: day.weather.evidence, cautions: day.weather.cautions },
    criticalWarnings: [...day.warnings.filter((w) => /booked|leave-by|closed|permit/i.test(w)), ...(input.warnings ?? [])].slice(0, 4),
    flexAlternatives: resilience?.flexItems ?? [],
    /*
     * V11 §27 — TWO AUTHORS, ONE LINE, NO ASSERTED GRAMMAR.
     *
     * This used to read `${name} — if ${trigger.toLowerCase()}`, and on the
     * screen that produced "Keep this afternoon flexible. — if anything that
     * runs late or closes": a dash after a full stop, then a fragment. Both
     * halves are written independently -- the name is a complete instruction
     * ending in a stop, and the trigger is a noun phrase from the composing
     * model, which "if " only fits by luck. Welding them with a conjunction
     * asserts a grammatical relationship neither side promised.
     *
     * So: strip the name's terminal stop and set the condition off with a dash,
     * which reads whether the trigger arrives as a noun phrase ("anything that
     * runs late or closes") or as a sentence ("Rain after midday").
     */
    ...(resilience?.fallback ? { fallback: `${resilience.fallback.name.replace(/\s*\.\s*$/, '')} — ${resilience.fallback.trigger.replace(/\s*\.\s*$/, '').toLowerCase()}` } : {}),
    stops: day.items.filter((i) => i.kind === 'activity').map((i) => ({ id: i.id, title: i.title, startMinute: i.startMinute, endMinute: i.endMinute, ...(i.placeId ? { placeId: i.placeId } : {}), done: i.endMinute <= minute })),
  });
}
