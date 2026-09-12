import { z } from 'zod';
import type { Itinerary } from '../schemas/itinerary';
import type { TravelIntelligence } from '../intelligence/model';
import type { BookedPlanItem } from '../intelligence/booking';

/**
 * V9 §9 — FRESHNESS AS A TRAVELLER FEATURE.
 *
 * Every volatile fact behind a plan was read on a date. This module lists
 * them, says which are stale, and says which a configured, cheap and
 * authoritative source could re-read — so the recheck action asks for the
 * fewest requests that could change anything, and the hub can say "2 things
 * changed since this trip was planned" from persisted observations alone.
 *
 * Deterministic and pure: nothing here runs a provider. `detect → explain →
 * propose → the traveller accepts → reverify` — the plan is never edited here.
 */
export const VOLATILE_FACT_KINDS = ['forecast', 'hours', 'status', 'transport', 'deadline', 'access', 'advisory'] as const;
export const volatileFactKindSchema = z.enum(VOLATILE_FACT_KINDS);
export type VolatileFactKind = z.infer<typeof volatileFactKindSchema>;

export const VOLATILE_FACT_KIND_LABELS: Record<VolatileFactKind, string> = {
  forecast: 'Weather forecast',
  hours: 'Opening hours',
  status: 'Whether a place is open',
  transport: 'Flight, train or ferry details',
  deadline: 'A booking or cancellation deadline',
  access: 'Road, trail or access status',
  advisory: 'Entry rules and advisories',
};

export interface VolatileFact {
  id: string;
  kind: VolatileFactKind;
  subject: string;
  /** ISO instant the plan last read this fact, when known. */
  readAt: string | null;
  staleAfterHours: number;
  stale: boolean;
  /** A configured source could re-read this without a model. */
  recheckable: boolean;
  dayNumbers: number[];
  detail: string;
}

/** What a recheck wrote down: one fact, what it said before, what it says now. */
export const factObservationSchema = z.object({
  id: z.string().min(1),
  factId: z.string().min(1),
  kind: volatileFactKindSchema,
  observedAt: z.string().min(1),
  previous: z.string().nullable(),
  current: z.string().nullable(),
  changed: z.boolean(),
  dayNumbers: z.array(z.number().int().min(1)).default([]),
  /** The sentence a traveller reads, written by the recheck that observed it. */
  summary: z.string().min(1),
  acknowledgedAt: z.string().nullable().default(null),
});
export type FactObservation = z.infer<typeof factObservationSchema>;

const STALE_AFTER_HOURS: Record<VolatileFactKind, number> = {
  forecast: 24,
  hours: 24 * 7,
  status: 24 * 7,
  transport: 24,
  deadline: 24 * 7,
  access: 24 * 3,
  advisory: 24 * 30,
};

function hoursSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / 3_600_000;
}

