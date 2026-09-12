import 'server-only';
import {
  BOOKED_ITEM_TYPE_LABELS,
  buildCalendar,
  deriveTimeZoneFromLongitude,
  formatMinuteOfDay,
  licence,
  yearsBetween,
  type BookedPlanItem,
  type CalendarEvent,
  type Itinerary,
  type ItineraryItem,
  type Trip,
} from '@sidequest/core';
import { loadTripIntelligence } from '@/lib/intelligence/load';
import { destinationTimeZone } from './destination-zone';
import { currentVersion } from '@/lib/refine/version-repository';
import { resolveTripRegion } from '@/lib/region';

/**
 * V9 §10 — THE TRIP AS CALENDAR EVENTS, DERIVED ONCE FOR THE SNAPSHOT AND THE FEED.
 *
 * Two layers. `calendarEventsFor` is pure: given the applied itinerary, the
 * booked facts, a zone per base and the trip's version, it returns the events
 * with stable UIDs, so a subscribed calendar updates an event rather than
 * growing a duplicate every time the plan is refined. `loadTripCalendarSource`
 * is the server half: it reads the compiled region for zones and
 * coordinates, applies booked facts over the pristine plan and reads the
 * version — and nothing else. Neither calls a provider or a model.
 *
 * What never enters an event: notes, confirmation references, costs, URLs
 * typed on a booking. A calendar is on every device the traveller signs into
 * and is the first thing shared with a companion; the private facts stay in
 * the hub.
 */

export interface TripCalendarSource {
  tripId: string;
  /** The itinerary with booked facts applied. */
  itinerary: Itinerary;
  booked: readonly BookedPlanItem[];
  /** IANA zone per base id; a day whose base is not listed uses `primaryTimeZone`. */
  zonesByBaseId: Record<string, string>;
  primaryTimeZone: string;
  /** Resolved positions by place id and base id, for `GEO`. */
  coordinates: Record<string, { lat: number; lng: number }>;
  /** The trip's current version — `SEQUENCE` on every event. */
  sequence: number;
}

export interface TripCalendarEvents {
  events: CalendarEvent[];
  timeZones: string[];
  years: number[];
}

/** Activities and meals are appointments; short travel legs are noise. */
export function isCalendarItem(item: ItineraryItem): boolean {
  if (item.id.startsWith('booked:')) return false;
  if (item.kind === 'activity') return true;
  if (item.kind === 'meal') return true;
  if (item.kind === 'travel') return item.durationMinutes >= 45;
  return false;
}

function mealLabel(item: ItineraryItem): string {
  switch (item.food?.slot) {
    case 'breakfast':
      return 'breakfast';
    case 'lunch':
      return 'lunch';
    case 'dinner':
      return 'dinner';
    default:
      return 'food stop';
  }
}

function timeToMinute(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return Math.min(23 * 60 + 59, (h ?? 0) * 60 + (m ?? 0));
}

/**
 * The UID an item keeps for the life of the trip.
 *
 * A package anchor is the model's own experience, and its id survives a
 * rebuild; an item id is renumbered. So the anchor's id is preferred — matched
 * by item id, then by place id — and the day-scoped item id is the fallback.
 */
export function calendarUidFor(tripId: string, item: ItineraryItem, dayNumber: number, itinerary: Itinerary): string {
  const anchors = itinerary.package?.anchors ?? [];
  const anchor = anchors.find((a) => a.id === item.id) ?? (item.placeId ? anchors.find((a) => a.placeId !== undefined && a.placeId === item.placeId) : undefined);
  if (anchor) return `${tripId}-anchor-${anchor.id}@sidequest`;
  return `${tripId}-day-${dayNumber}-${item.id}@sidequest`;
}

