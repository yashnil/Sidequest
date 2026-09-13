import { z } from 'zod';
import { gatewaySchema } from '../schemas/scope';

/**
 * V10 §8 — GATEWAYS ARE FIRST-CLASS, AND A GATEWAY WINDOW IS CONSERVATIVE.
 *
 * The founder's trip opened with a six-minute drive to its first stop at 16:00
 * against a 15:00 arrival, and ended with breakfast at 09:00 against an 11:00
 * flight. The arrival airport appears nowhere in the plan: not as an anchor, not
 * as a base, not as a leg. Nothing was wrong with the arithmetic, because there
 * was no arithmetic — the airport did not exist.
 *
 * A gateway plan holds four separate things, because they are four separate
 * things and folding any two of them together is how the hour goes missing:
 *
 *   arrival gateway → first base        …and…        final base → departure gateway
 *
 * and it costs **more than the drive**. Arrival costs immigration and bags;
 * departure costs a check-in buffer, and a self-drive trip costs a rental
 * pickup and a rental return on top. Every one of those is a named, adjustable
 * allowance rather than a number buried in a leg, so the traveller can see what
 * the hour is for.
 *
 * ## When the flight is unknown
 *
 * §8: hold a **conservative window** rather than pretending an 11:00 departure
 * works from a base two hours from the terminal. `feasibility` is then `conservative_window` — not
 * `feasible`, and not `infeasible` either, because nobody has said what the
 * flight is. The plan states the latest departure it can support and the time
 * the traveller would have to leave, and asks for the flight only when a real
 * preference is at stake (§19).
 */

/**
 * The V7 `gatewaySchema` (id, name, kind, role, coordinates, `fixed`) with the
 * three things a gateway *plan* needs on top: the code, whether the traveller
 * stated it, and whether it is still "X or Y airport". Extended rather than
 * re-declared so there is one gateway vocabulary in the product.
 */
export const gatewayNodeSchema = gatewaySchema.extend({
  /** IATA, UIC or similar, when one is known. Context, never the name. */
  code: z.string().min(2).max(8).optional(),
  /** True when the traveller named this gateway rather than Sidequest inferring it. */
  travellerStated: z.boolean().default(false),
  /** True when nothing settled which of several gateways it is ("Calgary or Edmonton"). */
  unresolved: z.boolean().default(false),
});
export type GatewayNode = z.infer<typeof gatewayNodeSchema>;

/**
 * The allowances a gateway costs beyond the drive. Defaults are deliberately
 * generous and deliberately visible: an under-generous default is a missed
 * flight, and an invisible one is a number nobody can argue with.
 */
export const gatewayAllowancesSchema = z.object({
  /** Landing to kerbside: immigration and bags. */
  arrivalProcessingMinutes: z.number().int().nonnegative().max(360).default(60),
  /** Kerbside to driving away, when the trip hires a car at the gateway. */
  rentalPickupMinutes: z.number().int().nonnegative().max(240).default(45),
  /** Returning the car before check-in. */
  rentalReturnMinutes: z.number().int().nonnegative().max(240).default(30),
  /** Arriving at the terminal before departure. */
  checkInBufferMinutes: z.number().int().nonnegative().max(360).default(120),
});
export type GatewayAllowances = z.infer<typeof gatewayAllowancesSchema>;

export const GATEWAY_FEASIBILITY = ['feasible', 'conservative_window', 'tight', 'infeasible', 'unmeasured'] as const;
export const gatewayFeasibilitySchema = z.enum(GATEWAY_FEASIBILITY);
export type GatewayFeasibility = z.infer<typeof gatewayFeasibilitySchema>;

export const GATEWAY_PLAN_VERSION = 1 as const;

export const gatewayTransferSchema = z.object({
  /** Measured road minutes between gateway and base, when a router answered. */
  minutes: z.number().int().nonnegative().max(1440).optional(),
  km: z.number().nonnegative().optional(),
  basis: z.enum(['measured', 'estimated', 'unmeasured']),
});
export type GatewayTransfer = z.infer<typeof gatewayTransferSchema>;