export function volatileFacts(input: {
  itinerary: Itinerary;
  intelligence: TravelIntelligence | null;
  booked: readonly BookedPlanItem[];
  now: Date;
  capabilities: { forecast: boolean; hours: boolean; transit: boolean };
}): VolatileFact[] {
  const facts: VolatileFact[] = [];
  const { itinerary, now } = input;
  const stale = (kind: VolatileFactKind, readAt: string | null) => {
    const age = hoursSince(readAt, now);
    return age === null ? true : age > STALE_AFTER_HOURS[kind];
  };

  // Forecast: one fact per forecast day (a climate day has no forecast to go stale).
  for (const day of itinerary.days) {
    if (day.weather.evidence !== 'forecast') continue;
    const readAt = day.weather.fetchedAt ?? null;
    facts.push({
      id: `fact:forecast:${day.dayNumber}`,
      kind: 'forecast',
      subject: `Day ${day.dayNumber}`,
      readAt,
      staleAfterHours: STALE_AFTER_HOURS.forecast,
      stale: stale('forecast', readAt),
      recheckable: input.capabilities.forecast,
      dayNumbers: [day.dayNumber],
      detail: day.weather.summary,
    });
  }

  // Hours and status: every stop with an operational reading or hours on record.
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.kind !== 'activity') continue;
      if (item.operational) {
        const kind: VolatileFactKind = item.operational.basis === 'status_only' ? 'status' : 'hours';
        facts.push({
          id: `fact:${kind}:${item.id}`,
          kind,
          subject: item.title,
          readAt: item.operational.checkedAt,
          staleAfterHours: STALE_AFTER_HOURS[kind],
          stale: item.operational.recheck || stale(kind, item.operational.checkedAt),
          recheckable: input.capabilities.hours,
          dayNumbers: [day.dayNumber],
          detail: item.operational.note,
        });
      } else if (item.hours) {
        facts.push({
          id: `fact:hours:${item.id}`,
          kind: 'hours',
          subject: item.title,
          readAt: null,
          staleAfterHours: STALE_AFTER_HOURS.hours,
          stale: true,
          recheckable: input.capabilities.hours,
          dayNumbers: [day.dayNumber],
          detail: 'Hours were read when the plan was built.',
        });
      }
    }
  }

  // Imported or typed transport: flights, trains, ferries carry operator-controlled times.
  for (const fact of input.booked) {
    if (fact.status === 'idea') continue;
    if (fact.type !== 'flight' && fact.type !== 'train' && fact.type !== 'ferry') continue;
    const day = fact.date ? itinerary.days.find((d) => d.date === fact.date) : undefined;
    facts.push({
      id: `fact:transport:${fact.id}`,
      kind: 'transport',
      subject: fact.title,
      readAt: fact.createdAt,
      staleAfterHours: STALE_AFTER_HOURS.transport,
      stale: stale('transport', fact.createdAt),
      recheckable: false,
      dayNumbers: day ? [day.dayNumber] : [],
      detail: 'No status provider is configured; the operator’s own app is the source.',
    });
    if (fact.cancellationDeadline) {
      facts.push({
        id: `fact:deadline:${fact.id}`,
        kind: 'deadline',
        subject: fact.title,
        readAt: fact.createdAt,
        staleAfterHours: STALE_AFTER_HOURS.deadline,
        stale: false,
        recheckable: false,
        dayNumbers: day ? [day.dayNumber] : [],
        detail: `Free cancellation until ${fact.cancellationDeadline}.`,
      });
    }
  }
  for (const fact of input.booked) {
    if (fact.type === 'flight' || fact.type === 'train' || fact.type === 'ferry' || !fact.cancellationDeadline) continue;
    const day = fact.date ? itinerary.days.find((d) => d.date === fact.date) : undefined;
    facts.push({ id: `fact:deadline:${fact.id}`, kind: 'deadline', subject: fact.title, readAt: fact.createdAt, staleAfterHours: STALE_AFTER_HOURS.deadline, stale: false, recheckable: false, dayNumbers: day ? [day.dayNumber] : [], detail: `Free cancellation until ${fact.cancellationDeadline}.` });
  }

  // Access and advisories from the source registry — official sources with a read date.
  for (const claim of input.intelligence?.sourceRegistry ?? []) {
    if (claim.state === 'not_applicable') continue;
    const kind: VolatileFactKind | null = claim.kind === 'seasonal_access' || claim.kind === 'transport_schedule' ? 'access' : claim.kind === 'entry_visa' || claim.kind === 'travel_advisory' || claim.kind === 'health_document' ? 'advisory' : null;
    if (!kind) continue;
    facts.push({
      id: `fact:${kind}:${claim.id}`,
      kind,
      subject: claim.claim.split(/[.:]/)[0] ?? claim.claim,
      readAt: claim.checkedAt ?? null,
      staleAfterHours: STALE_AFTER_HOURS[kind],
      stale: claim.state === 'stale' || stale(kind, claim.checkedAt ?? null),
      recheckable: false,
      dayNumbers: [],
      detail: claim.claim,
    });
  }

  return facts;
}

/** The facts a recheck should ask about now: stale, and answerable without a model. */
export function factsDueForRecheck(facts: readonly VolatileFact[]): VolatileFact[] {
  return facts.filter((f) => f.stale && f.recheckable);
}

/** "2 things changed since this trip was planned." */
export function summariseObservations(observations: readonly FactObservation[]): { changed: FactObservation[]; headline: string | null } {
  const changed = observations.filter((o) => o.changed && !o.acknowledgedAt);
  if (changed.length === 0) return { changed, headline: null };
  return { changed, headline: `${changed.length} thing${changed.length === 1 ? '' : 's'} changed since this trip was planned.` };
}
