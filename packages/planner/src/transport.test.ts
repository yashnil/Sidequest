import { describe, expect, it } from 'vitest';
import {
  accessDatasetSchema,
  assessPlaceAccess,
  capabilityFromProfile,
  dayOfWeekFor,
  evaluateRule,
  itineraryStructureFingerprint,
  serviceAvailabilityOn,
  uncoveredPlaceIds,
  validateAccessDataset,
  type AccessDataset,
  type Itinerary,
  type ItineraryDay,
} from '@sidequest/core';
import { planTrip } from './plan';
import { buildScenario, type ScenarioOptions } from './testing/scenario';
import { buildTransportStrategy } from './strategy';
import { validateStrategy } from './validate';
import {
  EASTERN_SIERRA_ACCESS,
  easternSierraAccessProvider,
} from '@sidequest/core/data';

/**
 * The transportation slice, scenario by scenario.
 *
 * These are the cases that decide whether the planner understands *access* or
 * merely geography. Every one of them is a plan that a distance-only planner
 * would happily produce and a traveller could not execute.
 */

function plan(options: ScenarioOptions = {}): Itinerary {
  const result = planTrip(buildScenario(options));
  if (!result.ok) throw new Error(`Planning failed: ${result.code} — ${result.message}`);
  return result.itinerary;
}

function activities(itinerary: Itinerary): string[] {
  return itinerary.days.flatMap((day) =>
    day.items.filter((item) => item.kind === 'activity').map((item) => item.placeId!),
  );
}

function errors(itinerary: Itinerary) {
  return itinerary.issues.filter((issue) => issue.severity === 'error');
}

function travelLegs(day: ItineraryDay) {
  return day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!);
}

function unscheduled(itinerary: Itinerary, placeId: string) {
  return itinerary.unscheduled.find((entry) => entry.placeId === placeId);
}

/** The dataset with one service edited, so a calendar rule can be exercised. */
function withService(
  patch: (dataset: AccessDataset) => AccessDataset,
): AccessDataset {
  return accessDatasetSchema.parse(patch(structuredClone(EASTERN_SIERRA_ACCESS)));
}

const REDS_MEADOW = ['devils-postpile', 'rainbow-falls'];

// ---------------------------------------------------------------------------
// Calendar primitives
// ---------------------------------------------------------------------------

describe('service calendars', () => {
  it('reads the weekday off a date label rather than an instant', () => {
    // 2026-08-12 is a Wednesday. Parsed locally, anyone west of Greenwich would
    // read Tuesday, and a Wednesday-only bus would silently run on Tuesdays.
    expect(dayOfWeekFor('2026-08-12')).toBe(3);
    expect(dayOfWeekFor('2026-08-15')).toBe(6);
    expect(dayOfWeekFor('2027-01-01')).toBe(5);
  });

  it('says which of season and weekday failed, not merely that it failed', () => {
    const shuttle = EASTERN_SIERRA_ACCESS.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
    expect(serviceAvailabilityOn(shuttle, '2026-08-12')).toEqual({ available: true });

    const winter = serviceAvailabilityOn(shuttle, '2027-01-12');
    expect(winter).toEqual({ available: false, reason: 'out_of_season' });

    const weekendOnly = withService((dataset) => {
      const service = dataset.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
      service.daysOfWeek = [0, 6];
      return dataset;
    });
    const patched = weekendOnly.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
    expect(serviceAvailabilityOn(patched, '2026-08-12')).toEqual({
      available: false,
      reason: 'not_this_weekday',
    });
    expect(serviceAvailabilityOn(patched, '2026-08-15')).toEqual({ available: true });
  });

  it('rejects a service window that cannot be executed', () => {
    const shuttle = EASTERN_SIERRA_ACCESS.services[0]!;
    const backwards = accessDatasetSchema.safeParse({
      ...EASTERN_SIERRA_ACCESS,
      services: [
        {
          ...shuttle,
          window: { firstDeparture: 600, lastOutboundDeparture: 500, lastReturnDeparture: 700 },
        },
      ],
    });
    expect(backwards.success).toBe(false);

    const pastMidnight = accessDatasetSchema.safeParse({
      ...EASTERN_SIERRA_ACCESS,
      services: [
        {
          ...shuttle,
          window: { firstDeparture: 600, lastOutboundDeparture: 700, lastReturnDeparture: 1440 },
        },
      ],
    });
    // Crossing midnight is not modelled. Rejecting it beats pretending it works.
    expect(pastMidnight.success).toBe(false);
  });
});

