import {
  capabilityFromProfile,
  evaluateRule,
  findPoint,
  rankOutcomes,
  ruleAppliesOn,
  rulesForPlace,
  type AccessBlocker,
  type AccessCapability,
  type AccessDataset,
  type AccessRule,
  type TransportMode,
  type TransportService,
  type TravelerProfile,
} from '@sidequest/core';
import { hasPoint, type TravelTimeMatrix } from '@sidequest/geo';
import type { PlanningCandidate } from './types';

/**
 * Turning access rules into something a clock can be laid against.
 *
 * `packages/core` answers "is there a legal way in on this date?". This answers
 * the harder question: "given the day you have, does that way in fit?" — which
 * needs the timetable, the walk from the drop-off, and the last bus out.
 *
 * The unit of planning here is the **access unit**: everything one gateway
 * sequence serves. Devils Postpile and Rainbow Falls are one unit, so the drive
 * to Main Lodge, the wait, the ride in and the ride out are paid for once. That
 * is the difference between a plan that works and a plan that boards the same
 * shuttle twice in an afternoon.
 */

/** A leg of transportation, as scheduled. Distinct from time spent at a place. */
export interface AccessLegPlan {
  mode: TransportMode;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  minutes: number;
  km: number;
  /** What this leg is for, so the timeline can label it without parsing prose. */
  role: 'approach' | 'wait' | 'ride' | 'walk' | 'transfer' | 'return';
  required: boolean;
  serviceId?: string;
  note?: string;
  /**
   * Where the number came from. `modelled` is the corridor road model,
   * `official` a published timetable, `estimated` an authored allowance.
   */
  provenance: 'measured' | 'modelled' | 'official' | 'estimated';
}

/**
 * A set of candidates behind one gateway sequence.
 *
 * Keyed by access rule where one exists, so the grouping is a property of the
 * data rather than of the algorithm. A place whose rule serves only itself is a
 * unit of one and behaves exactly as an ordinary stop always did.
 */
export interface AccessUnit {
  key: string;
  ruleId?: string;
  members: PlanningCandidate[];
  /** Matrix id the drive to this unit ends at. */
  gatewayRoutingId: string;
  gatewayName: string;
  /** Matrix id the onward drive starts from. Same as the gateway for a ride-in. */
  exitRoutingId: string;
}

/**
 * One legal, timed way to do one unit on one date.
 *
 * The approach drive is deliberately absent: it depends on where the traveller
 * was standing beforehand, which only the day's ordering knows. Everything from
 * the gateway inwards is fixed here.
 */
export interface AccessOption {
  unitKey: string;
  ruleId: string;
  date: string;
  gatewayRoutingId: string;
  gatewayName: string;
  /** Where the onward journey starts. Back at the gateway when you rode in. */
  exitRoutingId: string;
  approachMode: TransportMode;
  /** Fixed minutes for a non-driving approach; null means measure the drive. */
  approachMinutes: number | null;
  entryLegs: AccessLegPlan[];
  exitLegs: AccessLegPlan[];
  internalTransfer: { mode: TransportMode; minutes: number };
  /** Earliest the traveller may be standing at the first activity. */
  earliestActivityStart: number | null;
  /** Latest the last activity may finish and still get out. */
  latestActivityEnd: number | null;
  /** Minutes the vehicle is boarding-or-riding, by kind. */
  transitMinutes: number;
  walkMinutes: number;
  waitMinutes: number;
  usesPrivateVehicle: boolean;
  modes: TransportMode[];
  service?: TransportService;
  notes: string[];
  dynamicChecks: string[];
}

export type UnitAccess =
  | { available: true; option: AccessOption }
  | { available: false; blockers: AccessBlocker[] };

export interface ResolveAccessInput {
  units: readonly AccessUnit[];
  dates: readonly string[];
  dataset: AccessDataset;
  profile: TravelerProfile;
  matrix: TravelTimeMatrix;
}

/**
 * Every unit against every date. Keyed `unitKey|date`.
 *
 * Computed once, up front, because day assignment needs to know which dates a
 * unit can land on before it starts placing anything. Resolving it lazily inside
 * the packer would mean the same rule evaluated dozens of times and, worse, a
 * cluster handed to a Tuesday only to discover the bus does not run.
 */
export function resolveAccess(input: ResolveAccessInput): Map<string, UnitAccess> {
  const capability = capabilityFromProfile(input.profile);
  const resolved = new Map<string, UnitAccess>();

  for (const unit of input.units) {
    for (const date of input.dates) {
      resolved.set(accessKey(unit.key, date), resolveUnitOnDate(unit, date, input, capability));
    }
  }
  return resolved;
}

export function accessKey(unitKey: string, date: string): string {
  return `${unitKey}|${date}`;
}

