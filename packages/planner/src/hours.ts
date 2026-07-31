import {
  CLOSED_REASON_COPY,
  findOperatingCalendar,
  formatMinuteOfDay,
  intersectMinuteIntervals,
  intervalHolds,
  operatingOn,
  type AdmissionRequirement,
  type ClosedReason,
  type DateOperatingStatus,
  type MinuteInterval,
  type OpeningWindowOnDate,
  type OperatingHoursDataset,
  type SourceProvenance,
} from '@sidequest/core';

/**
 * Turning an operating calendar into a legal slot on a real day.
 *
 * `packages/core` answers "what hours is this open on 14 August?". This answers
 * the question that actually decides an itinerary: *given where the day has got
 * to, how long the visit takes, and the last bus out, is there a legal moment to
 * start it?* — which is the intersection of four independent constraints and
 * exactly the arithmetic that gets quietly duplicated and quietly diverges.
 *
 * It is one function. Every stage that needs the answer calls it: the
 * feasibility filter before day assignment, the packer while measuring a trial
 * day, and the layout while placing the visit. They cannot disagree, because
 * there is nothing for them to disagree with.
 */

/** Hours for one place on one date, with everything the timeline needs to say. */
export interface PlaceDayHours {
  placeId: string;
  date: string;
  status: DateOperatingStatus;
  /** The day's open windows. Empty when the place has no staffed hours at all. */
  windows: readonly OpeningWindowOnDate[];
  periodLabel: string | null;
  closedReason: ClosedReason | null;
  admission: AdmissionRequirement;
  /** Signed for daylight use only. Surfaced, never enforced — we have no sun. */
  daylightOnly: boolean;
  /** True when the plan must tell the traveller to confirm before travelling. */
  requiresVerification: boolean;
  verifyNote: string | null;
  provenance: SourceProvenance;
}

export function hoursKey(placeId: string, date: string): string {
  return `${placeId}|${date}`;
}

/**
 * Every place against every date, keyed `placeId|date`.
 *
 * Eager for the same reason access resolution is: day assignment has to know
 * which dates a place can land on *before* it starts placing anything, and
 * resolving lazily inside the packer would mean discovering on the fourth trial
 * that Wednesday was never possible.
 */
export function resolveOperatingHours(input: {
  placeIds: readonly string[];
  dates: readonly string[];
  dataset: OperatingHoursDataset;
}): Map<string, PlaceDayHours> {
  const resolved = new Map<string, PlaceDayHours>();

  for (const placeId of input.placeIds) {
    const calendar = findOperatingCalendar(input.dataset, placeId);
    for (const date of input.dates) {
      if (!calendar) {
        /**
         * The provider boundary refuses a dataset that does not cover every
         * place, so this is unreachable through the normal path. It exists
         * because the failure mode if it were ever reached is the exact one this
         * whole layer was built to prevent — a missing record read as "open
         * whenever you like" — so it fails towards `unknown` instead.
         */
        resolved.set(hoursKey(placeId, date), {
          placeId,
          date,
          status: 'unknown',
          windows: [],
          periodLabel: null,
          closedReason: null,
          admission: {
            reservationRequired: false,
            timedEntry: false,
            permitRequired: false,
            walkInAllowed: true,
            capacityLimited: false,
          },
          daylightOnly: false,
          requiresVerification: true,
          verifyNote:
            'We hold no opening hours for this at all. Confirm with the operator before you rely on it.',
          provenance: {
            kind: 'estimated',
            sourceName: 'No source',
            confidence: 0,
            volatility: 'dynamic',
            recheckNote: 'No opening-hours record exists for this place.',
          },
        });
        continue;
      }

      const onDate = operatingOn(calendar, date);
      // A recheck note is the instruction to verify, whatever the volatility
      // that produced it. `availability.ts` draws the same line.
      const needsRecheck =
        calendar.provenance.recheckNote !== undefined || calendar.kind === 'unknown';
      resolved.set(hoursKey(placeId, date), {
        placeId,
        date,
        status: onDate.status,
        windows: onDate.windows,
        periodLabel: onDate.periodLabel,
        closedReason: onDate.closedReason,
        admission: calendar.admission,
        daylightOnly: calendar.daylightOnly,
        requiresVerification: needsRecheck,
        verifyNote:
          calendar.provenance.recheckNote ??
          (calendar.kind === 'unknown'
            ? 'We have no confirmed opening hours for this. Check before you build a day around it.'
            : null),
        provenance: calendar.provenance,
      });
    }
  }

  return resolved;
}

export const HOURS_BLOCK_CODES = [
  /** Shut that day — out of season, a closed weekday, or a published closure. */
  'closed_on_date',
  /** Open, but its hours do not overlap the day or the way in at all. */
  'no_window_in_reach',
  /** You could get in before it shuts, but not before it stops letting people in. */
  'after_last_admission',
  /** You would be admitted and then turned out mid-visit. */
  'closes_too_soon',
] as const;
export type HoursBlockCode = (typeof HOURS_BLOCK_CODES)[number];

export type VisitPlacement =
  | {
      ok: true;
      startMinute: number;
      /** The window chosen, or null when the place has no hours to speak of. */
      window: OpeningWindowOnDate | null;
    }
  | { ok: false; code: HoursBlockCode; message: string };

