import type { Itinerary, ItineraryDay, ItineraryItem } from '@sidequest/core';

/**
 * EDITS ON A RECONCILED (MODEL-DRAFT) ITINERARY — DETERMINISTIC, LOCAL, AND
 * NEVER A RE-PLAN THROUGH THE LEGACY CANDIDATE PIPELINE.
 *
 * The planner package's own edit verbs (`removeStopFromDay`, `easeDay`)
 * rebuild a day from Discovery Board candidates, which is right for a plan
 * the deterministic planner authored and wrong for one the model composed:
 * a model-authored stop that is not a board card cannot be "rebuilt", and a
 * rebuild would quietly replace the traveller's trip with the board's idea
 * of it. So a reconciled itinerary is edited in place: the item and the leg
 * that reached it come off, the free time is re-derived, the totals are
 * recomputed from what is left, and the disposition in the package records
 * that the traveller removed it.
 */

const MIN_FREE_BLOCK_MINUTES = 30;

export function isReconciledItinerary(itinerary: Itinerary): boolean {
  return itinerary.package !== undefined;
}

function refillFreeTime(day: ItineraryDay, items: readonly ItineraryItem[]): ItineraryItem[] {
  const kept = items.filter((item) => item.kind !== 'free_time').sort((a, b) => a.startMinute - b.startMinute);
  const gaps: { start: number; end: number }[] = [];
  let cursor = day.window.startMinute;
  for (const item of kept) {
    if (item.startMinute - cursor >= MIN_FREE_BLOCK_MINUTES) gaps.push({ start: cursor, end: item.startMinute });
    cursor = Math.max(cursor, item.endMinute);
  }
  if (day.window.endMinute - cursor >= MIN_FREE_BLOCK_MINUTES) gaps.push({ start: cursor, end: day.window.endMinute });
  const free: ItineraryItem[] = gaps.map((g) => ({
    id: `d${day.dayNumber}-free-${g.start}`,
    kind: 'free_time',
    title: 'Free time',
    startMinute: g.start,
    endMinute: g.end,
    durationMinutes: g.end - g.start,
    reason: 'Deliberately unbooked. A plan with no slack in it is a plan that breaks.',
    weatherSensitive: false,
  }));
  return [...kept, ...free].sort((a, b) => a.startMinute - b.startMinute || (a.kind === 'free_time' ? 1 : -1));
}

function recomputeTotals(day: ItineraryDay, items: readonly ItineraryItem[]): ItineraryDay['totals'] {
  const totals = { activityMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, estimatedMinutes: 0, allowanceMinutes: 0, travelKm: 0, freeMinutes: 0, unmeasuredLegCount: 0 };
  for (const item of items) {
    if (item.kind === 'activity') totals.activityMinutes += item.durationMinutes;
    else if (item.kind === 'free_time') totals.freeMinutes += item.durationMinutes;
    else if (item.kind === 'travel' && item.travel) {
      if (item.travel.provenance === 'unmeasured') {
        totals.unmeasuredLegCount += 1;
        totals.allowanceMinutes += item.durationMinutes;
      } else if (item.travel.provenance === 'estimated') {
        totals.unmeasuredLegCount += 1;
        totals.estimatedMinutes += item.durationMinutes;
      } else {
        const mode = item.travel.mode;
        if (mode === 'drive') totals.driveMinutes += item.durationMinutes;
        else if (mode === 'walk') totals.walkMinutes += item.durationMinutes;
        else if (mode === 'rail' || mode === 'public_bus' || mode === 'shuttle' || mode === 'ferry') totals.transitMinutes += item.durationMinutes;
        else totals.unverifiedMinutes += item.durationMinutes;
        totals.travelKm += item.travel.km ?? 0;
      }
    }
  }
  return {
    ...totals,
    travelMinutes: totals.driveMinutes + totals.transitMinutes + totals.walkMinutes + totals.waitMinutes + totals.unverifiedMinutes + totals.estimatedMinutes + totals.allowanceMinutes,
    travelKm: Math.round(totals.travelKm * 10) / 10,
    strenuousCount: day.totals.strenuousCount,
  };
}

export type ReconciledEditResult = { ok: true; itinerary: Itinerary; changed: string } | { ok: false; message: string };

