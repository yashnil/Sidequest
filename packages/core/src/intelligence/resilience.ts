import { z } from 'zod';
import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { AccessStateEntry, DayWeatherSemantics } from './weather-access';
import type { BookingItem } from './booking';
import type { SourceClaim } from './claims';

/**
 * PLAN B, AND WHAT A TRAVELLER WOULD REGRET.
 *
 * A small useful set per day rather than hundreds of alternates: Plan A is
 * the day as written, the fallback is the best backup the plan already holds,
 * the flex items are the stops that can move or go, and the triggers are the
 * things that actually happen — weather, a closed door, a late arrival, a leg
 * nobody could time.
 */
export const dayResilienceSchema = z.object({
  dayNumber: z.number().int().min(1),
  planA: z.string().min(1),
  fallback: z.object({ name: z.string().min(1), trigger: z.string().min(1), why: z.string().min(1), verified: z.boolean() }).optional(),
  flexItems: z.array(z.string().min(1)).default([]),
  triggers: z.array(z.string().min(1)).default([]),
  decisionPoint: z.string().min(1).optional(),
});
export type DayResilience = z.infer<typeof dayResilienceSchema>;

export const regretIntelligenceSchema = z.object({
  dontMiss: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) })),
  safeToSkip: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) })),
  bookEarly: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) })),
  keepFlexible: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) })),
  verifyBeforeLeaving: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) })),
});
export type RegretIntelligence = z.infer<typeof regretIntelligenceSchema>;

export function buildResilience(input: { itinerary: Itinerary; pkg: TripPackage | undefined; weather: readonly DayWeatherSemantics[]; access: readonly AccessStateEntry[]; terminalViolations: readonly string[] }): DayResilience[] {
  const backups = input.pkg?.backups ?? [];
  return input.itinerary.days.map((day, index) => {
    const w = input.weather.find((d) => d.dayNumber === day.dayNumber);
    const dayAccess = input.access.filter((a) => a.dayNumber === day.dayNumber);
    const anchors = (input.pkg?.anchors ?? []).filter((a) => (a.scheduledDayNumber ?? a.dayNumber) === day.dayNumber);
    const flexItems = anchors.filter((a) => a.role === 'flex' || a.role === 'optional').map((a) => a.name);
    const triggers: string[] = [];
    if (w && w.sensitiveItems.length > 0) triggers.push(`Bad weather: ${w.sensitiveItems.map((s) => s.title).slice(0, 2).join(', ')} ${w.sensitiveItems.length > 2 ? 'and more ' : ''}depend on it.`);
    if (dayAccess.some((a) => a.state === 'hours_unknown' || a.state === 'seasonal_unknown')) triggers.push('A closed door: hours or season not confirmed for at least one stop.');
    if (day.totals.unmeasuredLegCount > 0) triggers.push(`Transport: ${day.totals.unmeasuredLegCount} leg${day.totals.unmeasuredLegCount === 1 ? '' : 's'} nobody could time.`);
    if (index === 0) triggers.push('Late arrival: everything today is optional.');
    if (day.intensity === 'intense') triggers.push('Fatigue: drop the last stop, not the first.');
    if (dayAccess.some((a) => a.state === 'reservation_required' || a.state === 'permit_required')) triggers.push('Sold out: a booked stop that did not book falls back to the flex items.');
    /*
     * PRODUCT RECOVERY V1 — a backup belongs to a day only when it was written
     * for it or deterministically matched to it (`package.backups[].dayNumbers`,
     * set by the reconciler from the day's own places). Nothing is assigned by
     * position any more; a day with no compatible backup says so plainly.
     */
    const weatherBackup = day.weather.backups[0];
    const pkgBackup = backups.find((b) => b.dayNumbers?.includes(day.dayNumber));
    const fallback = weatherBackup
      ? { name: weatherBackup.name, trigger: weatherBackup.trigger, why: weatherBackup.why, verified: true }
      : pkgBackup
        ? { name: pkgBackup.alternative, trigger: pkgBackup.trigger, why: 'Proposed by the composing model for this part of the trip; not independently verified.', verified: false }
        : flexItems.length > 0
          ? { name: `Keep the afternoon flexible: ${flexItems[0]} can move or go.`, trigger: 'Anything that runs late or closes', why: 'No day-specific alternative was written for this day; the optional stop is the slack.', verified: false }
          : { name: 'Keep this afternoon flexible.', trigger: 'Anything that runs late or closes', why: 'No day-specific alternative was written for this day.', verified: false };
    return dayResilienceSchema.parse({
      dayNumber: day.dayNumber,
      planA: day.theme,
      fallback,
      flexItems,
      triggers,
      ...(w?.decisionPoint ? { decisionPoint: w.decisionPoint } : {}),
    });
  });
}

