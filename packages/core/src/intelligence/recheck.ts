import { z } from 'zod';
import type { SourceClaim } from './claims';

/**
 * THE RECHECK MANIFEST.
 *
 * Freshness classes become a schedule. Each window names what to re-read
 * before the trip and, near departure, during it. Deterministic: nothing here
 * runs a provider; it is the list a later background job (or the traveller)
 * works through.
 */
export const RECHECK_WINDOWS = ['thirty_to_sixty_days', 'seven_days', 'one_to_two_days', 'same_day'] as const;
export const recheckWindowSchema = z.enum(RECHECK_WINDOWS);
export type RecheckWindow = z.infer<typeof recheckWindowSchema>;

export const RECHECK_WINDOW_LABELS: Record<RecheckWindow, string> = {
  thirty_to_sixty_days: '30–60 days out',
  seven_days: 'A week out',
  one_to_two_days: '24–48 hours out',
  same_day: 'On the day',
};

export const recheckItemSchema = z.object({
  id: z.string().min(1),
  window: recheckWindowSchema,
  title: z.string().min(1),
  why: z.string().min(1),
  claimIds: z.array(z.string().min(1)).default([]),
  /** Whether a configured provider could run this automatically later. */
  automatable: z.boolean(),
  sourceUrl: z.string().url().optional(),
  state: z.enum(['due', 'upcoming', 'past']),
});
export type RecheckItem = z.infer<typeof recheckItemSchema>;

export const recheckManifestSchema = z.object({
  daysUntilTrip: z.number().int(),
  items: z.array(recheckItemSchema),
  note: z.string().min(1),
});
export type RecheckManifest = z.infer<typeof recheckManifestSchema>;

function stateFor(window: RecheckWindow, daysUntilTrip: number, tripDays: number): RecheckItem['state'] {
  const inTrip = daysUntilTrip <= 0 && daysUntilTrip > -tripDays;
  switch (window) {
    case 'thirty_to_sixty_days':
      return daysUntilTrip > 60 ? 'upcoming' : daysUntilTrip >= 7 ? 'due' : 'past';
    case 'seven_days':
      return daysUntilTrip > 7 ? 'upcoming' : daysUntilTrip >= 1 ? 'due' : 'past';
    case 'one_to_two_days':
      return daysUntilTrip > 2 ? 'upcoming' : daysUntilTrip >= 0 ? 'due' : inTrip ? 'due' : 'past';
    case 'same_day':
      return daysUntilTrip > 0 ? 'upcoming' : inTrip ? 'due' : 'past';
  }
}

export function buildRecheckManifest(input: {
  claims: readonly SourceClaim[];
  daysUntilTrip: number;
  tripDays: number;
  drives: boolean;
  hasFlights: boolean;
  hasFerries: boolean;
  capabilities: { forecast: boolean; traffic: boolean; hours: boolean; transit: boolean };
}): RecheckManifest {
  const items: RecheckItem[] = [];
  const by = (kinds: readonly string[]) => input.claims.filter((c) => kinds.includes(c.kind) && c.state !== 'not_applicable');
  const push = (window: RecheckWindow, id: string, title: string, why: string, claims: readonly SourceClaim[], automatable: boolean) => {
    items.push(recheckItemSchema.parse({ id, window, title, why, claimIds: claims.map((c) => c.id), automatable, ...(claims.find((c) => c.sourceUrl)?.sourceUrl ? { sourceUrl: claims.find((c) => c.sourceUrl)!.sourceUrl } : {}), state: stateFor(window, input.daysUntilTrip, input.tripDays) }));
  };

  const regulatory = by(['entry_visa', 'passport_validity', 'transit_requirement', 'health_document', 'travel_advisory', 'local_law', 'driving_document']);
  if (regulatory.length > 0) push('thirty_to_sixty_days', 'recheck:entry', 'Entry rules, visas and health requirements', 'Regulations change without notice; read the official source again once you are inside the booking window.', regulatory, false);
  const permits = by(['permit']);
  if (permits.length > 0) push('thirty_to_sixty_days', 'recheck:permits', 'Permits and timed entry', 'Quotas open and close on the operator’s calendar.', permits, false);
  const schedules = by(['transport_schedule', 'seasonal_access']);
  if (schedules.length > 0 || input.hasFerries) push('thirty_to_sixty_days', 'recheck:seasonal-transport', 'Seasonal roads, ferries and timetables', 'Seasonal services publish their next timetable close to the season.', schedules, input.capabilities.transit);

  const hours = by(['opening_hours']);
  if (hours.length > 0) push('seven_days', 'recheck:hours', 'Venue hours and park access', 'Hours were read when the plan was built; holidays and off-season closures land a week out.', hours, input.capabilities.hours);
  const weather = by(['weather_forecast', 'climate']);
  push('seven_days', 'recheck:forecast', 'Weather forecast for your dates', 'The first real forecast for your dates arrives about a week out.', weather, input.capabilities.forecast);
  if (schedules.length > 0 || input.capabilities.transit) push('seven_days', 'recheck:transport-ops', 'Transport operations', 'Engineering works and cancellations are announced days ahead.', schedules, input.capabilities.transit);

  push('one_to_two_days', 'recheck:weather-48h', 'Weather', 'Forecasts inside 48 hours are the ones to plan a day on.', weather, input.capabilities.forecast);
  if (input.hasFlights || input.hasFerries) push('one_to_two_days', 'recheck:flight-ferry', 'Flight and ferry status', 'Schedule changes are notified in this window; no status provider is configured, so check with the operator.', [], false);
  if (input.drives) push('one_to_two_days', 'recheck:traffic-major', 'Traffic on the big drives', 'Traffic-aware timing only means something this close to departure.', by(['routing_duration']).slice(0, 4), input.capabilities.traffic);
  const booked = by(['booked_fact']);
  if (booked.length > 0) push('one_to_two_days', 'recheck:booked-venues', 'Booked venues and pickups', 'Confirm the booked things you cannot do without.', booked, false);

  push('same_day', 'recheck:same-day', 'Traffic, transit and disruptions', input.capabilities.traffic || input.capabilities.transit ? 'Where a provider supports it, this can run automatically on the day.' : 'No live traffic or transit provider is configured; check the operator apps.', [], input.capabilities.traffic || input.capabilities.transit);

  const due = items.filter((i) => i.state === 'due').length;
  return recheckManifestSchema.parse({
    daysUntilTrip: input.daysUntilTrip,
    items,
    note: input.daysUntilTrip > 60 ? 'Nothing needs re-checking yet; the first window opens 60 days before you go.' : due > 0 ? `${due} ${due === 1 ? 'check is' : 'checks are'} due now.` : 'Nothing is due right now.',
  });
}
