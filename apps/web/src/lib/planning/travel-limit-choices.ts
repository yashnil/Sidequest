import { itineraryStatusForVerdict, refreshTravelLimitFeasibility, type Itinerary, type ItineraryDay, type ItineraryItem } from '@sidequest/core';
import { recomputeTotals, refillFreeTime, removeStopFromReconciledItinerary } from './reconciled-edits';

/**
 * 2026-11 — THE DAILY-TRAVEL-LIMIT CHOICES, MADE REAL.
 *
 * The planner writes every day its hard limit could not hold on
 * `package.planning.travelLimit`, with the choices it found (`structure-repair.ts#travelLimitRecord`).
 * Until this module those choices were sentences: the feasibility report said
 * "Choose: …" and nothing on the page could make the choice. This is the one
 * place that decides which of them Sidequest can *execute*, in place, with no
 * model and no provider, and executes them:
 *
 *  - **Keep the long day** (`accept_long_day`): nothing on the day moves. The
 *    record says the traveller chose it, so the feasibility item becomes a
 *    caution they own instead of an open decision.
 *  - **Drop a stop** (`drop_stop`): the traveller's own pick that takes the day
 *    over comes off it — by identity (`placeId`), never by name — through the
 *    same local removal every other hand edit uses. The leg that reached it
 *    goes with it; the leg out of it either returns to where the day already
 *    was (and goes) or now joins a different pair, which is honestly
 *    unmeasured (`not_remeasured_after_edit`) with its old time held as an
 *    allowance. Nothing is re-measured silently. A booked or locked stop is
 *    never dropped this way: it is shown as information instead.
 *
 * The remaining kinds — add a night on the way, stay on and skip the move, a
 * faster mode — change where the traveller sleeps or how they move between
 * stays. That is a re-plan of the stays, not a local edit, so they are
 * presented as information with their figures and never as a control.
 *
 * Every applied choice is persisted through the ordinary edit seam
 * (`itinerary/actions.ts#persistEdit`), so it is a version and Undo is the
 * exact restore. Pure: no clock, no I/O.
 */

type TravelLimitRecord = NonNullable<NonNullable<NonNullable<Itinerary['package']>['planning']>['travelLimit']>;
type TravelLimitChoice = TravelLimitRecord['choices'][number];
type TravelLimitDecision = NonNullable<TravelLimitRecord['decisions']>[number];

export type TravelLimitOptionKind = 'accept_long_day' | 'drop_stop';

export interface TravelLimitOption {
  /** Stable for this plan: what the client sends back to apply it. */
  id: string;
  kind: TravelLimitOptionKind;
  label: string;
  /** What it changes, in numbers. */
  effect: string;
}

export interface TravelLimitInformation {
  kind: TravelLimitChoice['kind'];
  label: string;
  detail: string;
}

export interface TravelLimitDayView {
  dayNumber: number;
  travelMinutes: number;
  limitMinutes: number;
  cause: TravelLimitRecord['days'][number]['cause'];
  /** One sentence: how far over, and whose limit. */
  headline: string;
  /** Choices Sidequest can execute in place. Never empty while the day is open: keeping the day is always possible. */
  options: TravelLimitOption[];
  /** Choices shown for weighing, which Sidequest cannot execute in place. Never rendered as controls. */
  information: TravelLimitInformation[];
  /** Set once the traveller has chosen; the day then shows the decision instead of options. */
  decided?: string;
  /** A choice already made on a day that is still over (a drop that did not bring it inside the limit), said above the options left. */
  history?: string;
}

export interface TravelLimitContext {
  /** Places the traveller locked to a day (`itinerary_locks`). */
  lockedPlaceIds?: ReadonlySet<string>;
  /** Places a booked fact refers to. A booking outranks the plan around it. */
  bookedPlaceIds?: ReadonlySet<string>;
}

