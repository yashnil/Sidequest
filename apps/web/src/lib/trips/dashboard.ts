import 'server-only';
import { buildBookingProgress, buildNextActions, buildTripStateGraph, countNights, DASHBOARD_SECTIONS, deriveDecisions, imageryFallbackFor, isAbandoned, readLifecycle, type DestinationImage, type ImageryFallback, type NextAction, type Trip, type TripLifecycle } from '@sidequest/core';
import { adoptedCompiledRegionId, getIntent, getLatestJob } from '../db/compiler-repository';
import { destinationEntryById } from '../db/destination-index-repository';
import { listBookingResolutions, listDecisions, listObservations } from '../db/execution-repository';
import { acceptedImagesFor } from '../db/imagery-repository';
import { getTravelIntelligence, listBookedItems } from '../db/intelligence-repository';
import { getItinerary, getProfile, listTripsFor } from '../db/repository';
import { applyBookedFacts } from '../intelligence/booked-reconcile';
import { formatDayRange } from '../format/dates';
import { tripProgress } from '../format/trip-progress';
import { bookingStateLabel, primaryHrefFor } from './card-metadata';

/**
 * V9 §21 — THE DASHBOARD'S SECTIONS.
 *
 * Traveling now · Booked / Getting ready · Planning · Ideas · Past · Archived.
 * The core table (`DASHBOARD_SECTIONS`) still names the first section
 * `upcoming`; the ids the surfaces and the browser suite use are these, so
 * the mapping lives here and the core stays untouched.
 */
export const DASHBOARD_V3_SECTIONS: readonly { id: 'traveling' | 'booked' | 'planning' | 'ideas' | 'past' | 'archived'; title: string; lifecycles: readonly TripLifecycle[] }[] = DASHBOARD_SECTIONS.map((section) =>
  section.id === 'upcoming' ? { id: 'traveling' as const, title: 'Traveling now', lifecycles: section.lifecycles } : section.id === 'booked' ? { id: 'booked' as const, title: 'Booked · Getting ready', lifecycles: section.lifecycles } : { id: section.id, title: section.title, lifecycles: section.lifecycles },
);

/**
 * THE DASHBOARD'S ROWS — EVERYTHING A TRIP CARD SAYS, COMPUTED ON THE SERVER
 * FROM PERSISTED FACTS.
 *
 * V6 §25. One read per trip for each of: the row, the intent (destination
 * identity), the itinerary (status, bases, feasibility), booked items and
 * the profile; the lifecycle is a pure function of those. No provider is
 * called: the picture comes from the imagery table when the destination has
 * one, and from the designed fallback otherwise.
 */
export interface DashboardRow {
  id: string;
  title: string;
  destination: string;
  dates: string;
  /** "Dates set", "Sidequest chose the dates", "Timing still open". */
  timing: 'fixed' | 'chosen' | 'open';
  nights: number;
  party: string;
  lifecycle: TripLifecycle;
  lifecycleBasis: 'inferred' | 'override' | 'archived';
  /** The base sequence, when a plan exists. */
  bases: string[];
  itineraryStatus: 'ready' | 'ready_with_cautions' | 'needs_decision' | null;
  feasibilitySummary: string | null;
  bookedCount: number;
  nextAction: string;
  href: string;
  /**
   * V9 §21 — the next best action from the execution engine, when a plan and
   * its intelligence exist: what kind of act, what, why, and where in the hub.
   * Null for a trip with no plan yet, whose next step is the progress action.
   */
  next?: { kind: NextAction['kind']; title: string; why: string; href: string } | null;
  /** "6 of 8 major items booked", or null when the plan needs nothing major. */
  bookingState?: string | null;
  progressTone: 'neutral' | 'pine' | 'amber' | 'blue' | 'clay';
  /**
   * V8 §9 — where the trip is when no finished plan can speak for it, in
   * `tripProgress`'s words ("Not planned yet", "Building now", "Waiting on
   * your answers"), and its rank so the home strip can lead with what
   * somebody most likely came back for.
   */
  progressState: string;
  progressLabel: string;
  progressRank: number;
  updatedAt: string;
  startDate: string;
  image: DestinationImage | null;
  fallback: ImageryFallback;
  claimed: boolean;
}

export function dashboardRowsFor(owner: { userId: string | null; ownerToken: string | null }, now: Date = new Date()): DashboardRow[] {
  const trips = listTripsFor(owner);
  const subjects = trips.map((trip) => {
    const entryId = getIntent(trip.id)?.selectedDestination?.entryId ?? null;
    const entry = entryId ? destinationEntryById(entryId) : null;
    return { trip, entry };
  });
  const images = acceptedImagesFor(subjects.filter((s) => s.entry).map((s) => ({ kind: 'destination' as const, id: s.entry!.id, ...(s.entry!.wikidataId ? { wikidataId: s.entry!.wikidataId } : {}) })), now);
  return subjects.map(({ trip, entry }) => rowFor(trip, entry, images[entry?.id ?? ''] ?? null, now));
}

