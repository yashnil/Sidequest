import { bookingComSearchUrl, type BookingItem, type Itinerary, type TravelIntelligence } from '@sidequest/core';

/**
 * WHAT TO BOOK BEFORE YOU GO, WITH SOMEWHERE TO BOOK IT.
 *
 * The Book view knew *what* needed arranging — a bed in each base, the car, a
 * timed entry — and stopped there, so a traveller left the product to start
 * every search from nothing. This turns each need into a row with links that
 * carry what Sidequest already knows: the place, the dates, the party.
 *
 * Honest about what a link is: a pre-filled *search* on a booking site (we
 * never show a price, an availability or a property we have not seen), or the
 * official page when the plan has one. Pure: the itinerary and intelligence
 * in, rows out, no provider.
 */

export interface BookingLink {
  label: string;
  href: string;
  /** The operator's own page, which outranks any search. */
  official?: boolean;
}

export interface SuggestedBooking {
  id: string;
  kind: 'stay' | 'car' | 'transfer' | 'ticket';
  title: string;
  /** "12–15 Sept · 3 nights · 2 adults" */
  detail: string;
  why?: string;
  status: 'open' | 'booked';
  links: BookingLink[];
  /**
   * A stay row's request for named places to stay (`itinerary/lodging-actions.ts`):
   * the base, and where each day spent from it begins. Present only when the
   * base has a position to search around; pressed by the traveller, never fetched on render.
   */
  lodging?: { baseId: string; dayStarts: { dayNumber: number; name: string; lat: number; lng: number }[] };
}

export interface BookingLinkInput {
  itinerary: Itinerary;
  intel: TravelIntelligence | null;
  adults: number;
  children: number;
  /** Disambiguates a base name for a search engine ("Lake George" → "Lake George, New York"). */
  regionHint?: string;
  /** Stop positions by place id, as the page already resolved them; lets a stay row say where its days start. */
  coordinates?: Record<string, { lat: number; lng: number }>;
}