export function buildRegret(input: { pkg: TripPackage | undefined; itinerary: Itinerary; bookings: readonly BookingItem[]; access: readonly AccessStateEntry[]; weather: readonly DayWeatherSemantics[]; claims: readonly SourceClaim[]; worthSkipping: readonly { name: string; reason: string }[] }): RegretIntelligence {
  const anchors = input.pkg?.anchors ?? [];
  const scheduledCore = anchors.filter((a) => a.role === 'core' && (a.disposition === 'preserved' || a.disposition === 'preserved_with_verified_facts' || a.disposition === 'moved_same_day' || a.disposition === 'moved_other_day' || a.disposition === 'retained_unverified'));
  const dontMiss = scheduledCore.filter((a, i, all) => all.findIndex((x) => x.name === a.name) === i).slice(0, 5).map((a) => ({ name: a.name, why: a.verification === 'verified' ? `A core stop, confirmed as a place on the map, on day ${a.scheduledDayNumber ?? a.dayNumber}.` : `A core stop of the plan on day ${a.scheduledDayNumber ?? a.dayNumber}; kept as proposed.` }));
  const safeToSkip = [
    ...(input.pkg?.omissions ?? []).map((o) => ({ name: o.name, why: o.reason })),
    ...input.worthSkipping.map((w) => ({ name: w.name, why: w.reason })),
  ].filter((entry, i, all) => all.findIndex((e) => e.name === entry.name) === i).slice(0, 5);
  const bookEarly = input.bookings.filter((b) => b.priority === 'book_first').map((b) => ({ name: b.title, why: b.reason })).filter((entry, i, all) => all.findIndex((e) => e.name === entry.name) === i).slice(0, 5);
  const sensitive = input.weather.flatMap((d) => d.sensitiveItems.filter((s) => s.sensitivity === 'high').map((s) => ({ name: s.title, why: `Weather decides day ${d.dayNumber}; ${s.fallbackType === 'reschedule_within_trip' ? 'it can move within the trip' : s.fallbackType === 'shorten' ? 'it can be cut short' : 'there is a fallback'}.` })));
  const keepFlexible = [...sensitive, ...input.bookings.filter((b) => b.priority === 'keep_flexible').map((b) => ({ name: b.title, why: b.reason }))].filter((entry, i, all) => all.findIndex((e) => e.name === entry.name) === i).slice(0, 5);
  const verify = [
    ...input.access.filter((a) => a.verifyBeforeTravel && (a.state === 'hours_unknown' || a.state === 'seasonal_unknown' || a.state === 'permit_required')).map((a) => ({ name: a.title, why: a.note })),
    ...input.claims.filter((c) => c.freshness === 'regulatory_volatile' && c.state !== 'not_applicable').map((c) => ({ name: c.claim, why: 'Rules can change; re-read the official source before you leave.' })),
  ].filter((entry, i, all) => all.findIndex((e) => e.name === entry.name) === i).slice(0, 6);
  return regretIntelligenceSchema.parse({ dontMiss, safeToSkip, bookEarly, keepFlexible, verifyBeforeLeaving: verify });
}
