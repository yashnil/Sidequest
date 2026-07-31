import {
  findService,
  monthFor,
  ruleAppliesOn,
  rulesForPlace,
  serviceAvailabilityOn,
  type AccessDataset,
  type AccessRule,
  type TransportMode,
  type TransportPriority,
  type TransportService,
} from '../schemas/access';
import type { TravelerProfile } from '../schemas/profile';

/**
 * Can this traveller legally and practically reach this place on these dates?
 *
 * Deliberately date-by-date rather than trip-wide. "Open in August" is not an
 * answer when the shuttle runs Thursday to Sunday, and the day the planner picks
 * is the only day that matters. Every date in the trip is evaluated against every
 * rule that applies to it, and the result records which dates worked, which did
 * not, and why — so a conflict can name the actual constraint instead of saying
 * "poor logistics fit".
 *
 * This layer knows nothing about the clock. It answers "is there a legal way in
 * at all?"; whether that way fits between 09:00 and the last bus is the planner's
 * question, because only the planner knows what else is on the day.
 */

export interface AccessCapability {
  hasCar: boolean;
  willUseShuttles: boolean;
  /** Minutes on foot the traveller will accept purely to reach a stop. */
  maxAccessWalkMinutes: number;
  priority: TransportPriority;
}

export function capabilityFromProfile(profile: TravelerProfile): AccessCapability {
  return {
    hasCar: profile.transport.willDrive,
    willUseShuttles: profile.transport.willUseShuttles,
    maxAccessWalkMinutes: profile.transport.maxAccessWalkMinutes,
    priority: profile.transport.priority,
  };
}

export const ACCESS_BLOCKER_CODES = [
  /** Nothing in the dataset says how to reach this. Never assume a road. */
  'no_access_data',
  'needs_private_vehicle',
  'private_vehicle_prohibited',
  'shuttle_declined',
  'service_out_of_season',
  'service_not_operating',
  'walk_too_long',
  'unsupported_mode',
] as const;
export type AccessBlockerCode = (typeof ACCESS_BLOCKER_CODES)[number];

export interface AccessBlocker {
  code: AccessBlockerCode;
  message: string;
}

export const ACCESS_BADGES = [
  'car_required',
  'shuttle_required',
  'shuttle_available',
  'seasonal_service',
  'no_transit',
  'permit_required',
  'verify_conditions',
] as const;
export type AccessBadge = (typeof ACCESS_BADGES)[number];

export const ACCESS_BADGE_LABELS: Record<AccessBadge, string> = {
  car_required: 'Car required',
  shuttle_required: 'Shuttle only',
  shuttle_available: 'Shuttle option',
  seasonal_service: 'Seasonal service',
  no_transit: 'No transit',
  permit_required: 'Permit needed',
  verify_conditions: 'Check before you go',
};

/** The way in that a given rule offers on a given date, once evaluated. */
export type RuleOutcome =
  | {
      ok: true;
      ruleId: string;
      /** Modes the traveller will actually use, in the order they use them. */
      modes: TransportMode[];
      /** Set when the entry is on a scheduled service that day. */
      service?: TransportService;
      usesPrivateVehicle: boolean;
      walkMinutes: number;
    }
  | { ok: false; ruleId: string; blocker: AccessBlocker };

export interface DateAccess {
  date: string;
  /** Best legal outcome for the date, or undefined when there is none. */
  outcome?: Extract<RuleOutcome, { ok: true }>;
  blockers: AccessBlocker[];
}

export interface PlaceAccessAssessment {
  placeId: string;
  status: 'open' | 'partial' | 'blocked';
  byDate: DateAccess[];
  usableDates: string[];
  /** Every mode the traveller would use on at least one usable date. */
  requiredModes: TransportMode[];
  /** Present only when no date works at all. Ordered, most specific first. */
  blockers: AccessBlocker[];
  cautions: string[];
  badges: AccessBadge[];
  /** Facts that change year to year and must be confirmed before travel. */
  dynamicChecks: string[];
}

export interface AssessAccessInput {
  placeId: string;
  dataset: AccessDataset;
  /** Every date of the trip, as `YYYY-MM-DD`. */
  dates: readonly string[];
  capability: AccessCapability;
}