/** Removes one stop (by place id or item id) from a day; the approach leg that reached it goes with it. */
export function removeStopFromReconciledItinerary(itinerary: Itinerary, dayNumber: number, stopId: string): ReconciledEditResult {
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const index = day.items.findIndex((item) => item.kind === 'activity' && (item.placeId === stopId || item.id === stopId));
  if (index < 0) return { ok: false, message: `Day ${dayNumber} does not visit that place.` };
  const removed = day.items[index]!;
  const remaining = day.items.filter((item, i) => {
    if (i === index) return false;
    // The leg that reached the removed stop is meaningless without it.
    if (item.kind === 'travel' && item.travel && (item.travel.toId === removed.placeId || item.travel.toId === `draft:${removed.id}`)) return false;
    return true;
  });
  const items = refillFreeTime(day, remaining);
  const newDay: ItineraryDay = { ...day, items, totals: recomputeTotals(day, items) };
  const pkg = itinerary.package
    ? {
        ...itinerary.package,
        anchors: itinerary.package.anchors.map((anchor) =>
          anchor.id === removed.id || (anchor.placeId !== undefined && anchor.placeId === removed.placeId && (anchor.scheduledDayNumber ?? anchor.dayNumber) === dayNumber)
            ? { ...anchor, disposition: 'unscheduled_capacity' as const, note: 'You took this off the plan yourself.' }
            : anchor,
        ),
      }
    : itinerary.package;
  const activityCount = itinerary.days.reduce((s, d) => s + d.items.filter((i) => i.kind === 'activity').length, 0) - 1;
  if (activityCount <= 0) return { ok: false, message: 'That is the last stop on the plan; removing it would leave nothing to show.' };
  return {
    ok: true,
    itinerary: {
      ...itinerary,
      days: itinerary.days.map((d) => (d.dayNumber === dayNumber ? newDay : d)),
      unscheduled: [
        ...itinerary.unscheduled,
        {
          placeId: removed.placeId ?? removed.id,
          name: removed.title,
          wasManual: false,
          reasonCode: 'lower_priority',
          reason: `You took ${removed.title} off day ${dayNumber}.`,
        },
      ],
      diagnostics: {
        ...itinerary.diagnostics,
        revisions: [...itinerary.diagnostics.revisions, { code: 'traveller_edit', description: `You took ${removed.title} off day ${dayNumber}.`, dayNumber, ...(removed.placeId ? { placeId: removed.placeId } : {}) }],
        counts: { ...itinerary.diagnostics.counts, scheduled: Math.max(0, itinerary.diagnostics.counts.scheduled - 1), unscheduled: itinerary.diagnostics.counts.unscheduled + 1 },
      },
      ...(pkg ? { package: pkg } : {}),
    },
    changed: `You took ${removed.title} off day ${dayNumber}; the rest of the day was re-timed around it.`,
  };
}

/** Makes a day easier by removing its lowest-role, last-placed stop. */
export function easeReconciledDay(itinerary: Itinerary, dayNumber: number): ReconciledEditResult {
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const activities = day.items.filter((item) => item.kind === 'activity');
  if (activities.length <= 1) return { ok: false, message: 'This day already has only one stop on it.' };
  const roleOf = (item: ItineraryItem): number => {
    const anchor = itinerary.package?.anchors.find((a) => a.id === item.id);
    return anchor ? ['core', 'secondary', 'optional', 'flex'].indexOf(anchor.role) : 1;
  };
  const victim = [...activities].sort((a, b) => roleOf(b) - roleOf(a) || b.startMinute - a.startMinute)[0]!;
  const result = removeStopFromReconciledItinerary(itinerary, dayNumber, victim.id);
  if (!result.ok) return result;
  const eased: ItineraryDay = { ...result.itinerary.days.find((d) => d.dayNumber === dayNumber)!, intensity: day.intensity === 'intense' ? 'moderate' : 'light' };
  return {
    ok: true,
    itinerary: { ...result.itinerary, days: result.itinerary.days.map((d) => (d.dayNumber === dayNumber ? eased : d)) },
    changed: `Day ${dayNumber} is easier: ${victim.title} came off it.`,
  };
}

/* ------------------------------------------------------------------ *
 * LIVE WORLD V1 — DAY EDITING VERBS
 * ------------------------------------------------------------------ *
 *
 * Move a stop to another day, shift it earlier or later, change how long it
 * gets, add a stop of the traveller's own, mark one must-keep or optional.
 * Every verb is deterministic and local: the day is re-timed from its window
 * start in the order the traveller chose, measured legs stay measured only
 * where the pair they measured is unchanged, and any leg that now joins a
 * different pair is honestly unmeasured (`not_remeasured_after_edit`) rather
 * than carrying a figure for a drive nobody timed. No model call, no
 * provider call: a render must never spend.
 */

const DEFAULT_CUSTOM_STOP_MINUTES = 60;

