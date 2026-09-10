import type { TripDraft } from '../planning/trip-draft';
import { anchorIndex } from './patch';
import type { BlastRadius, PreservationContract, RefinementIntent, RefinementLock } from './state';

/**
 * WHAT ONE EDIT MAY REACH, AND WHAT IT PROMISES NOT TO TOUCH.
 *
 * PRODUCTION LOCK V5 §38 and §39. Deterministic and model-free: the model says
 * what the traveller wants, and this decides how far that reaches. Keeping the
 * two apart is the point — a model that both interprets the request *and* sets
 * its own scope has no check on it, and "make Day 4 easier" becomes a rewritten
 * trip because that was easier to write.
 *
 * The contract is derived from the radius plus the locks, and the locks always
 * win: a locked thing is on the preserve list whatever the radius says.
 */

/** Trip-level facts a refinement can be about, in the vocabulary the contract uses. */
const TRIP_FACTS = {
  timing: 'timing',
  transport: 'transport',
  pace: 'pace',
  diet: 'diet',
  thesis: 'thesis',
  booked: 'booked_facts',
} as const;

function multiDayRuns(draft: TripDraft, days: readonly number[]): number[] {
  const expanded = new Set(days);
  for (const dayNumber of days) {
    const partOf = draft.days.find((day) => day.dayNumber === dayNumber)?.partOf;
    if (!partOf) continue;
    for (const day of draft.days) if (day.partOf === partOf) expanded.add(day.dayNumber);
  }
  return [...expanded].sort((a, b) => a - b);
}

/** Intents that may legitimately move where the traveller sleeps. */
const BASE_INTENTS: ReadonlySet<RefinementIntent> = new Set<RefinementIntent>(['preserve_x_change_y', 'change_stay', 'change_base', 'change_route', 'try_alternative', 'major_replan', 'change_booked_fact']);

/**
 * V6 — THE RADIUS, BOUNDED TO THE PATCH.
 *
 * The intent radius is the envelope the request allows; the patch is what the
 * model actually proposes. The scope shown to the traveller and written into
 * the contract is their intersection, plus two consequences the patch cannot
 * express on its own: a multi-day run moves whole, and a night moved moves the
 * days that sleep on it. So a day the request named but the patch never
 * touches is not "changed" (the live Hokkaido proposal listed the two kept
 * Biei days as changing), a day the patch reaches outside the envelope stays
 * preserved and is refused with that reason, and a stay the patch edits under
 * an intent that may move stays is in scope rather than silently held.
 */
export function radiusForPatch(input: { radius: BlastRadius; reach: { days: readonly number[]; bases: readonly string[] }; intent: RefinementIntent; draft: TripDraft }): BlastRadius {
  const { radius, reach, intent, draft } = input;
  if (radius.wholeTrip) return radius;
  const bases = BASE_INTENTS.has(intent) ? [...new Set([...radius.bases, ...reach.bases.filter((id) => draft.bases.some((base) => base.id === id))])] : [...radius.bases];
  const envelope = new Set(radius.days);
  const reached = multiDayRuns(draft, reach.days);
  const days = reach.days.length === 0 ? [...radius.days] : reached.filter((day) => envelope.has(day) || radius.days.length === 0 || reach.bases.length > 0);
  return { ...radius, days: [...new Set(days)].sort((a, b) => a - b), bases };
}

/**
 * Which days and bases an intent reaches, given the days the request named.
 *
 * `namedDays` comes from the model's own reading of the request ("Day 4" →
 * `[4]`), which is the one thing here a deterministic function cannot do. What
 * this adds is the *consequence*: a day whose intensity changes does not move
 * the hotel, and a route that loses a base moves everything downstream of it.
 */