export function assessPlaceAccess(input: AssessAccessInput): PlaceAccessAssessment {
  const { placeId, dataset, dates, capability } = input;
  const rules = rulesForPlace(dataset, placeId);

  const byDate: DateAccess[] = dates.map((date) => {
    const applicable = rules.filter((rule) => ruleAppliesOn(rule, date));
    if (applicable.length === 0) {
      return {
        date,
        blockers: [
          {
            code: rules.length === 0 ? 'no_access_data' : 'service_out_of_season',
            message:
              rules.length === 0
                ? 'We have no record of how to reach this, so we will not assume you can drive there.'
                : `Nothing we have on record gets you in during ${monthName(monthFor(date))}.`,
          } satisfies AccessBlocker,
        ],
      };
    }

    const outcomes = applicable.map((rule) => evaluateRule(rule, date, dataset, capability));
    const workable = outcomes.filter(
      (outcome): outcome is Extract<RuleOutcome, { ok: true }> => outcome.ok,
    );
    if (workable.length === 0) {
      return {
        date,
        blockers: outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.blocker])),
      };
    }
    return { date, outcome: rankOutcomes(workable, capability.priority)[0]!, blockers: [] };
  });

  const usableDates = byDate.filter((entry) => entry.outcome).map((entry) => entry.date);
  const status =
    usableDates.length === 0 ? 'blocked' : usableDates.length === dates.length ? 'open' : 'partial';

  const requiredModes = [
    ...new Set(byDate.flatMap((entry) => entry.outcome?.modes ?? [])),
  ].sort();

  // Only report blockers when the place is genuinely out of reach. A date that
  // failed while another worked is a scheduling detail, not a reason to tell
  // someone they cannot go.
  const blockers =
    status === 'blocked' ? dedupeBlockers(byDate.flatMap((entry) => entry.blockers)) : [];

  return {
    placeId,
    status,
    byDate,
    usableDates,
    requiredModes,
    blockers,
    cautions: buildCautions(rules, byDate, dataset, status),
    badges: buildBadges(rules, byDate, dataset, requiredModes, capability),
    dynamicChecks: dedupe(
      rules
        .filter((rule) => rule.provenance.volatility === 'dynamic' && rule.provenance.recheckNote)
        .map((rule) => rule.provenance.recheckNote!)
        .concat(
          rules
            .map((rule) => findService(dataset, rule.serviceId))
            .filter((service): service is TransportService => Boolean(service))
            .filter((service) => service.provenance.volatility === 'dynamic')
            .map((service) => service.provenance.recheckNote ?? ''),
        )
        .filter(Boolean),
    ),
  };
}

/**
 * One rule against one date.
 *
 * The order of the checks is the order the real world imposes them: first, does
 * the service run today; then, is the traveller allowed to drive instead; then,
 * will they do the thing that is left.
 */
export function evaluateRule(
  rule: AccessRule,
  date: string,
  dataset: AccessDataset,
  capability: AccessCapability,
): RuleOutcome {
  const service = findService(dataset, rule.serviceId);

  if (rule.approachMode === 'unsupported') {
    return {
      ok: false,
      ruleId: rule.id,
      blocker: {
        code: 'unsupported_mode',
        message: 'Getting here needs a kind of transport we do not plan yet.',
      },
    };
  }

  if (rule.walkMinutesFromDropOff > capability.maxAccessWalkMinutes) {
    return {
      ok: false,
      ruleId: rule.id,
      blocker: {
        code: 'walk_too_long',
        message: `It is a ${rule.walkMinutesFromDropOff} min walk in from the nearest drop-off, past the ${capability.maxAccessWalkMinutes} min you said you would walk.`,
      },
    };
  }

  const approachNeedsCar = rule.approachMode === 'drive';
  const approachIsScheduled = isScheduledMode(rule.approachMode);

  if (approachNeedsCar && !capability.hasCar) {
    return {
      ok: false,
      ruleId: rule.id,
      blocker: {
        code: 'needs_private_vehicle',
        message: 'Reaching the start of this one needs your own vehicle — nothing scheduled goes there.',
      },
    };
  }
  if (approachIsScheduled && !capability.willUseShuttles) {
    return {
      ok: false,
      ruleId: rule.id,
      blocker: {
        code: 'shuttle_declined',
        message: 'The only way here is a shuttle or bus, and you asked us to leave those out.',
      },
    };
  }

  const serviceRuns = service ? serviceAvailabilityOn(service, date) : undefined;

  if (rule.serviceRequirement === 'required') {
    if (!service) {
      return {
        ok: false,
        ruleId: rule.id,
        blocker: {
          code: 'no_access_data',
          message: 'This needs a scheduled service and we have no timetable for it.',
        },
      };
    }
    if (!serviceRuns?.available) {
      const reason = serviceRuns?.reason;
      // The service is the only way past the gate. If vehicles are barred
      // outright, a day it does not run is simply a day you cannot go.
      if (rule.privateVehicle === 'prohibited') {
        return { ok: false, ruleId: rule.id, blocker: serviceGapBlocker(service, reason) };
      }
      // Vehicles are barred only while the service runs, so a day it does not
      // run is a day you drive — provided you have something to drive.
      if (!capability.hasCar) {
        return {
          ok: false,
          ruleId: rule.id,
          blocker:
            rule.privateVehicle === 'prohibited_during_service'
              ? serviceGapBlocker(service, reason)
              : {
                  code: 'needs_private_vehicle',
                  message: `${service.label} is not running that day, which leaves your own vehicle — and you do not have one.`,
                },
        };
      }
      return driveOutcome(rule);
    }
    if (!capability.willUseShuttles) {
      if (rule.privateVehicle === 'allowed' && capability.hasCar) return driveOutcome(rule);
      return {
        ok: false,
        ruleId: rule.id,
        blocker: {
          code: 'shuttle_declined',
          message: `${service.label} replaces private vehicles here, and you asked us to leave shuttles out.`,
        },
      };
    }
    return serviceOutcome(rule, service);
  }

  if (rule.serviceRequirement === 'optional' && service && serviceRuns?.available) {
    const canDrive = rule.privateVehicle === 'allowed' && capability.hasCar;
    if (capability.willUseShuttles && !canDrive) return serviceOutcome(rule, service);
    if (capability.willUseShuttles) {
      // Both work; the ranking decides. Return the service outcome and let the
      // caller compare it against the drive outcome from the same rule set.
      return preferByPriority(rule, service, capability);
    }
    if (canDrive) return driveOutcome(rule);
    return {
      ok: false,
      ruleId: rule.id,
      blocker: {
        code: 'shuttle_declined',
        message: `${service.label} is the way in and you asked us to leave shuttles out.`,
      },
    };
  }

  // No service in play: it comes down to whether they may, and can, drive.
  if (rule.privateVehicle === 'prohibited') {
    return {
      ok: false,
      ruleId: rule.id,
      blocker: {
        code: 'private_vehicle_prohibited',
        message: 'Private vehicles are not allowed in and there is no service running that day.',
      },
    };
  }
  if (approachNeedsCar && !capability.hasCar) {
    return {
      ok: false,
      ruleId: rule.id,
      blocker: {
        code: 'needs_private_vehicle',
        message: 'There is no way to reach this without your own vehicle.',
      },
    };
  }
  return driveOutcome(rule);
}