const OPERATOR_KINDS: ReadonlySet<string> = new Set(['vessel', 'trail_camp', 'camp']);
const TICKET_KINDS: ReadonlySet<BookingItem['kind']> = new Set(['timed_entry', 'park_entry', 'permit', 'tour_guide', 'event', 'cruise', 'programme', 'shuttle', 'ferry', 'train', 'restaurant']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dateRangeLabel(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const am = MONTHS[a.getUTCMonth()]!;
  const bm = MONTHS[b.getUTCMonth()]!;
  return am === bm ? `${a.getUTCDate()}–${b.getUTCDate()} ${am}` : `${a.getUTCDate()} ${am} – ${b.getUTCDate()} ${bm}`;
}

function partyLabel(adults: number, children: number): string {
  const parts = [`${adults} ${adults === 1 ? 'adult' : 'adults'}`];
  if (children > 0) parts.push(`${children} ${children === 1 ? 'child' : 'children'}`);
  return parts.join(', ');
}

function searchPlace(name: string, hint: string | undefined): string {
  if (!hint) return name;
  const tail = hint.split(',').map((part) => part.trim()).filter(Boolean);
  const extra = tail.filter((part) => !name.toLowerCase().includes(part.toLowerCase())).slice(-2);
  return extra.length > 0 ? `${name}, ${extra.join(', ')}` : name;
}

export function stayLinks(place: string, checkIn: string, checkOut: string, adults: number, children: number): BookingLink[] {
  const q = encodeURIComponent(place);
  return [
    { label: 'Booking.com', href: bookingComSearchUrl({ query: place, checkIn, checkOut, adults, children }) },
    { label: 'Airbnb', href: `https://www.airbnb.com/s/${q}/homes?checkin=${checkIn}&checkout=${checkOut}&adults=${adults}${children > 0 ? `&children=${children}` : ''}` },
    /* Google Travel has no documented date parameters; it reads them from the query itself. */
    { label: 'Google Hotels', href: `https://www.google.com/travel/search?q=${encodeURIComponent(`hotels in ${place} ${shortDate(checkIn)} to ${shortDate(checkOut)}`)}` },
  ];
}

export function carLinks(place: string, from: string, to: string): BookingLink[] {
  const us = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  return [
    { label: 'Kayak', href: `https://www.kayak.com/cars/${encodeURIComponent(place)}/${from}/${to}` },
    { label: 'Expedia', href: `https://www.expedia.com/carsearch?locn=${encodeURIComponent(place)}&date1=${encodeURIComponent(us(from))}&date2=${encodeURIComponent(us(to))}` },
  ];
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string): string {
  return `${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))} ${iso.slice(0, 4)}`;
}

function ticketLinks(item: BookingItem, place: string): BookingLink[] {
  const links: BookingLink[] = [];
  if (item.officialSourceUrl && /^https:\/\//i.test(item.officialSourceUrl)) links.push({ label: item.officialSourceName ? `${item.officialSourceName}` : 'Official site', href: item.officialSourceUrl, official: true });
  links.push({ label: links.length > 0 ? 'Search tickets' : 'Find tickets', href: `https://www.google.com/search?q=${encodeURIComponent(`${place} tickets booking`)}` });
  return links;
}

/** The first stop with a position on each day spent from this base: where a walking day starts. */
function dayStartsFor(itinerary: Itinerary, baseId: string, coordinates: Record<string, { lat: number; lng: number }>): { dayNumber: number; name: string; lat: number; lng: number }[] {
  const out: { dayNumber: number; name: string; lat: number; lng: number }[] = [];
  for (const day of itinerary.days) {
    if (day.baseId !== baseId) continue;
    const first = day.items.find((item) => item.kind === 'activity' && item.placeId && coordinates[item.placeId]);
    if (!first?.placeId) continue;
    const point = coordinates[first.placeId]!;
    out.push({ dayNumber: day.dayNumber, name: first.title.slice(0, 160), lat: point.lat, lng: point.lng });
  }
  return out.slice(0, 30);
}

export function suggestedBookings(input: BookingLinkInput): SuggestedBooking[] {
  const { itinerary, intel, adults, children, regionHint, coordinates } = input;
  const items = intel?.bookings.items ?? [];
  const party = partyLabel(adults, children);
  const out: SuggestedBooking[] = [];

  // --- somewhere to sleep, one row per stay, in order ---------------------------
  let cursor = itinerary.startDate;
  for (const base of itinerary.package?.bases ?? []) {
    const nights = base.nights;
    const checkIn = cursor;
    cursor = addDays(cursor, nights);
    if (nights <= 0 || (base.baseKind && OPERATOR_KINDS.has(base.baseKind))) continue;
    const need = items.find((b) => b.kind === 'accommodation' && b.baseId === base.id);
    if (need?.status === 'not_needed') continue;
    const name = base.displayName ?? base.name;
    const place = searchPlace(base.locality && !name.includes(base.locality) ? `${name}, ${base.locality}` : name, regionHint);
    out.push({
      id: `stay:${base.id}`,
      kind: 'stay',
      title: `Stay in ${name}`,
      detail: `${dateRangeLabel(checkIn, cursor)} · ${nights} ${nights === 1 ? 'night' : 'nights'} · ${party}`,
      ...(base.area ? { why: `Stay around ${base.area}.` } : {}),
      status: need && (need.status === 'booked' || need.status === 'soft_hold') ? 'booked' : 'open',
      links: stayLinks(place, checkIn, cursor, adults, children),
      ...(base.coordinates ? { lodging: { baseId: base.id, dayStarts: dayStartsFor(itinerary, base.id, coordinates ?? {}) } } : {}),
    });
  }

  // --- the car, when the trip is planned around one ------------------------------
  const carNeed = items.find((b) => b.kind === 'rental_vehicle');
  const drives = itinerary.transportStrategy.primaryMode === 'drive';
  if ((carNeed && carNeed.status !== 'not_needed') || (drives && !carNeed)) {
    const first = itinerary.package?.bases[0];
    /*
     * Where a traveller actually collects a car is where they arrive: the
     * arrival gateway when the plan settled one, else the first base.
     */
    const arrival = itinerary.package?.gateway?.arrival;
    const gateway = arrival && !arrival.unresolved ? arrival.name : null;
    const pickupName = gateway ?? (first ? first.displayName ?? first.name : null);
    const pickup = searchPlace(pickupName ?? regionHint ?? 'the airport', regionHint);
    out.push({
      id: 'car',
      kind: 'car',
      title: 'A rental car for the trip',
      detail: `${dateRangeLabel(itinerary.startDate, itinerary.endDate)} · pick up ${gateway ? `at ${gateway}` : pickupName ? `near ${pickupName}` : 'where you arrive'}`,
      why: carNeed?.reason ?? 'The days are planned by car; most stops are not reachable otherwise.',
      status: carNeed && (carNeed.status === 'booked' || carNeed.status === 'soft_hold') ? 'booked' : 'open',
      links: carLinks(pickup, itinerary.startDate, itinerary.endDate),
    });
  }

  // --- moving between stays without a car -----------------------------------------
  if (!drives) {
    const bases = (itinerary.package?.bases ?? []).filter((b) => b.nights > 0);
    for (let i = 1; i < bases.length; i++) {
      const from = bases[i - 1]!.displayName ?? bases[i - 1]!.name;
      const to = bases[i]!.displayName ?? bases[i]!.name;
      if (from === to) continue;
      out.push({
        id: `transfer:${bases[i]!.id}`,
        kind: 'transfer',
        title: `${from} to ${to}`,
        detail: 'Trains, buses and ferries between your stays',
        status: 'open',
        links: [{ label: 'Rome2Rio', href: `https://www.rome2rio.com/map/${encodeURIComponent(searchPlace(from, regionHint))}/${encodeURIComponent(searchPlace(to, regionHint))}` }],
      });
    }
  }

  // --- tickets, entries, permits and tours the plan says to arrange ---------------
  for (const item of items) {
    if (!TICKET_KINDS.has(item.kind) || item.status === 'not_needed' || item.memberIds) continue;
    if (item.priority === 'keep_flexible') continue;
    const place = searchPlace(item.title.replace(/^(timed entry|book|reserve|tickets?)\s*(for|:)?\s*/i, ''), regionHint);
    out.push({
      id: `ticket:${item.id}`,
      kind: 'ticket',
      title: item.title,
      detail: [item.dayNumber ? `Day ${item.dayNumber}` : null, item.bookingWindow ?? null].filter(Boolean).join(' · ') || 'Before you go',
      why: item.reason,
      status: item.status === 'booked' || item.status === 'soft_hold' ? 'booked' : 'open',
      links: ticketLinks(item, place),
    });
  }
  return out;
}
