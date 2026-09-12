import 'server-only';
import { dayState, formatMinuteOfDay, type BookedPlanItem, type FactObservation, type Itinerary, type NextActions, type TodayView, type Trip, type TripNodeState } from '@sidequest/core';
import { legDirectionsLinks, navModeFor, placeNavigationLinks } from '@/lib/navigation-links';
import { itineraryViewModel } from '../itinerary/view-model';

/**
 * V9 §8 — TODAY, READ FOR A PHONE.
 *
 * The same `itineraryViewModel` the hub reads — one load path, one clock,
 * no provider — picked down to what the day-of screen needs: now, next,
 * when to leave and on what basis, a directions link where a position is
 * established evidence, the reservation behind the next thing, the weather,
 * the fallback, what changed today, the timeline with its done state.
 * Nothing here is stored and nothing here is fetched.
 */
export interface TodayDirections {
  google: string;
  apple: string;
  /** "Directions to Harbour Market" / "Directions for the next leg". */
  label: string;
  mode: 'driving' | 'walking' | 'transit';
}

export interface TodayReservation {
  id: string;
  title: string;
  startTime?: string;
  location?: string;
  /** Owner only: the page is owner-gated, so the reference may be shown behind a disclosure. */
  confirmationRef?: string;
}

export interface TodayModel {
  tripId: string;
  destination: string;
  today: TodayView;
  /** The trip's first and last dates, for the "not travelling today" state. */
  firstDate: string;
  lastDate: string;
  dayCount: number;
  timeZone: string | null;
  /** Where the day stands on the state graph. */
  state: TripNodeState | null;
  directions: TodayDirections | null;
  reservation: TodayReservation | null;
  /** Unacknowledged changes observed for today. */
  changed: FactObservation[];
  nextActions: NextActions | null;
  /** The next item's start, as a clock, for the "Change today" request. */
  clock: (minute: number) => string;
}

/** A leg's two ends, or the next stop, as a navigation link — only where a position is established. */
export function todayDirections(today: TodayView, coordinates: Record<string, { lat: number; lng: number }>): TodayDirections | null {
  const leg = today.nextTransport;
  if (leg?.fromId && leg.toId) {
    const from = coordinates[leg.fromId];
    const to = coordinates[leg.toId];
    if (from && to) {
      const mode = navModeFor(leg.mode);
      return { ...legDirectionsLinks(from, to, mode), label: `Directions for ${leg.title}`, mode };
    }
  }
  const next = today.next;
  const stop = next ? today.stops.find((s) => s.id === next.id) : undefined;
  const placeId = stop?.placeId;
  const point = placeId ? coordinates[placeId] : undefined;
  if (next && point) {
    const mode = leg ? navModeFor(leg.mode) : 'driving';
    return { ...placeNavigationLinks({ ...point, name: next.title }), label: `Directions to ${next.title}`, mode };
  }
  return null;
}

/** The booked fact behind the next item — matched by place, then by title — with its reference. */
export function todayReservation(today: TodayView, booked: readonly BookedPlanItem[]): TodayReservation | null {
  const next = today.next;
  if (!next) return null;
  const onToday = new Set(today.bookedToday.map((b) => b.id));
  const stop = today.stops.find((s) => s.id === next.id);
  const fold = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = fold(next.title);
  const match = booked.find((b) => onToday.has(b.id) && b.status === 'booked' && ((stop?.placeId && b.placeId && b.placeId === stop.placeId) || fold(b.title) === wanted || fold(b.title).includes(wanted) || wanted.includes(fold(b.title))));
  if (!match) return null;
  return {
    id: match.id,
    title: match.title,
    ...(match.startTime ? { startTime: match.startTime } : {}),
    ...(match.location ? { location: match.location } : {}),
    ...(match.confirmationRef ? { confirmationRef: match.confirmationRef } : {}),
  };
}

export async function todayViewModel(trip: Trip, itinerary: Itinerary): Promise<TodayModel> {
  const model = await itineraryViewModel(trip, itinerary);
  const today = model.today;
  const days = model.appliedItinerary.days;
  return {
    tripId: trip.id,
    destination: trip.basics.destinationInput,
    today,
    firstDate: days[0]?.date ?? trip.basics.startDate,
    lastDate: days[days.length - 1]?.date ?? trip.basics.endDate,
    dayCount: days.length,
    timeZone: model.timeZone ?? null,
    state: today.dayNumber ? dayState(model.graph, today.dayNumber).state : null,
    directions: todayDirections(today, model.coordinates),
    reservation: todayReservation(today, model.booked),
    changed: today.dayNumber ? model.observations.filter((o) => o.changed && !o.acknowledgedAt && o.dayNumbers.includes(today.dayNumber!)) : [],
    nextActions: model.nextActions,
    clock: formatMinuteOfDay,
  };
}