function resolveUnitOnDate(
  unit: AccessUnit,
  date: string,
  input: ResolveAccessInput,
  capability: AccessCapability,
): UnitAccess {
  const { dataset } = input;
  // Every member must be covered by the unit's rule, which is how the unit was
  // formed — so evaluating the rule once answers for all of them.
  const representative = unit.members[0];
  if (!representative) return { available: false, blockers: [] };

  const rules = unit.ruleId
    ? dataset.rules.filter((rule) => rule.id === unit.ruleId)
    : rulesForPlace(dataset, representative.place.id);

  const applicable = rules.filter((rule) => ruleAppliesOn(rule, date));
  if (applicable.length === 0) {
    return {
      available: false,
      blockers: [
        {
          code: 'no_access_data',
          message: `Nothing we have on record gets you to ${representative.place.name} on ${date}.`,
        },
      ],
    };
  }

  const blockers: AccessBlocker[] = [];
  const outcomes = applicable.flatMap((rule) => {
    const outcome = evaluateRule(rule, date, dataset, capability);
    if (!outcome.ok) {
      blockers.push(outcome.blocker);
      return [];
    }
    return [{ rule, outcome }];
  });

  if (outcomes.length === 0) return { available: false, blockers };

  // The traveller's optimisation preference orders what is legal; it never makes
  // anything legal. Ranking is on the same measured quantities `core` uses, so
  // the board and the planner cannot disagree about which way in is preferred.
  const ranked = rankOutcomes(
    outcomes.map((entry) => entry.outcome),
    capability.priority,
  );
  const best = ranked[0]!;
  const chosen = outcomes.find((entry) => entry.outcome.ruleId === best.ruleId)!;

  const option = buildOption({
    unit,
    date,
    rule: chosen.rule,
    service: best.service,
    dataset,
    matrix: input.matrix,
  });
  if (!option) {
    return {
      available: false,
      blockers: [
        {
          code: 'no_access_data',
          message: `We have no travel data for the way in to ${representative.place.name}.`,
        },
      ],
    };
  }
  return { available: true, option };
}