export interface PlaceVisitInput {
  hours: PlaceDayHours;
  placeName: string;
  /** The earliest the traveller could be standing at the door. */
  arrivalMinute: number;
  durationMinutes: number;
  /**
   * Everything else that constrains the visit, already intersected: the day's
   * usable hours and, where there is one, the window between the first way in
   * and the last way out.
   */
  bounds: MinuteInterval;
}

/**
 * The single legality test for a visit.
 *
 * A visit is legal only if it starts after opening, starts at or before the last
 * admission, finishes before closing, and sits inside `bounds`. "Arrived before
 * closing" is *not* enough: turning up at Bodie at 17:50 for a three-hour walk
 * around a ghost town is a plan to be thrown out at six.
 *
 * The visit is never shortened to make it fit. A place worth three hours is
 * either worth three hours or is not on the day; silently trimming it to fifty
 * minutes so a constraint passes is how a validator gets to report success on an
 * itinerary nobody would want.
 */
export function placeVisit(input: PlaceVisitInput): VisitPlacement {
  const { hours, placeName, arrivalMinute, durationMinutes, bounds } = input;

  if (hours.status === 'closed') {
    const reason = hours.closedReason ? CLOSED_REASON_COPY[hours.closedReason] : 'closed';
    return {
      ok: false,
      code: 'closed_on_date',
      message: `${placeName} is ${reason} on ${hours.date}.`,
    };
  }

  /**
   * No staffed hours, or hours nobody has confirmed. Neither is a licence to
   * ignore the clock — the visit still has to fit the day and the way out — but
   * neither is a reason to refuse the place either. Unknown hours are surfaced
   * as a caution the traveller has to act on, not silently treated as closed and
   * not silently treated as unrestricted.
   */
  const unconstrained = hours.status !== 'open' || hours.windows.length === 0;
  const windows: readonly OpeningWindowOnDate[] = unconstrained
    ? [{ openMinute: bounds.startMinute, closeMinute: bounds.endMinute, lastAdmissionMinute: null }]
    : hours.windows;

  let bestFailure: { code: HoursBlockCode; message: string; closeMinute: number } | null = null;
  const note = (code: HoursBlockCode, message: string, closeMinute: number) => {
    // When several windows fail, report the one that closes latest: that is the
    // last chance the traveller had, and therefore the one worth explaining.
    if (!bestFailure || closeMinute > bestFailure.closeMinute) {
      bestFailure = { code, message, closeMinute };
    }
  };

  for (const window of [...windows].sort((a, b) => a.openMinute - b.openMinute)) {
    const legal = intersectMinuteIntervals(bounds, {
      startMinute: window.openMinute,
      endMinute: window.closeMinute,
    });
    if (!legal) {
      note(
        'no_window_in_reach',
        `${placeName} is open ${formatMinuteOfDay(window.openMinute)}–${formatMinuteOfDay(
          window.closeMinute,
        )}, which does not overlap the hours this day can give it.`,
        window.closeMinute,
      );
      continue;
    }

    const startMinute = Math.max(arrivalMinute, legal.startMinute);

    if (window.lastAdmissionMinute !== null && startMinute > window.lastAdmissionMinute) {
      note(
        'after_last_admission',
        `${placeName} stops admitting people at ${formatMinuteOfDay(
          window.lastAdmissionMinute,
        )}, and this day cannot get there before ${formatMinuteOfDay(startMinute)}.`,
        window.closeMinute,
      );
      continue;
    }

    if (!intervalHolds({ startMinute, endMinute: legal.endMinute }, durationMinutes)) {
      note(
        'closes_too_soon',
        unconstrained
          ? `${placeName} needs ${durationMinutes} min and this day only has until ${formatMinuteOfDay(
              legal.endMinute,
            )}.`
          : `${placeName} closes at ${formatMinuteOfDay(window.closeMinute)}, and a ${durationMinutes} min visit starting at ${formatMinuteOfDay(startMinute)} would not finish in time.`,
        window.closeMinute,
      );
      continue;
    }

    return { ok: true, startMinute, window: unconstrained ? null : window };
  }

  return (
    bestFailure ?? {
      ok: false,
      code: 'no_window_in_reach',
      message: `${placeName} has no hours that fit this day.`,
    }
  );
}

/**
 * Could this place be visited on this date at all, given the whole day and the
 * whole access window? Used before anything is placed, so that a closed Monday
 * pushes a stop to Tuesday rather than being discovered and dropped later.
 */
export function couldVisitOnDate(input: {
  hours: PlaceDayHours;
  placeName: string;
  durationMinutes: number;
  bounds: MinuteInterval;
}): boolean {
  return placeVisit({ ...input, arrivalMinute: input.bounds.startMinute }).ok;
}

/**
 * The latest a visit of this length may begin. Combines the closing time with
 * the last admission, because whichever bites first is the real deadline.
 */
export function latestStartOn(
  hours: PlaceDayHours | undefined,
  durationMinutes: number,
): number {
  if (!hours || hours.status !== 'open' || hours.windows.length === 0) return Infinity;
  return Math.max(
    ...hours.windows.map((window) =>
      Math.min(
        window.closeMinute - durationMinutes,
        window.lastAdmissionMinute ?? Number.POSITIVE_INFINITY,
      ),
    ),
  );
}
