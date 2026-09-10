import 'server-only';
import { countNights, imageryFallbackFor, isAbandoned, readLifecycle, type DestinationImage, type ImageryFallback, type Trip, type TripLifecycle } from '@sidequest/core';
import { adoptedCompiledRegionId, getIntent, getLatestJob } from '../db/compiler-repository';
import { destinationEntryById } from '../db/destination-index-repository';
import { acceptedImagesFor } from '../db/imagery-repository';
import { listBookedItems } from '../db/intelligence-repository';
import { getItinerary, getProfile, listTripsFor } from '../db/repository';
import { formatDayRange } from '../format/dates';
import { tripProgress } from '../format/trip-progress';

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
  progressTone: 'neutral' | 'pine' | 'amber' | 'blue' | 'clay';
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
    nextAction: reading.lifecycle === 'past' ? 'Look back' : reading.lifecycle === 'archived' ? 'Open' : progress.action,
    href: progress.path(trip.id),
    progressTone: progress.tone,
    updatedAt: trip.updatedAt,
    startDate: trip.basics.startDate,
    image,
    fallback: imageryFallbackFor({ kind: 'destination', id: entry?.id ?? trip.id, name: trip.basics.destinationInput, ...(entry?.center ? { coordinates: entry.center } : {}) }),
    claimed: Boolean(trip.userId),
  };
}