export function blastRadiusFor(input: {
  draft: TripDraft;
  intent: RefinementIntent;
  namedDays?: readonly number[];
  namedBases?: readonly string[];
}): BlastRadius {
  const { draft, intent } = input;
  const namedDays = [...new Set(input.namedDays ?? [])].filter((day) => day >= 1 && day <= draft.days.length).sort((a, b) => a - b);
  const namedBases = [...new Set(input.namedBases ?? [])].filter((id) => draft.bases.some((base) => base.id === id));
  const allDays = draft.days.map((day) => day.dayNumber);
  const allBases = draft.bases.map((base) => base.id);

  /**
   * A day that belongs to a multi-day experience cannot be edited alone.
   *
   * Making day 5 of a four-day traverse "easier" is a change to the traverse, and
   * a system that edited only day 5 would produce a route whose days no longer
   * join up. Pulling the whole run into the radius is what makes that visible.
   */
  const withMultiDayRuns = (days: readonly number[]): number[] => multiDayRuns(draft, days);

  switch (intent) {
    case 'ask_about_trip':
    case 'explain_decision':
      return { days: [], bases: [], facts: [], wholeTrip: false, reason: 'A question about the trip changes nothing in it.' };

    case 'change_activity':
    case 'add_activity':
    case 'remove_activity': {
      const days = withMultiDayRuns(namedDays.length > 0 ? namedDays : allDays.slice(0, 0));
      return {
        days,
        bases: [],
        facts: [],
        wholeTrip: days.length === 0,
        reason: days.length > 0 ? `Only the experiences on day${days.length > 1 ? 's' : ''} ${days.join(', ')} change.` : 'The request did not name a day, so every day is in scope.',
      };
    }

    case 'move_activity': {
      const days = withMultiDayRuns(namedDays);
      return { days, bases: [], facts: [], wholeTrip: days.length === 0, reason: days.length > 0 ? `Moving something touches day${days.length > 1 ? 's' : ''} ${days.join(', ')} and nothing else.` : 'The request did not say which days.' };
    }

    case 'change_day': {
      const days = withMultiDayRuns(namedDays);
      return { days, bases: [], facts: [], wholeTrip: days.length === 0, reason: days.length > 0 ? `Day ${days.join(', ')}: its experiences, its timing and its travel. Not the stay, not the other days, not the booked facts.` : 'No day was named.' };
    }

    case 'change_stay':
    case 'change_base': {
      const bases = namedBases.length > 0 ? namedBases : allBases;
      const days = draft.days.filter((day) => bases.includes(day.baseId)).map((day) => day.dayNumber);
      return { days, bases, facts: [], wholeTrip: false, reason: `Where the traveller sleeps for ${days.length} night${days.length === 1 ? '' : 's'}, and the days that depend on it.` };
    }

    case 'change_pace':
    case 'change_priority':
      /*
       * Pace and priority are trip-level by nature: "less rushed" is not a
       * property of one day. Every day is in scope and the bases are not, because
       * a slower trip in the same places is the smaller change and the one to try
       * first.
       */
      return { days: allDays, bases: [], facts: [TRIP_FACTS.pace], wholeTrip: true, reason: 'How full the days are is a property of the whole trip, so every day is in scope. Where the traveller sleeps is not.' };

    case 'change_transport':
      return { days: allDays, bases: [], facts: [TRIP_FACTS.transport], wholeTrip: false, reason: 'The transport plan and the legs that depend on it.' };

    case 'change_route':
      return { days: allDays, bases: allBases, facts: [TRIP_FACTS.transport], wholeTrip: true, reason: 'A different route changes the base sequence, the transfer days and the days that depend on them.' };

    case 'change_timing':
      return { days: allDays, bases: [], facts: [TRIP_FACTS.timing], wholeTrip: true, reason: 'New dates change what is open, what the light does and what the weather allows on every day.' };

    case 'change_booked_fact':
      return { days: allDays, bases: allBases, facts: [TRIP_FACTS.booked], wholeTrip: true, reason: 'A booked fact is a hard constraint, so everything built around it is in scope.' };

    case 'change_diet_rule':
      return { days: allDays, bases: [], facts: [TRIP_FACTS.diet], wholeTrip: false, reason: 'Every meal, and nothing else.' };

    case 'preserve_x_change_y': {
      const days = namedDays.length > 0 ? withMultiDayRuns(namedDays) : allDays;
      return { days, bases: [], facts: [], wholeTrip: false, reason: 'What the traveller asked to keep is held exactly; the rest of the named scope may change.' };
    }

    case 'try_alternative':
    case 'major_replan':
      return { days: allDays, bases: allBases, facts: [TRIP_FACTS.timing, TRIP_FACTS.transport, TRIP_FACTS.thesis], wholeTrip: true, reason: 'The traveller asked for a different trip, so everything except their hard rules and bookings is in scope.' };

    default:
      return { days: allDays, bases: allBases, facts: [], wholeTrip: true, reason: 'The request could not be scoped, so nothing is assumed safe to change.' };
  }
}