export const gatewayPlanSchema = z.object({
  version: z.literal(GATEWAY_PLAN_VERSION),
  arrival: gatewayNodeSchema.optional(),
  departure: gatewayNodeSchema.optional(),
  /** The base the first night is spent in, named separately from the gateway. */
  firstBaseId: z.string().min(1).max(96).optional(),
  firstBaseName: z.string().min(1).max(120).optional(),
  finalBaseId: z.string().min(1).max(96).optional(),
  finalBaseName: z.string().min(1).max(120).optional(),
  allowances: gatewayAllowancesSchema,
  arrivalTransfer: gatewayTransferSchema.optional(),
  departureTransfer: gatewayTransferSchema.optional(),
  /** Minute-of-day the traveller is usable at the first base, when it can be computed. */
  usableFromMinute: z.number().int().min(0).max(2880).optional(),
  /** Minute-of-day the traveller must leave the final base by, when it can be computed. */
  leaveFinalBaseByMinute: z.number().int().min(-1440).max(2880).optional(),
  arrivalFeasibility: gatewayFeasibilitySchema,
  departureFeasibility: gatewayFeasibilitySchema,
  /** Traveller-readable sentences; no field names. */
  notes: z.array(z.string().min(1).max(240)).max(8).default([]),
});
export type GatewayPlan = z.infer<typeof gatewayPlanSchema>;

export interface GatewayPlanInput {
  arrival?: GatewayNode | undefined;
  departure?: GatewayNode | undefined;
  firstBase?: { id: string; name: string } | undefined;
  finalBase?: { id: string; name: string } | undefined;
  allowances?: Partial<GatewayAllowances>;
  arrivalTransfer?: GatewayTransfer | undefined;
  departureTransfer?: GatewayTransfer | undefined;
  /** Minute-of-day the traveller lands, when they told us. */
  arrivalMinute?: number | null;
  /** Minute-of-day the traveller leaves, when they told us. */
  departureMinute?: number | null;
  /** False when the time is Sidequest's assumption rather than the traveller's statement. */
  arrivalStated?: boolean;
  departureStated?: boolean;
  /** True when the trip hires a car at the gateway. */
  selfDrive?: boolean;
  /** The first day's earliest useful activity minute and the last day's latest, for the tightness reading. */
  firstDayFirstActivityMinute?: number | null;
  lastDayLastActivityMinute?: number | null;
  /**
   * V10 §8 — THE CONSERVATIVE WINDOW WHEN NOBODY KNOWS THE TERMINAL.
   *
   * A country typed as a bare name resolves no gateway: the interpreter is not
   * asked about a country, and the draft may name none. Before this, that meant
   * §8 produced *nothing* — which is the founder's own last day, breakfast at
   * 09:00 against an 11:00 flight, with no arithmetic anywhere because there was
   * no airport to do arithmetic about.
   *
   * A trip still has an edge. Given a conservative allowance for the run to
   * whatever terminal it turns out to be, the check-in buffer and the rental
   * return are enough to say "you have to be leaving by about this time", and
   * §8's answer is a **window**, not a measurement: the plan is never called
   * `feasible` on an assumption, only `conservative_window` — or `infeasible`,
   * when even the generous reading does not work.
   */
  assumedTransferMinutes?: number | null;
}

/**
 * How long to allow for reaching an unknown terminal. Deliberately modest: the
 * point is to catch a last day that cannot possibly work, not to pad every trip.
 * A measured transfer always replaces it.
 */
export const ASSUMED_GATEWAY_TRANSFER_MINUTES = 75;

/** Minutes the day's start is delayed beyond landing: processing, plus a rental pickup on a self-drive trip. */
export function arrivalOverheadMinutes(allowances: GatewayAllowances, selfDrive: boolean): number {
  return allowances.arrivalProcessingMinutes + (selfDrive ? allowances.rentalPickupMinutes : 0);
}