function rowFor(trip: Trip, entry: { id: string; center?: { lat: number; lng: number } } | null, image: DestinationImage | null, now: Date): DashboardRow {
  const itinerary = getItinerary(trip.id);
  const booked = listBookedItems(trip.id).filter((item) => item.status === 'booked');
  const profile = getProfile(trip.id);
  const job = getLatestJob(trip.id);
  const progress = tripProgress({
    status: trip.status,
    jobState: job?.state ?? null,
    jobLive: job ? !isAbandoned(job, now) : false,
    hasCompiledRegion: adoptedCompiledRegionId(trip.id) !== null,
    hasItinerary: itinerary !== null,
  });
  const reading = readLifecycle({ trip, itineraryStatus: itinerary?.status ?? null, bookedTypes: booked.map((b) => b.type), hasProfile: profile !== null, now });
  const adults = trip.basics.adults;
  const children = trip.basics.children;
  const party = `${adults} adult${adults === 1 ? '' : 's'}${children > 0 ? `, ${children} child${children === 1 ? '' : 'ren'}` : ''}`;
  const execution = executionFor(trip, itinerary, reading.lifecycle, now);
  const href = primaryHrefFor({ tripId: trip.id, lifecycle: reading.lifecycle, progressHref: progress.path(trip.id), nextHref: null });
  return {
    id: trip.id,
    title: trip.title ?? trip.basics.destinationInput,
    destination: trip.basics.destinationInput,
    dates: formatDayRange(trip.basics.startDate, trip.basics.endDate),
    timing: trip.basics.timingLock === 'traveler' ? 'fixed' : trip.basics.timingLock === 'sidequest' ? 'chosen' : itinerary ? 'fixed' : 'open',
    nights: countNights(trip.basics.startDate, trip.basics.endDate),
    party,
    lifecycle: reading.lifecycle,
    lifecycleBasis: reading.basis,
    bases: (itinerary?.package?.bases ?? []).map((b) => b.name),
    itineraryStatus: itinerary?.status ?? null,
    feasibilitySummary: itinerary?.package?.feasibility?.summary ?? null,
    bookedCount: booked.length,
    nextAction: reading.lifecycle === 'traveling' ? 'Open Today' : reading.lifecycle === 'past' ? 'Look back' : reading.lifecycle === 'archived' ? 'Open' : progress.action,
    href,
    next: execution.next,
    bookingState: execution.bookingState,
    progressTone: progress.tone,
    progressState: progress.state,
    progressLabel: progress.label,
    progressRank: progress.rank,
    updatedAt: trip.updatedAt,
    startDate: trip.basics.startDate,
    image,
    fallback: imageryFallbackFor({ kind: 'destination', id: entry?.id ?? trip.id, name: trip.basics.destinationInput, ...(entry?.center ? { coordinates: entry.center } : {}) }),
    claimed: Boolean(trip.userId),
  };
}

/**
 * V9 §21 — THE ENGINE'S READING OF A TRIP, FOR ONE CARD.
 *
 * The state graph and the next actions are built exactly as the hub builds
 * them — the applied itinerary, the stored intelligence snapshot, the booked
 * items, the traveller's decisions and resolutions, what changed — so the
 * card and the hub cannot name two different next things. Reads only: a
 * trip with no stored snapshot gets no engine reading rather than a build.
 */
function executionFor(trip: Trip, itinerary: ReturnType<typeof getItinerary>, lifecycle: TripLifecycle, now: Date): { next: DashboardRow['next']; bookingState: string | null } {
  if (!itinerary) return { next: null, bookingState: null };
  try {
    const intelligence = getTravelIntelligence(trip.id);
    const booked = listBookedItems(trip.id);
    const applied = applyBookedFacts(itinerary, booked).itinerary;
    const decisions = deriveDecisions({ itinerary: applied, intelligence, persisted: listDecisions(trip.id) });
    const graph = buildTripStateGraph({ itinerary: applied, intelligence, booked, decisions, resolutions: listBookingResolutions(trip.id), observations: listObservations(trip.id), now });
    const daysUntilTrip = Math.round((Date.parse(`${trip.basics.startDate}T00:00:00Z`) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
    const first = buildNextActions({ graph, lifecycle, daysUntilTrip, now }).actions[0] ?? null;
    const next = first ? { kind: first.kind, title: first.title, why: first.why, href: primaryHrefFor({ tripId: trip.id, lifecycle, progressHref: `/trips/${trip.id}/itinerary`, nextHref: first.href }) } : null;
    return { next, bookingState: bookingStateLabel(intelligence ? buildBookingProgress(intelligence.bookings.items) : null) };
  } catch (error) {
    console.warn('The dashboard could not read a trip’s execution state', { tripId: trip.id, message: error instanceof Error ? error.message : 'unknown' });
    return { next: null, bookingState: null };
  }
}

/**
 * When a trip was last touched, in the words a person would use.
 *
 * Deliberately coarse. A timestamp to the minute is a database field; what a
 * traveller wants to know is whether this is the thing they were working on
 * yesterday or something they started in the spring. Computed on the server,
 * once, because the card is a client component rendered twice and "3 days
 * ago" from `Date.now()` in both places is a hydration mismatch waiting for a
 * midnight.
 */
export function lastTouched(updatedAt: string, now: Date): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return 'Saved';
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 7) return `Updated ${days} days ago`;
  if (days < 14) return 'Updated last week';
  if (days < 60) return `Updated ${Math.round(days / 7)} weeks ago`;
  return `Updated ${Math.round(days / 30)} months ago`;
}
