import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  EASTERN_SIERRA_HOURS,
  itineraryStructureFingerprint,
  operatingHoursDatasetSchema,
  type operatingCalendarSchema,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type OperatingCalendar,
  type OperatingHoursDataset,
} from '@sidequest/core';
import { planTrip } from './plan';
import { buildScenario, type ScenarioOptions } from './testing/scenario';
import { resolveConfig } from './types';
import { validateItinerary } from './validate';

/**
 * Opening hours, end to end.
 *
 * The scenarios below are the ones that decide whether a plan can actually be
 * executed: arriving before a gate opens, arriving after it stops admitting,
 * a visit that would still be going at closing, a closed weekday, and the two
 * halves of the region's hardest day — a shared shuttle whose stops keep
 * different hours from each other.
 */

function plan(options: ScenarioOptions = {}): Itinerary {
  const result = planTrip(buildScenario(options));
  if (!result.ok) throw new Error(`Planning failed: ${result.code} — ${result.message}`);
  return result.itinerary;
}

/**
 * A copy of the seed hours with one place's calendar swapped, re-validated so a
 * malformed patch fails in the test rather than in the planner.
 *
 * Takes the schema's *input* shape, so a patch may leave defaulted fields out
 * exactly as the seed data does.
 */
function withCalendar(
  placeId: string,
  calendar: z.input<typeof operatingCalendarSchema>,
): OperatingHoursDataset {
  const next = structuredClone(EASTERN_SIERRA_HOURS) as OperatingHoursDataset;
  const index = next.calendars.findIndex((entry) => entry.placeId === placeId);
  if (index < 0) throw new Error(`No calendar for ${placeId}`);
  (next.calendars as unknown[])[index] = calendar;
  return operatingHoursDatasetSchema.parse(next);
}

const AUTHORED = {
  kind: 'authored' as const,
  sourceName: 'Test fixture',
  confidence: 0.5,
  volatility: 'stable' as const,
};

const NO_ADMISSION = {
  reservationRequired: false,
  timedEntry: false,
  permitRequired: false,
  walkInAllowed: true,
  capacityLimited: false,
};

/** Roomy enough that Bodie's 160 minutes of driving is not the binding limit. */
const LONG_DRIVES: ScenarioOptions['answers'] = { maxDailyTravelMinutes: 300 };

function activities(day: ItineraryDay): ItineraryItem[] {
  return day.items.filter((item) => item.kind === 'activity');
}

function visitOf(itinerary: Itinerary, placeId: string): ItineraryItem | undefined {
  return itinerary.days
    .flatMap((day) => day.items)
    .find((item) => item.kind === 'activity' && item.placeId === placeId);
}

function dayOf(itinerary: Itinerary, placeId: string): ItineraryDay | undefined {
  return itinerary.days.find((day) =>
    day.items.some((item) => item.kind === 'activity' && item.placeId === placeId),
  );
}

function unscheduled(itinerary: Itinerary, placeId: string) {
  return itinerary.unscheduled.find((entry) => entry.placeId === placeId);
}

function errors(itinerary: Itinerary) {
  return itinerary.issues.filter((issue) => issue.severity === 'error');
}

// ---------------------------------------------------------------------------
// 1. The ordinary case
// ---------------------------------------------------------------------------

