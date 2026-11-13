import { decideTripArrangement, type Itinerary, type TripArrangement, type TripArrangementDay } from '@sidequest/core';
import { episodesOf, type TripDraft } from './trip-draft';

/**
 * The trip's transport arrangement (`decideTripArrangement`), read from what
 * this app persists: the draft, and — once it exists — the reconciled itinerary.
 * Every surface that needs to know whether the traveller drives, who drives them
 * or whether a flight is part of the plan asks here, so bookings, budget,
 * Prepare and the day text cannot each answer differently.
 */

/** Persisted leg modes that are a vehicle on a road. */
const ROAD_LEG_MODES = new Set(['drive', 'private_transfer', 'shuttle', 'rideshare', 'public_bus']);

type DraftLike = Pick<TripDraft, 'days' | 'bases'> & Partial<Pick<TripDraft, 'driving' | 'episodes' | 'package'>>;

/** The loosest draft shape the intelligence layer holds: per-day stop transports, optionally the move, optionally the stated arrangement. */
export interface ArrangementDraftHints {
  driving?: string | undefined;
  days?: readonly { dayNumber?: number; anchors: readonly { transport?: string | undefined }[]; move?: { how: string } | undefined }[];
  package?: { transport: { summary: string; notes: readonly string[] } } | undefined;
}

function draftDayHints(day: { anchors: readonly { transport?: string | undefined }[]; move?: { how: string } | undefined } | undefined): string[] {
  if (!day) return [];
  return [...day.anchors.map((anchor) => anchor.transport), day.move?.how].filter((hint): hint is string => Boolean(hint));
}

/** Before the itinerary exists: the draft alone (the reconciler's view). */
export function arrangementFromDraft(draft: DraftLike, willDrive?: boolean): TripArrangement {
  return decideTripArrangement({
    ...(draft.driving ? { driving: draft.driving } : {}),
    ...(willDrive !== undefined ? { willDrive } : {}),
    transportText: draft.package ? [draft.package.transport.summary, ...draft.package.transport.notes] : [],
    days: draft.days.map((day) => ({ dayNumber: day.dayNumber, theme: day.theme, hints: draftDayHints(day) })),
    episodes: episodesOf(draft).map((episode) => ({ dayNumbers: Array.from({ length: episode.toDay - episode.fromDay + 1 }, (_, i) => episode.fromDay + i), kind: episode.kind, mode: episode.mode, ...(episode.timing ? { timing: episode.timing } : {}) })),
  });
}

/** True when a day's base-to-base leg is a road leg (and not a flight hint carried on a road mode). */
export function dayHasRoadTransfer(day: Itinerary['days'][number]): boolean {
  return day.items.some((item) => item.kind === 'travel' && item.travel?.role === 'transfer' && item.travel.hint !== 'flight' && ROAD_LEG_MODES.has(item.travel.mode));
}

/** True when the day carries a structured flight leg. */
export function dayHasFlightLeg(day: Itinerary['days'][number]): boolean {
  return day.items.some((item) => item.kind === 'travel' && item.travel?.hint === 'flight');
}

/** After reconciliation: the persisted itinerary, with the draft where it is still held. */
export function tripArrangementOf(input: { itinerary: Itinerary; draft?: ArrangementDraftHints | DraftLike | null | undefined; willDrive?: boolean | undefined }): TripArrangement {
  const { itinerary } = input;
  const draft = input.draft ?? null;
  const pkg = itinerary.package;
  /* A day without its own number is the day at that position, which is how the stored hints are kept. */
  const draftDay = new Map((draft?.days ?? []).map((day, index) => [day.dayNumber ?? index + 1, day] as const));
  const days: TripArrangementDay[] = itinerary.days.map((day) => ({
    dayNumber: day.dayNumber,
    theme: day.theme,
    hints: [...draftDayHints(draftDay.get(day.dayNumber)), ...day.items.flatMap((item) => (item.kind === 'travel' && item.travel?.hint ? [item.travel.hint] : []))],
    legModes: day.items.flatMap((item) => (item.kind === 'travel' && item.travel && item.travel.fromId !== item.travel.toId ? [item.travel.mode] : [])),
    roadTransfer: dayHasRoadTransfer(day),
  }));
  const episodes = pkg?.episodes && pkg.episodes.length > 0
    ? pkg.episodes.map((episode) => ({ dayNumbers: episode.dayNumbers, kind: episode.kind, mode: episode.mode, timing: episode.timing }))
    : draft && 'bases' in draft && draft.bases && (draft.days ?? []).every((day) => 'theme' in day)
      ? episodesOf(draft as DraftLike).map((episode) => ({ dayNumbers: Array.from({ length: episode.toDay - episode.fromDay + 1 }, (_, i) => episode.fromDay + i), kind: episode.kind, mode: episode.mode, ...(episode.timing ? { timing: episode.timing } : {}) }))
      : [];
  const transportText = pkg ? [pkg.transport.summary, ...pkg.transport.notes] : draft?.package ? [draft.package.transport.summary, ...draft.package.transport.notes] : [];
  return decideTripArrangement({
    ...(draft?.driving ? { driving: draft.driving } : {}),
    ...(input.willDrive !== undefined ? { willDrive: input.willDrive } : {}),
    transportText,
    days,
    episodes,
    primaryMode: itinerary.transportStrategy.primaryMode,
  });
}
