import { TERMINAL_BUFFERS, bookedItemBinds, minuteOf, type BookedPlanItem, type Itinerary, type ItineraryDay, type ItineraryItem } from '@sidequest/core';

/**
 * BOOKED REALITY, APPLIED DETERMINISTICALLY.
 *
 * A booked fact is stronger than a model preference. This never regenerates
 * the trip and never calls a model; it makes the smallest edits that make the
 * plan consistent with what the traveller has actually arranged:
 *
 *   lodging   the base for those nights is named after the booking and locked
 *   timed     a ticket, table or event is inserted as a locked stop at its
 *             time; overlapping model content is shifted later inside the day
 *             window, and whatever no longer fits is reported as a conflict —
 *             never dropped silently
 *   departure a booked flight, train or ferry on the last day tightens the
 *             leave-by boundary; stops after it are conflicts
 *
 * Everything it changes is recorded as a revision on the itinerary.
 */
export interface BookedReconciliation {
  itinerary: Itinerary;
  honored: string[];
  conflicts: string[];
}

const BOOKED_ITEM_PREFIX = 'booked:';

export function isBookedItemId(id: string): boolean {
  return id.startsWith(BOOKED_ITEM_PREFIX);
}

function withoutPriorBookedItems(itinerary: Itinerary): Itinerary {
  return {
    ...itinerary,
    days: itinerary.days.map((day) => ({ ...day, items: day.items.filter((item) => !isBookedItemId(item.id)), warnings: day.warnings.filter((w) => !w.startsWith('Booked:')) })),
  };
}

function recomputeTotals(day: ItineraryDay): ItineraryDay {
  const activityMinutes = day.items.filter((i) => i.kind === 'activity').reduce((n, i) => n + i.durationMinutes, 0);
  const freeMinutes = day.items.filter((i) => i.kind === 'free_time').reduce((n, i) => n + i.durationMinutes, 0);
  return { ...day, totals: { ...day.totals, activityMinutes, freeMinutes } };
}

function shiftAround(day: ItineraryDay, locked: ItineraryItem): { day: ItineraryDay; displaced: ItineraryItem[] } {
  const displaced: ItineraryItem[] = [];
  const others = day.items.filter((i) => i.id !== locked.id && i.kind !== 'free_time');
  const before = others.filter((i) => i.endMinute <= locked.startMinute);
  const overlapping = others.filter((i) => !(i.endMinute <= locked.startMinute || i.startMinute >= locked.endMinute));
  const after = others.filter((i) => i.startMinute >= locked.endMinute);
  const kept: ItineraryItem[] = [...before, locked];
  let cursor = locked.endMinute;
  for (const item of [...overlapping, ...after].sort((a, b) => a.startMinute - b.startMinute)) {
    const start = Math.max(cursor, item.startMinute >= locked.endMinute ? item.startMinute : cursor);
    const end = start + item.durationMinutes;
    if (end > day.window.endMinute) {
      displaced.push(item);
      continue;
    }
    kept.push({ ...item, startMinute: start, endMinute: end });
    cursor = end;
  }
  const free = day.items.filter((i) => i.kind === 'free_time');
  return { day: recomputeTotals({ ...day, items: [...kept, ...free].sort((a, b) => a.startMinute - b.startMinute) }), displaced };
}