function buildOption(args: {
  unit: AccessUnit;
  date: string;
  rule: AccessRule;
  service: TransportService | undefined;
  dataset: AccessDataset;
  matrix: TravelTimeMatrix;
}): AccessOption | null {
  const { unit, date, rule, service, dataset, matrix } = args;
  /**
   * The gateway belongs to the service, not to the rule.
   *
   * Reds Meadow in October is the case: the road is open, the shuttle has stopped
   * for the year, and you drive the whole way in. Keeping the boarding point as
   * the drive destination would route the car to Main Lodge and then substitute a
   * ten-minute walk for thirteen kilometres of mountain road — a day that reads
   * as two hours and takes four.
   */
  const gateway = service ? findPoint(dataset, rule.gatewayPointId) : undefined;
  const gatewayRoutingId = gateway?.routingId ?? unit.members[0]?.place.id ?? unit.gatewayRoutingId;
  const walkFromDropOff = service ? rule.walkMinutesFromDropOff : 0;
  // The shuttle between valley stops is not available on a day it does not run.
  const internalTransfer =
    service || rule.internalTransfer.mode !== 'shuttle'
      ? rule.internalTransfer
      : { mode: 'drive' as const, minutes: 0 };

  // Refusing to plan on a point the matrix does not know is the same rule the
  // rest of the planner follows: a missing travel time is a failure, not a zero.
  if (!hasPoint(matrix, gatewayRoutingId)) return null;

  const entryLegs: AccessLegPlan[] = [];
  const exitLegs: AccessLegPlan[] = [];
  const notes = [...rule.notes];
  const dynamicChecks: string[] = [];
  if (rule.provenance.volatility === 'dynamic' && rule.provenance.recheckNote) {
    dynamicChecks.push(rule.provenance.recheckNote);
  }

  let transitMinutes = 0;
  let waitMinutes = 0;
  let walkMinutes = 0;
  let earliestActivityStart: number | null = null;
  let latestActivityEnd: number | null = null;

  const gatewayName = gateway?.name ?? unit.gatewayName;
  const firstMemberName = unit.members[0]?.place.name ?? unit.key;

  if (service) {
    const dropOff = findPoint(dataset, service.dropOffPointId);
    const dropOffName = dropOff?.name ?? 'the drop-off';

    entryLegs.push({
      mode: service.mode,
      fromId: gatewayRoutingId,
      toId: service.dropOffPointId,
      fromName: gatewayName,
      toName: dropOffName,
      minutes: service.transferBufferMinutes,
      km: 0,
      role: 'wait',
      required: true,
      serviceId: service.id,
      note: service.headwayMinutes
        ? `${service.label} runs about every ${service.headwayMinutes} min.`
        : `Buy your ticket and wait for the next ${service.label}.`,
      provenance: 'estimated',
    });
    entryLegs.push({
      mode: service.mode,
      fromId: gatewayRoutingId,
      toId: service.dropOffPointId,
      fromName: gatewayName,
      toName: dropOffName,
      minutes: service.rideMinutes,
      km: 0,
      role: 'ride',
      required: true,
      serviceId: service.id,
      ...(service.fareNote ? { note: service.fareNote } : {}),
      // The calendar is official; the in-vehicle time is not. No operator here
      // publishes one, so calling this leg "official" would put a published
      // timetable's authority behind a number we made up.
      provenance: 'estimated',
    });
    waitMinutes += service.transferBufferMinutes;
    transitMinutes += service.rideMinutes;

    exitLegs.push({
      mode: service.mode,
      fromId: service.dropOffPointId,
      toId: gatewayRoutingId,
      fromName: dropOffName,
      toName: gatewayName,
      minutes: service.rideMinutes,
      km: 0,
      role: 'return',
      required: true,
      serviceId: service.id,
      note: `Last one back leaves at ${formatMinute(service.window.lastReturnDeparture)}.`,
      provenance: 'estimated',
    });
    transitMinutes += service.rideMinutes;

    // You cannot be at the far end before the first bus has carried you there,
    // and you must be back at the stop before the last one leaves.
    earliestActivityStart =
      service.window.firstDeparture + service.rideMinutes + walkFromDropOff;
    // You must be standing at the stop before it leaves, not as it leaves — so
    // the walk out and the wait both come off the back of the day.
    latestActivityEnd =
      service.window.lastReturnDeparture - walkFromDropOff - service.transferBufferMinutes;

    notes.push(
      `${service.label}: ${service.operator}. First out ${formatMinute(
        service.window.firstDeparture,
      )}, last back ${formatMinute(service.window.lastReturnDeparture)}.`,
    );
    if (service.provenance.volatility === 'dynamic' && service.provenance.recheckNote) {
      dynamicChecks.push(service.provenance.recheckNote);
    } else if (
      service.provenance.volatility === 'seasonal_recurring' &&
      service.provenance.recheckNote
    ) {
      dynamicChecks.push(service.provenance.recheckNote);
    }
  }

  if (walkFromDropOff > 0) {
    const walkFrom = service ? service.dropOffPointId : gatewayRoutingId;
    const walkFromName = service
      ? (findPoint(dataset, service.dropOffPointId)?.name ?? 'the drop-off')
      : gatewayName;
    entryLegs.push({
      mode: 'walk',
      fromId: walkFrom,
      toId: unit.members[0]?.place.id ?? unit.key,
      fromName: walkFromName,
      toName: firstMemberName,
      minutes: walkFromDropOff,
      km: 0,
      role: 'walk',
      required: true,
      provenance: 'estimated',
    });
    exitLegs.unshift({
      mode: 'walk',
      fromId: unit.members[unit.members.length - 1]?.place.id ?? unit.key,
      toId: walkFrom,
      fromName: unit.members[unit.members.length - 1]?.place.name ?? unit.key,
      toName: walkFromName,
      minutes: walkFromDropOff,
      km: 0,
      role: 'walk',
      required: true,
      provenance: 'estimated',
    });
    walkMinutes += walkFromDropOff * 2;
  }

  const modes: TransportMode[] = [rule.approachMode];
  if (service) modes.push(service.mode);
  if (walkMinutes > 0) modes.push('walk');
  if (unit.members.length > 1 && internalTransfer.minutes > 0) {
    modes.push(internalTransfer.mode);
  }

  if (rule.permitRequired && rule.permitNote) notes.push(rule.permitNote);

  return {
    unitKey: unit.key,
    ruleId: rule.id,
    date,
    gatewayRoutingId,
    gatewayName,
    // Ride in, ride out, and you are back where you parked. Drive in and the
    // next leg starts from the last thing you saw.
    exitRoutingId: service
      ? gatewayRoutingId
      : (unit.members[unit.members.length - 1]?.place.id ?? gatewayRoutingId),
    approachMode: rule.approachMode,
    approachMinutes: rule.approachMode === 'drive' ? null : (rule.approachMinutes ?? 0),
    entryLegs,
    exitLegs,
    internalTransfer,
    earliestActivityStart,
    latestActivityEnd,
    transitMinutes,
    walkMinutes,
    waitMinutes,
    usesPrivateVehicle: rule.approachMode === 'drive',
    modes: [...new Set(modes)],
    ...(service ? { service } : {}),
    notes: [...new Set(notes)],
    dynamicChecks: [...new Set(dynamicChecks)],
  };
}