function pairKey(a: string | undefined, b: string | undefined): string {
  return `${a ?? '?'}=>${b ?? '?'}`;
}

/** Re-times a day's non-free items sequentially from the window start, keeping their order; legs beside a changed pair are un-measured. */
function retimeDay(day: ItineraryDay, ordered: readonly ItineraryItem[], measuredPairs: ReadonlySet<string>): ItineraryItem[] {
  let clock = day.window.startMinute;
  const out: ItineraryItem[] = [];
  let previousStopId: string | undefined = day.baseId;
  for (const item of ordered) {
    if (item.kind === 'free_time') continue;
    let next: ItineraryItem = item;
    if (item.kind === 'travel' && item.travel) {
      const toId = item.travel.toId;
      const key = pairKey(previousStopId, toId);
      const stillMeasured = item.travel.provenance === 'measured' && measuredPairs.has(key);
      if (item.travel.provenance === 'measured' && !stillMeasured) {
        next = {
          ...item,
          title: `Travel to ${item.travel.toName}`,
          reason: 'You changed the stops around this leg; it is not re-measured until the plan is rebuilt.',
          travel: { fromId: previousStopId ?? item.travel.fromId, toId, fromName: item.travel.fromName, toName: item.travel.toName, minutes: null, km: null, mode: item.travel.mode, role: item.travel.role, provenance: 'unmeasured', unmeasuredReason: 'not_remeasured_after_edit' },
        };
      }
    }
    const duration = next.kind === 'travel' ? (next.travel?.minutes ?? 0) : next.durationMinutes;
    const start = Math.max(day.window.startMinute, clock);
    const end = Math.min(1440, start + duration);
    next = { ...next, startMinute: start, endMinute: end, durationMinutes: end - start };
    out.push(next);
    clock = end;
    if (next.kind === 'activity') previousStopId = next.placeId ?? `draft:${next.id}`;
  }
  return refillFreeTime(day, out);
}

function measuredPairsOf(day: ItineraryDay): Set<string> {
  const pairs = new Set<string>();
  for (const item of day.items) if (item.kind === 'travel' && item.travel?.provenance === 'measured') pairs.add(pairKey(item.travel.fromId, item.travel.toId));
  return pairs;
}

function withDay(itinerary: Itinerary, day: ItineraryDay, items: ItineraryItem[], note: { dayNumber: number; description: string; placeId?: string }): Itinerary {
  const newDay: ItineraryDay = { ...day, items, totals: recomputeTotals(day, items) };
  return {
    ...itinerary,
    days: itinerary.days.map((d) => (d.dayNumber === day.dayNumber ? newDay : d)),
    diagnostics: { ...itinerary.diagnostics, revisions: [...itinerary.diagnostics.revisions, { code: 'traveller_edit', description: note.description, dayNumber: note.dayNumber, ...(note.placeId ? { placeId: note.placeId } : {}) }] },
  };
}

function findStop(day: ItineraryDay, stopId: string): number {
  return day.items.findIndex((item) => item.kind === 'activity' && (item.placeId === stopId || item.id === stopId));
}