/**
 * The preserve / change / recheck contract, from the radius and the locks.
 *
 * Three rules, in order of authority:
 *
 * 1. **A lock is absolute.** Anything locked is preserved, whatever the radius
 *    said. If that makes the request impossible, the graph interrupts and
 *    explains (§45) — it never resolves the conflict by overriding the lock.
 * 2. **Hard rules and booked facts are preserved unless the request is about
 *    them.** "Make it less touristy" does not touch a diet.
 * 3. **Everything outside the radius is preserved**, and named as such, so
 *    "kept" in the traveller's summary is a list rather than a claim.
 */
export function preservationContractFor(input: { draft: TripDraft; radius: BlastRadius; intent: RefinementIntent; locks: readonly RefinementLock[] }): PreservationContract {
  const { draft, radius, intent, locks } = input;
  const inRadius = new Set(radius.days);
  const preserve = new Set<string>();
  const change = new Set<string>();
  const recheck = new Set<string>();

  for (const lock of locks) preserve.add(`${lock.kind}:${lock.ref}`);

  /* Hard rules and bookings are preserved unless this refinement is explicitly about them. */
  if (intent !== 'change_diet_rule') preserve.add('trip_fact:diet');
  if (intent !== 'change_booked_fact') preserve.add('trip_fact:booked_facts');
  preserve.add('trip_fact:hard_rules');
  if (!radius.facts.includes('timing')) preserve.add('trip_fact:timing');

  for (const day of draft.days) {
    if (inRadius.has(day.dayNumber)) {
      change.add(`day:${day.dayNumber}`);
      recheck.add(`day:${day.dayNumber}:travel`);
      if (day.anchors.length > 0) recheck.add(`day:${day.dayNumber}:hours`);
    } else {
      preserve.add(`day:${day.dayNumber}`);
    }
  }

  const basesInRadius = new Set(radius.bases);
  for (const base of draft.bases) {
    if (basesInRadius.has(base.id)) {
      change.add(`base:${base.id}`);
      recheck.add(`base:${base.id}:area`);
    } else {
      preserve.add(`base:${base.id}`);
    }
  }

  /* Every activity outside the radius is named individually, so preservation is checkable. */
  for (const [id, address] of anchorIndex(draft)) {
    if (!inRadius.has(address.dayNumber)) preserve.add(`activity:${id}`);
  }

  for (const fact of radius.facts) change.add(`trip_fact:${fact}`);

  /* A lock beats the radius. The last word, always. */
  for (const lock of locks) change.delete(`${lock.kind}:${lock.ref}`);

  return { preserve: [...preserve].sort(), change: [...change].sort(), recheck: [...recheck].sort() };
}

/**
 * Whether a lock makes the request impossible, and what to ask about it.
 *
 * §45: a locked fact survives unless the traveller's own change makes it
 * impossible or they unlock it. This detects the first case and hands the
 * decision back to the person rather than picking a side.
 */
export function lockConflicts(input: { radius: BlastRadius; locks: readonly RefinementLock[]; draft: TripDraft }): RefinementLock[] {
  const inRadius = new Set(input.radius.days);
  return input.locks.filter((lock) => {
    if (lock.kind === 'day') return inRadius.has(Number(lock.ref));
    if (lock.kind === 'activity') {
      const address = anchorIndex(input.draft).get(lock.ref);
      return address !== undefined && inRadius.has(address.dayNumber);
    }
    if (lock.kind === 'base' || lock.kind === 'lodging') return input.radius.bases.includes(lock.ref);
    if (lock.kind === 'timing') return input.radius.facts.includes('timing');
    return false;
  });
}
