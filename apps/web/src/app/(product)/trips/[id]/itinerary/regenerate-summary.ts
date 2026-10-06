import type { DiscoverySelection, Itinerary } from '@sidequest/core';

/**
 * V1 CONVERGENCE — WHAT A REBUILD KEEPS, AND WHAT IT REPLACES.
 *
 * "Regenerate" throws the stored itinerary away and plans the trip again from
 * the traveller's saved inputs. Before it does, the confirmation says which of
 * the traveller's own acts survive that and which do not — and it may only say
 * what is true, so the answer is derived here from the same rows the build
 * reads, not written as reassurance.
 *
 * - Survives: every Discovery Board decision (`discovery_selections` — includes,
 *   skips with their reasons, un-ticked Sidequest picks), bookings and the
 *   party, all of which live outside the itinerary row. A stop taken off the
 *   plan is a board skip (`removeStopAction` writes one), so it stays off.
 * - Carried: a stop marked must-keep, or locked to a day, is carried into the
 *   next build as a board include the traveller made — but only when the stop is
 *   a board place. The planner builds from the board; a stop the board has
 *   never heard of cannot be carried, and the confirmation names it.
 * - Replaced: the edits made on the itinerary itself — a move, a custom stop,
 *   a changed duration, an easier day, a fixed day. They exist only on the
 *   stored plan, which is what a rebuild replaces.
 */

/** The exact note `setStopKeep` writes on a must-keep anchor (`lib/planning/reconciled-edits.ts`). */
export const MUST_KEEP_NOTE = 'You marked this must-keep.';

export interface KeptStop {
  placeId: string | null;
  name: string;
}

export interface RegenerationPreview {
  /** Board rows the traveller made by hand (includes, maybes, skips, un-ticks). */
  boardDecisions: number;
  /** Must-keep and locked stops that will reach the next build as the traveller's own board picks. */
  carriedKeeps: KeptStop[];
  /** Must-keep and locked stops that are not board places and so cannot be carried. */
  uncarriedKeeps: KeptStop[];
  /** Edits made on this itinerary that a rebuild replaces, newest last, in the words they were recorded in. */
  manualEdits: string[];
  bookings: number;
}

/**
 * The traveller edit revisions a rebuild does NOT undo: a must-keep/optional
 * mark (carried, or named as uncarried) and a removal (a board skip). Matched on
 * the sentences `reconciled-edits.ts` writes; `regenerate-summary.test.ts` runs
 * the real edit verbs so a reworded sentence fails there, not in production.
 * (Named "survives" loosely: the second half of a move is skipped so one move
 * counts once.)
 */
function survivesRebuild(description: string): boolean {
  /* A move writes two revisions — "You moved X from day 1 to day 3." and "X arrived from day 1." — and is one change. */
  if (/ arrived from day \d+\.$/.test(description)) return true;
  return /^You marked .+ (must-keep|optional)\.$/.test(description) || /^You took .+ off day \d+\.$/.test(description);
}

export function regenerationPreview(input: {
  itinerary: Itinerary;
  locks: readonly { placeId: string; dayNumber: number }[];
  selections: readonly DiscoverySelection[];
  bookings: number;
}): RegenerationPreview {
  const { itinerary } = input;
  const boardRow = new Map(input.selections.map((s) => [s.placeId, s]));
  const nameOf = new Map<string, string>();
  for (const day of itinerary.days) for (const item of day.items) if (item.placeId && !nameOf.has(item.placeId)) nameOf.set(item.placeId, item.title);

  const keeps: KeptStop[] = [];
  const seen = new Set<string>();
  const push = (placeId: string | null, name: string) => {
    const key = placeId ?? `name:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    keeps.push({ placeId, name });
  };
  for (const anchor of itinerary.package?.anchors ?? []) {
    if (anchor.note === MUST_KEEP_NOTE) push(anchor.placeId ?? null, anchor.name);
  }
  for (const lock of input.locks) push(lock.placeId, nameOf.get(lock.placeId) ?? itinerary.package?.anchors.find((a) => a.placeId === lock.placeId)?.name ?? 'A locked stop');

  /* A board place is one the board already has a row for that is not a skip; the planner reads nothing else. */
  const carriable = (stop: KeptStop) => {
    if (!stop.placeId) return false;
    const row = boardRow.get(stop.placeId);
    return Boolean(row) && row!.status !== 'excluded' && row!.status !== 'dismissed';
  };

  const manualEdits = itinerary.diagnostics.revisions
    .filter((revision) => revision.code === 'traveller_edit' && !survivesRebuild(revision.description))
    .map((revision) => revision.description);

  return {
    boardDecisions: input.selections.filter((s) => s.source === 'user').length,
    carriedKeeps: keeps.filter(carriable),
    uncarriedKeeps: keeps.filter((k) => !carriable(k)),
    manualEdits,
    bookings: input.bookings,
  };
}

/** The place ids to record as the traveller's own includes before a rebuild starts. Already-own includes are left alone. */
export function keepsToCarry(preview: RegenerationPreview, selections: readonly DiscoverySelection[]): string[] {
  const row = new Map(selections.map((s) => [s.placeId, s]));
  return preview.carriedKeeps
    .map((k) => k.placeId!)
    .filter((placeId) => {
      const existing = row.get(placeId);
      return !(existing?.status === 'included' && existing.source === 'user');
    });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function nameList(stops: readonly KeptStop[]): string {
  const names = stops.map((s) => s.name);
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length <= 4) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/**
 * The confirmation's sentences. `replaced` is empty when nothing the traveller
 * did on this itinerary would be lost — the "your edits will be replaced"
 * sentence is shown only when there are edits to replace.
 */
export function regenerationCopy(preview: RegenerationPreview): { kept: string; replaced: string[] } {
  const keptParts: string[] = [];
  keptParts.push(preview.boardDecisions > 0 ? `your ${plural(preview.boardDecisions, 'Discovery Board decision', 'Discovery Board decisions')} (includes, skips and un-ticked picks)` : 'your Discovery Board choices');
  if (preview.carriedKeeps.length > 0) keptParts.push(`${nameList(preview.carriedKeeps)}, which you marked must-keep or locked — ${preview.carriedKeeps.length === 1 ? 'it stays in, and a locked stop keeps its day' : 'they stay in, and locked stops keep their days'}`);
  if (preview.bookings > 0) keptParts.push(`your ${plural(preview.bookings, 'booking', 'bookings')}`);
  keptParts.push('who is travelling');
  const kept = `Kept: ${keptParts.slice(0, -1).join('; ')}${keptParts.length > 1 ? '; and ' : ''}${keptParts.at(-1)}.`;

  const replaced: string[] = [];
  if (preview.manualEdits.length > 0) {
    replaced.push(`Replaced: the ${plural(preview.manualEdits.length, 'change', 'changes')} you made on this itinerary — moved stops, your own stops, changed durations, eased or fixed days.`);
  }
  if (preview.uncarriedKeeps.length > 0) {
    replaced.push(`${nameList(preview.uncarriedKeeps)} ${preview.uncarriedKeeps.length === 1 ? 'is' : 'are'} not on your Discovery Board, so the new plan may leave ${preview.uncarriedKeeps.length === 1 ? 'it' : 'them'} out even though you marked ${preview.uncarriedKeeps.length === 1 ? 'it' : 'them'} to keep.`);
  }
  return { kept, replaced };
}