export function clockWords(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

const optionId = (kind: TravelLimitOptionKind, dayNumber: number, placeId?: string) => (placeId ? `${kind}:${dayNumber}:${placeId}` : `${kind}:${dayNumber}`);

function parseOptionId(id: string): { kind: TravelLimitOptionKind; dayNumber: number; placeId?: string } | null {
  const match = /^(accept_long_day|drop_stop):(\d{1,3})(?::(.+))?$/.exec(id);
  if (!match) return null;
  const kind = match[1] as TravelLimitOptionKind;
  const placeId = match[3];
  if (kind === 'drop_stop' && !placeId) return null;
  if (kind === 'accept_long_day' && placeId) return null;
  return { kind, dayNumber: Number(match[2]), ...(placeId ? { placeId } : {}) };
}

function recordOf(itinerary: Itinerary): TravelLimitRecord | null {
  return itinerary.package?.planning?.travelLimit ?? null;
}

/** The activity on this day that a drop choice refers to, by identity. */
function stopOnDay(day: ItineraryDay | undefined, placeId: string): ItineraryItem | undefined {
  return day?.items.find((item) => item.kind === 'activity' && item.placeId === placeId);
}

function decisionSentence(decision: TravelLimitDecision, limit: number): string {
  if (decision.kind === 'accept_long_day') return `You chose to keep day ${decision.dayNumber} as planned: about ${clockWords(decision.travelMinutesAfter)} of travel, over your ${clockWords(limit)} a day.`;
  return `You dropped ${decision.subject ?? 'a stop'} from day ${decision.dayNumber}: about ${clockWords(decision.travelMinutesBefore)} of travel became about ${clockWords(decision.travelMinutesAfter)}${decision.travelMinutesAfter <= limit ? ', inside your limit' : ''}.`;
}

/**
 * Every day over the traveller's own limit, with what can be done about it.
 * Only a hard limit carries choices; over Sidequest's default the day note
 * already states the trade-off and there is nothing to decide.
 */
export function travelLimitDayViews(itinerary: Itinerary, context: TravelLimitContext = {}): TravelLimitDayView[] {
  const record = recordOf(itinerary);
  if (!record || !record.hard) return [];
  const limit = record.limitMinutes;
  const views: TravelLimitDayView[] = [];
  for (const day of record.days) {
    const n = day.dayNumber;
    const over = Math.max(0, day.travelMinutes - limit);
    const base = { dayNumber: n, travelMinutes: day.travelMinutes, limitMinutes: limit, cause: day.cause };
    const decision = [...(record.decisions ?? [])].reverse().find((d) => d.dayNumber === n);
    if (day.accepted) {
      views.push({ ...base, headline: `About ${clockWords(day.travelMinutes)} of travel on day ${n}, ${clockWords(over)} past your ${clockWords(limit)} a day.`, options: [], information: [], decided: decision ? decisionSentence(decision, limit) : `You chose to keep day ${n} as planned.` });
      continue;
    }
    const itineraryDay = itinerary.days.find((d) => d.dayNumber === n);
    const options: TravelLimitOption[] = [];
    const information: TravelLimitInformation[] = [];
    for (const choice of record.choices.filter((c) => c.dayNumber === n)) {
      if (choice.kind === 'accept_long_day') {
        options.push({ id: optionId('accept_long_day', n), kind: 'accept_long_day', label: 'Keep the long day', effect: `Day ${n} stays as planned: about ${clockWords(day.travelMinutes)} of travel, ${clockWords(over)} past your ${clockWords(limit)} a day, for this day only. Nothing is moved or dropped.` });
        continue;
      }
      if (choice.kind === 'drop_stop') {
        const name = choice.subject ?? 'this stop';
        const after = choice.travelMinutes;
        const stop = choice.placeId ? stopOnDay(itineraryDay, choice.placeId) : undefined;
        if (!choice.placeId || after === undefined || !stop) continue;
        const saved = Math.max(0, day.travelMinutes - after);
        const numbers = `saves about ${clockWords(saved)} of travel: day ${n} goes from about ${clockWords(day.travelMinutes)} to about ${clockWords(after)}${after <= limit ? ', inside your limit' : `, still ${clockWords(after - limit)} over`}`;
        const protectedBy = context.bookedPlaceIds?.has(choice.placeId) ? 'booked' : context.lockedPlaceIds?.has(choice.placeId) ? 'locked' : null;
        if (protectedBy) {
          information.push({ kind: 'drop_stop', label: `Dropping ${name} would help`, detail: `It ${numbers}. You have ${protectedBy === 'booked' ? 'booked it' : 'locked it to this day'}, so Sidequest will not take it off for you${protectedBy === 'locked' ? '; unlock it first if you want this' : ''}.` });
          continue;
        }
        options.push({ id: optionId('drop_stop', n, choice.placeId), kind: 'drop_stop', label: `Drop ${name}`, effect: `It ${numbers}. ${name} comes off the plan; nothing else on the day moves.` });
        continue;
      }
      /* A change to where the traveller sleeps or how they move between stays: a re-plan, never a local edit. */
      information.push({ kind: choice.kind, label: choice.label, detail: `${choice.detail} This changes your stays, so it is not something Sidequest can apply here.` });
    }
    /* Keeping the day is always possible, even on a record written before the choice existed. */
    if (!options.some((o) => o.kind === 'accept_long_day')) {
      options.unshift({ id: optionId('accept_long_day', n), kind: 'accept_long_day', label: 'Keep the long day', effect: `Day ${n} stays as planned: about ${clockWords(day.travelMinutes)} of travel, ${clockWords(over)} past your ${clockWords(limit)} a day, for this day only. Nothing is moved or dropped.` });
    }
    views.push({ ...base, headline: `About ${clockWords(day.travelMinutes)} of travel on day ${n}, ${clockWords(over)} past the ${clockWords(limit)} a day you set.`, options, information, ...(decision ? { history: decisionSentence(decision, limit) } : {}) });
  }
  /* A day a drop brought back inside the limit is no longer over, but the traveller still sees what they chose. */
  for (const decision of record.decisions ?? []) {
    if (record.days.some((d) => d.dayNumber === decision.dayNumber) || views.some((v) => v.dayNumber === decision.dayNumber)) continue;
    views.push({ dayNumber: decision.dayNumber, travelMinutes: decision.travelMinutesAfter, limitMinutes: limit, cause: 'traveller_pick', headline: `Day ${decision.dayNumber} is inside your ${clockWords(limit)} a day.`, options: [], information: [], decided: decisionSentence(decision, limit) });
  }
  return views.sort((a, b) => a.dayNumber - b.dayNumber);
}

export type TravelLimitApplyResult = { ok: true; itinerary: Itinerary; changed: string; dropPlaceId?: string } | { ok: false; message: string };

/**
 * The leg out of a removed stop: gone if it led back to where the day already
 * was, otherwise kept as an honest unmeasured leg holding its old time as an
 * allowance. Re-derives free time and totals; never re-measures anything.
 */
function settleLegOut(before: ItineraryDay, after: ItineraryDay, removed: ItineraryItem): ItineraryDay {
  const removedIds = new Set([removed.placeId, `draft:${removed.id}`].filter((v): v is string => Boolean(v)));
  const ordered = before.items.filter((item) => item.kind !== 'free_time');
  const at = ordered.findIndex((item) => item.id === removed.id);
  const previousStop = [...ordered.slice(0, Math.max(0, at))].reverse().find((item) => item.kind === 'activity');
  const previousId = previousStop ? (previousStop.placeId ?? `draft:${previousStop.id}`) : before.baseId;
  let changed = false;
  const items: ItineraryItem[] = [];
  for (const item of after.items) {
    if (item.kind === 'travel' && item.travel && removedIds.has(item.travel.fromId)) {
      changed = true;
      if (item.travel.toId === previousId) continue;
      items.push({
        ...item,
        reason: 'You dropped the stop before this leg; it is not re-measured until the plan is rebuilt, so its old time is held as an allowance.',
        travel: { ...item.travel, fromId: previousId, fromName: previousStop?.title ?? item.travel.fromName, minutes: null, km: null, provenance: 'unmeasured', unmeasuredReason: 'not_remeasured_after_edit' },
        timing: { precision: 'band', allowanceMinutes: item.durationMinutes },
      });
      continue;
    }
    items.push(item);
  }
  if (!changed) return after;
  const refilled = refillFreeTime(after, items);
  return { ...after, items: refilled, totals: recomputeTotals(after, refilled) };
}

function withRecord(itinerary: Itinerary, record: TravelLimitRecord, dayNotes: NonNullable<NonNullable<Itinerary['package']>['planning']>['dayNotes']): Itinerary {
  const pkg = itinerary.package!;
  const planning = pkg.planning!;
  const feasibility = pkg.feasibility ? refreshTravelLimitFeasibility(pkg.feasibility, record) : undefined;
  const metrics = pkg.metrics && 'plannerDaysOverTravelLimit' in pkg.metrics ? { ...pkg.metrics, plannerDaysOverTravelLimit: record.daysOver } : pkg.metrics;
  return {
    ...itinerary,
    ...(feasibility ? { status: itineraryStatusForVerdict(feasibility.verdict) } : {}),
    package: {
      ...pkg,
      planning: { ...planning, travelLimit: record, ...(dayNotes ? { dayNotes } : {}) },
      ...(feasibility ? { feasibility } : {}),
      ...(metrics ? { metrics } : {}),
    },
  };
}

/**
 * Applies one option. Refuses — with a sentence — anything the current plan no
 * longer supports: a soft limit, a day no longer over, a stop no longer on the
 * day, a booked or locked stop, an option this plan never offered.
 */
export function applyTravelLimitChoice(itinerary: Itinerary, id: string, context: TravelLimitContext = {}): TravelLimitApplyResult {
  const parsed = typeof id === 'string' && id.length <= 300 ? parseOptionId(id) : null;
  if (!parsed) return { ok: false, message: 'That choice is not one this plan offers.' };
  const record = recordOf(itinerary);
  if (!record || !record.hard || !itinerary.package?.planning) return { ok: false, message: 'This plan has no daily travel limit of yours to decide on.' };
  const view = travelLimitDayViews(itinerary, context).find((v) => v.dayNumber === parsed.dayNumber);
  if (!view || view.decided) return { ok: false, message: `Day ${parsed.dayNumber} has nothing left to decide about its travel.` };
  const option = view.options.find((o) => o.id === id);
  if (!option) {
    const blocked = parsed.placeId && (context.bookedPlaceIds?.has(parsed.placeId) || context.lockedPlaceIds?.has(parsed.placeId));
    return { ok: false, message: blocked ? 'That stop is booked or locked to its day, so Sidequest will not drop it for you.' : 'That choice is no longer on offer for this day; the plan has changed since.' };
  }
  const limit = record.limitMinutes;
  const n = parsed.dayNumber;
  const dayRecord = record.days.find((d) => d.dayNumber === n)!;
  const dayNotes = itinerary.package.planning.dayNotes;

  if (parsed.kind === 'accept_long_day') {
    const decision: TravelLimitDecision = { dayNumber: n, kind: 'accept_long_day', travelMinutesBefore: dayRecord.travelMinutes, travelMinutesAfter: dayRecord.travelMinutes };
    const next: TravelLimitRecord = {
      ...record,
      days: record.days.map((d) => (d.dayNumber === n ? { ...d, accepted: true } : d)),
      choices: record.choices.filter((c) => c.dayNumber !== n),
      decisions: [...(record.decisions ?? []), decision],
    };
    const revised = withRecord(itinerary, next, dayNotes);
    return {
      ok: true,
      itinerary: { ...revised, diagnostics: { ...revised.diagnostics, revisions: [...revised.diagnostics.revisions, { code: 'traveller_edit', description: `You chose to keep day ${n}'s ${clockWords(dayRecord.travelMinutes)} of travel.`, dayNumber: n }] } },
      changed: `Day ${n} stays as planned, with about ${clockWords(dayRecord.travelMinutes)} of travel — over your ${clockWords(limit)} a day, by your choice.`,
    };
  }

  /* drop_stop */
  const choice = record.choices.find((c) => c.dayNumber === n && c.kind === 'drop_stop' && c.placeId === parsed.placeId)!;
  const before = itinerary.days.find((d) => d.dayNumber === n)!;
  const stop = stopOnDay(before, parsed.placeId!)!;
  const removed = removeStopFromReconciledItinerary(itinerary, n, stop.id);
  if (!removed.ok) return { ok: false, message: removed.message };
  const settledDay = settleLegOut(before, removed.itinerary.days.find((d) => d.dayNumber === n)!, stop);
  const afterRemoval: Itinerary = { ...removed.itinerary, days: removed.itinerary.days.map((d) => (d.dayNumber === n ? settledDay : d)) };
  const after = choice.travelMinutes!;
  const stillOver = after > limit;
  const decision: TravelLimitDecision = { dayNumber: n, kind: 'drop_stop', subject: choice.subject ?? stop.title, placeId: parsed.placeId!, travelMinutesBefore: dayRecord.travelMinutes, travelMinutesAfter: after };
  const days = stillOver ? record.days.map((d) => (d.dayNumber === n ? { ...d, travelMinutes: after } : d)) : record.days.filter((d) => d.dayNumber !== n);
  /* The other choices for the day were figured with this stop on it; only keeping the day survives, at its new figure. */
  const choices = [
    ...record.choices.filter((c) => c.dayNumber !== n),
    ...(stillOver ? [{ dayNumber: n, kind: 'accept_long_day' as const, label: `Accept about ${clockWords(after)} of travel on day ${n}`, detail: `Keep day ${n} as it now is: about ${clockWords(after)} of travel, ${clockWords(after - limit)} past your ${clockWords(limit)} a day.`, travelMinutes: after }] : []),
  ];
  const next: TravelLimitRecord = { ...record, days, choices, daysOver: days.length, decisions: [...(record.decisions ?? []), decision] };
  const name = decision.subject!;
  const notes = dayNotes
    ? [
        ...dayNotes.filter((note) => !(note.dayNumber === n && note.code === 'travel_over_limit')),
        ...(stillOver && dayNotes.some((note) => note.dayNumber === n && note.code === 'travel_over_limit') ? [{ dayNumber: n, code: 'travel_over_limit', note: `About ${clockWords(after)} of travel today, over the ${clockWords(limit)} a day you set, after you dropped ${name}.` }] : []),
      ]
    : undefined;
  return {
    ok: true,
    itinerary: withRecord(afterRemoval, next, notes),
    changed: `You dropped ${name} from day ${n}: about ${clockWords(dayRecord.travelMinutes)} of travel becomes about ${clockWords(after)}${stillOver ? '' : ', inside your limit'}.`,
    dropPlaceId: parsed.placeId!,
  };
}
