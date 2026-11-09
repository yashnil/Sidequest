import { describe, expect, it } from 'vitest';
import { dayOfStop, findStop, initialSelection, parseStoredSelection, reconcileSelection, selectionAnnouncement, unplacedSentence, type SelectionDay, type TripSelection } from './trip-selection-model';

const DAYS: SelectionDay[] = [
  { dayNumber: 1, stops: [{ id: 'village', name: 'The Village', number: 1, placed: true }, { id: 'vista', name: 'Minaret Vista', number: 2, placed: true }] },
  { dayNumber: 2, stops: [{ id: 'convict', name: 'Convict Lake', number: 1, placed: true }, { id: 'hot-creek', name: 'Hot Creek', placed: false }] },
  { dayNumber: 3, stops: [{ id: 'basin', name: 'Lakes Basin', number: 1, placed: true }] },
];

const chosen = (day: number, stop: string | null, stopDay: number | null = stop ? day : null): TripSelection => ({ day, stop, stopDay, chosen: true });

describe('the one selection the list and the maps share', () => {
  it('starts on the first day with nothing selected and nothing chosen', () => {
    expect(initialSelection(DAYS)).toEqual({ day: 1, stop: null, stopDay: null, chosen: false });
    expect(initialSelection([])).toEqual({ day: 1, stop: null, stopDay: null, chosen: false });
  });

  it('finds the day a stop is on, preferring the day in focus', () => {
    const twice: SelectionDay[] = [...DAYS, { dayNumber: 4, stops: [{ id: 'convict', name: 'Convict Lake', number: 1, placed: true }] }];
    expect(dayOfStop(twice, 'convict')).toBe(2);
    expect(dayOfStop(twice, 'convict', 4)).toBe(4);
    expect(dayOfStop(twice, 'nowhere')).toBeNull();
    expect(findStop(DAYS, 'vista')).toMatchObject({ name: 'Minaret Vista', dayNumber: 1, number: 2 });
  });

  it('leaves a selection alone while the plan still agrees with it — the same object, so nothing re-renders', () => {
    const selection = chosen(2, 'convict');
    expect(reconcileSelection(selection, DAYS)).toBe(selection);
  });

  it('lets go of a stop an edit removed, and keeps the day', () => {
    const without = DAYS.map((day) => (day.dayNumber === 2 ? { ...day, stops: day.stops.filter((stop) => stop.id !== 'convict') } : day));
    expect(reconcileSelection(chosen(2, 'convict'), without)).toMatchObject({ day: 2, stop: null, stopDay: null });
  });

  it('follows a stop an edit moved to another day when that was the day being read', () => {
    const moved = DAYS.map((day) =>
      day.dayNumber === 2 ? { ...day, stops: day.stops.filter((stop) => stop.id !== 'convict') } : day.dayNumber === 3 ? { ...day, stops: [...day.stops, { id: 'convict', name: 'Convict Lake', number: 2, placed: true }] } : day,
    );
    expect(reconcileSelection(chosen(2, 'convict'), moved)).toMatchObject({ day: 3, stop: 'convict', stopDay: 3 });
  });

  it('does not drag the reader to a moved stop when they had scrolled to another day', () => {
    const moved = DAYS.map((day) =>
      day.dayNumber === 2 ? { ...day, stops: day.stops.filter((stop) => stop.id !== 'convict') } : day.dayNumber === 3 ? { ...day, stops: [...day.stops, { id: 'convict', name: 'Convict Lake', number: 2, placed: true }] } : day,
    );
    expect(reconcileSelection(chosen(1, 'convict', 2), moved)).toMatchObject({ day: 1, stop: 'convict', stopDay: 3 });
  });

  it('scrolling to another day keeps the selected stop', () => {
    expect(reconcileSelection(chosen(3, 'convict', 2), DAYS)).toMatchObject({ day: 3, stop: 'convict', stopDay: 2 });
  });

  it('falls back to the nearest day when the selected day no longer exists', () => {
    expect(reconcileSelection(chosen(9, null), DAYS).day).toBe(3);
    expect(reconcileSelection(chosen(0, null), DAYS).day).toBe(1);
  });

  it('reads a stored selection defensively', () => {
    expect(parseStoredSelection(null, DAYS)).toBeNull();
    expect(parseStoredSelection('not json', DAYS)).toBeNull();
    expect(parseStoredSelection('{"day":"2"}', DAYS)).toBeNull();
    expect(parseStoredSelection('{"day":2,"stop":"convict"}', DAYS)).toEqual({ day: 2, stop: 'convict', stopDay: 2, chosen: true });
    /* A stop that has since left the plan is not restored; a day that has gone falls back. */
    expect(parseStoredSelection('{"day":2,"stop":"gone"}', DAYS)).toEqual({ day: 2, stop: null, stopDay: null, chosen: true });
    expect(parseStoredSelection('{"day":12,"stop":null}', DAYS)?.day).toBe(3);
  });
});

describe('what a screen reader hears', () => {
  it('names where the other view now is', () => {
    expect(selectionAnnouncement({ days: DAYS, selection: chosen(2, 'convict'), source: 'list' })).toBe('Convict Lake, stop 1 of day 2, is marked on the map.');
    expect(selectionAnnouncement({ days: DAYS, selection: chosen(2, 'convict'), source: 'map' })).toBe('Convict Lake, stop 1 of day 2, is marked in your itinerary.');
  });

  it('says plainly when a stop has no position — absence, never an error', () => {
    expect(selectionAnnouncement({ days: DAYS, selection: chosen(2, 'hot-creek'), source: 'list' })).toBe('Hot Creek has no confirmed position yet, so it is not on the map.');
  });

  it('describes a chosen day, including what could not be drawn', () => {
    expect(selectionAnnouncement({ days: DAYS, selection: chosen(1, null), source: 'list' })).toBe('Day 1 on the map: 2 stops and the route between them.');
    expect(selectionAnnouncement({ days: DAYS, selection: chosen(2, null), source: 'map' })).toBe('Day 2 on the map: 1 stop and the route between them; 1 more has no confirmed position.');
    const unplacedDay: SelectionDay[] = [{ dayNumber: 1, stops: [{ id: 'a', name: 'A', placed: false }] }];
    expect(selectionAnnouncement({ days: unplacedDay, selection: chosen(1, null), source: 'list' })).toBe('Day 1 on the map: nothing on it has a confirmed position yet.');
  });

  it('names the stops a day could not place', () => {
    expect(unplacedSentence(DAYS[0])).toBeNull();
    expect(unplacedSentence(DAYS[1])).toBe('Not on the map: Hot Creek — no confirmed position yet.');
    expect(unplacedSentence({ dayNumber: 1, stops: ['A', 'B', 'C', 'D'].map((name) => ({ id: name, name, placed: false })) })).toBe('Not on the map: A, B and 2 more — no confirmed position yet.');
    expect(unplacedSentence(undefined)).toBeNull();
  });
});
