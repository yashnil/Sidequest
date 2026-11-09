/**
 * ONE SELECTION FOR THE WHOLE TRIP PAGE — the pure half.
 *
 * The day being read and the stop that was pressed used to live in three
 * places: the Days view's provider, the Map view's own state and the phone
 * sheet. So a stop chosen in the list was unknown to the Map tab, and a day
 * chosen on the map was forgotten by the list. This module is the one record
 * both read, and the rules that keep it honest when the plan changes under it:
 *
 * - a stop that an edit removed is no longer selected (never a dangling id);
 * - a stop that an edit moved to another day takes the selection with it;
 * - a day that no longer exists falls back to the nearest one that does;
 * - a stop with no coordinates can still be selected — the list marks it and
 *   the map says it has no position, which is absence, never an error.
 *
 * No React and no DOM, so every rule is a unit test.
 */
export interface SelectionStop {
  /** The place id the timeline row and the map pin share. */
  id: string;
  name: string;
  /** The number on the row and on the pin; absent for a stop with no position. */
  number?: number;
  placed: boolean;
}

export interface SelectionDay {
  dayNumber: number;
  stops: readonly SelectionStop[];
}

export interface TripSelection {
  /** The day in focus: the one being read, or the one chosen. */
  day: number;
  stop: string | null;
  /** The day the selected stop was on when it was chosen — how a later move is noticed. */
  stopDay: number | null;
  /** True once the traveller chose a day or a stop on purpose, as opposed to scrolling past one. */
  chosen: boolean;
}

export function initialSelection(days: readonly SelectionDay[]): TripSelection {
  return { day: days[0]?.dayNumber ?? 1, stop: null, stopDay: null, chosen: false };
}

/** The day a stop is on, preferring the day already in focus when it appears on several. */
export function dayOfStop(days: readonly SelectionDay[], stopId: string, prefer?: number): number | null {
  const preferred = prefer === undefined ? undefined : days.find((day) => day.dayNumber === prefer);
  if (preferred?.stops.some((stop) => stop.id === stopId)) return preferred.dayNumber;
  return days.find((day) => day.stops.some((stop) => stop.id === stopId))?.dayNumber ?? null;
}

export function findStop(days: readonly SelectionDay[], stopId: string | null, dayNumber?: number): (SelectionStop & { dayNumber: number }) | null {
  if (!stopId) return null;
  const owner = dayOfStop(days, stopId, dayNumber);
  if (owner === null) return null;
  const stop = days.find((day) => day.dayNumber === owner)!.stops.find((entry) => entry.id === stopId)!;
  return { ...stop, dayNumber: owner };
}

/**
 * The selection, made true of the plan as it now is.
 *
 * Called whenever the plan re-renders (an edit, a refresh) and when a stored
 * selection is read back, so neither can leave the page pointing at something
 * that is not there. Returns the same object when nothing needed changing.
 */
export function reconcileSelection(selection: TripSelection, days: readonly SelectionDay[]): TripSelection {
  if (days.length === 0) return selection;
  let { day, stop, stopDay } = selection;
  if (stop !== null) {
    const stillThere = stopDay !== null && days.some((entry) => entry.dayNumber === stopDay && entry.stops.some((candidate) => candidate.id === stop));
    if (!stillThere) {
      const owner = dayOfStop(days, stop, day);
      if (owner === null) {
        stop = null;
        stopDay = null;
      } else {
        /* The traveller was looking at the day it left: follow it. Reading some other day: stay there. */
        if (stopDay === null || day === stopDay) day = owner;
        stopDay = owner;
      }
    }
  } else {
    stopDay = null;
  }
  if (!days.some((entry) => entry.dayNumber === day)) {
    day = days.reduce((best, entry) => (Math.abs(entry.dayNumber - day) < Math.abs(best - day) ? entry.dayNumber : best), days[0]!.dayNumber);
  }
  if (day === selection.day && stop === selection.stop && stopDay === selection.stopDay) return selection;
  return { ...selection, day, stop, stopDay };
}

/** A stored selection, read defensively: anything that is not the shape we wrote is ignored. */
export function parseStoredSelection(raw: string | null, days: readonly SelectionDay[]): TripSelection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { day?: unknown; stop?: unknown };
    if (typeof value.day !== 'number' || !Number.isInteger(value.day)) return null;
    const stop = typeof value.stop === 'string' && value.stop.length > 0 ? value.stop : null;
    return reconcileSelection({ day: value.day, stop, stopDay: null, chosen: true }, days);
  } catch {
    return null;
  }
}

/**
 * What a screen reader hears when the selection changes.
 *
 * The list and the map are two views of one thing, so the sentence always
 * names where the *other* view now is — and says plainly when a stop has no
 * position to show.
 */
export function selectionAnnouncement(input: { days: readonly SelectionDay[]; selection: TripSelection; source: 'list' | 'map' }): string {
  const { days, selection, source } = input;
  const stop = findStop(days, selection.stop, selection.stopDay ?? selection.day);
  if (stop) {
    if (!stop.placed) return `${stop.name} has no confirmed position yet, so it is not on the map.`;
    const numbered = stop.number === undefined ? '' : `stop ${stop.number} of `;
    return source === 'list' ? `${stop.name}, ${numbered}day ${stop.dayNumber}, is marked on the map.` : `${stop.name}, ${numbered}day ${stop.dayNumber}, is marked in your itinerary.`;
  }
  const day = days.find((entry) => entry.dayNumber === selection.day);
  if (!day) return '';
  const placed = day.stops.filter((entry) => entry.placed).length;
  const missing = day.stops.length - placed;
  const drawn = placed === 0 ? 'nothing on it has a confirmed position yet' : `${placed} ${placed === 1 ? 'stop' : 'stops'} and the route between them`;
  return `Day ${day.dayNumber} on the map: ${drawn}${placed > 0 && missing > 0 ? `; ${missing} more ${missing === 1 ? 'has' : 'have'} no confirmed position` : ''}.`;
}

/** "Not on the map: A and B — no confirmed position yet." Null when every stop is placed. */
export function unplacedSentence(day: SelectionDay | undefined): string | null {
  const names = (day?.stops ?? []).filter((stop) => !stop.placed).map((stop) => stop.name);
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `Not on the map: ${list} — no confirmed position yet.`;
}