describe('the access provider boundary', () => {
  it('accepts the region dataset and reports the region it is for', () => {
    const dataset = validateAccessDataset(EASTERN_SIERRA_ACCESS, {
      regionId: 'eastern-sierra',
      placeIds: REDS_MEADOW,
    });
    expect(dataset.regionId).toBe('eastern-sierra');
  });

  it('refuses a dataset for the wrong region rather than planning on it', () => {
    expect(() =>
      validateAccessDataset(EASTERN_SIERRA_ACCESS, { regionId: 'alaska', placeIds: [] }),
    ).toThrow(/eastern-sierra/);
  });

  it('refuses a rule that names a service nobody defined', () => {
    const broken = {
      ...EASTERN_SIERRA_ACCESS,
      rules: [{ ...EASTERN_SIERRA_ACCESS.rules[0]!, serviceId: 'svc-does-not-exist' }],
    };
    expect(() =>
      validateAccessDataset(broken, { regionId: 'eastern-sierra', placeIds: [] }),
    ).toThrow(/does not exist/);
  });

  it('resolves and validates a dataset through the provider seam', async () => {
    const dataset = await easternSierraAccessProvider.getAccessDataset({
      regionId: 'eastern-sierra',
      placeIds: REDS_MEADOW,
      dates: ['2026-08-12'],
    });
    // Parsing returns a fresh object, so this is deep equality on purpose: what
    // matters is that nothing was dropped or coerced crossing the boundary.
    expect(
      validateAccessDataset(dataset, { regionId: 'eastern-sierra', placeIds: REDS_MEADOW }),
    ).toStrictEqual(dataset);
    expect(uncoveredPlaceIds(dataset, REDS_MEADOW)).toEqual([]);
    // A place nobody wrote a rule for is reported, never assumed drivable.
    expect(uncoveredPlaceIds(dataset, ['nowhere'])).toEqual(['nowhere']);

    await expect(
      easternSierraAccessProvider.getAccessDataset({
        regionId: 'alaska',
        placeIds: [],
        dates: [],
      }),
    ).rejects.toThrow(/alaska/);
  });

  it('refuses a dataset that does not cover every place it was asked about', () => {
    // The boundary's whole job. A place added without a rule must stop the plan,
    // not quietly become drivable three stages later.
    expect(() =>
      validateAccessDataset(EASTERN_SIERRA_ACCESS, {
        regionId: 'eastern-sierra',
        placeIds: [...REDS_MEADOW, 'a-place-nobody-wrote-a-rule-for'],
      }),
    ).toThrow(/a-place-nobody-wrote-a-rule-for/);
  });

  it('rejects a last outbound departure you could not get home from', () => {
    const service = EASTERN_SIERRA_ACCESS.services.find((s) => s.id === 'svc-mammoth-express')!;
    // The real one is already sound: leave by the last usable outbound and the
    // last return is still ahead of you.
    expect(service.window.lastOutboundDeparture + service.rideMinutes).toBeLessThanOrEqual(
      service.window.lastReturnDeparture,
    );

    const oneWay = accessDatasetSchema.safeParse({
      ...EASTERN_SIERRA_ACCESS,
      services: [
        {
          ...service,
          window: { ...service.window, lastOutboundDeparture: service.window.lastReturnDeparture },
        },
      ],
    });
    expect(oneWay.success).toBe(false);
  });

  it('rejects a date that is not a real day', () => {
    // `Date.parse` accepts 2026-02-30 and rolls it to March 2, which would be
    // evaluated against February's rules with March's weekday.
    expect(() => dayOfWeekFor('2026-02-30')).toThrow(/calendar date/);
    expect(() => dayOfWeekFor('2026-13-01')).toThrow(/calendar date/);
    expect(dayOfWeekFor('2028-02-29')).toBe(2);
  });

  it('never turns missing access data into "you can drive there"', () => {
    const capability = capabilityFromProfile(buildScenario().profile);
    const assessment = assessPlaceAccess({
      placeId: 'a-place-nobody-wrote-a-rule-for',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-08-12'],
      capability,
    });
    expect(assessment.status).toBe('blocked');
    expect(assessment.blockers[0]?.code).toBe('no_access_data');
    expect(assessment.requiredModes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Canonical scenarios
// ---------------------------------------------------------------------------

describe('scenario 1 — the standard summer car trip', () => {
  const itinerary = plan();

  it('recommends the car, and says why', () => {
    expect(itinerary.transportStrategy.primaryMode).toBe('drive');
    expect(itinerary.transportStrategy.rationale.join(' ')).toMatch(/corridor|vehicle/i);
  });

  it('keeps every day inside both budgets, separately', () => {
    const profile = buildScenario().profile;
    for (const day of itinerary.days) {
      expect(day.totals.driveMinutes).toBeLessThanOrEqual(profile.transport.maxDailyDriveMinutes);
      expect(day.totals.travelMinutes).toBeLessThanOrEqual(
        profile.transport.maxDailyTransportMinutes,
      );
    }
  });

  it('produces coherent drive legs with no invented mode changes', () => {
    for (const day of itinerary.days) {
      for (const travel of travelLegs(day)) {
        expect(['drive', 'shuttle', 'walk', 'public_bus']).toContain(travel.mode);
        expect(travel.fromId).toBeTruthy();
        expect(travel.toId).toBeTruthy();
      }
    }
  });

  it('reports no access violations', () => {
    const codes = errors(itinerary).map((issue) => issue.code);
    expect(codes).not.toContain('missed_last_return');
    expect(codes).not.toContain('required_mode_unavailable');
    expect(codes).not.toContain('duplicate_access_sequence');
  });

  it('adds its transport totals up to what the days actually contain', () => {
    expect(validateStrategy(itinerary.transportStrategy, itinerary.days)).toEqual([]);
  });
});

describe('scenario 2 — the Reds Meadow shared-access day', () => {
  const itinerary = plan({ manualIncludes: REDS_MEADOW });
  const valleyDay = itinerary.days.find((day) =>
    day.transport.serviceIds.includes('svc-reds-meadow-shuttle'),
  );

  it('puts the valley behind one shuttle day', () => {
    expect(valleyDay).toBeDefined();
    expect(
      itinerary.days.filter((day) => day.transport.serviceIds.includes('svc-reds-meadow-shuttle')),
    ).toHaveLength(1);
  });

  it('boards once and rides back once, however many stops are inside', () => {
    const legs = travelLegs(valleyDay!);
    expect(legs.filter((leg) => leg.role === 'ride' && leg.serviceId)).toHaveLength(1);
    expect(legs.filter((leg) => leg.role === 'return' && leg.serviceId)).toHaveLength(1);
    // One wait each way: queueing to get in, and standing at the stop to get out.
    expect(legs.filter((leg) => leg.role === 'wait')).toHaveLength(2);
    // Scoped to the boarding point. The day may also drive a couple of minutes
    // to a bakery on the way out of town, which is a real approach leg and not
    // a second run at the valley.
    expect(
      legs.filter(
        (leg) => leg.role === 'approach' && leg.mode === 'drive' && /Gondola Building/.test(leg.toName),
      ),
    ).toHaveLength(1);
  });

  it('is standing at the stop before the last bus leaves, not as it leaves', () => {
    const shuttle = EASTERN_SIERRA_ACCESS.services.find(
      (service) => service.id === 'svc-reds-meadow-shuttle',
    )!;
    const items = valleyDay!.items;
    const boarding = items.find(
      (item) => item.travel?.role === 'return' && item.travel.serviceId === shuttle.id,
    )!;
    const waitBefore = items.find(
      (item) =>
        item.travel?.role === 'wait' &&
        item.travel.serviceId === shuttle.id &&
        item.endMinute === boarding.startMinute,
    );
    expect(waitBefore).toBeDefined();
    expect(boarding.startMinute).toBeLessThanOrEqual(shuttle.window.lastReturnDeparture);
  });

  it('drives to the boarding point rather than to the valley', () => {
    // The last approach before the first boarding leg: the one that actually
    // delivers the traveller to the shuttle, whatever it stopped for first.
    const legs = travelLegs(valleyDay!);
    const boarding = legs.findIndex((leg) => leg.role === 'wait');
    const approach = legs.slice(0, boarding).filter((leg) => leg.role === 'approach').at(-1);
    expect(approach?.mode).toBe('drive');
    expect(approach?.toName).toMatch(/Gondola Building/);
  });

  it('lays the sequence out in order: drive, board, ride, walk, visit, walk, ride back', () => {
    const shape = valleyDay!.items
      .filter((item) => item.kind === 'travel' || item.kind === 'activity')
      .map((item) => ({
        role: item.kind === 'activity' ? 'visit' : item.travel!.role,
        toName: item.kind === 'activity' ? item.title : item.travel!.toName,
      }));
    // From the leg that reaches the boarding point. Anything before it belongs
    // to the morning rather than to the valley.
    const gateway = shape.findIndex((entry) => /Gondola Building/.test(entry.toName));
    expect(shape.slice(gateway, gateway + 5).map((entry) => entry.role)).toEqual([
      'approach',
      'wait',
      'ride',
      'walk',
      'visit',
    ]);

    // The valley portion closes the way it opened: walk out, wait, ride back.
    // Asserted on the shuttle legs rather than on the tail of the day, because
    // the day may drive on to another stop afterwards.
    const shuttleShape = valleyDay!.items
      .filter(
        (item) =>
          item.kind === 'activity' ||
          item.travel?.serviceId === 'svc-reds-meadow-shuttle' ||
          item.travel?.role === 'walk',
      )
      .map((item) => (item.kind === 'activity' ? 'visit' : item.travel!.role));
    expect(shuttleShape.slice(-3)).toEqual(['walk', 'wait', 'return']);
  });

  it('finishes everything inside the valley before the last bus out', () => {
    const shuttle = EASTERN_SIERRA_ACCESS.services.find(
      (service) => service.id === 'svc-reds-meadow-shuttle',
    )!;
    const returnLeg = travelLegs(valleyDay!).find((leg) => leg.role === 'return');
    const returnItem = valleyDay!.items.find((item) => item.travel === returnLeg)!;
    expect(returnItem.startMinute).toBeLessThanOrEqual(shuttle.window.lastReturnDeparture);
  });

  it('never names a stop on a leg that the day then dropped', () => {
    const scheduled = new Set(activities(itinerary));
    for (const day of itinerary.days) {
      for (const leg of travelLegs(day)) {
        for (const id of [leg.fromId, leg.toId]) {
          const isPlace = EASTERN_SIERRA_ACCESS.rules.some((rule) => rule.placeIds.includes(id));
          if (isPlace && !id.startsWith('ap-')) {
            // Only assert for the members of a shuttle-served group; a drive-up
            // stop is its own routing point whether or not it was scheduled.
            if (REDS_MEADOW.includes(id)) expect(scheduled.has(id)).toBe(true);
          }
        }
      }
    }
  });
});

describe('scenario 3 — outside the shuttle season', () => {
  // The trip runs in August; a June-July shuttle season means it is not running.
  const outOfSeason = withService((dataset) => {
    const service = dataset.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
    service.operatingMonths = [6, 7];
    return dataset;
  });

  it('does not put anybody on a shuttle that is not running', () => {
    const itinerary = plan({ manualIncludes: REDS_MEADOW, access: outOfSeason });
    for (const day of itinerary.days) {
      expect(day.transport.serviceIds).not.toContain('svc-reds-meadow-shuttle');
      // By service, not by mode — the Lakes Basin trolley is also a shuttle and
      // is running perfectly well.
      for (const leg of travelLegs(day)) {
        expect(leg.serviceId).not.toBe('svc-reds-meadow-shuttle');
      }
    }
  });

  it('falls back to driving, because that is the verified legal alternative', () => {
    // This is the real Reds Meadow rule and it must not be lost: vehicles are
    // barred *while the shuttle runs*, so a day it does not run is a day you
    // drive in. Declaring the valley shut would be wrong, not merely cautious.
    const itinerary = plan({ manualIncludes: REDS_MEADOW, access: outOfSeason });
    expect(activities(itinerary)).toContain('devils-postpile');
    const day = itinerary.days.find((entry) =>
      entry.items.some((item) => item.placeId === 'devils-postpile'),
    )!;
    expect(day.transport.primaryMode).toBe('drive');
  });

  it('makes it genuinely unavailable when vehicles are barred outright', () => {
    // Same missing service, but now the road is closed to private vehicles at
    // all times — so there is no second way in and the answer is "no".
    const noWayIn = withService((dataset) => {
      const service = dataset.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
      service.operatingMonths = [6, 7];
      const rule = dataset.rules.find((r) => r.id === 'rule-reds-meadow-shuttle')!;
      rule.privateVehicle = 'prohibited';
      return dataset;
    });
    const itinerary = plan({ manualIncludes: REDS_MEADOW, access: noWayIn });

    for (const placeId of REDS_MEADOW) {
      expect(activities(itinerary)).not.toContain(placeId);
      const entry = unscheduled(itinerary, placeId);
      expect(entry).toBeDefined();
      expect(entry!.reasonCode).toBe('service_not_operating');
      expect(entry!.reason).toMatch(/season/i);
    }

    const conflicts = errors(itinerary).filter(
      (issue) => issue.code === 'must_include_unscheduled',
    );
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    expect(itinerary.status).toBe('needs_decision');
  });
});

describe('the vehicle has a position', () => {
  it('never drives away from a place the traveller reached on foot', () => {
    // The trolley leaves the car at base. A later drive leg starting from the
    // Village would be the car teleporting to a bus stop — and the drive out to
    // fetch it would be missing from the day and from its driving total.
    const itinerary = plan({
      answers: { transportPriority: 'least_stressful' },
      selections: [
        { placeId: 'mammoth-lakes-basin', status: 'included', source: 'user', updatedAt: 'x' },
        { placeId: 'hot-creek-geologic-site', status: 'included', source: 'user', updatedAt: 'x' },
      ],
    });

    for (const day of itinerary.days) {
      let vehicleAt = itinerary.baseId;
      for (const leg of travelLegs(day)) {
        if (leg.mode === 'drive') {
          expect(
            leg.fromId,
            `day ${day.dayNumber}: drives from ${leg.fromId} with the car at ${vehicleAt}`,
          ).toBe(vehicleAt);
          vehicleAt = leg.toId;
        }
      }
    }
  });

  it('does not stand at a stop for an hour when it could leave later', () => {
    const itinerary = plan({
      answers: { willDrive: false },
      selections: [
        { placeId: 'mammoth-lakes-basin', status: 'included', source: 'user', updatedAt: 'x' },
      ],
    });
    const day = itinerary.days.find((entry) => entry.totals.waitMinutes > 0)!;
    const trolley = EASTERN_SIERRA_ACCESS.services.find(
      (service) => service.id === 'svc-lakes-basin-trolley',
    )!;
    // The wait is the boarding buffer, not the gap between waking up and 09:00.
    expect(day.totals.waitMinutes).toBeLessThanOrEqual(trolley.transferBufferMinutes * 2);
  });
});

describe('a service that is not running is not a gateway', () => {
  // October: Reds Meadow Road is open, the shuttle has stopped for the year.
  const october = { basics: { startDate: '2026-10-12', endDate: '2026-10-15' } };

  it('drives the whole way in rather than to the boarding point', () => {
    const itinerary = plan({ ...october, manualIncludes: REDS_MEADOW });
    const day = itinerary.days.find((entry) =>
      entry.items.some((item) => item.placeId === 'devils-postpile'),
    )!;

    // The leg that reaches the valley, not whatever the morning stopped at
    // first. Out of season there is no boarding point to drive to instead.
    const approach = travelLegs(day).find(
      (leg) => leg.role === 'approach' && leg.toId === 'devils-postpile',
    )!;
    expect(approach).toBeDefined();
    // The authored drive time to the valley, not the 12 minutes to Main Lodge.
    // Measured from wherever the day set off, which may be a cafe a minute out
    // of town rather than the base itself.
    expect(approach.minutes).toBeGreaterThanOrEqual(45);
    expect(approach.minutes).toBeLessThanOrEqual(48);
    expect(travelLegs(day).some((leg) => leg.toId === 'panorama-gondola')).toBe(false);
  });

  it('does not schedule the shuttle as an internal transfer out of season', () => {
    const itinerary = plan({ ...october, manualIncludes: REDS_MEADOW });
    for (const day of itinerary.days) {
      for (const leg of travelLegs(day)) {
        expect(leg.mode).not.toBe('shuttle');
      }
      expect(day.transport.modes).not.toContain('shuttle');
    }
  });

  it('measures the hop between the two valley stops on the road, not as a walk', () => {
    const itinerary = plan({ ...october, manualIncludes: REDS_MEADOW });
    const day = itinerary.days.find((entry) =>
      entry.items.some((item) => item.placeId === 'rainbow-falls'),
    )!;
    const transfer = travelLegs(day).find((leg) => leg.role === 'transfer');
    if (transfer) {
      expect(transfer.mode).toBe('drive');
      expect(transfer.provenance).toBe('modelled');
    }
    // And the totals reflect a real drive out and back, not a ten-minute stroll.
    expect(day.totals.driveMinutes).toBeGreaterThanOrEqual(90);
    expect(day.totals.walkMinutes).toBe(0);
  });
});

describe('scenario 4 — the service does not run on that weekday', () => {
  /** Weekday-restricted, with no drive-in fallback, so the rule actually bites. */
  const onlyOn = (days: number[]) =>
    withService((dataset) => {
      const service = dataset.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
      service.daysOfWeek = days;
      const rule = dataset.rules.find((r) => r.id === 'rule-reds-meadow-shuttle')!;
      rule.privateVehicle = 'prohibited';
      return dataset;
    });

  it('enforces the weekday rule and names it', () => {
    // Sunday only. The trip runs Wed 12 Aug to Sat 15 Aug, so no day qualifies.
    const itinerary = plan({ manualIncludes: REDS_MEADOW, access: onlyOn([0]) });
    expect(activities(itinerary)).not.toContain('devils-postpile');
    const entry = unscheduled(itinerary, 'devils-postpile')!;
    expect(entry.reasonCode).toBe('service_not_operating');
    expect(entry.reason).toMatch(/day of the week/i);
  });

  it('moves the visit to the day the service does run', () => {
    // Friday 14 August is inside this trip and is a full day, so it is the only
    // day both the weekday rule and the hours allow.
    const itinerary = plan({ manualIncludes: REDS_MEADOW, access: onlyOn([5]) });
    const valleyDay = itinerary.days.find((day) =>
      day.transport.serviceIds.includes('svc-reds-meadow-shuttle'),
    );
    expect(valleyDay).toBeDefined();
    expect(dayOfWeekFor(valleyDay!.date)).toBe(5);
    expect(valleyDay!.date).toBe('2026-08-14');
  });

  it('will not squeeze a weekday-restricted valley onto a departure morning', () => {
    // Saturday 15 August is the departure day. The rule permits it; the hours do
    // not, and the honest answer is a conflict rather than a plan that cannot run.
    const itinerary = plan({ manualIncludes: REDS_MEADOW, access: onlyOn([6]) });
    expect(activities(itinerary)).not.toContain('devils-postpile');
    expect(unscheduled(itinerary, 'devils-postpile')).toBeDefined();
  });
});

describe('scenario 5 — the traveller without a car', () => {
  const noCar = plan({ answers: { willDrive: false } });
  const withCar = plan();

  it('produces a materially different, smaller feasible set', () => {
    const carless = new Set(activities(noCar));
    const driving = new Set(activities(withCar));
    expect(carless.size).toBeLessThan(driving.size);
    expect([...carless]).not.toEqual([...driving]);
  });

  it('never schedules a drive', () => {
    for (const day of noCar.days) {
      expect(day.totals.driveMinutes).toBe(0);
      for (const leg of travelLegs(day)) expect(leg.mode).not.toBe('drive');
    }
  });

  it('never auto-selects a place that needs a car', () => {
    expect(activities(noCar)).not.toContain('convict-lake');
    expect(activities(noCar)).not.toContain('mono-lake-south-tufa');
    // Nor the shuttle-served valley, whose boarding point needs one to reach.
    expect(activities(noCar)).not.toContain('devils-postpile');
  });

  it('explains the limitation instead of inventing a rideshare', () => {
    expect(noCar.transportStrategy.primaryMode).not.toBe('drive');
    expect(noCar.transportStrategy.totals.driveMinutes).toBe(0);
    for (const day of noCar.days) {
      for (const leg of travelLegs(day)) {
        expect(['rideshare', 'private_transfer', 'rail', 'ferry']).not.toContain(leg.mode);
      }
    }
  });

  it('keeps the options a scheduled service genuinely supports', () => {
    const reachable = activities(noCar);
    // The trolley and the Mammoth Express are real, published, seven-day services.
    expect(reachable.length).toBeGreaterThan(0);
    for (const day of noCar.days) {
      for (const serviceId of day.transport.serviceIds) {
        expect(
          EASTERN_SIERRA_ACCESS.services.some((service) => service.id === serviceId),
        ).toBe(true);
      }
    }
  });
});

describe('scenario 6 — the traveller who will not use a shuttle', () => {
  const itinerary = plan({
    answers: { willUseShuttles: false },
    manualIncludes: REDS_MEADOW,
  });

  it('treats it as a hard block, not a preference', () => {
    expect(activities(itinerary)).not.toContain('devils-postpile');
    const entry = unscheduled(itinerary, 'devils-postpile')!;
    expect(entry.reasonCode).toBe('transport_mode_unavailable');
    expect(entry.reason).toMatch(/shuttle/i);
    expect(entry.suggestedRemedy).toMatch(/shuttle/i);
    expect(entry.wasManual).toBe(true);
  });

  it('leaves ordinary drive-up stops entirely alone', () => {
    expect(activities(itinerary).length).toBeGreaterThan(0);
    for (const day of itinerary.days) {
      expect(day.transport.serviceIds).toEqual([]);
    }
  });
});

describe('scenario 7 — the road-averse traveller', () => {
  it('blocks an unpaved approach when it is a stated avoidance', () => {
    const itinerary = plan({
      answers: { avoidances: ['rough_or_gravel_roads'], comfortableGravelRoads: false },
    });
    for (const placeId of activities(itinerary)) {
      const rule = EASTERN_SIERRA_ACCESS.rules.find((entry) => entry.placeIds.includes(placeId));
      expect(rule).toBeDefined();
    }
    expect(activities(itinerary)).not.toContain('hot-creek-geologic-site');
    expect(activities(itinerary)).not.toContain('bodie-state-historic-park');
    expect(errors(itinerary).map((issue) => issue.code)).not.toContain(
      'road_surface_incompatible',
    );
  });

  it('lets a comfortable driver keep them', () => {
    const itinerary = plan({
      answers: { comfortableGravelRoads: true, avoidances: [] },
      manualIncludes: ['hot-creek-geologic-site'],
    });
    expect(activities(itinerary)).toContain('hot-creek-geologic-site');
  });
});

describe('scenario 8 — missing the last way out', () => {
  // A shuttle whose last bus leaves shortly after the first arrives. Nothing in
  // the valley can be done in the gap, so the day must not be built.
  const tightWindow = withService((dataset) => {
    const service = dataset.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
    service.window = {
      firstDeparture: 7 * 60 + 30,
      lastOutboundDeparture: 8 * 60,
      lastReturnDeparture: 9 * 60 + 30,
    };
    return dataset;
  });
  const itinerary = plan({ manualIncludes: REDS_MEADOW, access: tightWindow });

  it('schedules nothing that would finish after the last return', () => {
    const shuttle = tightWindow.services.find((s) => s.id === 'svc-reds-meadow-shuttle')!;
    for (const day of itinerary.days) {
      const returnLeg = day.items.find(
        (item) => item.travel?.role === 'return' && item.travel.serviceId,
      );
      if (returnLeg) {
        expect(returnLeg.startMinute).toBeLessThanOrEqual(shuttle.window.lastReturnDeparture);
      }
    }
  });

  it('reports the conflict with a stable, specific code', () => {
    const entries = REDS_MEADOW.map((id) => unscheduled(itinerary, id)).filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    expect(errors(itinerary).some((issue) => issue.code === 'must_include_unscheduled')).toBe(true);
  });
});

describe('scenario 9 — too much transportation in a day', () => {
  it('enforces the driving budget and the total-travel budget separately', () => {
    const itinerary = plan({ answers: { maxDailyTravelMinutes: 90 } });
    const profile = buildScenario({ answers: { maxDailyTravelMinutes: 90 } }).profile;

    expect(profile.transport.maxDailyDriveMinutes).toBe(90);
    // Riding and walking do not come out of the driving allowance.
    expect(profile.transport.maxDailyTransportMinutes).toBeGreaterThan(90);

    for (const day of itinerary.days) {
      expect(day.totals.driveMinutes).toBeLessThanOrEqual(90);
      expect(day.totals.travelMinutes).toBeLessThanOrEqual(
        profile.transport.maxDailyTransportMinutes,
      );
    }
    expect(errors(itinerary).map((issue) => issue.code)).not.toContain('daily_drive_exceeded');
  });

  it('gives a car-free traveller a transport budget rather than a zero one', () => {
    const profile = buildScenario({ answers: { willDrive: false } }).profile;
    expect(profile.transport.maxDailyDriveMinutes).toBe(0);
    expect(profile.transport.maxDailyTransportMinutes).toBeGreaterThan(0);
  });
});

describe('scenario 10 — rebuilding after a transport preference changes', () => {
  it('produces a different strategy and a different feasible set', () => {
    const before = plan();
    const after = plan({ answers: { willDrive: false } });

    expect(before.transportStrategy.primaryMode).toBe('drive');
    expect(after.transportStrategy.primaryMode).not.toBe('drive');
    expect(after.transportStrategy.totals.driveMinutes).toBe(0);
    expect(activities(after)).not.toEqual(activities(before));
  });

  it('keeps a manual pick visible as a conflict when the change breaks it', () => {
    const after = plan({ answers: { willDrive: false }, manualIncludes: ['convict-lake'] });
    expect(activities(after)).not.toContain('convict-lake');
    const entry = unscheduled(after, 'convict-lake')!;
    expect(entry.wasManual).toBe(true);
    expect(entry.reason).toMatch(/vehicle|car/i);
    expect(entry.suggestedRemedy).toMatch(/vehicle|car/i);
  });
});

describe('scenario 11 — determinism', () => {
  it('produces a byte-identical structure from identical inputs', () => {
    const a = plan({ manualIncludes: REDS_MEADOW });
    const b = plan({ manualIncludes: REDS_MEADOW });
    expect(itineraryStructureFingerprint(a)).toBe(itineraryStructureFingerprint(b));
  });

  it('holds the transport legs and access choices inside the fingerprint', () => {
    const itinerary = plan({ manualIncludes: REDS_MEADOW });
    const fingerprint = itineraryStructureFingerprint(itinerary);

    // The rule a narration layer must not be able to break: rewriting prose
    // leaves the structure alone, but changing a mode changes the fingerprint.
    const narrated: Itinerary = {
      ...itinerary,
      summary: 'A completely different sentence.',
      transportStrategy: {
        ...itinerary.transportStrategy,
        headline: 'Rewritten by a model.',
        rationale: ['Something else entirely.'],
      },
      days: itinerary.days.map((day) => ({
        ...day,
        theme: 'Rewritten',
        items: day.items.map((item) => ({ ...item, reason: 'Rewritten.', title: 'Rewritten' })),
      })),
    };
    expect(itineraryStructureFingerprint(narrated)).toBe(fingerprint);

    const modeSwapped: Itinerary = {
      ...itinerary,
      days: itinerary.days.map((day) => ({
        ...day,
        items: day.items.map((item) =>
          item.travel ? { ...item, travel: { ...item.travel, mode: 'drive' as const } } : item,
        ),
      })),
    };
    expect(itineraryStructureFingerprint(modeSwapped)).not.toBe(fingerprint);
  });
});

describe('the transport strategy', () => {
  it('never invents a cost figure it cannot support', () => {
    const strategy = plan().transportStrategy;
    const text = JSON.stringify(strategy);
    expect(text).not.toMatch(/\$\d/);
    expect(strategy).not.toHaveProperty('estimatedCost');
  });

  it('always discloses that the driving times are modelled', () => {
    const strategy = plan().transportStrategy;
    expect(strategy.dataDisclosure).toMatch(/modelled/);
    expect(strategy.dataDisclosure).toMatch(/not measured/);
  });

  it('says what a car-free version of the same trip would lose', () => {
    const strategy = plan().transportStrategy;
    expect(strategy.withoutPrimary).toBeDefined();
    expect(strategy.withoutPrimary).toMatch(/without a vehicle/i);
  });

  it('reports no alternative rather than inventing one', () => {
    const scenario = buildScenario({ answers: { willUseShuttles: false } });
    const result = planTrip(scenario);
    if (!result.ok) throw new Error(result.message);
    expect(result.itinerary.transportStrategy.secondaryMode).toBeNull();
  });

  it('is caught by the validator if it ever contradicts its own days', () => {
    const itinerary = plan();
    const lying = {
      ...itinerary.transportStrategy,
      totals: { ...itinerary.transportStrategy.totals, driveMinutes: 99_999 },
    };
    const issues = validateStrategy(lying, itinerary.days);
    expect(issues.map((issue) => issue.code)).toContain('inconsistent_transport_totals');
  });

  it('is derived, not declared — an empty plan produces an honest strategy', () => {
    const scenario = buildScenario();
    const strategy = buildTransportStrategy({
      days: [],
      profile: scenario.profile,
      region: scenario.region,
      dataset: EASTERN_SIERRA_ACCESS,
      unscheduled: [],
      matrixNote: 'test',
      matrixProvenance: 'modelled',
    });
    expect(strategy.totals.driveMinutes).toBe(0);
    expect(strategy.secondaryMode).toBeNull();
  });
});

describe('rule evaluation', () => {
  const capability = capabilityFromProfile(buildScenario().profile);

  it('bars the valley to a car when the shuttle is running, and allows it when it is not', () => {
    const rule = EASTERN_SIERRA_ACCESS.rules.find((r) => r.id === 'rule-reds-meadow-shuttle')!;
    const inSeason = evaluateRule(rule, '2026-08-12', EASTERN_SIERRA_ACCESS, capability);
    expect(inSeason.ok).toBe(true);
    if (inSeason.ok) expect(inSeason.modes).toContain('shuttle');

    // October: the road is open, the shuttle is not running, so you drive.
    const october = evaluateRule(rule, '2026-10-12', EASTERN_SIERRA_ACCESS, capability);
    expect(october.ok).toBe(true);
    if (october.ok) expect(october.modes).not.toContain('shuttle');
  });

  it('refuses a walk longer than the traveller said they would do', () => {
    const impatient = { ...capability, maxAccessWalkMinutes: 2 };
    const rule = EASTERN_SIERRA_ACCESS.rules.find((r) => r.id === 'rule-reds-meadow-shuttle')!;
    const outcome = evaluateRule(rule, '2026-08-12', EASTERN_SIERRA_ACCESS, impatient);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.blocker.code).toBe('walk_too_long');
  });

  it('ranks the ways in deterministically for a given priority', () => {
    const relaxed = capabilityFromProfile(
      buildScenario({ answers: { transportPriority: 'least_stressful' } }).profile,
    );
    const basin = assessPlaceAccess({
      placeId: 'mammoth-lakes-basin',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-08-12'],
      capability: relaxed,
    });
    // Both driving and the trolley are legal in August; least-stressful rides.
    expect(basin.status).toBe('open');
    expect(basin.byDate[0]?.outcome?.service?.id).toBe('svc-lakes-basin-trolley');

    const hurried = capabilityFromProfile(
      buildScenario({ answers: { transportPriority: 'fastest' } }).profile,
    );
    const driven = assessPlaceAccess({
      placeId: 'mammoth-lakes-basin',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-08-12'],
      capability: hurried,
    });
    expect(driven.byDate[0]?.outcome?.service).toBeUndefined();
  });

  it('falls back to the only remaining option when one becomes unavailable', () => {
    const noCar = capabilityFromProfile(buildScenario({ answers: { willDrive: false } }).profile);
    const summer = assessPlaceAccess({
      placeId: 'mammoth-lakes-basin',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-08-12'],
      capability: noCar,
    });
    expect(summer.status).toBe('open');
    expect(summer.requiredModes).not.toContain('drive');

    // The trolley is a summer service. In May there is nothing left.
    const may = assessPlaceAccess({
      placeId: 'mammoth-lakes-basin',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2027-05-12'],
      capability: noCar,
    });
    expect(may.status).toBe('blocked');
  });
});
