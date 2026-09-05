import type { Itinerary, ItineraryDay } from '@sidequest/core';
import { removeStopFromReconciledItinerary } from './reconciled-edits';

/**
 * "FIX THIS DAY" — DETERMINISTIC, LOCAL, EXPLAINED.
 *
 * A day that runs past its window, or has no slack at all, is repaired by
 * taking off its least-committed stops (optional and flex before secondary,
 * never a must-keep core stop, never a booked one) until it fits with at
 * least half an hour free. Each step is named so the traveller reads exactly
 * what changed and why. It never re-routes, never calls a model or a
 * provider: the measured legs that remain are the ones that were measured.
 */
const MIN_SLACK_MINUTES = 30;
const MAX_STEPS = 4;

export interface DayRepairResult {
  ok: boolean;
  itinerary?: Itinerary;
  message: string;
  steps: string[];
}

function endOfDay(day: ItineraryDay): number {
  return Math.max(day.window.startMinute, ...day.items.filter((i) => i.kind !== 'free_time').map((i) => i.endMinute));
}

function problemOf(day: ItineraryDay): string | null {
  const end = endOfDay(day);
  if (end > day.window.endMinute) return `runs ${end - day.window.endMinute} minutes past its window`;
  if (day.totals.freeMinutes < MIN_SLACK_MINUTES && day.items.filter((i) => i.kind === 'activity').length > 1) return 'has no slack in it';
  return null;
}

export function repairReconciledDay(itinerary: Itinerary, dayNumber: number, options: { bookedItemIds?: ReadonlySet<string> } = {}): DayRepairResult {
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.`, steps: [] };
  const initial = problemOf(day);
  if (!initial) return { ok: false, message: `Day ${dayNumber} already fits its window with time to spare.`, steps: [] };
  const rank = (role: string | undefined) => ['flex', 'optional', 'secondary', 'core'].indexOf(role ?? 'secondary');
  const steps: string[] = [];
  let current = itinerary;
  for (let n = 0; n < MAX_STEPS; n += 1) {
    const today = current.days.find((d) => d.dayNumber === dayNumber)!;
    if (!problemOf(today)) break;
    const candidates = today.items
      .filter((i) => i.kind === 'activity')
      .map((item) => {
        const anchor = current.package?.anchors.find((a) => a.id === item.id || (a.placeId !== undefined && a.placeId === item.placeId && (a.scheduledDayNumber ?? a.dayNumber) === dayNumber));
        return { item, role: anchor?.role, booked: Boolean(item.booking && (item.booking.kind === 'timed_entry' || item.booking.kind === 'reservation')) || (options.bookedItemIds?.has(item.id) ?? false) };
      })
      .filter((c) => !c.booked && c.role !== 'core')
      .sort((a, b) => rank(a.role) - rank(b.role) || b.item.startMinute - a.item.startMinute);
    const victim = candidates[0];
    if (!victim) break;
    const result = removeStopFromReconciledItinerary(current, dayNumber, victim.item.id);
    if (!result.ok) break;
    current = result.itinerary;
    steps.push(`Took off ${victim.item.title} (${victim.role ?? 'secondary'}) — the last-placed stop Sidequest could give up.`);
  }
  const after = current.days.find((d) => d.dayNumber === dayNumber)!;
  const remaining = problemOf(after);
  if (steps.length === 0) return { ok: false, message: `Day ${dayNumber} ${initial}, but every stop on it is must-keep or booked, so nothing was removed. Move a stop to another day, or mark one optional.`, steps: [] };
  const eased: ItineraryDay = { ...after, intensity: after.intensity === 'intense' ? 'moderate' : after.intensity };
  return {
    ok: true,
    itinerary: { ...current, days: current.days.map((d) => (d.dayNumber === dayNumber ? eased : d)) },
    message: remaining ? `Day ${dayNumber} still ${remaining} after ${steps.length} change${steps.length === 1 ? '' : 's'}; the rest is must-keep or booked.` : `Day ${dayNumber} fits its window now.`,
    steps,
  };
}