export function calendarEventsFor(source: TripCalendarSource): TripCalendarEvents {
  const { itinerary, tripId } = source;
  const zoneOfDay = (baseId: string): string => source.zonesByBaseId[baseId] ?? source.primaryTimeZone;
  const zoneOfDate = (date: string): string => {
    const day = itinerary.days.find((d) => d.date === date);
    return day ? zoneOfDay(day.baseId) : source.primaryTimeZone;
  };
  const events: CalendarEvent[] = [];
  const zones = new Set<string>();

  /*
   * Booked facts first: a calendar that carried the model's hotel while the
   * traveller has booked a different one would be the wrong calendar.
   */
  for (const booking of source.booked) {
    if (booking.status !== 'booked' || !booking.date) continue;
    const start = booking.startTime ?? (booking.type === 'lodging' ? '15:00' : '09:00');
    const end = booking.endTime ?? (booking.type === 'lodging' ? '11:00' : null);
    const endDate = booking.type === 'lodging' ? (booking.endDate ?? booking.date) : booking.date;
    const startMinute = timeToMinute(start);
    const endMinute = end ? timeToMinute(end) : Math.min(23 * 60 + 59, startMinute + 120);
    const timeZone = booking.timeZone ?? zoneOfDate(booking.date);
    zones.add(timeZone);
    const geo = booking.placeId ? source.coordinates[booking.placeId] : booking.baseId ? source.coordinates[booking.baseId] : undefined;
    events.push({
      uid: `${tripId}-booked-${booking.id}@sidequest`,
      date: booking.date,
      startMinute,
      endMinute: endDate === booking.date ? Math.max(startMinute, endMinute) : endMinute,
      ...(endDate !== booking.date ? { endDate } : {}),
      timeZone,
      summary: `Booked: ${booking.title}`,
      description: [BOOKED_ITEM_TYPE_LABELS[booking.type], booking.provider ? `with ${booking.provider}` : null].filter((p): p is string => Boolean(p)).join(' '),
      ...(booking.location ? { location: booking.location } : {}),
      ...(geo ? { geo } : {}),
      status: 'confirmed',
      categories: ['Booked'],
      sequence: source.sequence,
    });
  }

  for (const day of itinerary.days) {
    const timeZone = zoneOfDay(day.baseId);
    zones.add(timeZone);
    for (const item of day.items) {
      if (!isCalendarItem(item)) continue;
      const summary = item.kind === 'meal' && item.food?.venueName ? `${item.title} — ${mealLabel(item)}` : item.title;
      const description = [
        item.reason,
        item.hours ? `Open ${formatMinuteOfDay(item.hours.openMinute)}–${formatMinuteOfDay(item.hours.closeMinute)}.` : null,
        item.verifyBeforeTravel ? `Check before travel: ${item.verifyBeforeTravel}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');
      const geo = item.placeId ? source.coordinates[item.placeId] : undefined;
      events.push({
        uid: calendarUidFor(tripId, item, day.dayNumber, itinerary),
        date: day.date,
        startMinute: item.startMinute,
        endMinute: item.endMinute,
        timeZone,
        summary,
        ...(description ? { description } : {}),
        ...(geo ? { geo } : {}),
        status: 'tentative',
        sequence: source.sequence,
      });
    }
  }

  const dates = [itinerary.startDate, itinerary.endDate, ...source.booked.flatMap((b) => [b.date, b.endDate].filter((d): d is string => Boolean(d)))].sort();
  const years = yearsBetween(dates[0]!, dates[dates.length - 1]!);
  return { events, timeZones: [...zones], years };
}

export interface TripCalendarDocumentOptions {
  name: string;
  summary: string;
  attributions: readonly string[];
  /** ISO instant for DTSTAMP. */
  stamp: string;
  /** Present on the feed only. */
  refreshInterval?: string;
}

/** The complete VCALENDAR text for a trip. */
export function buildTripCalendar(source: TripCalendarSource, options: TripCalendarDocumentOptions): string {
  const derived = calendarEventsFor(source);
  return buildCalendar({
    name: options.name,
    description: `${options.summary} ${options.attributions.join(' · ')}. All times are local to the destination.`,
    prodId: '-//Sidequest//Itinerary//EN',
    timeZones: derived.timeZones,
    years: derived.years,
    events: derived.events,
    stamp: options.stamp,
    primaryTimeZone: source.primaryTimeZone,
    ...(options.refreshInterval ? { refreshInterval: options.refreshInterval } : {}),
  });
}

export interface LoadedTripCalendar {
  source: TripCalendarSource;
  attributions: readonly string[];
  /** The zone the trip's wall clock runs on, when a compiled base carries one. */
  timeZone: string | undefined;
}

/**
 * Everything the calendar needs, read from disk.
 *
 * Zones come from the compiled bases when the region resolves, then from each
 * package base's own coordinates (solar time, `deriveTimeZoneFromLongitude`),
 * then UTC — and a zone derived from longitude is recorded as such by the
 * `Etc/GMT±N` name a client sees. Coordinates for `GEO` come from the same two
 * sources. Nothing here asks a provider.
 */
export function loadTripCalendarSource(trip: Trip, itinerary: Itinerary, now: Date): Promise<LoadedTripCalendar> {
  return loadSource(trip, itinerary, now);
}

async function loadSource(trip: Trip, itinerary: Itinerary, now: Date): Promise<LoadedTripCalendar> {
  const zonesByBaseId: Record<string, string> = {};
  const coordinates: Record<string, { lat: number; lng: number }> = {};
  let attributions: readonly string[] = [];
  let timeZone: string | undefined;
  try {
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) {
      for (const base of resolved.context.compiled.bases) {
        if (base.timeZone) zonesByBaseId[base.id] = base.timeZone;
        coordinates[base.id] = { lat: base.coordinates.lat, lng: base.coordinates.lng };
      }
      for (const place of resolved.context.compiled.places) coordinates[place.id] = { lat: place.coordinates.lat, lng: place.coordinates.lng };
      timeZone = resolved.context.compiled.bases.find((base) => base.id === itinerary.baseId)?.timeZone;
      attributions = resolved.context.compiled.sourceManifest.attributions ?? [];
    }
  } catch {
    /* The calendar is still valid without a compiled region; the package's own positions stand. */
  }
  /* The destination's civil zone before solar time: a regionless build has no base zones, and Iceland is not UTC−1. */
  const destinationZone = destinationTimeZone(trip.id);
  if (!timeZone && destinationZone) timeZone = destinationZone;
  for (const base of itinerary.package?.bases ?? []) {
    if (base.coordinates) {
      if (!zonesByBaseId[base.id]) zonesByBaseId[base.id] = destinationZone ?? deriveTimeZoneFromLongitude(base.coordinates.lng);
      if (!coordinates[base.id]) coordinates[base.id] = base.coordinates;
      if (base.placeId && !coordinates[base.placeId]) coordinates[base.placeId] = base.coordinates;
    }
  }
  for (const anchor of itinerary.package?.anchors ?? []) {
    if (anchor.placeId && anchor.identity?.coordinates && !coordinates[anchor.placeId]) coordinates[anchor.placeId] = anchor.identity.coordinates;
  }
  if (attributions.length === 0) attributions = [licence('ODbL-1.0').attribution];
  const primaryTimeZone = timeZone ?? zonesByBaseId[itinerary.baseId] ?? Object.values(zonesByBaseId)[0] ?? 'UTC';

  const loaded = loadTripIntelligence({ trip, itinerary, ...(timeZone ? { timeZone } : {}), persist: false, now });
  return {
    source: {
      tripId: trip.id,
      itinerary: loaded.itinerary,
      booked: loaded.booked,
      zonesByBaseId,
      primaryTimeZone,
      coordinates,
      sequence: currentVersion(trip.id),
    },
    attributions,
    timeZone,
  };
}