/** Moves a stop (and nothing else) from one day to the end of another; both days are re-timed. */
export function moveStopToDay(itinerary: Itinerary, fromDay: number, stopId: string, toDay: number): ReconciledEditResult {
  if (fromDay === toDay) return { ok: false, message: 'That stop is already on that day.' };
  const source = itinerary.days.find((d) => d.dayNumber === fromDay);
  const target = itinerary.days.find((d) => d.dayNumber === toDay);
  if (!source || !target) return { ok: false, message: `This trip has no day ${source ? toDay : fromDay}.` };
  const index = findStop(source, stopId);
  if (index < 0) return { ok: false, message: `Day ${fromDay} does not visit that place.` };
  const stop = source.items[index]!;
  const sourceRemaining = source.items.filter((item, i) => i !== index && !(item.kind === 'travel' && item.travel && (item.travel.toId === stop.placeId || item.travel.toId === `draft:${stop.id}`)));
  const sourceItems = retimeDay(source, sourceRemaining, measuredPairsOf(source));
  const targetOrdered = [...target.items.filter((i) => i.kind !== 'free_time')];
  // The new stop lands before any return leg, after the last activity or meal.
  const returnIndex = targetOrdered.findIndex((i) => i.kind === 'travel' && i.travel?.role === 'return');
  const approach: ItineraryItem = {
    id: `d${toDay}-leg-moved-${stop.id}`,
    kind: 'travel',
    title: `Travel to ${stop.title}`,
    startMinute: 0,
    endMinute: 0,
    durationMinutes: 0,
    reason: 'You moved this stop here; the leg to it is not measured until the plan is rebuilt.',
    weatherSensitive: false,
    travel: { fromId: target.baseId, toId: stop.placeId ?? `draft:${stop.id}`, fromName: 'previous stop', toName: stop.title, minutes: null, km: null, mode: 'drive', role: 'approach', provenance: 'unmeasured', unmeasuredReason: 'not_remeasured_after_edit' },
  };
  const moved: ItineraryItem = { ...stop, id: `d${toDay}-moved-${stop.id}`, reason: `${stop.reason} Moved here by you from day ${fromDay}.` };
  if (returnIndex >= 0) targetOrdered.splice(returnIndex, 0, approach, moved);
  else targetOrdered.push(approach, moved);
  const targetItems = retimeDay(target, targetOrdered, measuredPairsOf(target));
  const overflow = targetItems.some((i) => i.kind !== 'free_time' && i.endMinute > target.window.endMinute);
  let next = withDay(itinerary, source, sourceItems, { dayNumber: fromDay, description: `You moved ${stop.title} from day ${fromDay} to day ${toDay}.`, ...(stop.placeId ? { placeId: stop.placeId } : {}) });
  next = withDay(next, next.days.find((d) => d.dayNumber === toDay)!, targetItems, { dayNumber: toDay, description: `${stop.title} arrived from day ${fromDay}.` });
  const pkg = next.package
    ? { ...next.package, anchors: next.package.anchors.map((a) => (a.id === stop.id || (a.placeId !== undefined && a.placeId === stop.placeId && (a.scheduledDayNumber ?? a.dayNumber) === fromDay) ? { ...a, scheduledDayNumber: toDay, note: `You moved this to day ${toDay}.` } : a)) }
    : next.package;
  return {
    ok: true,
    itinerary: { ...next, ...(pkg ? { package: pkg } : {}), days: next.days.map((d) => (d.dayNumber === toDay && overflow ? { ...d, warnings: [...d.warnings, `Day ${toDay} now runs past its window after your move; Fix this day can trim it.`] } : d)) },
    changed: `You moved ${stop.title} to day ${toDay}.${overflow ? ' That day now runs long.' : ''}`,
  };
}

/** Swaps a stop with its neighbouring stop on the same day. */
export function shiftStop(itinerary: Itinerary, dayNumber: number, stopId: string, direction: 'earlier' | 'later'): ReconciledEditResult {
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const stops = day.items.filter((i) => i.kind === 'activity');
  const position = stops.findIndex((i) => i.placeId === stopId || i.id === stopId);
  if (position < 0) return { ok: false, message: `Day ${dayNumber} does not visit that place.` };
  const other = direction === 'earlier' ? position - 1 : position + 1;
  if (other < 0 || other >= stops.length) return { ok: false, message: direction === 'earlier' ? 'That stop is already first.' : 'That stop is already last.' };
  const a = stops[position]!;
  const b = stops[other]!;
  const ordered = day.items.filter((i) => i.kind !== 'free_time').map((i) => (i.id === a.id ? b : i.id === b.id ? a : i));
  const items = retimeDay(day, ordered, measuredPairsOf(day));
  return { ok: true, itinerary: withDay(itinerary, day, items, { dayNumber, description: `You moved ${a.title} ${direction} on day ${dayNumber}.`, ...(a.placeId ? { placeId: a.placeId } : {}) }), changed: `${a.title} now comes ${direction === 'earlier' ? 'before' : 'after'} ${b.title}.` };
}

/** Changes how long one stop gets; the rest of the day re-times around it. */
export function setStopDuration(itinerary: Itinerary, dayNumber: number, stopId: string, minutes: number): ReconciledEditResult {
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 600) return { ok: false, message: 'Give a stop between 15 minutes and 10 hours.' };
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const index = findStop(day, stopId);
  if (index < 0) return { ok: false, message: `Day ${dayNumber} does not visit that place.` };
  const stop = day.items[index]!;
  const ordered = day.items.filter((i) => i.kind !== 'free_time').map((i) => (i.id === stop.id ? { ...i, durationMinutes: Math.round(minutes), endMinute: i.startMinute + Math.round(minutes), note: `You set this to ${Math.round(minutes)} minutes.` } : i));
  const items = retimeDay(day, ordered, measuredPairsOf(day));
  return { ok: true, itinerary: withDay(itinerary, day, items, { dayNumber, description: `You gave ${stop.title} ${Math.round(minutes)} minutes.`, ...(stop.placeId ? { placeId: stop.placeId } : {}) }), changed: `${stop.title} now has ${Math.round(minutes)} minutes.` };
}

