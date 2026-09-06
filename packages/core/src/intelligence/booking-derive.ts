import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';
import { bookingItemSchema, bookingPriorityFor, type BookedPlanItem, type BookingItem, type BookingItemKind } from './booking';
import type { TransportLeg } from './transport';
import { baseDaySpans } from './lodging';

/**
 * WHAT THIS TRIP DEPENDS ON SOMEBODY ARRANGING.
 *
 * Read off the plan's own facts: a booking the evidence attached to a stop, a
 * restaurant that takes reservations, a night in each base, the car the route
 * needs, the flight or ferry the model routed through, the guided day. Each
 * item's priority comes from `bookingPriorityFor`, which never invents
 * scarcity.
 */
export interface DeriveBookingsInput {
  itinerary: Itinerary;
  pkg: TripPackage | undefined;
  profile: TravelerProfile;
  legs: readonly TransportLeg[];
  booked: readonly BookedPlanItem[];
  daysUntilTrip: number;
  remoteBaseIds: ReadonlySet<string>;
}

function matchBooked(booked: readonly BookedPlanItem[], kind: BookingItemKind, opts: { date?: string; baseId?: string; placeId?: string; title?: string }): BookedPlanItem | undefined {
  const typeFor: Record<BookingItemKind, BookedPlanItem['type'][]> = {
    accommodation: ['lodging'],
    flight: ['flight'],
    train: ['train'],
    ferry: ['ferry'],
    park_entry: ['activity'],
    timed_entry: ['activity'],
    permit: ['activity', 'custom'],
    tour_guide: ['activity', 'transfer'],
    restaurant: ['restaurant'],
    event: ['event', 'activity'],
    rental_vehicle: ['rental_car'],
    shuttle: ['transfer'],
    internal_transfer: ['transfer'],
  };
  const key = opts.title?.toLowerCase();
  return booked.find(
    (b) =>
      typeFor[kind].includes(b.type) &&
      b.status !== 'idea' &&
      ((opts.baseId && b.baseId === opts.baseId) ||
        (opts.placeId && b.placeId === opts.placeId) ||
        (opts.date && b.date === opts.date && (kind !== 'accommodation' || !b.baseId)) ||
        (key && b.title.toLowerCase().includes(key.slice(0, 16)))),
  );
}