/** Minutes that must exist before the flight: check-in, plus a rental return on a self-drive trip. */
export function departureOverheadMinutes(allowances: GatewayAllowances, selfDrive: boolean): number {
  return allowances.checkInBufferMinutes + (selfDrive ? allowances.rentalReturnMinutes : 0);
}

/** Before this, the morning is a pre-dawn start whatever the arithmetic says. */
const PRE_DAWN_MINUTE = 6 * 60;
/** Slack under this between the last thing planned and the leave-by time is tight, not comfortable. */
const TIGHT_MARGIN_MINUTES = 45;

function transferMinutes(transfer: GatewayTransfer | undefined): number | null {
  if (!transfer) return null;
  if (transfer.basis === 'unmeasured') return null;
  return transfer.minutes ?? null;
}

/**
 * Build the plan. Pure: every provider answer is already in `arrivalTransfer`
 * and `departureTransfer`, and an unmeasured transfer stays unmeasured rather
 * than becoming a guess.
 */
export function buildGatewayPlan(input: GatewayPlanInput): GatewayPlan {
  const allowances = gatewayAllowancesSchema.parse(input.allowances ?? {});
  const selfDrive = Boolean(input.selfDrive);
  const notes: string[] = [];

  const assumed = input.assumedTransferMinutes ?? null;
  /* A measurement always wins; the assumption is the floor under a plan that has no terminal at all. */
  const inbound = transferMinutes(input.arrivalTransfer) ?? assumed;
  const outbound = transferMinutes(input.departureTransfer) ?? assumed;
  const inboundAssumed = transferMinutes(input.arrivalTransfer) === null && assumed !== null;
  const outboundAssumed = transferMinutes(input.departureTransfer) === null && assumed !== null;

  let usableFromMinute: number | undefined;
  let arrivalFeasibility: GatewayFeasibility = 'unmeasured';
  if (input.arrivalMinute !== null && input.arrivalMinute !== undefined) {
    if (inbound === null) {
      arrivalFeasibility = 'unmeasured';
      if (input.arrival && input.firstBase) notes.push(`The run from ${input.arrival.name} to ${input.firstBase.name} has not been timed yet, so the first afternoon is shown as parts of the day.`);
    } else {
      usableFromMinute = input.arrivalMinute + arrivalOverheadMinutes(allowances, selfDrive) + inbound;
      const firstActivity = input.firstDayFirstActivityMinute;
      if (firstActivity !== null && firstActivity !== undefined && firstActivity < usableFromMinute) {
        arrivalFeasibility = 'infeasible';
        notes.push(`The first stop is set for ${clock(firstActivity)} but you cannot be in ${input.firstBase?.name ?? 'town'} before ${clock(usableFromMinute)} after landing at ${clock(input.arrivalMinute)}.`);
      } else if (inboundAssumed) {
        /* An assumption may never read as a measurement, however generous it is. */
        arrivalFeasibility = 'conservative_window';
        notes.push(`Sidequest does not know which terminal you arrive at, so day one allows about ${assumed} minutes to reach ${input.firstBase?.name ?? 'your first base'} and treats you as free from ${clock(usableFromMinute)}.`);
      } else if (!input.arrivalStated) {
        arrivalFeasibility = 'conservative_window';
        notes.push(`Nobody has told Sidequest the inbound flight, so day one is planned as if you are only free from ${clock(usableFromMinute)}.`);
      } else {
        arrivalFeasibility = 'feasible';
      }
    }
  } else if (input.arrival) {
    arrivalFeasibility = 'conservative_window';
    notes.push(`Arrival time is unknown, so day one holds nothing before the afternoon.`);
  }

  let leaveFinalBaseByMinute: number | undefined;
  let departureFeasibility: GatewayFeasibility = 'unmeasured';
  if (input.departureMinute !== null && input.departureMinute !== undefined) {
    if (outbound === null) {
      departureFeasibility = 'unmeasured';
      if (input.departure && input.finalBase) notes.push(`The run from ${input.finalBase.name} to ${input.departure.name} has not been timed yet, so the last morning is shown as parts of the day.`);
    } else {
      leaveFinalBaseByMinute = input.departureMinute - departureOverheadMinutes(allowances, selfDrive) - outbound;
      const lastActivity = input.lastDayLastActivityMinute;
      if (lastActivity !== null && lastActivity !== undefined && lastActivity > leaveFinalBaseByMinute) {
        departureFeasibility = 'infeasible';
        notes.push(`The last day runs to ${clock(lastActivity)}, and you have to leave ${input.finalBase?.name ?? 'your last base'} by ${clock(leaveFinalBaseByMinute)} for a ${clock(input.departureMinute)} departure.`);
      } else if (leaveFinalBaseByMinute < PRE_DAWN_MINUTE || (lastActivity !== null && lastActivity !== undefined && leaveFinalBaseByMinute - lastActivity < TIGHT_MARGIN_MINUTES)) {
        /* Tight, not impossible: a pre-dawn start, or under three quarters of an hour of slack. Said plainly rather than hidden. */
        departureFeasibility = 'tight';
        notes.push(`A ${clock(input.departureMinute)} departure means leaving ${input.finalBase?.name ?? 'your last base'} at ${clock(leaveFinalBaseByMinute)}${leaveFinalBaseByMinute < 0 ? ' — the night before' : ''}.`);
      } else if (outboundAssumed) {
        departureFeasibility = 'conservative_window';
        notes.push(`Sidequest does not know which terminal you leave from, so the last morning allows about ${assumed} minutes to reach it and keeps you free from ${clock(leaveFinalBaseByMinute)}.`);
      } else if (!input.departureStated) {
        departureFeasibility = 'conservative_window';
        notes.push(`Nobody has told Sidequest the outbound flight, so the last morning is kept clear from ${clock(leaveFinalBaseByMinute)}.`);
      } else {
        departureFeasibility = 'feasible';
        notes.push(`Leave ${input.finalBase?.name ?? 'your last base'} by ${clock(leaveFinalBaseByMinute)} for the ${clock(input.departureMinute)} departure.`);
      }
    }
  } else if (input.departure) {
    departureFeasibility = 'conservative_window';
    notes.push('Departure time is unknown, so the last morning is kept clear.');
  }

  if (input.arrival?.unresolved) notes.push(`Which airport you fly into is still open, so the first day is planned to work from either.`);
  if (input.departure?.unresolved) notes.push(`Which airport you fly out of is still open, so the last day is planned to work from either.`);

  return gatewayPlanSchema.parse({
    version: GATEWAY_PLAN_VERSION,
    ...(input.arrival ? { arrival: input.arrival } : {}),
    ...(input.departure ? { departure: input.departure } : {}),
    ...(input.firstBase ? { firstBaseId: input.firstBase.id, firstBaseName: input.firstBase.name } : {}),
    ...(input.finalBase ? { finalBaseId: input.finalBase.id, finalBaseName: input.finalBase.name } : {}),
    allowances,
    ...(input.arrivalTransfer ? { arrivalTransfer: input.arrivalTransfer } : {}),
    ...(input.departureTransfer ? { departureTransfer: input.departureTransfer } : {}),
    ...(usableFromMinute !== undefined ? { usableFromMinute } : {}),
    ...(leaveFinalBaseByMinute !== undefined ? { leaveFinalBaseByMinute } : {}),
    arrivalFeasibility,
    departureFeasibility,
    notes: notes.slice(0, 8),
  });
}

/** True when either edge of the trip does not work as planned. §22: gateways must be feasible. */
export function gatewayInfeasible(plan: GatewayPlan): boolean {
  return plan.arrivalFeasibility === 'infeasible' || plan.departureFeasibility === 'infeasible';
}

function clock(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}
