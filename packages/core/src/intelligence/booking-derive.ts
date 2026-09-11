import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';
import { bookingItemSchema, bookingPriorityFor, type BookedPlanItem, type BookingItem, type BookingItemKind } from './booking';
import type { TransportLeg } from './transport';
import { baseDaySpans } from './lodging';
import type { TravelReality } from '../reality/schema';

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
  /** V7 §14 — whether the traveller drives a car they hired; a hired driver or an operator produces no rental row. */
  selfDrives?: boolean;
  /** V7 §14 — booking lead times compiled for the destination, when known. */
  reality?: TravelReality | null;
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
    cruise: ['activity', 'custom', 'lodging'],
    programme: ['activity', 'custom'],
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

/**
 * MVP V3, Stage 48 — the fallback the plan already holds for this thing.
 *
 * Three sources, in order of how specific they are, and nothing else:
 *
 * 1. A package backup whose `dayNumbers` include this booking's day — the
 *    model wrote it for that day and the deterministic matcher agreed.
 * 2. A weather backup on the day that explicitly replaces this stop.
 * 3. Another place in the day's own backups, named plainly.
 *
 * Returns undefined when the plan holds nothing, which is the honest answer
 * far more often than a sentence would be. Nothing here composes a new
 * alternative, and nothing here consults a provider.
 */
