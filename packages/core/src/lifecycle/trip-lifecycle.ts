import { TRIP_LIFECYCLES, type Trip, type TripLifecycle } from '../schemas/trip';

/**
 * THE TRIP LIFECYCLE — INFERRED FROM FACTS, OVERRIDABLE BY THE TRAVELLER.
 *
 * V6 §24. `idea → planning → ready → booked → traveling → past → archived`.
 * Most of it is a function of what exists: an itinerary makes a trip
 * `planning`, a feasible one `ready`, real booked facts `booked`, the calendar
 * `traveling` and `past`. The traveller can set a stage by hand, and the
 * override is honoured — with one rule, from the spec: **booked requires
 * booked facts**. Pressing a label is not a booking. `lifecycleOverride` may
 * say `booked` only when something is actually booked, and the action that
 * sets it refuses otherwise.
 *
 * `archived` is a separate flag (`archivedAt`), not an inferred stage, because
 * archiving is always a person's decision and never expires.
 */

export { TRIP_LIFECYCLES };

export const LIFECYCLE_LABELS: Record<TripLifecycle, string> = {
  idea: 'Idea',
  planning: 'Planning',
  ready: 'Ready',
  booked: 'Booked',
  traveling: 'Travelling',
  past: 'Past',
  archived: 'Archived',
};

export interface LifecycleFacts {
  trip: Pick<Trip, 'basics' | 'status' | 'lifecycleOverride' | 'archivedAt'>;
  /** The persisted itinerary's status, when one exists. */
  itineraryStatus: 'ready' | 'ready_with_cautions' | 'needs_decision' | null;
  /** Booked items that are real bookings (status `booked`), by type. */
  bookedTypes: readonly string[];
  /** The traveller answered the interview, or accepted the smart defaults. */
  hasProfile: boolean;
  now: Date;
}

export interface LifecycleReading {
  lifecycle: TripLifecycle;
  /** The stage the facts alone would give, before any override. */
  inferred: TripLifecycle;
  basis: 'inferred' | 'override' | 'archived';
  /** True when the override was refused because the facts do not support it. */
  overrideRefused: boolean;
}

/** Bookings that count as "meaningful": a bed or a way there. A restaurant table does not make a trip booked. */
const MEANINGFUL_BOOKING_TYPES = new Set(['lodging', 'flight', 'train', 'ferry', 'rental_car', 'transfer']);

export function bookingsAreMeaningful(bookedTypes: readonly string[]): boolean {
  return bookedTypes.some((type) => MEANINGFUL_BOOKING_TYPES.has(type));
}

export function inferLifecycle(facts: LifecycleFacts): TripLifecycle {
  const today = facts.now.toISOString().slice(0, 10);
  const { startDate, endDate } = facts.trip.basics;
  if (endDate < today) return 'past';
  if (startDate <= today && today <= endDate) return 'traveling';
  if (bookingsAreMeaningful(facts.bookedTypes)) return 'booked';
  if (facts.itineraryStatus === 'ready' || facts.itineraryStatus === 'ready_with_cautions') return 'ready';
  if (facts.itineraryStatus !== null || facts.hasProfile || facts.trip.status !== 'draft') return 'planning';
  return 'idea';
}

export function readLifecycle(facts: LifecycleFacts): LifecycleReading {
  const inferred = inferLifecycle(facts);
  if (facts.trip.archivedAt) return { lifecycle: 'archived', inferred, basis: 'archived', overrideRefused: false };
  const override = facts.trip.lifecycleOverride;
  if (!override || override === 'archived') return { lifecycle: inferred, inferred, basis: 'inferred', overrideRefused: false };
  /* The calendar is not overridable: a trip that has ended is past whatever anyone labels it. */
  if (inferred === 'past' || inferred === 'traveling') return { lifecycle: inferred, inferred, basis: 'inferred', overrideRefused: override !== inferred };
  if (override === 'booked' && !bookingsAreMeaningful(facts.bookedTypes)) return { lifecycle: inferred, inferred, basis: 'inferred', overrideRefused: true };
  return { lifecycle: override, inferred, basis: 'override', overrideRefused: false };
}

/** Whether a traveller may set this stage by hand, and if not, why. */
export function overrideRefusal(target: TripLifecycle, facts: LifecycleFacts): string | null {
  const inferred = inferLifecycle(facts);
  if (target === 'archived') return 'Use Archive for that.';
  if (inferred === 'past' && target !== 'past') return 'This trip has already ended, so it stays in the past.';
  if (inferred === 'traveling' && target !== 'traveling') return 'This trip is under way right now.';
  if (target === 'booked' && !bookingsAreMeaningful(facts.bookedTypes)) return 'Add a booked stay or a booked way there first; a trip is booked when something is.';
  return null;
}

/** The dashboard's sections, in the order they are shown. */
export const DASHBOARD_SECTIONS: { id: 'upcoming' | 'booked' | 'planning' | 'ideas' | 'past' | 'archived'; title: string; lifecycles: readonly TripLifecycle[] }[] = [
  { id: 'upcoming', title: 'Up next', lifecycles: ['traveling'] },
  { id: 'booked', title: 'Booked', lifecycles: ['booked'] },
  { id: 'planning', title: 'Planning', lifecycles: ['planning', 'ready'] },
  { id: 'ideas', title: 'Ideas', lifecycles: ['idea'] },
  { id: 'past', title: 'Past', lifecycles: ['past'] },
  { id: 'archived', title: 'Archived', lifecycles: ['archived'] },
];

export function dashboardSectionFor(lifecycle: TripLifecycle): (typeof DASHBOARD_SECTIONS)[number]['id'] {
  return DASHBOARD_SECTIONS.find((section) => section.lifecycles.includes(lifecycle))?.id ?? 'planning';
}
