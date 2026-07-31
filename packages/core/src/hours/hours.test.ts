import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA_HOURS, easternSierraHoursProvider } from '../data/hours';
import { EASTERN_SIERRA_PLACES } from '../data/places';
import { placesWithoutOperatingHours } from '../data/index';
import { intersectMinuteIntervals, intervalHolds } from '../time/interval';
import { assertCalendarDate, dayOfWeekFor, monthDayFor, monthFor } from '../schemas/calendar';
import { operatingCalendarSchema, operatingHoursDatasetSchema } from '../schemas/hours';
import { assessOperatingHours, operatingOn } from './availability';
import {
  OperatingHoursDataError,
  validateOperatingHoursDataset,
} from './provider';

/** The Wednesday-to-Saturday span the rest of the fixtures use. */
const AUGUST = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

const PROVENANCE = {
  kind: 'authored' as const,
  sourceName: 'Test',
  confidence: 0.5,
  volatility: 'stable' as const,
};

function calendar(overrides: Record<string, unknown>) {
  return operatingCalendarSchema.parse({
    kind: 'scheduled',
    placeId: 'test-place',
    periods: [
      {
        label: 'All year',
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        windows: [{ openMinute: 540, closeMinute: 1020 }],
      },
    ],
    provenance: PROVENANCE,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Interval arithmetic — the one mechanism every stage shares
// ---------------------------------------------------------------------------

describe('minute intervals', () => {
  it('intersects overlapping ranges', () => {
    expect(
      intersectMinuteIntervals({ startMinute: 540, endMinute: 1020 }, { startMinute: 600, endMinute: 1200 }),
    ).toEqual({ startMinute: 600, endMinute: 1020 });
  });

  it('returns null when two ranges do not meet', () => {
    expect(
      intersectMinuteIntervals({ startMinute: 0, endMinute: 300 }, { startMinute: 400, endMinute: 500 }),
    ).toBeNull();
  });

  it('treats ranges that touch at one minute as touching, not overlapping', () => {
    // The itinerary timeline packs items back to back and the validator reads
    // `next.start === current.end` as legal. Intervals have to agree, or a
    // visit that ends exactly at closing reads as a violation in one place and
    // a fit in another.
    const met = intersectMinuteIntervals(
      { startMinute: 0, endMinute: 600 },
      { startMinute: 600, endMinute: 900 },
    );
    expect(met).toEqual({ startMinute: 600, endMinute: 600 });
    expect(intervalHolds(met!, 0)).toBe(true);
    expect(intervalHolds(met!, 1)).toBe(false);
  });

  it('knows whether what is left can hold the visit', () => {
    expect(intervalHolds({ startMinute: 540, endMinute: 780 }, 240)).toBe(true);
    expect(intervalHolds({ startMinute: 540, endMinute: 780 }, 241)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Calendar primitives
// ---------------------------------------------------------------------------

describe('calendar dates', () => {
  it('reads weekdays in UTC so the answer does not depend on where the server is', () => {
    // 2026-08-12 is a Wednesday. 3 = Wednesday with 0 = Sunday.
    expect(dayOfWeekFor('2026-08-12')).toBe(3);
    expect(dayOfWeekFor('2026-08-15')).toBe(6);
  });

  it('rejects a date that is not a real day, in both halves of the check', () => {
    // `Date.parse` rolls 2026-02-30 forward to March 2. Left alone, a month
    // check reads February while a weekday check reads March.
    expect(() => assertCalendarDate('2026-02-30')).toThrow(/not a calendar date/);
    expect(() => monthFor('2026-02-30')).toThrow(/not a calendar date/);
    expect(() => dayOfWeekFor('2026-02-30')).toThrow(/not a calendar date/);
    expect(() => monthDayFor('2026-13-01')).toThrow(/not a calendar date/);
  });
});

// ---------------------------------------------------------------------------
// Schema guards
// ---------------------------------------------------------------------------

describe('operating calendar schema', () => {
  it('rejects a window that closes before it opens rather than wrapping it', () => {
    // Overnight opening is a real thing and is not modelled. Silently wrapping
    // would schedule a visit that starts today and ends yesterday.
    expect(() =>
      calendar({
        periods: [{ label: 'Night', months: [1], windows: [{ openMinute: 1320, closeMinute: 120 }] }],
      }),
    ).toThrow(/overnight/i);
  });

  it('rejects a zero-length window', () => {
    expect(() =>
      calendar({
        periods: [{ label: 'X', months: [1], windows: [{ openMinute: 600, closeMinute: 600 }] }],
      }),
    ).toThrow();
  });

  it('rejects a last admission outside its own window', () => {
    expect(() =>
      calendar({
        periods: [
          {
            label: 'X',
            months: [1],
            windows: [{ openMinute: 540, closeMinute: 1020, lastAdmissionMinute: 1080 }],
          },
        ],
      }),
    ).toThrow(/last admission/i);
  });

  it('rejects two opening windows on one day that overlap', () => {
    expect(() =>
      calendar({
        periods: [
          {
            label: 'Split',
            months: [1],
            windows: [
              { openMinute: 540, closeMinute: 780 },
              { openMinute: 700, closeMinute: 1020 },
            ],
          },
        ],
      }),
    ).toThrow(/overlap/i);
  });

  it('rejects timed entry that does not also require a reservation', () => {
    expect(() =>
      calendar({
        admission: {
          reservationRequired: false,
          timedEntry: true,
          note: 'Book a slot.',
        },
      }),
    ).toThrow(/reservation/i);
  });

  it('rejects a booking requirement with nothing telling the traveller what to do', () => {
    expect(() => calendar({ admission: { reservationRequired: true } })).toThrow(/note or an official link/i);
  });

  it('rejects hours that change without notice and carry no recheck note', () => {
    expect(() =>
      operatingHoursDatasetSchema.parse({
        version: 1,
        regionId: 'r',
        calendars: [
          {
            kind: 'always_open',
            placeId: 'p',
            provenance: { ...PROVENANCE, volatility: 'dynamic' },
          },
        ],
      }),
    ).toThrow(/recheck note/i);
  });

  it('refuses to call unknown hours official', () => {
    expect(() =>
      operatingHoursDatasetSchema.parse({
        version: 1,
        regionId: 'r',
        calendars: [
          {
            kind: 'unknown',
            placeId: 'p',
            provenance: {
              kind: 'official',
              sourceName: 'X',
              lastVerified: '2026-07-30',
              confidence: 0.9,
              volatility: 'stable',
            },
          },
        ],
      }),
    ).toThrow(/cannot have official provenance/i);
  });
});

// ---------------------------------------------------------------------------
// Resolving a calendar against a date
// ---------------------------------------------------------------------------

describe('operatingOn', () => {
  it('reports a closed weekday as a weekday closure, not as a season', () => {
    // The remedy differs: one is "come on Friday", the other is "come in June".
    const weekdays = calendar({
      periods: [
        {
          label: 'Visitor centre',
          months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
          daysOfWeek: [0, 1, 5, 6],
          windows: [{ openMinute: 540, closeMinute: 990 }],
        },
      ],
    });
    expect(operatingOn(weekdays, '2026-08-12').status).toBe('closed');
    expect(operatingOn(weekdays, '2026-08-12').closedReason).toBe('closed_weekday');
    expect(operatingOn(weekdays, '2026-08-14').status).toBe('open');
  });

  it('reports a month outside every period as out of season', () => {
    const summer = calendar({
      periods: [{ label: 'Summer', months: [6, 7, 8], windows: [{ openMinute: 540, closeMinute: 1020 }] }],
    });
    expect(operatingOn(summer, '2026-12-01').closedReason).toBe('out_of_season');
  });

  it('honours a published annual closure', () => {
    const christmas = calendar({ closedAnnualDates: ['12-25'] });
    expect(operatingOn(christmas, '2026-12-25').closedReason).toBe('closed_date');
    expect(operatingOn(christmas, '2026-12-24').status).toBe('open');
  });

  it('returns both halves of a split day, in order', () => {
    const split = calendar({
      periods: [
        {
          label: 'Split',
          months: [8],
          windows: [
            { openMinute: 780, closeMinute: 1020 },
            { openMinute: 540, closeMinute: 720 },
          ],
        },
      ],
    });
    expect(operatingOn(split, '2026-08-12').windows.map((w) => w.openMinute)).toEqual([540, 780]);
  });

  it('never invents a window for a place whose hours are unknown', () => {
    const unknown = operatingCalendarSchema.parse({
      kind: 'unknown',
      placeId: 'p',
      provenance: PROVENANCE,
    });
    const onDate = operatingOn(unknown, '2026-08-12');
    expect(onDate.status).toBe('unknown');
    expect(onDate.windows).toEqual([]);
  });
});

describe('assessOperatingHours across a trip', () => {
  it('separates "open every day" from "open some days" from "shut throughout"', () => {
    const monFri = calendar({
      periods: [
        {
          label: 'Weekdays',
          months: [8],
          daysOfWeek: [1, 2, 3, 4, 5],
          windows: [{ openMinute: 540, closeMinute: 1020 }],
        },
      ],
    });
    expect(assessOperatingHours({ calendar: monFri, dates: AUGUST }).status).toBe('open_some_days');
    expect(assessOperatingHours({ calendar: monFri, dates: ['2026-08-15'] }).status).toBe(
      'closed_throughout',
    );
    expect(assessOperatingHours({ calendar: monFri, dates: ['2026-08-12'] }).status).toBe(
      'open_every_day',
    );
  });

  it('puts no badge at all on a place with no hours', () => {
    // Seventeen of twenty-three places here have no closing time. A badge on every
    // one of them is a badge nobody reads.
    const open = operatingCalendarSchema.parse({
      kind: 'always_open',
      placeId: 'p',
      provenance: PROVENANCE,
    });
    const assessment = assessOperatingHours({ calendar: open, dates: AUGUST });
    expect(assessment.status).toBe('always_open');
    expect(assessment.badges).toEqual([]);
    expect(assessment.hoursSummary).toBeNull();
  });

  it('summarises the hours of this trip rather than the whole year', () => {
    const assessment = assessOperatingHours({ calendar: calendar({}), dates: AUGUST });
    expect(assessment.hoursSummary).toBe('09:00–17:00');
    expect(assessment.badges).toContain('limited_hours');
  });

  it('does not call a sixteen-hour day-use window "limited hours"', () => {
    // Several Forest Service sites here post day use 06:00–22:00. No trip day
    // this planner builds is that long, so those hours cannot constrain
    // anything, and a badge that fires when nothing is wrong trains people to
    // ignore it on the card where something is.
    const dayUse = calendar({
      periods: [
        {
          label: 'Day use',
          months: [8],
          windows: [{ openMinute: 6 * 60, closeMinute: 22 * 60 }],
        },
      ],
    });
    expect(assessOperatingHours({ calendar: dayUse, dates: AUGUST }).badges).not.toContain(
      'limited_hours',
    );
  });

  it('surfaces a published last admission and nothing when there is none', () => {
    const withLast = calendar({
      periods: [
        {
          label: 'X',
          months: [8],
          windows: [{ openMinute: 540, closeMinute: 1080, lastAdmissionMinute: 1065 }],
        },
      ],
    });
    expect(assessOperatingHours({ calendar: withLast, dates: AUGUST }).lastAdmissionSummary).toBe(
      'Last entry 17:45',
    );
    expect(assessOperatingHours({ calendar: calendar({}), dates: AUGUST }).lastAdmissionSummary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The provider boundary
// ---------------------------------------------------------------------------

describe('the operating-hours provider boundary', () => {
  it('accepts what the offline provider returns, through the same gate a live one would cross', async () => {
    const dataset = await easternSierraHoursProvider.getOperatingHours({
      regionId: 'eastern-sierra',
      placeIds: EASTERN_SIERRA_PLACES.map((place) => place.id),
      dates: AUGUST,
    });
    expect(() =>
      validateOperatingHoursDataset(dataset, {
        regionId: 'eastern-sierra',
        placeIds: EASTERN_SIERRA_PLACES.map((place) => place.id),
      }),
    ).not.toThrow();
  });

  it('refuses to answer for a region it does not hold', async () => {
    await expect(
      easternSierraHoursProvider.getOperatingHours({
        regionId: 'alaska',
        placeIds: [],
        dates: AUGUST,
      }),
    ).rejects.toThrow(/No opening-hours data/);
  });

  it('accepts the real seed dataset', () => {
    expect(() =>
      validateOperatingHoursDataset(EASTERN_SIERRA_HOURS, {
        regionId: 'eastern-sierra',
        placeIds: EASTERN_SIERRA_PLACES.map((place) => place.id),
      }),
    ).not.toThrow();
  });

  it('refuses a dataset that leaves a place out rather than assuming it is open', () => {
    // The whole point: silence must not read as "open whenever you like".
    try {
      validateOperatingHoursDataset(EASTERN_SIERRA_HOURS, {
        regionId: 'eastern-sierra',
        placeIds: ['convict-lake', 'somewhere-nobody-checked'],
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OperatingHoursDataError);
      expect((error as OperatingHoursDataError).code).toBe('incomplete_coverage');
      expect((error as OperatingHoursDataError).message).toMatch(/will not assume a place is open/);
    }
  });

  it('refuses malformed data with a useful code, not a silent fallback', () => {
    try {
      validateOperatingHoursDataset(
        { version: 1, regionId: 'eastern-sierra', calendars: [{ kind: 'nonsense' }] },
        { regionId: 'eastern-sierra', placeIds: [] },
      );
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as OperatingHoursDataError).code).toBe('invalid_dataset');
    }
  });

  it('refuses hours belonging to another region', () => {
    try {
      validateOperatingHoursDataset(EASTERN_SIERRA_HOURS, { regionId: 'alaska', placeIds: [] });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as OperatingHoursDataError).code).toBe('unknown_region');
    }
  });
});

describe('the Eastern Sierra hours fixture', () => {
  it('covers every seeded place', () => {
    expect(placesWithoutOperatingHours()).toEqual([]);
  });

  it('keeps the region overwhelmingly unscheduled, because it is', () => {
    // A regression guard on judgement rather than on code: if a later change
    // starts giving trailheads synthetic opening hours, this fails. Note what
    // is *not* here: the Manzanar grounds. Staffed hours belong to the visitor
    // centre, and the site around it is open every day.
    const scheduled = EASTERN_SIERRA_HOURS.calendars.filter((c) => c.kind === 'scheduled');
    expect(scheduled.map((c) => c.placeId).sort()).toEqual([
      'bodie-state-historic-park',
      'earthquake-fault',
      'hot-creek-geologic-site',
      'inyo-craters',
      'manzanar-visitor-center',
      'panorama-gondola',
    ]);
  });

  it('encodes Bodie’s two seasons and its entry cutoff', () => {
    const bodie = EASTERN_SIERRA_HOURS.calendars.find(
      (c) => c.placeId === 'bodie-state-historic-park',
    )!;
    const august = operatingOn(bodie, '2026-08-12');
    expect(august.windows).toEqual([
      { openMinute: 540, closeMinute: 1080, lastAdmissionMinute: 1065 },
    ]);
    const october = operatingOn(bodie, '2026-10-12');
    expect(october.windows).toEqual([
      { openMinute: 540, closeMinute: 960, lastAdmissionMinute: 945 },
    ]);
  });

  it('models Manzanar as two places, and only one of them is staffed', () => {
    // The conflation this split exists to undo: one record cannot hold a site
    // that never closes and a building that shuts three days a week.
    const grounds = EASTERN_SIERRA_HOURS.calendars.find(
      (entry) => entry.placeId === 'manzanar-historic-site',
    )!;
    const centre = EASTERN_SIERRA_HOURS.calendars.find(
      (entry) => entry.placeId === 'manzanar-visitor-center',
    )!;

    expect(grounds.kind).toBe('always_open');
    expect(grounds.daylightOnly).toBe(true);
    expect(centre.kind).toBe('scheduled');
    expect(centre.provenance.volatility).toBe('dynamic');

    // Wednesday 12 August 2026: the grounds open, the centre shut.
    expect(operatingOn(grounds, '2026-08-12').status).toBe('always_open');
    expect(operatingOn(centre, '2026-08-12').closedReason).toBe('closed_weekday');
    // Friday: both.
    expect(operatingOn(centre, '2026-08-14').status).toBe('open');
  });

  it('marks daylight dependence without inventing sunrise or sunset', () => {
    const daylight = EASTERN_SIERRA_HOURS.calendars.filter((entry) => entry.daylightOnly);
    expect(daylight.map((entry) => entry.placeId).sort()).toEqual([
      'mammoth-lakes-basin',
      'manzanar-historic-site',
    ]);
    // A marker on an otherwise unrestricted place, never a fabricated window.
    for (const entry of daylight) {
      expect(entry.kind).toBe('always_open');
      const assessment = assessOperatingHours({ calendar: entry, dates: AUGUST });
      expect(assessment.hoursSummary).toBeNull();
      expect(assessment.badges).toContain('daylight_only');
      expect(assessment.cautions.join(' ')).toMatch(/do not work out sunrise and sunset/i);
    }
  });

  it('never claims a verification date for data nobody verified', () => {
    for (const entry of EASTERN_SIERRA_HOURS.calendars) {
      if (entry.provenance.kind === 'authored') {
        expect(entry.provenance.lastVerified).toBeUndefined();
      } else {
        expect(entry.provenance.lastVerified).toBeDefined();
      }
    }
  });
});