export function deriveBookings(input: DeriveBookingsInput): BookingItem[] {
  const { itinerary, pkg, profile } = input;
  const items: BookingItem[] = [];
  const longLead = input.daysUntilTrip > 45;

  // Every base needs a bed ------------------------------------------------------
  const spans = baseDaySpans(itinerary, pkg);
  const bases = spans.map((span) => {
    const pkgBase = pkg?.bases.find((b) => b.id === span.baseId);
    return { id: span.baseId, name: span.name, nights: pkgBase?.nights ?? Math.max(0, span.dayNumbers.length - 1), firstDayNumber: span.dayNumbers[0] };
  });
  bases.forEach((base, index) => {
    if (base.nights === 0) return;
    const firstDay = itinerary.days.find((d) => d.dayNumber === base.firstDayNumber);
    const booked = matchBooked(input.booked, 'accommodation', { baseId: base.id, date: firstDay?.date, title: base.name });
    const remote = input.remoteBaseIds.has(base.id);
    const priority = bookingPriorityFor({ necessity: 'required', hardDependency: true, fixedDateTime: true, limitedCapacity: remote, fewAlternatives: remote, longLeadTime: false, weatherSensitive: false, importance: 'core' });
    items.push(
      bookingItemSchema.parse({
        id: `booking:lodging:${base.id}`,
        title: `${base.nights} night${base.nights === 1 ? '' : 's'} in ${base.name}`,
        kind: 'accommodation',
        necessity: 'required',
        // A remote bed is scarce and stands on its own; every other base is a member of the one "stays" dependency below.
        priority: remote ? 'book_first' : priority === 'book_first' ? 'book_soon' : priority,
        group: 'stays',
        reason: remote ? 'A remote base with few beds; the route depends on sleeping here.' : index === 0 ? 'The first night anchors the arrival day.' : `The route sleeps here for ${base.nights} night${base.nights === 1 ? '' : 's'}.`,
        ...(firstDay ? { dayNumber: firstDay.dayNumber, date: firstDay.date } : {}),
        baseId: base.id,
        capacityEvidence: 'unknown',
        status: booked ? (booked.status === 'soft_hold' ? 'soft_hold' : 'booked') : 'open',
        ...(booked ? { bookedItemId: booked.id } : {}),
        travelerAction: `Book somewhere to sleep in ${base.name}`,
        authority: 'model_proposal',
      }),
    );
  });

  // The stays, as one dependency ------------------------------------------------------
  const stayItems = items.filter((i) => i.kind === 'accommodation');
  if (stayItems.length > 0) {
    const nights = bases.reduce((n, b) => n + b.nights, 0);
    const bookedStays = stayItems.filter((i) => i.status === 'booked').length;
    const heldStays = stayItems.filter((i) => i.status === 'soft_hold').length;
    items.unshift(
      bookingItemSchema.parse({
        id: 'booking:stays',
        title: `Stays: ${bases.filter((b) => b.nights > 0).length} base${bases.filter((b) => b.nights > 0).length === 1 ? '' : 's'}, ${nights} night${nights === 1 ? '' : 's'}`,
        kind: 'accommodation',
        necessity: 'required',
        priority: 'book_first',
        group: 'stays',
        memberIds: stayItems.map((i) => i.id),
        reason: bookedStays === stayItems.length ? 'Every base has a bed.' : `${stayItems.length - bookedStays} of ${stayItems.length} bases still need a bed; the route depends on all of them.`,
        dayNumber: 1,
        date: itinerary.startDate,
        capacityEvidence: 'unknown',
        status: bookedStays === stayItems.length ? 'booked' : bookedStays + heldStays > 0 ? 'soft_hold' : 'open',
        travelerAction: 'Book a bed at each base, first night first',
        authority: 'model_proposal',
      }),
    );
  }

  // The car the route needs -----------------------------------------------------------
  /*
   * QUALITY V1 — only when the plan is actually self-driven. A safari circuit
   * moved by private transfers and 4x4 game drives still carries `drive` as
   * the profile's primary mode, and the live East Africa build recommended
   * "Rental car for the whole trip — 0 km of the plan is driven". The model's
   * own transport summary says how the route moves; when it moves by
   * transfers, drivers or guides, the transfer legs below are the bookings.
   */
  const movesByTransfers = /\b(transfer|driver|guide|guided|4x4 (game|safari)|game drive)/i.test(itinerary.package?.transport.summary ?? '');
  if (itinerary.transportStrategy.primaryMode === 'drive' && profile.transport.willDrive && !movesByTransfers) {
    const booked = matchBooked(input.booked, 'rental_vehicle', { date: itinerary.startDate, title: 'car' });
    items.push(
      bookingItemSchema.parse({
        id: 'booking:rental',
        title: 'Rental car for the whole trip',
        kind: 'rental_vehicle',
        necessity: 'required',
        priority: bookingPriorityFor({ necessity: 'required', hardDependency: true, fixedDateTime: true, limitedCapacity: false, fewAlternatives: true, longLeadTime: longLead, weatherSensitive: false, importance: 'core' }),
        reason: itinerary.transportStrategy.totals.driveKm > 0 ? `${Math.round(itinerary.transportStrategy.totals.driveKm)} km of the plan is driven; nothing else reaches the far stops.` : 'The ordinary days rely on a car; nothing else reaches the far stops.',
        date: itinerary.startDate,
        status: booked ? 'booked' : 'open',
        ...(booked ? { bookedItemId: booked.id } : {}),
        travelerAction: 'Book the car, with the insurance excess you are comfortable with',
        authority: 'model_proposal',
      }),
    );
  }

  // Flights, ferries and guided transfers the model routed through -----------------------
  for (const leg of input.legs) {
    if (leg.mode !== 'flight' && leg.mode !== 'ferry' && leg.mode !== 'boat' && leg.mode !== 'guide_transfer' && leg.mode !== 'lodge_transfer') continue;
    const kind: BookingItemKind = leg.mode === 'flight' ? 'flight' : leg.mode === 'ferry' || leg.mode === 'boat' ? 'ferry' : 'internal_transfer';
    const day = leg.dayNumber ? itinerary.days.find((d) => d.dayNumber === leg.dayNumber) : undefined;
    const booked = matchBooked(input.booked, kind, { date: day?.date, title: leg.destinationName });
    items.push(
      bookingItemSchema.parse({
        id: `booking:leg:${leg.id}`,
        title: `${leg.mode === 'flight' ? 'Flight' : leg.mode === 'ferry' ? 'Ferry' : leg.mode === 'boat' ? 'Boat' : 'Transfer'}: ${leg.originName} → ${leg.destinationName}`,
        kind,
        necessity: leg.mode === 'flight' ? 'required' : 'strongly_recommended',
        priority: bookingPriorityFor({ necessity: leg.mode === 'flight' ? 'required' : 'strongly_recommended', hardDependency: true, fixedDateTime: true, limitedCapacity: leg.mode === 'flight', fewAlternatives: true, longLeadTime: longLead, weatherSensitive: false, importance: 'core' }),
        reason: leg.mode === 'flight' ? 'The route moves by air here; without the seat the next base is out of reach.' : `The route crosses water or hands over to an operator here; ${leg.durationBasis === 'unmeasured' ? 'the timetable was not checked, so confirm it' : 'confirm the sailing'}.`,
        ...(leg.dayNumber ? { dayNumber: leg.dayNumber } : {}),
        ...(day ? { date: day.date } : {}),
        status: booked ? 'booked' : 'open',
        ...(booked ? { bookedItemId: booked.id } : {}),
        travelerAction: `Book the ${leg.mode === 'flight' ? 'flight' : leg.mode === 'ferry' || leg.mode === 'boat' ? 'crossing' : 'transfer'} to ${leg.destinationName}`,
        authority: leg.durationBasis === 'scheduled_transit' ? 'official_current' : 'model_proposal',
      }),
    );
  }

  // Stops the evidence says need a ticket, permit or reservation ------------------------------
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.booking) {
        const kind: BookingItemKind = item.booking.kind === 'permit' ? 'permit' : item.booking.kind === 'timed_entry' ? 'timed_entry' : 'park_entry';
        const booked = matchBooked(input.booked, kind, { placeId: item.placeId, date: day.date, title: item.title });
        items.push(
          bookingItemSchema.parse({
            id: `booking:item:${item.id}`,
            title: `${item.title} — ${item.booking.kind === 'permit' ? 'permit' : item.booking.kind === 'timed_entry' ? 'timed entry' : 'booking'}`,
            kind,
            necessity: 'required',
            priority: bookingPriorityFor({ necessity: 'required', hardDependency: false, fixedDateTime: item.booking.kind === 'timed_entry', limitedCapacity: item.booking.kind !== 'reservation', fewAlternatives: false, longLeadTime: item.booking.kind === 'permit', weatherSensitive: Boolean(item.weatherSensitive), importance: 'core' }),
            reason: item.booking.note ?? 'The evidence Sidequest holds says entry is controlled.',
            dayNumber: day.dayNumber,
            date: day.date,
            timeLabel: `${String(Math.floor(item.startMinute / 60)).padStart(2, '0')}:${String(item.startMinute % 60).padStart(2, '0')}`,
            ...(item.placeId ? { placeId: item.placeId } : {}),
            ...(item.booking.url ? { officialSourceUrl: item.booking.url, officialSourceName: 'Official booking page' } : {}),
            capacityEvidence: item.booking.kind === 'reservation' ? 'unknown' : 'limited',
            status: booked ? 'booked' : 'open',
            ...(booked ? { bookedItemId: booked.id } : {}),
            travelerAction: `Arrange ${item.booking.kind === 'permit' ? 'the permit' : 'entry'} for ${item.title}`,
            authority: item.booking.url ? 'official_current' : 'authoritative_structured',
          }),
        );
      }
      if (item.food?.reservation && (item.food.reservation.requirement === 'required' || item.food.reservation.requirement === 'recommended') && item.food.venueName) {
        const booked = matchBooked(input.booked, 'restaurant', { date: day.date, title: item.food.venueName });
        const required = item.food.reservation.requirement === 'required';
        items.push(
          bookingItemSchema.parse({
            id: `booking:food:${item.id}`,
            title: `Table at ${item.food.venueName}`,
            kind: 'restaurant',
            necessity: required ? 'required' : 'strongly_recommended',
            priority: bookingPriorityFor({ necessity: required ? 'required' : 'strongly_recommended', hardDependency: false, fixedDateTime: true, limitedCapacity: required, fewAlternatives: false, longLeadTime: false, weatherSensitive: false, importance: item.food.isSpecialMeal ? 'core' : 'secondary' }),
            reason: item.food.isSpecialMeal ? 'Your one special meal; it takes bookings.' : 'It takes bookings and the plan puts you there at a busy hour.',
            dayNumber: day.dayNumber,
            date: day.date,
            timeLabel: `${String(Math.floor(item.startMinute / 60)).padStart(2, '0')}:${String(item.startMinute % 60).padStart(2, '0')}`,
            status: booked ? 'booked' : 'open',
            ...(booked ? { bookedItemId: booked.id } : {}),
            travelerAction: `Book a table at ${item.food.venueName}`,
            authority: 'authoritative_structured',
          }),
        );
      }
    }
  }

  // Guided days ----------------------------------------------------------------------------
  for (const anchor of pkg?.anchors ?? []) {
    if (anchor.category !== 'activity' && anchor.category !== 'wildlife') continue;
    if (anchor.disposition.startsWith('rejected') || anchor.disposition === 'unscheduled_capacity') continue;
    if (!/guide|tour|safari|cruise|boat|kayak|snorkel|dive|rafting|expedition|game drive/i.test(anchor.name)) continue;
    if (items.some((i) => i.placeId && i.placeId === anchor.placeId)) continue;
    const day = itinerary.days.find((d) => d.dayNumber === (anchor.scheduledDayNumber ?? anchor.dayNumber));
    const booked = matchBooked(input.booked, 'tour_guide', { placeId: anchor.placeId, date: day?.date, title: anchor.name });
    items.push(
      bookingItemSchema.parse({
        id: `booking:guided:${anchor.id}`,
        title: anchor.name,
        kind: 'tour_guide',
        necessity: 'strongly_recommended',
        priority: bookingPriorityFor({ necessity: 'strongly_recommended', hardDependency: false, fixedDateTime: true, limitedCapacity: false, fewAlternatives: true, longLeadTime: longLead, weatherSensitive: true, importance: anchor.role }),
        reason: 'A guided or operated activity; operators run on their own calendars.',
        ...(day ? { dayNumber: day.dayNumber, date: day.date } : {}),
        ...(anchor.placeId ? { placeId: anchor.placeId } : {}),
        status: booked ? 'booked' : 'open',
        ...(booked ? { bookedItemId: booked.id } : {}),
        travelerAction: `Book ${anchor.name} with an operator`,
        authority: 'model_proposal',
      }),
    );
  }

  const order = { book_first: 0, book_soon: 1, can_wait: 2, keep_flexible: 3 } as const;
  return items.sort((a, b) => order[a.priority] - order[b.priority] || (a.dayNumber ?? 0) - (b.dayNumber ?? 0));
}