function isScheduledMode(mode: TransportMode): boolean {
  return mode === 'shuttle' || mode === 'public_bus' || mode === 'rail' || mode === 'ferry';
}

function serviceGapBlocker(
  service: TransportService,
  reason: 'out_of_season' | 'not_this_weekday' | undefined,
): AccessBlocker {
  if (reason === 'not_this_weekday') {
    return {
      code: 'service_not_operating',
      message: `${service.label} does not run on that day of the week, and it is the only way past the gate.`,
    };
  }
  return {
    code: 'service_out_of_season',
    message: `${service.label} is out of season on your dates, and it is the only way past the gate.`,
  };
}

function driveOutcome(rule: AccessRule): Extract<RuleOutcome, { ok: true }> {
  const modes: TransportMode[] = [rule.approachMode];
  if (rule.walkMinutesFromDropOff > 0) modes.push('walk');
  return {
    ok: true,
    ruleId: rule.id,
    modes,
    usesPrivateVehicle: rule.approachMode === 'drive',
    walkMinutes: rule.walkMinutesFromDropOff,
  };
}

function serviceOutcome(
  rule: AccessRule,
  service: TransportService,
): Extract<RuleOutcome, { ok: true }> {
  const modes: TransportMode[] = [rule.approachMode, service.mode];
  if (rule.walkMinutesFromDropOff > 0) modes.push('walk');
  return {
    ok: true,
    ruleId: rule.id,
    modes: [...new Set(modes)],
    service,
    usesPrivateVehicle: rule.approachMode === 'drive',
    walkMinutes: rule.walkMinutesFromDropOff,
  };
}

function preferByPriority(
  rule: AccessRule,
  service: TransportService,
  capability: AccessCapability,
): Extract<RuleOutcome, { ok: true }> {
  // Driving is faster and more flexible; riding is less stressful and cheaper.
  // Anything else is a claim we cannot support without fare and parking data.
  const ride = capability.priority === 'least_stressful' || capability.priority === 'cheapest';
  return ride ? serviceOutcome(rule, service) : driveOutcome(rule);
}

/**
 * Deterministic ordering of the legal ways in.
 *
 * Ranks only on things the dataset actually measures — number of modes, whether
 * a car is involved, minutes on foot — and breaks ties on rule id. Cost is
 * deliberately absent: without fares and parking charges, ranking by price would
 * be a guess dressed up as a preference.
 */