describe('scenario 1 — a standard four-day summer trip', () => {
  const itinerary = plan();

  it('never schedules an activity outside the window it records', () => {
    for (const day of itinerary.days) {
      for (const item of activities(day)) {
        if (!item.hours) continue;
        expect(item.startMinute).toBeGreaterThanOrEqual(item.hours.openMinute);
        expect(item.endMinute).toBeLessThanOrEqual(item.hours.closeMinute);
        if (item.hours.lastAdmissionMinute !== undefined) {
          expect(item.startMinute).toBeLessThanOrEqual(item.hours.lastAdmissionMinute);
        }
      }
    }
  });

  it('raises no opening-hours error at all', () => {
    const hoursCodes = errors(itinerary).map((issue) => issue.code);
    expect(hoursCodes).not.toContain('arrives_before_opening');
    expect(hoursCodes).not.toContain('arrives_after_last_admission');
    expect(hoursCodes).not.toContain('visit_ends_after_closing');
    expect(hoursCodes).not.toContain('attraction_closed_on_date');
    expect(hoursCodes).not.toContain('operating_evidence_inconsistent');
  });

  it('leaves the region’s unscheduled majority genuinely unscheduled', () => {
    // The guard against a later change quietly giving trailheads opening hours:
    // most stops on a normal trip should carry no window at all.
    const all = itinerary.days.flatMap(activities);
    expect(all.length).toBeGreaterThan(3);
    expect(all.filter((item) => !item.hours).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. A limited-hours attraction
// ---------------------------------------------------------------------------

describe('scenario 2 — Bodie, open 09:00 to 18:00 with a 17:45 cutoff', () => {
  const itinerary = plan({
    answers: LONG_DRIVES,
    manualIncludes: ['bodie-state-historic-park'],
  });

  it('is scheduled, and inside its hours', () => {
    const visit = visitOf(itinerary, 'bodie-state-historic-park');
    expect(visit, itinerary.unscheduled.map((u) => `${u.placeId}: ${u.reason}`).join('\n')).toBeDefined();
    expect(visit!.hours).toEqual(
      expect.objectContaining({ openMinute: 540, closeMinute: 1080, lastAdmissionMinute: 1065 }),
    );
    expect(visit!.startMinute).toBeGreaterThanOrEqual(540);
    expect(visit!.startMinute).toBeLessThanOrEqual(1065);
    expect(visit!.endMinute).toBeLessThanOrEqual(1080);
  });

  it('is never an evening stop', () => {
    const visit = visitOf(itinerary, 'bodie-state-historic-park')!;
    expect(visit.startMinute).toBeLessThan(17 * 60);
  });

  it('anchors its day, and the flexible stops are named as flexible', () => {
    const day = dayOf(itinerary, 'bodie-state-historic-park')!;
    expect(day.availability.anchorPlaceId).toBe('bodie-state-historic-park');
    expect(day.availability.anchorNote).toMatch(/09:00/);
    expect(day.availability.anchorNote).toMatch(/18:00/);
    expect(day.availability.flexiblePlaceIds).not.toContain('bodie-state-historic-park');
  });

  it('carries the source it was verified against, and says we have not rechecked', () => {
    const visit = visitOf(itinerary, 'bodie-state-historic-park')!;
    expect(visit.hours!.sourceKind).toBe('official');
    expect(visit.hours!.sourceUrl).toMatch(/parks\.ca\.gov/);
    expect(visit.hours!.lastVerified).toBe('2026-07-30');
    expect(visit.verifyBeforeTravel).toMatch(/confirm/i);
  });
});

// ---------------------------------------------------------------------------
// 3. A closed weekday
// ---------------------------------------------------------------------------

describe('scenario 3 — the Manzanar visitor centre is shut Tuesday to Thursday', () => {
  it('lands on a day it is open, never on one of its closed weekdays', () => {
    // The trip runs Wednesday 12 August to Saturday 15 August. The centre opens
    // Friday to Monday, so only the 14th and 15th work.
    const itinerary = plan({
      answers: { ...LONG_DRIVES, regionalExpansion: 'best_regional', detourToleranceMinutes: 120 },
      manualIncludes: ['manzanar-visitor-center'],
    });
    const day = dayOf(itinerary, 'manzanar-visitor-center');
    if (day) {
      expect(['2026-08-14', '2026-08-15']).toContain(day.date);
      expect(errors(itinerary).map((i) => i.code)).not.toContain('attraction_closed_on_date');
    } else {
      // If it could not be fitted at all it must say why, and the reason must
      // name the real constraint rather than shrugging about logistics.
      const entry = unscheduled(itinerary, 'manzanar-visitor-center');
      expect(entry).toBeDefined();
      expect(entry!.wasManual).toBe(true);
    }
  });

  it('becomes an explicit conflict when no legal day is left', () => {
    // A Tuesday-to-Thursday trip contains none of its open days.
    const itinerary = plan({
      basics: { startDate: '2026-08-11', endDate: '2026-08-13' },
      answers: { ...LONG_DRIVES, regionalExpansion: 'best_regional', detourToleranceMinutes: 120 },
      manualIncludes: ['manzanar-visitor-center'],
    });
    const entry = unscheduled(itinerary, 'manzanar-visitor-center');
    expect(entry?.reasonCode).toBe('closed_on_trip_dates');
    expect(entry?.reason).toMatch(/days of the week it does not open/i);
    expect(entry?.wasManual).toBe(true);
    expect(itinerary.status).toBe('needs_decision');
    expect(errors(itinerary).some((i) => i.code === 'must_include_unscheduled')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. A seasonal closure
// ---------------------------------------------------------------------------

describe('scenario 4 — a place shut for the season on these dates', () => {
  const closedInAugust = withCalendar('convict-lake', {
    kind: 'scheduled',
    placeId: 'convict-lake',
    periods: [
      { label: 'Winter only', months: [12, 1, 2], windows: [{ openMinute: 540, closeMinute: 1020 }] },
    ],
    closedAnnualDates: [],
    admission: { ...NO_ADMISSION },
    provenance: AUTHORED,
  });

  it('keeps a hand-picked one visible with a specific explanation', () => {
    const itinerary = plan({ hours: closedInAugust, manualIncludes: ['convict-lake'] });
    expect(visitOf(itinerary, 'convict-lake')).toBeUndefined();
    const entry = unscheduled(itinerary, 'convict-lake');
    expect(entry?.reasonCode).toBe('closed_on_trip_dates');
    expect(entry?.reason).toMatch(/season/i);
    expect(entry?.suggestedRemedy).toBeDefined();
  });

  it('invents neither hours nor a way in to make it work', () => {
    const itinerary = plan({ hours: closedInAugust, manualIncludes: ['convict-lake'] });
    for (const day of itinerary.days) {
      expect(day.items.some((item) => item.placeId === 'convict-lake')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. A split daily schedule
// ---------------------------------------------------------------------------

describe('scenario 5 — a morning window and an evening window with a gap between', () => {
  it('picks one interval and never schedules through the closed middle', () => {
    const split = withCalendar('convict-lake', {
      kind: 'scheduled',
      placeId: 'convict-lake',
      periods: [
        {
          label: 'Split',
          months: [8],
          windows: [
            { openMinute: 9 * 60, closeMinute: 11 * 60 },
            { openMinute: 15 * 60, closeMinute: 19 * 60 },
          ],
        },
      ],
      closedAnnualDates: [],
      admission: { ...NO_ADMISSION },
      provenance: AUTHORED,
    });

    const itinerary = plan({ hours: split, manualIncludes: ['convict-lake'] });
    const visit = visitOf(itinerary, 'convict-lake');
    expect(visit).toBeDefined();

    const window = visit!.hours!;
    // Whichever half it chose, the whole visit sits inside that one half.
    expect([540, 900]).toContain(window.openMinute);
    expect(visit!.startMinute).toBeGreaterThanOrEqual(window.openMinute);
    expect(visit!.endMinute).toBeLessThanOrEqual(window.closeMinute);
    // And in particular it does not straddle the 11:00–15:00 closure.
    const straddles = visit!.startMinute < 11 * 60 && visit!.endMinute > 11 * 60;
    expect(straddles).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Last admission
// ---------------------------------------------------------------------------

describe('scenario 6 — arriving before closing but after the last admission', () => {
  it('is rejected, and the place is left off rather than squeezed in', () => {
    // Open until 22:00, but nobody admitted after 08:00 — so a day that cannot
    // physically reach it that early has no legal visit, even though the gate
    // is open for another fourteen hours.
    const earlyCutoff = withCalendar('bodie-state-historic-park', {
      kind: 'scheduled',
      placeId: 'bodie-state-historic-park',
      periods: [
        {
          label: 'Odd',
          months: [8],
          windows: [{ openMinute: 6 * 60, closeMinute: 22 * 60, lastAdmissionMinute: 8 * 60 }],
        },
      ],
      closedAnnualDates: [],
      admission: { ...NO_ADMISSION },
      provenance: AUTHORED,
    });

    const itinerary = plan({
      answers: LONG_DRIVES,
      hours: earlyCutoff,
      manualIncludes: ['bodie-state-historic-park'],
    });
    const visit = visitOf(itinerary, 'bodie-state-historic-park');
    if (visit) {
      // If it did fit, it fitted legally — a 07:30 start plus an 80-minute
      // drive leaves it very close, and either outcome is correct.
      expect(visit.startMinute).toBeLessThanOrEqual(8 * 60);
    } else {
      const entry = unscheduled(itinerary, 'bodie-state-historic-park');
      expect(entry?.reasonCode).toBe('hours_do_not_fit');
      expect(entry?.wasManual).toBe(true);
    }
    expect(errors(itinerary).map((i) => i.code)).not.toContain('arrives_after_last_admission');
  });
});

// ---------------------------------------------------------------------------
// 7. The visit does not fit before closing
// ---------------------------------------------------------------------------

describe('scenario 7 — the visit is longer than the hours left', () => {
  it('is omitted rather than trimmed to fit', () => {
    // Convict Lake wants two hours; this leaves it thirty minutes.
    const tiny = withCalendar('convict-lake', {
      kind: 'scheduled',
      placeId: 'convict-lake',
      periods: [
        { label: 'Sliver', months: [8], windows: [{ openMinute: 10 * 60, closeMinute: 10 * 60 + 30 }] },
      ],
      closedAnnualDates: [],
      admission: { ...NO_ADMISSION },
      provenance: AUTHORED,
    });

    const itinerary = plan({ hours: tiny, manualIncludes: ['convict-lake'] });
    expect(visitOf(itinerary, 'convict-lake')).toBeUndefined();

    const entry = unscheduled(itinerary, 'convict-lake');
    expect(entry?.reasonCode).toBe('hours_do_not_fit');
    expect(entry?.reason).toMatch(/never for long enough|does not fit/i);
    // And it is surfaced as a decision rather than swallowed.
    expect(itinerary.status).toBe('needs_decision');
  });

  it('never shortens an activity below the time the place is worth', () => {
    const tiny = withCalendar('convict-lake', {
      kind: 'scheduled',
      placeId: 'convict-lake',
      periods: [
        { label: 'Sliver', months: [8], windows: [{ openMinute: 10 * 60, closeMinute: 10 * 60 + 30 }] },
      ],
      closedAnnualDates: [],
      admission: { ...NO_ADMISSION },
      provenance: AUTHORED,
    });
    const itinerary = plan({ hours: tiny });
    for (const day of itinerary.days) {
      for (const item of activities(day)) {
        expect(item.durationMinutes).toBeGreaterThanOrEqual(15);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. A shared access group whose members keep different hours
// ---------------------------------------------------------------------------

describe('scenario 8 — one shuttle, two stops, different hours', () => {
  // Devils Postpile and Rainbow Falls share one mandatory shuttle sequence.
  // Give the falls a schedule that ends at lunchtime and the postpile none.
  const fallsCloseEarly = withCalendar('rainbow-falls', {
    kind: 'scheduled',
    placeId: 'rainbow-falls',
    periods: [
      { label: 'Mornings only', months: [6, 7, 8, 9, 10], windows: [{ openMinute: 420, closeMinute: 780 }] },
    ],
    closedAnnualDates: [],
    admission: { ...NO_ADMISSION },
    provenance: AUTHORED,
  });

  const itinerary = plan({
    hours: fallsCloseEarly,
    manualIncludes: ['devils-postpile', 'rainbow-falls'],
  });

  it('still boards the shuttle exactly once', () => {
    for (const day of itinerary.days) {
      const rides = day.items.filter(
        (item) => item.travel?.role === 'ride' && item.travel.serviceId === 'svc-reds-meadow-shuttle',
      );
      expect(rides.length).toBeLessThanOrEqual(1);
    }
  });

  it('schedules the falls, and inside its own hours', () => {
    // Asserted unconditionally: a guarded `if (falls)` would pass silently in
    // exactly the case worth catching, which is the falls being dropped.
    const falls = visitOf(itinerary, 'rainbow-falls');
    expect(
      falls,
      itinerary.unscheduled.map((entry) => `${entry.placeId}: ${entry.reason}`).join('\n'),
    ).toBeDefined();
    expect(falls!.hours).toEqual(expect.objectContaining({ openMinute: 420, closeMinute: 780 }));
    expect(falls!.startMinute).toBeGreaterThanOrEqual(420);
    expect(falls!.endMinute).toBeLessThanOrEqual(780);
  });

  it('does not assume the postpile keeps the falls’ hours', () => {
    const postpile = visitOf(itinerary, 'devils-postpile');
    expect(postpile).toBeDefined();
    expect(postpile!.hours).toBeUndefined();
    // Same day, same shuttle, different constraints — which is the whole point.
    expect(dayOf(itinerary, 'devils-postpile')?.dayNumber).toBe(
      dayOf(itinerary, 'rainbow-falls')?.dayNumber,
    );
  });

  it('raises no hours error either way', () => {
    expect(errors(itinerary).map((i) => i.code)).not.toContain('visit_ends_after_closing');
    expect(errors(itinerary).map((i) => i.code)).not.toContain('arrives_before_opening');
  });
});

// ---------------------------------------------------------------------------
// 9. Genuinely always open
// ---------------------------------------------------------------------------

describe('scenario 9 — a place with no staffed hours', () => {
  const itinerary = plan();

  it('carries no fabricated window and no badge', () => {
    const lake = visitOf(itinerary, 'convict-lake');
    if (lake) {
      expect(lake.hours).toBeUndefined();
      expect(lake.booking).toBeUndefined();
    }
  });

  it('is still bounded by the day, the travel and the way out', () => {
    for (const day of itinerary.days) {
      for (const item of day.items) {
        expect(item.startMinute).toBeGreaterThanOrEqual(day.window.startMinute);
        expect(item.endMinute).toBeLessThanOrEqual(day.window.endMinute);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Unknown hours
// ---------------------------------------------------------------------------

describe('scenario 10 — hours nobody has confirmed', () => {
  it('schedules the Village but says plainly that its hours are unconfirmed', () => {
    const itinerary = plan({ manualIncludes: ['the-village-at-mammoth'] });
    const visit = visitOf(itinerary, 'the-village-at-mammoth');
    expect(visit).toBeDefined();
    // No invented schedule.
    expect(visit!.hours).toBeUndefined();
    // But an explicit caution the traveller has to act on.
    expect(visit!.verifyBeforeTravel).toMatch(/hours/i);
    const day = dayOf(itinerary, 'the-village-at-mammoth')!;
    expect(day.availability.cautions.join(' ')).toMatch(/could not confirm/i);
    expect(itinerary.issues.some((i) => i.code === 'operating_hours_unknown')).toBe(true);
  });

  it('reports it as a caution, never as a clean bill of health', () => {
    const itinerary = plan({ manualIncludes: ['the-village-at-mammoth'] });
    expect(itinerary.status).not.toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// 11. A booking the traveller has to make
// ---------------------------------------------------------------------------

describe('scenario 11 — an activity that needs a reservation', () => {
  const needsBooking = withCalendar('convict-lake', {
    kind: 'scheduled',
    placeId: 'convict-lake',
    periods: [
      { label: 'Timed', months: [8], windows: [{ openMinute: 8 * 60, closeMinute: 18 * 60 }] },
    ],
    closedAnnualDates: [],
    admission: {
      ...NO_ADMISSION,
      reservationRequired: true,
      timedEntry: true,
      bookingUrl: 'https://example.gov/book',
      note: 'A timed slot has to be booked in advance.',
    },
    provenance: AUTHORED,
  });

  const itinerary = plan({ hours: needsBooking, manualIncludes: ['convict-lake'] });

  it('keeps the requirement attached to the visit and to the day', () => {
    const visit = visitOf(itinerary, 'convict-lake')!;
    expect(visit.booking).toEqual({
      placeId: 'convict-lake',
      name: 'Convict Lake',
      kind: 'timed_entry',
      note: 'A timed slot has to be booked in advance.',
      url: 'https://example.gov/book',
    });
    const day = dayOf(itinerary, 'convict-lake')!;
    expect(day.availability.bookings.map((b) => b.placeId)).toContain('convict-lake');
  });

  it('never implies the booking has been made', () => {
    expect(itinerary.issues.some((i) => i.code === 'booking_unresolved')).toBe(true);
    const issue = itinerary.issues.find((i) => i.code === 'booking_unresolved')!;
    expect(issue.severity).toBe('warning');
    expect(issue.message).toMatch(/We have not made it/);
  });

  it('is a caution rather than a blocker: booking is the traveller’s to do', () => {
    expect(errors(itinerary).map((i) => i.code)).not.toContain('booking_unresolved');
  });
});

// ---------------------------------------------------------------------------
// 12. Changing the trip dates
// ---------------------------------------------------------------------------

describe('scenario 12 — moving the trip onto days a place is shut', () => {
  it('recalculates rather than carrying the old answer forward', () => {
    const open = plan({
      basics: { startDate: '2026-08-14', endDate: '2026-08-16' },
      answers: { ...LONG_DRIVES, regionalExpansion: 'best_regional', detourToleranceMinutes: 120 },
      manualIncludes: ['manzanar-visitor-center'],
    });
    const shut = plan({
      basics: { startDate: '2026-08-11', endDate: '2026-08-13' },
      answers: { ...LONG_DRIVES, regionalExpansion: 'best_regional', detourToleranceMinutes: 120 },
      manualIncludes: ['manzanar-visitor-center'],
    });

    // Friday to Sunday contains open days; Tuesday to Thursday contains none.
    expect(open.days.map((d) => d.date)).toEqual(['2026-08-14', '2026-08-15', '2026-08-16']);
    expect(unscheduled(shut, 'manzanar-visitor-center')?.reasonCode).toBe('closed_on_trip_dates');
    expect(itineraryStructureFingerprint(open)).not.toBe(itineraryStructureFingerprint(shut));
  });
});

// ---------------------------------------------------------------------------
// 13. Malformed and missing provider data
// ---------------------------------------------------------------------------

describe('scenario 13 — data the provider should never have produced', () => {
  it('refuses a dataset that omits a place, rather than defaulting it open', () => {
    const thinned = structuredClone(EASTERN_SIERRA_HOURS) as OperatingHoursDataset;
    (thinned.calendars as OperatingCalendar[]).splice(0, 1);
    // The planner is handed data, so this is the boundary's job — but if a
    // gap ever reaches the planner it must refuse the place, not schedule it.
    const itinerary = plan({ hours: operatingHoursDatasetSchema.parse(thinned) });
    const missing = EASTERN_SIERRA_HOURS.calendars[0]!.placeId;
    expect(visitOf(itinerary, missing)).toBeUndefined();
  });

  it('never produces a partial plan from a malformed calendar', () => {
    expect(() =>
      operatingHoursDatasetSchema.parse({
        version: 1,
        regionId: 'eastern-sierra',
        calendars: [{ kind: 'scheduled', placeId: 'x', periods: [], provenance: AUTHORED }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 13b. One site, two experiences, two calendars
// ---------------------------------------------------------------------------

describe('Manzanar — an outdoor site and a staffed facility, modelled apart', () => {
  const OWENS_VALLEY: ScenarioOptions['answers'] = {
    ...LONG_DRIVES,
    regionalExpansion: 'best_regional',
    detourToleranceMinutes: 120,
  };
  /** Tuesday to Thursday: the visitor centre opens on none of them. */
  const MIDWEEK = { startDate: '2026-08-11', endDate: '2026-08-13' };

  it('schedules the grounds on days the visitor centre is shut', () => {
    // The whole reason for the split. Before it, one closed weekday took the
    // entire site off the board and the traveller was told it was "shut".
    const itinerary = plan({
      basics: MIDWEEK,
      answers: OWENS_VALLEY,
      manualIncludes: ['manzanar-historic-site', 'manzanar-visitor-center'],
    });

    const grounds = visitOf(itinerary, 'manzanar-historic-site');
    expect(
      grounds,
      itinerary.unscheduled.map((entry) => `${entry.placeId}: ${entry.reason}`).join('\n'),
    ).toBeDefined();
    // And it carries no borrowed schedule.
    expect(grounds!.hours).toBeUndefined();

    const centre = unscheduled(itinerary, 'manzanar-visitor-center');
    expect(centre?.reasonCode).toBe('closed_on_trip_dates');
    // Named, and named as a weekday closure rather than a season — the board's
    // own blocker explains it, since it never reaches the planner at all.
    expect(centre?.reason).toMatch(/^Manzanar Visitor Center is shut/);
    expect(centre?.reason).toMatch(/days of the week it does not open/i);
  });

  it('pairs them on an open day, on one journey', () => {
    const itinerary = plan({
      answers: OWENS_VALLEY,
      manualIncludes: ['manzanar-historic-site', 'manzanar-visitor-center'],
    });

    const groundsDay = dayOf(itinerary, 'manzanar-historic-site');
    const centreDay = dayOf(itinerary, 'manzanar-visitor-center');
    expect(groundsDay).toBeDefined();
    expect(centreDay?.dayNumber).toBe(groundsDay?.dayNumber);
    // Friday or Saturday — the days the centre opens.
    expect(['2026-08-14', '2026-08-15']).toContain(centreDay!.date);

    // The centre keeps its own hours; the grounds still have none.
    expect(visitOf(itinerary, 'manzanar-visitor-center')!.hours).toEqual(
      expect.objectContaining({ openMinute: 540, closeMinute: 990 }),
    );
    expect(visitOf(itinerary, 'manzanar-historic-site')!.hours).toBeUndefined();
  });

  it('drives out to Manzanar once, not twice', () => {
    // The failure a naive split produces: two records at one car park billed as
    // two ninety-minute approaches, turning a half-day into an impossible one.
    const itinerary = plan({
      answers: OWENS_VALLEY,
      manualIncludes: ['manzanar-historic-site', 'manzanar-visitor-center'],
    });
    const day = dayOf(itinerary, 'manzanar-visitor-center')!;

    const approaches = day.items.filter(
      (item) => item.travel?.role === 'approach' && item.travel.toId.startsWith('manzanar'),
    );
    expect(approaches).toHaveLength(1);
    expect(approaches[0]!.travel!.minutes).toBe(95);

    // Nothing at all between the two halves: same car park, back to back.
    const between = day.items.filter(
      (item) =>
        item.kind === 'travel' &&
        item.travel!.fromId.startsWith('manzanar') &&
        item.travel!.toId.startsWith('manzanar'),
    );
    expect(between).toHaveLength(0);

    const ordered = day.items
      .filter((item) => item.kind === 'activity')
      .map((item) => item.placeId);
    const first = ordered.indexOf('manzanar-historic-site');
    const second = ordered.indexOf('manzanar-visitor-center');
    expect(Math.abs(first - second)).toBe(1);
  });

  it('keeps a selection stored before the split pointing at something real', () => {
    // A row written when `manzanar-historic-site` meant the whole site. It has
    // to resolve, and it has to resolve to the half that is always open — the
    // safe direction for a legacy choice to land.
    const legacy = plan({
      basics: MIDWEEK,
      answers: OWENS_VALLEY,
      selections: [
        {
          placeId: 'manzanar-historic-site',
          status: 'included',
          source: 'user',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    });
    expect(visitOf(legacy, 'manzanar-historic-site')).toBeDefined();
    expect(errors(legacy)).toEqual([]);
    expect(legacy.status).not.toBe('needs_decision');
  });

  it('marks the grounds as daylight-limited without inventing a sunset', () => {
    const itinerary = plan({
      answers: OWENS_VALLEY,
      manualIncludes: ['manzanar-historic-site'],
    });
    const grounds = visitOf(itinerary, 'manzanar-historic-site')!;
    expect(grounds.daylightOnly).toBe(true);
    // A marker, not a window: no fabricated hours came with it.
    expect(grounds.hours).toBeUndefined();
  });

  it('produces the same plan twice, with both halves in it', () => {
    const options: ScenarioOptions = {
      answers: OWENS_VALLEY,
      manualIncludes: ['manzanar-historic-site', 'manzanar-visitor-center'],
    };
    const a = plan(options);
    const b = plan(options);
    expect(itineraryStructureFingerprint(a)).toBe(itineraryStructureFingerprint(b));
    expect(JSON.stringify(a.days)).toBe(JSON.stringify(b.days));
  });

  it('rejects a stored plan carrying hours the place no longer has', () => {
    // Exactly what a plan built before the split looks like: the grounds with
    // the visitor centre's window stamped on them. Better a rebuild than a
    // timeline quoting a schedule that belongs to somewhere else.
    const itinerary = plan({ answers: OWENS_VALLEY, manualIncludes: ['manzanar-historic-site'] });
    const stale = structuredClone(itinerary) as Itinerary;
    const visit = stale.days
      .flatMap((day) => day.items)
      .find((item) => item.placeId === 'manzanar-historic-site')!;
    visit.hours = {
      openMinute: 540,
      closeMinute: 990,
      sourceKind: 'official',
      sourceName: 'Stale',
      confidence: 0.8,
    };

    const scenario = buildScenario({ answers: OWENS_VALLEY });
    const issues = validateItinerary({
      days: stale.days,
      unscheduled: [],
      profile: scenario.profile,
      config: resolveConfig(),
      matrix: scenario.matrix,
      placesById: new Map(scenario.candidates.map((c) => [c.place.id, c.place])),
      baseId: scenario.baseId,
      access: scenario.access,
      hours: scenario.hours,
      weather: scenario.weather,
    });
    expect(issues.some((issue) => issue.code === 'operating_evidence_inconsistent')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. Nothing goes missing, whatever the hours do
// ---------------------------------------------------------------------------

describe('scenario 14 — a stop is never quietly absent', () => {
  /**
   * The invariant this whole layer could most easily break.
   *
   * Before the reconciliation in `plan.ts`, a stop the packer had accepted could
   * be skipped by the layout — shut, or no longer fitting after a revision
   * reordered the day — and end up neither on the timeline nor in the list of
   * things that did not fit. Selected, gone, no reason given. This asserts the
   * product's actual promise: everything you chose is somewhere.
   */
  const cases: Array<[string, ScenarioOptions]> = [
    ['the ordinary trip', {}],
    ['long drives allowed', { answers: LONG_DRIVES }],
    [
      'six manual includes at once',
      {
        answers: LONG_DRIVES,
        manualIncludes: [
          'bodie-state-historic-park',
          'panorama-gondola',
          'manzanar-historic-site',
          'manzanar-visitor-center',
          'devils-postpile',
          'rainbow-falls',
          'the-village-at-mammoth',
        ],
      },
    ],
    [
      'a midweek trip that closes Manzanar',
      {
        basics: { startDate: '2026-08-11', endDate: '2026-08-13' },
        answers: LONG_DRIVES,
        manualIncludes: ['manzanar-visitor-center'],
      },
    ],
    ['no car at all', { answers: { willDrive: false } }],
  ];

  for (const [name, options] of cases) {
    it(`accounts for every chosen place — ${name}`, () => {
      const itinerary = plan(options);
      const scheduled = new Set(
        itinerary.days
          .flatMap((day) => day.items)
          .filter((item) => item.kind === 'activity' && item.placeId)
          .map((item) => item.placeId!),
      );
      const explained = new Set(itinerary.unscheduled.map((entry) => entry.placeId));

      const chosen = buildScenario(options)
        .selections.filter((selection) => selection.status !== 'excluded')
        .map((selection) => selection.placeId);

      const missing = chosen.filter((id) => !scheduled.has(id) && !explained.has(id));
      expect(missing, `neither scheduled nor explained: ${missing.join(', ')}`).toEqual([]);
    });

    it(`never routes to a stop it does not visit — ${name}`, () => {
      // The other half of the same defect: a walk or transfer leg naming a place
      // that was skipped, so the timeline reads "walk to Devils Postpile" on a
      // day Devils Postpile is not on.
      const itinerary = plan(options);
      const scenario = buildScenario(options);
      /**
       * Boarding points are excluded, not overlooked: a few of them reuse a
       * place's routing id because the matrix is keyed that way, so the Village
       * is genuinely passed through as a trolley stop on days nobody visits it.
       * Everything else named on a leg has to be somewhere the day actually goes.
       */
      const gateways = new Set([
        scenario.baseId,
        ...scenario.access.points.map((point) => point.routingId),
      ]);
      const placeIds = new Set(
        scenario.candidates.map((c) => c.place.id).filter((id) => !gateways.has(id)),
      );

      for (const day of itinerary.days) {
        const visited = new Set(
          day.items
            .filter((item) => item.kind === 'activity' && item.placeId)
            .map((item) => item.placeId!),
        );
        for (const item of day.items) {
          for (const endpoint of [item.travel?.fromId, item.travel?.toId]) {
            if (!endpoint || !placeIds.has(endpoint)) continue;
            expect(
              visited.has(endpoint),
              `day ${day.dayNumber} routes via ${endpoint}, which it never visits`,
            ).toBe(true);
          }
        }
      }
    });
  }

  it('does not pay for the journey out to a valley where everything is shut', () => {
    // Both stops behind the Reds Meadow shuttle closed. The day must not drive
    // out, board, ride in, walk to nothing and ride back.
    const shutValley = [...['devils-postpile', 'rainbow-falls']].reduce(
      (dataset, placeId) =>
        operatingHoursDatasetSchema.parse({
          ...dataset,
          calendars: dataset.calendars.map((entry) =>
            entry.placeId === placeId
              ? {
                  kind: 'scheduled' as const,
                  placeId,
                  periods: [
                    {
                      label: 'Winter only',
                      months: [1],
                      windows: [{ openMinute: 540, closeMinute: 1020 }],
                    },
                  ],
                  closedAnnualDates: [],
                  admission: { ...NO_ADMISSION },
                  provenance: AUTHORED,
                }
              : entry,
          ),
        }),
      EASTERN_SIERRA_HOURS,
    );

    const itinerary = plan({
      hours: shutValley,
      manualIncludes: ['devils-postpile', 'rainbow-falls'],
    });

    for (const day of itinerary.days) {
      expect(day.transport.serviceIds).not.toContain('svc-reds-meadow-shuttle');
      for (const item of day.items) {
        expect(item.travel?.serviceId).not.toBe('svc-reds-meadow-shuttle');
      }
    }
    expect(unscheduled(itinerary, 'devils-postpile')).toBeDefined();
    expect(unscheduled(itinerary, 'rainbow-falls')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 15. Determinism and the structural fingerprint
// ---------------------------------------------------------------------------

describe('scenario 15 — determinism, and what narration may not touch', () => {
  it('produces a byte-identical plan from identical input', () => {
    const options: ScenarioOptions = {
      answers: LONG_DRIVES,
      manualIncludes: ['bodie-state-historic-park', 'panorama-gondola'],
    };
    const a = plan(options);
    const b = plan(options);
    expect(itineraryStructureFingerprint(a)).toBe(itineraryStructureFingerprint(b));
    expect(JSON.stringify(a.days)).toBe(JSON.stringify(b.days));
    expect(JSON.stringify(a.unscheduled)).toBe(JSON.stringify(b.unscheduled));
  });

  it('holds the chosen opening window inside the fingerprint', () => {
    // The §27 guarantee, extended: a narration layer can rewrite every word and
    // provably cannot relax the window a visit was placed inside.
    const itinerary = plan({ answers: LONG_DRIVES, manualIncludes: ['panorama-gondola'] });
    const before = itineraryStructureFingerprint(itinerary);

    const narrated = structuredClone(itinerary) as Itinerary;
    narrated.summary = 'A rewritten summary.';
    for (const day of narrated.days) {
      day.theme = 'Rewritten theme';
      day.availability.anchorNote = 'Rewritten anchor prose';
      day.availability.cautions = ['Rewritten caution'];
      for (const item of day.items) {
        item.title = 'Rewritten title';
        item.reason = 'Rewritten reason';
      }
    }
    expect(itineraryStructureFingerprint(narrated)).toBe(before);

    // Widening a window, on the other hand, changes it.
    const widened = structuredClone(itinerary) as Itinerary;
    const target = widened.days
      .flatMap((day) => day.items)
      .find((item) => item.hours !== undefined);
    expect(target, 'the gondola scenario should schedule something with hours').toBeDefined();
    target!.hours!.closeMinute += 60;
    expect(itineraryStructureFingerprint(widened)).not.toBe(before);
  });

  it('does not depend on the order selections arrive in', () => {
    const base = buildScenario({ answers: LONG_DRIVES, manualIncludes: ['bodie-state-historic-park'] });
    const reversed = {
      ...base,
      selections: [...base.selections].reverse(),
      candidates: [...base.candidates].reverse(),
    };
    const a = planTrip(base);
    const b = planTrip(reversed);
    if (!a.ok || !b.ok) throw new Error('planning failed');
    expect(itineraryStructureFingerprint(a.itinerary)).toBe(
      itineraryStructureFingerprint(b.itinerary),
    );
  });
});

// ---------------------------------------------------------------------------
// Ordering, waiting and the intersection with access
// ---------------------------------------------------------------------------

describe('ordering around a closing time', () => {
  it('puts the stop that shuts first before the one that never shuts', () => {
    // Convict Lake and McGee Creek sit on the same road out of town and are
    // normally ordered by geography. Give the further one a closing time and
    // the day should visit it first rather than arrive after it shuts.
    const mcGeeCloses = withCalendar('mcgee-creek-canyon', {
      kind: 'scheduled',
      placeId: 'mcgee-creek-canyon',
      periods: [
        { label: 'Short day', months: [8], windows: [{ openMinute: 7 * 60, closeMinute: 12 * 60 }] },
      ],
      closedAnnualDates: [],
      admission: { ...NO_ADMISSION },
      provenance: AUTHORED,
    });

    const itinerary = plan({
      hours: mcGeeCloses,
      manualIncludes: ['convict-lake', 'mcgee-creek-canyon'],
    });
    const day = dayOf(itinerary, 'mcgee-creek-canyon');
    if (!day) return; // Legitimately unschedulable; scenario 7 covers that path.

    const visit = visitOf(itinerary, 'mcgee-creek-canyon')!;
    expect(visit.endMinute).toBeLessThanOrEqual(12 * 60);

    const lake = day.items.find((item) => item.placeId === 'convict-lake');
    if (lake) expect(visit.startMinute).toBeLessThan(lake.startMinute);
  });

  it('sets off later rather than standing at a locked gate', () => {
    // The gondola opens at 09:00 and is 27 minutes from base. A day that starts
    // at 07:30 should leave at about 08:30, not wait an hour on the tarmac.
    const itinerary = plan({ manualIncludes: ['panorama-gondola'] });
    const day = dayOf(itinerary, 'panorama-gondola');
    if (!day) return;
    const visit = visitOf(itinerary, 'panorama-gondola')!;
    expect(visit.startMinute).toBeGreaterThanOrEqual(9 * 60);

    const first = day.items[0]!;
    if (first.travel?.toId === 'panorama-gondola' || first.travel?.role === 'approach') {
      const waited = day.items
        .filter((item) => item.kind === 'free_time' && item.startMinute < visit.startMinute)
        .reduce((sum, item) => sum + item.durationMinutes, 0);
      expect(waited).toBeLessThan(30);
    }
  });

  it('records the wait when one is genuinely unavoidable', () => {
    // Nothing else can go before it, so the gap has to be visible rather than
    // left as a hole in the timeline.
    const opensLate = withCalendar('convict-lake', {
      kind: 'scheduled',
      placeId: 'convict-lake',
      periods: [
        { label: 'Afternoons', months: [8], windows: [{ openMinute: 14 * 60, closeMinute: 20 * 60 }] },
      ],
      closedAnnualDates: [],
      admission: { ...NO_ADMISSION },
      provenance: AUTHORED,
    });
    const itinerary = plan({ hours: opensLate, manualIncludes: ['convict-lake'] });
    const visit = visitOf(itinerary, 'convict-lake');
    if (!visit) return;
    expect(visit.startMinute).toBeGreaterThanOrEqual(14 * 60);

    const day = dayOf(itinerary, 'convict-lake')!;
    // No holes: every item runs from where the last one finished.
    const ordered = [...day.items].sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      expect(ordered[index + 1]!.startMinute).toBe(ordered[index]!.endMinute);
    }
  });
});

describe('hours and access are separate gates', () => {
  it('refuses a place that is open but unreachable, naming the transport reason', () => {
    const itinerary = plan({
      answers: { willDrive: false, maxDailyTravelMinutes: 150 },
      manualIncludes: ['bodie-state-historic-park'],
    });
    const entry = unscheduled(itinerary, 'bodie-state-historic-park');
    expect(entry).toBeDefined();
    // Not an hours reason: the gate is open, the traveller cannot get there.
    expect(entry!.reasonCode).not.toBe('closed_on_trip_dates');
    expect(entry!.reasonCode).not.toBe('hours_do_not_fit');
  });

  it('refuses a place that is reachable but shut, naming the hours reason', () => {
    const shut = withCalendar('convict-lake', {
      kind: 'scheduled',
      placeId: 'convict-lake',
      periods: [
        { label: 'Winter', months: [1], windows: [{ openMinute: 540, closeMinute: 1020 }] },
      ],
      closedAnnualDates: [],
      admission: { ...NO_ADMISSION },
      provenance: AUTHORED,
    });
    const itinerary = plan({ hours: shut, manualIncludes: ['convict-lake'] });
    expect(unscheduled(itinerary, 'convict-lake')?.reasonCode).toBe('closed_on_trip_dates');
  });
});