/**
 * Groups candidates into access units.
 *
 * The key is the access rule that covers them — but only when that rule really
 * is a shared gateway. A rule that happens to list seven unrelated trailheads
 * ("drive to them, there is no bus") does not make them one outing, so a rule
 * with no gateway and no service groups each place on its own.
 */
export function buildAccessUnits(
  candidates: readonly PlanningCandidate[],
  dataset: AccessDataset,
  baseName: string,
): AccessUnit[] {
  const byKey = new Map<string, { rule?: AccessRule; members: PlanningCandidate[] }>();

  for (const candidate of candidates) {
    const rule = sharedGatewayRuleFor(dataset, candidate.place.id);
    const key = rule ? `rule:${rule.id}` : `place:${candidate.place.id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.members.push(candidate);
    else byKey.set(key, { ...(rule ? { rule } : {}), members: [candidate] });
  }

  return [...byKey.entries()]
    .map(([key, { rule, members }]) => {
      // Nearest the base first, so the unit is clustered as the thing you meet
      // on the way in and the ordering inside it reads as a route.
      const sorted = [...members].sort(
        (a, b) =>
          a.driveMinutesFromBase - b.driveMinutesFromBase || a.place.id.localeCompare(b.place.id),
      );
      const gateway = findPoint(dataset, rule?.gatewayPointId);
      const gatewayRoutingId = gateway?.routingId ?? sorted[0]!.place.id;
      return {
        key,
        ...(rule ? { ruleId: rule.id } : {}),
        members: sorted,
        gatewayRoutingId,
        gatewayName: gateway?.name ?? sorted[0]!.place.name,
        // With a service you come back out the way you went in; without one you
        // simply drive onward from the last stop.
        exitRoutingId: rule?.serviceId ? gatewayRoutingId : sorted[sorted.length - 1]!.place.id,
      } satisfies AccessUnit;
    })
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((unit) => ({ ...unit, gatewayName: unit.gatewayName || baseName }));
}

/**
 * The rule for a place, when that rule describes a gateway several places share.
 * Returns undefined for a plain drive-up, which is most of them.
 */
function sharedGatewayRuleFor(
  dataset: AccessDataset,
  placeId: string,
): AccessRule | undefined {
  return dataset.rules.find(
    (rule) =>
      rule.placeIds.includes(placeId) &&
      (rule.serviceId !== undefined || rule.gatewayPointId !== undefined) &&
      rule.placeIds.length > 1,
  );
}

/**
 * How a single day is got through, summarised from the units it actually holds.
 *
 * Derived rather than declared: if the day changes, this changes with it, so the
 * summary and the timeline cannot drift apart.
 */
export function summariseDayTransport(
  scheduled: readonly { option: AccessOption }[],
  layout: {
    driveMinutes: number;
    transitMinutes: number;
    walkMinutes: number;
    modes: TransportMode[];
  },
  dataset: AccessDataset,
): {
  primaryMode: TransportMode;
  modes: TransportMode[];
  serviceIds: string[];
  lastReturnNote?: string;
  parkingNotes: string[];
  accessNotes: string[];
  verifyBeforeTravel: string[];
} {
  const services = scheduled
    .map((entry) => entry.option.service)
    .filter((service): service is TransportService => Boolean(service));

  // The tightest last-return governs the day, because missing it is the failure
  // that matters and the earliest one is the one you can actually miss.
  const tightest = services.reduce<TransportService | undefined>(
    (best, service) =>
      !best || service.window.lastReturnDeparture < best.window.lastReturnDeparture
        ? service
        : best,
    undefined,
  );

  const parkingNotes = [
    ...new Set(
      scheduled
        .map((entry) => findPoint(dataset, gatewayPointIdFor(dataset, entry.option))?.parking.note)
        .filter((note): note is string => Boolean(note)),
    ),
  ];

  return {
    primaryMode:
      layout.driveMinutes >= layout.transitMinutes && layout.driveMinutes > 0
        ? 'drive'
        : layout.transitMinutes > 0
          ? (services[0]?.mode ?? 'shuttle')
          : layout.walkMinutes > 0
            ? 'walk'
            : 'drive',
    modes: layout.modes,
    serviceIds: [...new Set(services.map((service) => service.id))].sort(),
    ...(tightest
      ? {
          lastReturnNote: `The last ${tightest.label} out leaves at ${formatMinute(
            tightest.window.lastReturnDeparture,
          )}. This day is built to be back before it.`,
        }
      : {}),
    parkingNotes,
    accessNotes: [...new Set(scheduled.flatMap((entry) => entry.option.notes))],
    verifyBeforeTravel: [...new Set(scheduled.flatMap((entry) => entry.option.dynamicChecks))],
  };
}

function gatewayPointIdFor(dataset: AccessDataset, option: AccessOption): string | undefined {
  return dataset.rules.find((rule) => rule.id === option.ruleId)?.gatewayPointId;
}

function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