export function applyBookedFacts(source: Itinerary, booked: readonly BookedPlanItem[]): BookedReconciliation {
  const honored: string[] = [];
  const conflicts: string[] = [];
  const revisions: Itinerary['diagnostics']['revisions'] = [];
  let itinerary = withoutPriorBookedItems(source);
  const binding = booked.filter(bookedItemBinds);

  // Lodging locks the base --------------------------------------------------------
  for (const item of binding.filter((b) => b.type === 'lodging' && b.date)) {
    const checkIn = item.date!;
    const checkOut = item.endDate ?? checkIn;
    const lastDate = itinerary.days[itinerary.days.length - 1]!.date;
    // The check-out morning still belongs to this bed when it is the last day of the trip.
    const nights = itinerary.days.filter((d) => d.date >= checkIn && (d.date < checkOut || (d.date === checkOut && d.date === lastDate)));
    const affected = nights.length > 0 ? nights : itinerary.days.filter((d) => d.date === checkIn);
    if (affected.length === 0) {
      conflicts.push(`Booked: ${item.title} (${checkIn}) falls outside the trip dates, so no day was changed.`);
      continue;
    }
    const baseName = item.location?.trim() || item.title;
    const changed = affected.filter((d) => d.baseName !== baseName);
    itinerary = {
      ...itinerary,
      days: itinerary.days.map((d) => (affected.some((a) => a.dayNumber === d.dayNumber) ? { ...d, baseName, ...(item.baseId ? { baseId: item.baseId } : {}) } : d)),
    };
    honored.push(`${item.title}: base for ${affected.length === 1 ? `day ${affected[0]!.dayNumber}` : `days ${affected[0]!.dayNumber}–${affected[affected.length - 1]!.dayNumber}`} is locked to your booking.`);
    if (changed.length > 0) revisions.push({ code: 'base_locked_to_booking', description: `Base on ${changed.length === 1 ? 'one day' : `${changed.length} days`} renamed to your booked lodging (${baseName}).` });
  }

  // Timed things become locked stops ----------------------------------------------------
  for (const item of binding.filter((b) => (b.type === 'activity' || b.type === 'restaurant' || b.type === 'event' || b.type === 'custom') && b.date && b.startTime)) {
    const day = itinerary.days.find((d) => d.date === item.date);
    if (!day) {
      conflicts.push(`Booked: ${item.title} (${item.date}) is outside the trip dates.`);
      continue;
    }
    const start = minuteOf(item.startTime!);
    const end = item.endTime ? minuteOf(item.endTime) : Math.min(1440, start + (item.type === 'restaurant' ? 90 : 120));
    const locked: ItineraryItem = {
      id: `${BOOKED_ITEM_PREFIX}${item.id}`,
      kind: item.type === 'restaurant' ? 'meal' : 'activity',
      title: item.title,
      startMinute: start,
      endMinute: end,
      durationMinutes: end - start,
      reason: 'Booked by you. Sidequest schedules around it and never moves it.',
      weatherSensitive: false,
      ...(item.notes ? { note: item.notes } : {}),
      ...(item.placeId ? { placeId: item.placeId } : {}),
    };
    if (start < day.window.startMinute || end > day.window.endMinute) {
      conflicts.push(`Booked: ${item.title} at ${item.startTime} on day ${day.dayNumber} is outside the hours you are there (${clock(day.window.startMinute)}–${clock(day.window.endMinute)}). It is kept on the plan; check the time.`);
    }
    const { day: next, displaced } = shiftAround(day, locked);
    for (const d of displaced) conflicts.push(`Booked: ${item.title} on day ${day.dayNumber} leaves no room for "${d.title}"; it was not dropped silently — move it or drop it yourself.`);
    const withWarnings = { ...next, warnings: [...next.warnings, ...displaced.map((d) => `Booked: ${d.title} no longer fits around ${item.title}.`)] };
    itinerary = { ...itinerary, days: itinerary.days.map((d) => (d.dayNumber === day.dayNumber ? withWarnings : d)) };
    honored.push(`${item.title} on day ${day.dayNumber} at ${item.startTime} is fixed.`);
    revisions.push({ code: 'booked_stop_inserted', description: `${item.title} placed at ${item.startTime} on day ${day.dayNumber}${displaced.length > 0 ? `; ${displaced.length} model stop${displaced.length === 1 ? '' : 's'} no longer fit` : ''}.` });
  }

  // A booked departure tightens the last day ---------------------------------------------
  const last = itinerary.days[itinerary.days.length - 1]!;
  const departures = binding.filter((b) => (b.type === 'flight' || b.type === 'train' || b.type === 'ferry') && b.date === last.date && b.startTime);
  if (departures.length > 0) {
    const earliest = departures.reduce((min, b) => Math.min(min, minuteOf(b.startTime!)), 1440);
    const kind = departures.find((b) => minuteOf(b.startTime!) === earliest)!.type;
    const buffer = kind === 'flight' ? TERMINAL_BUFFERS.checkInUnknown : TERMINAL_BUFFERS.stationBuffer;
    const leaveBy = Math.max(0, earliest - buffer - TERMINAL_BUFFERS.transferEstimate);
    /*
     * What runs past the leave-by time: a meal or a slot of free time simply
     * cannot happen after you have left, so it goes (with a revision); an
     * activity is the traveller's plan and is kept, named as a conflict, for
     * them to move or drop. A zero-length travel stub is noise.
     */
    const late = last.items.filter((i) => i.kind === 'activity' && i.endMinute > leaveBy && !isBookedItemId(i.id));
    const removed = last.items.filter((i) => (i.kind === 'meal' || (i.kind === 'travel' && i.durationMinutes === 0) || i.kind === 'rest') && i.endMinute > leaveBy && i.startMinute >= leaveBy);
    for (const i of late) conflicts.push(`Booked: your ${kind} at ${clock(earliest)} means leaving base by ${clock(leaveBy)}; "${i.title}" on day ${last.dayNumber} runs past that.`);
    const trimmed = last.items
      .filter((i) => !removed.includes(i))
      .map((i) => (i.kind === 'free_time' && i.endMinute > leaveBy ? { ...i, endMinute: Math.max(i.startMinute, leaveBy), durationMinutes: Math.max(0, leaveBy - i.startMinute) } : i))
      .filter((i) => !(i.kind === 'free_time' && i.durationMinutes === 0));
    const tightened: ItineraryDay = recomputeTotals({
      ...last,
      items: trimmed,
      window: { ...last.window, endMinute: Math.min(last.window.endMinute, leaveBy), usableMinutes: Math.max(0, Math.min(last.window.endMinute, leaveBy) - last.window.startMinute), note: `Leave base by ${clock(leaveBy)} for your booked ${kind}.` },
      warnings: [...last.warnings, ...late.map((i) => `Booked: ${i.title} runs past the ${clock(leaveBy)} leave-by time.`)],
    });
    if (removed.some((i) => i.kind === 'meal')) revisions.push({ code: 'departure_window_tightened', description: `${removed.filter((i) => i.kind === 'meal').map((i) => i.title).join(', ')} removed: you will have left for the ${kind}.` });
    itinerary = { ...itinerary, days: itinerary.days.map((d) => (d.dayNumber === last.dayNumber ? tightened : d)) };
    honored.push(`Departure ${kind} at ${clock(earliest)} sets the last day’s leave-by time to ${clock(leaveBy)}.`);
    revisions.push({ code: 'departure_window_tightened', description: `Last day ends by ${clock(leaveBy)} for the booked ${kind}.` });
  }

  // Arrival on day one -----------------------------------------------------------------
  const first = itinerary.days[0]!;
  const arrivals = binding.filter((b) => (b.type === 'flight' || b.type === 'train' || b.type === 'ferry') && b.date === first.date && (b.endTime ?? b.startTime) && b.date !== last.date);
  if (arrivals.length > 0) {
    const latest = arrivals.reduce((max, b) => Math.max(max, minuteOf(b.endTime ?? b.startTime!)), 0);
    const availableFrom = Math.min(1440, latest + TERMINAL_BUFFERS.immigrationUnknown + TERMINAL_BUFFERS.transferEstimate);
    const early = first.items.filter((i) => i.kind !== 'free_time' && i.kind !== 'rest' && i.startMinute < availableFrom && !isBookedItemId(i.id));
    for (const i of early) conflicts.push(`Booked: you land at ${clock(latest)}, so "${i.title}" on day ${first.dayNumber} starts before you can be at base (${clock(availableFrom)}).`);
    if (availableFrom > first.window.startMinute) {
      const widened: ItineraryDay = { ...first, window: { ...first.window, startMinute: availableFrom, usableMinutes: Math.max(0, first.window.endMinute - availableFrom), note: `Usable from ${clock(availableFrom)} after your booked arrival.` } };
      itinerary = { ...itinerary, days: itinerary.days.map((d) => (d.dayNumber === first.dayNumber ? widened : d)) };
      revisions.push({ code: 'arrival_window_tightened', description: `First day starts at ${clock(availableFrom)} after the booked arrival.` });
    }
    honored.push(`Arrival at ${clock(latest)} sets when day one can start.`);
  }

  if (revisions.length > 0) {
    itinerary = { ...itinerary, diagnostics: { ...itinerary.diagnostics, revisions: [...itinerary.diagnostics.revisions.filter((r) => !String(r.code).startsWith('booked') && !String(r.code).includes('_locked_to_booking') && !String(r.code).includes('window_tightened')), ...revisions] } };
  }
  return { itinerary, honored, conflicts };
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