function fallbackFor(input: { itinerary: Itinerary; pkg: TripPackage | null | undefined; dayNumber?: number; placeId?: string }): string | undefined {
  const { dayNumber, placeId } = input;
  if (dayNumber === undefined) return undefined;
  const day = input.itinerary.days.find((entry) => entry.dayNumber === dayNumber);

  const replacement = placeId ? day?.weather?.backups.find((backup) => backup.replacesPlaceId === placeId) : undefined;
  if (replacement) return `${replacement.name} stands in for it that day — ${replacement.why}`;

  const authored = input.pkg?.backups.find((backup) => backup.dayNumbers?.includes(dayNumber));
  if (authored) return `${authored.alternative} (the plan's backup for ${authored.trigger.toLowerCase()}).`;

  const anyBackup = day?.weather?.backups[0];
  if (anyBackup) return `${anyBackup.name} is the day's backup — ${anyBackup.why}`;
  return undefined;
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
  const vesselBaseIds = new Set((pkg?.bases ?? []).filter((b) => b.baseKind === 'vessel').map((b) => b.id));
  bases.forEach((base, index) => {
    if (base.nights === 0) return;
    /* V7 §8 — a night on a ship or a sleeper is booked as the episode, never as "a bed in the cruise ship". */
    if (vesselBaseIds.has(base.id)) return;
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

  // V7 §14 — the episodes: a cruise, a trek, a safari programme is one booking the trip stands on -----
  const leadFor = (kind: NonNullable<TravelReality['bookingLeads']>[number]['kind']) => input.reality?.bookingLeads.find((b) => b.kind === kind) ?? null;
  for (const episode of pkg?.episodes ?? []) {
    const firstDay = itinerary.days.find((d) => d.dayNumber === episode.dayNumbers[0]);
    const kind: BookingItemKind = episode.kind === 'cruise' || episode.kind === 'expedition_boat' ? 'cruise' : episode.kind === 'road_trip_segment' || episode.kind === 'resort_stay' ? 'accommodation' : 'programme';
    if (kind === 'accommodation') continue;
    const lead = episode.kind === 'cruise' || episode.kind === 'expedition_boat' ? leadFor('cruise') : episode.kind === 'safari' ? leadFor('safari_lodge') : episode.kind === 'trek' || episode.kind === 'hut_to_hut' ? (leadFor('permit') ?? leadFor('guide')) : null;
    const booked = matchBooked(input.booked, kind, { date: firstDay?.date, title: episode.name });
    const nights = Math.max(0, episode.dayNumbers.length - 1);
    items.push(
      bookingItemSchema.parse({
        id: `booking:episode:${episode.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        title: `${episode.name}${nights > 0 ? ` (${episode.dayNumbers.length} days${episode.kind === 'cruise' || episode.kind === 'expedition_boat' ? `, ${nights} night${nights === 1 ? '' : 's'} on board` : ''})` : ''}`,
        kind,
        necessity: 'required',
        priority: 'book_first',
        reason: `${episode.kind === 'cruise' || episode.kind === 'expedition_boat' ? 'The cabin is the bed, the boat is the transport and the stops are the operator’s' : episode.kind === 'safari' ? 'The camps and the driver-guide are the trip on these days' : 'An operated multi-day experience with fixed departures'}; days ${episode.dayNumbers[0]}–${episode.dayNumbers[episode.dayNumbers.length - 1]} depend on it.${lead ? ` ${lead.note}` : ''}`,
        ...(firstDay ? { dayNumber: firstDay.dayNumber, date: firstDay.date } : {}),
        ...(lead ? { bookingWindow: `Usually needs booking about ${Math.round(lead.leadDays / 30) >= 2 ? `${Math.round(lead.leadDays / 30)} months` : `${lead.leadDays} days`} ahead` } : {}),
        capacityEvidence: 'unknown',
        status: booked ? (booked.status === 'soft_hold' ? 'soft_hold' : 'booked') : 'open',
        ...(booked ? { bookedItemId: booked.id } : {}),
        travelerAction: `Book ${episode.name} with the operator${episode.startGateway ? ` (boarding at ${episode.startGateway})` : ''}`,
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
   * V7 — the draft's own `driving` word decides where it exists.
   */
  const movesByTransfers = /\b(transfer|driver|guide|guided|4x4 (game|safari)|game drive)/i.test(itinerary.package?.transport.summary ?? '');
  const selfDrives = input.selfDrives ?? (itinerary.transportStrategy.primaryMode === 'drive' && profile.transport.willDrive && !movesByTransfers);
  if (selfDrives) {
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

  // Flights, ferries, trains and guided transfers the model routed through -----------------------
  const railLead = leadFor('rail');
  for (const leg of input.legs) {
    /* V7 §14 — a regional train (a base move, or high-speed rail by the draft's own word) is a reservation; a metro hop is not. */
    const regionalRail = leg.mode === 'rail' && (leg.role === 'base_move' || leg.role === 'transfer' || (leg.durationMinutes ?? 0) >= 90 || /high_speed/i.test(String(leg.notes.join(' '))));
    if (leg.mode !== 'flight' && leg.mode !== 'ferry' && leg.mode !== 'boat' && leg.mode !== 'guide_transfer' && leg.mode !== 'lodge_transfer' && !regionalRail) continue;
    if (leg.episode !== undefined && leg.role !== 'base_move' && leg.role !== 'transfer') continue; // movement inside an episode is the operator's, booked with the episode
    const kind: BookingItemKind = leg.mode === 'flight' ? 'flight' : leg.mode === 'ferry' || leg.mode === 'boat' ? 'ferry' : regionalRail ? 'train' : 'internal_transfer';
    const day = leg.dayNumber ? itinerary.days.find((d) => d.dayNumber === leg.dayNumber) : undefined;
    const booked = matchBooked(input.booked, kind, { date: day?.date, title: leg.destinationName });
    items.push(
      bookingItemSchema.parse({
        id: `booking:leg:${leg.id}`,
        title: `${leg.mode === 'flight' ? 'Flight' : leg.mode === 'ferry' ? 'Ferry' : leg.mode === 'boat' ? 'Boat' : kind === 'train' ? 'Train' : 'Transfer'}: ${leg.originName} → ${leg.destinationName}`,
        kind,
        necessity: leg.mode === 'flight' ? 'required' : 'strongly_recommended',
        priority: bookingPriorityFor({ necessity: leg.mode === 'flight' ? 'required' : 'strongly_recommended', hardDependency: true, fixedDateTime: true, limitedCapacity: leg.mode === 'flight' || (kind === 'train' && railLead !== null), fewAlternatives: true, longLeadTime: longLead, weatherSensitive: false, importance: 'core' }),
        reason:
          leg.mode === 'flight'
            ? `The route flies from ${leg.originName} to ${leg.destinationName}; without the seat the next base is out of reach.`
            : leg.mode === 'ferry' || leg.mode === 'boat'
              ? `${leg.originName} to ${leg.destinationName} is by ${leg.mode}; ${leg.durationBasis === 'unmeasured' ? 'the sailing times were not checked, so confirm them' : 'confirm the sailing time'}.`
              : kind === 'train'
                ? `${leg.originName} to ${leg.destinationName} is by train; ${railLead ? railLead.note : 'seats on busy routes sell out, so book once the dates are firm'}.`
                : `${leg.originName} to ${leg.destinationName} is a transfer an operator arranges; ${leg.durationBasis === 'unmeasured' ? 'its timing was not checked, so confirm it with them' : 'confirm the pickup time'}.`,
        ...(kind === 'train' && railLead ? { bookingWindow: `Seats usually open about ${railLead.leadDays} days ahead` } : {}),
        ...(leg.dayNumber ? { dayNumber: leg.dayNumber } : {}),
        ...(day ? { date: day.date } : {}),
        status: booked ? 'booked' : 'open',
        ...(booked ? { bookedItemId: booked.id } : {}),
        travelerAction: `Book the ${leg.mode === 'flight' ? 'flight' : leg.mode === 'ferry' || leg.mode === 'boat' ? 'crossing' : kind === 'train' ? 'train' : 'transfer'} to ${leg.destinationName}`,
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
            ...(() => {
              const fallback = fallbackFor({ itinerary, pkg, dayNumber: day.dayNumber, ...(item.placeId ? { placeId: item.placeId } : {}) });
              return fallback ? { ifUnavailable: fallback } : {};
            })(),
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
            ...(item.food.alternatives?.[0]
              ? { ifUnavailable: `${item.food.alternatives[0].name} is the alternative already on the plan — ${item.food.alternatives[0].tradeoff}` }
              : {}),
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