/** Adds a stop of the traveller's own naming to the end of a day. It is unverified until a rebuild looks it up. */
export function addCustomStop(itinerary: Itinerary, dayNumber: number, input: { title: string; minutes?: number; note?: string }): ReconciledEditResult {
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (title.length < 2 || title.length > 80) return { ok: false, message: 'Name the stop in 2 to 80 characters.' };
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const minutes = Math.round(input.minutes ?? DEFAULT_CUSTOM_STOP_MINUTES);
  if (minutes < 15 || minutes > 600) return { ok: false, message: 'Give a stop between 15 minutes and 10 hours.' };
  const id = `d${dayNumber}-custom-${Date.now().toString(36)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`;
  const approach: ItineraryItem = {
    id: `${id}-leg`,
    kind: 'travel',
    title: `Travel to ${title}`,
    startMinute: 0,
    endMinute: 0,
    durationMinutes: 0,
    reason: 'A stop you added; the leg to it is not measured until the plan is rebuilt.',
    weatherSensitive: false,
    travel: { fromId: day.baseId, toId: `draft:${id}`, fromName: 'previous stop', toName: title, minutes: null, km: null, mode: 'drive', role: 'approach', provenance: 'unmeasured', unmeasuredReason: 'not_remeasured_after_edit' },
  };
  const stop: ItineraryItem = { id, kind: 'activity', title, startMinute: 0, endMinute: minutes, durationMinutes: minutes, reason: 'You added this yourself. Sidequest has not verified it as a place; a rebuild will look it up.', weatherSensitive: false, ...(input.note ? { note: input.note.slice(0, 200) } : {}) };
  const ordered = [...day.items.filter((i) => i.kind !== 'free_time')];
  const returnIndex = ordered.findIndex((i) => i.kind === 'travel' && i.travel?.role === 'return');
  if (returnIndex >= 0) ordered.splice(returnIndex, 0, approach, stop);
  else ordered.push(approach, stop);
  const items = retimeDay(day, ordered, measuredPairsOf(day));
  const next = withDay(itinerary, day, items, { dayNumber, description: `You added ${title} to day ${dayNumber}.` });
  const pkg = next.package
    ? { ...next.package, anchors: [...next.package.anchors, { id, dayNumber, name: title, role: 'optional' as const, category: 'other', disposition: 'preserved' as const, verification: 'unverified' as const, note: 'Added by you.' }] }
    : next.package;
  return { ok: true, itinerary: { ...next, ...(pkg ? { package: pkg } : {}), diagnostics: { ...next.diagnostics, counts: { ...next.diagnostics.counts, scheduled: next.diagnostics.counts.scheduled + 1 } } }, changed: `${title} is on day ${dayNumber}, unverified until the next rebuild.` };
}

/** Marks a stop must-keep (core) or optional in the package, so repair and rebuilds treat it accordingly. */
export function setStopKeep(itinerary: Itinerary, dayNumber: number, stopId: string, keep: 'must_keep' | 'optional'): ReconciledEditResult {
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const index = findStop(day, stopId);
  if (index < 0) return { ok: false, message: `Day ${dayNumber} does not visit that place.` };
  const stop = day.items[index]!;
  if (!itinerary.package) return { ok: false, message: 'This plan has no package to record that on.' };
  const role = keep === 'must_keep' ? ('core' as const) : ('optional' as const);
  let touched = false;
  const anchors = itinerary.package.anchors.map((a) => {
    const match = a.id === stop.id || (a.placeId !== undefined && a.placeId === stop.placeId && (a.scheduledDayNumber ?? a.dayNumber) === dayNumber);
    if (!match) return a;
    touched = true;
    return { ...a, role, note: keep === 'must_keep' ? 'You marked this must-keep.' : 'You marked this optional.' };
  });
  if (!touched) return { ok: false, message: 'That stop is not in the package, so its role cannot be changed.' };
  return {
    ok: true,
    itinerary: { ...itinerary, package: { ...itinerary.package, anchors }, diagnostics: { ...itinerary.diagnostics, revisions: [...itinerary.diagnostics.revisions, { code: 'traveller_edit', description: `You marked ${stop.title} ${keep === 'must_keep' ? 'must-keep' : 'optional'}.`, dayNumber, ...(stop.placeId ? { placeId: stop.placeId } : {}) }] } },
    changed: `${stop.title} is now ${keep === 'must_keep' ? 'must-keep' : 'optional'}.`,
  };
}