export function rankOutcomes(
  outcomes: readonly Extract<RuleOutcome, { ok: true }>[],
  priority: TransportPriority,
): Extract<RuleOutcome, { ok: true }>[] {
  const score = (outcome: Extract<RuleOutcome, { ok: true }>): number => {
    // Handovers and walking are the two costs every priority pays something for;
    // what changes between them is how much doing your own driving is worth.
    const handovers = Math.max(0, outcome.modes.length - 1);
    switch (priority) {
      case 'least_stressful':
        // Someone else at the wheel is the whole point, and it has to outweigh
        // the extra handover that riding always adds — otherwise "least
        // stressful" quietly means "drive", which is the opposite of the answer.
        return (outcome.usesPrivateVehicle ? 30 : 0) + handovers * 8 + outcome.walkMinutes;
      case 'cheapest':
        // Parking and fuel against a fare we usually do not have a figure for.
        return (outcome.usesPrivateVehicle ? 20 : 0) + outcome.walkMinutes;
      case 'fastest':
        // A timetable costs you the wait even when the ride is the same length.
        return (outcome.service ? 15 : 0) + outcome.walkMinutes;
      case 'most_scenic':
        // Driving yourself is what lets you stop, so it wins here.
        return (outcome.usesPrivateVehicle ? 0 : 10) + handovers * 3;
      case 'best_value':
      default:
        return handovers * 5 + outcome.walkMinutes;
    }
  };
  return [...outcomes].sort((a, b) => score(a) - score(b) || a.ruleId.localeCompare(b.ruleId));
}

function buildCautions(
  rules: readonly AccessRule[],
  byDate: readonly DateAccess[],
  dataset: AccessDataset,
  status: PlaceAccessAssessment['status'],
): string[] {
  const cautions: string[] = [];

  if (status === 'partial') {
    const blocked = byDate.filter((entry) => !entry.outcome);
    const first = blocked[0]?.blockers[0];
    cautions.push(
      `Reachable on ${byDate.length - blocked.length} of your ${byDate.length} days.${
        first ? ` ${first.message}` : ''
      }`,
    );
  }

  for (const rule of rules) {
    const service = findService(dataset, rule.serviceId);
    if (service && rule.serviceRequirement === 'required') {
      cautions.push(
        `${service.label} replaces private vehicles here — it runs ${describeMonths(
          service.operatingMonths,
        )}, first out ${hhmm(service.window.firstDeparture)}, last back ${hhmm(
          service.window.lastReturnDeparture,
        )}.`,
      );
    }
    if (rule.permitRequired && rule.permitNote) cautions.push(rule.permitNote);
    cautions.push(...rule.notes);
  }

  return dedupe(cautions);
}

function buildBadges(
  rules: readonly AccessRule[],
  byDate: readonly DateAccess[],
  dataset: AccessDataset,
  requiredModes: readonly TransportMode[],
  capability: AccessCapability,
): AccessBadge[] {
  const badges = new Set<AccessBadge>();

  const usesService = byDate.some((entry) => entry.outcome?.service);
  const serviceRequired = rules.some(
    (rule) => rule.serviceRequirement === 'required' && rule.serviceId,
  );
  const anyService = rules.some((rule) => rule.serviceId);

  if (requiredModes.includes('drive')) badges.add('car_required');
  if (serviceRequired && usesService) badges.add('shuttle_required');
  else if (anyService && capability.willUseShuttles) badges.add('shuttle_available');
  if (!anyService) badges.add('no_transit');
  if (
    rules.some((rule) => {
      const service = findService(dataset, rule.serviceId);
      return service ? service.operatingMonths.length < 12 : false;
    })
  ) {
    badges.add('seasonal_service');
  }
  if (rules.some((rule) => rule.permitRequired)) badges.add('permit_required');
  if (
    rules.some(
      (rule) =>
        rule.provenance.volatility === 'dynamic' ||
        findService(dataset, rule.serviceId)?.provenance.volatility === 'dynamic',
    )
  ) {
    badges.add('verify_conditions');
  }

  return [...badges];
}

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function monthName(month: number): string {
  return MONTH_ABBREVIATIONS[month - 1] ?? String(month);
}

export function describeMonths(months: readonly number[]): string {
  const sorted = [...new Set(months)].sort((a, b) => a - b);
  if (sorted.length === 12) return 'year round';
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return 'on no known dates';
  const contiguous = sorted.every((month, index) => month === first + index);
  if (contiguous && sorted.length > 1) return `${monthName(first)}–${monthName(last)}`;
  if (sorted.length === 1) return `in ${monthName(first)}`;
  return sorted.map(monthName).join(', ');
}

export function hhmm(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dedupeBlockers(blockers: readonly AccessBlocker[]): AccessBlocker[] {
  const byCode = new Map<AccessBlockerCode, AccessBlocker>();
  for (const blocker of blockers) {
    if (!byCode.has(blocker.code)) byCode.set(blocker.code, blocker);
  }
  return [...byCode.values()];
}
