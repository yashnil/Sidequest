import { describe, expect, it } from 'vitest';
import { ASSUMED_GATEWAY_TRANSFER_MINUTES, arrivalOverheadMinutes, buildGatewayPlan, departureOverheadMinutes, gatewayAllowancesSchema, gatewayInfeasible, gatewayNodeSchema } from './plan';

/**
 * V10 §8 — the two edges of the founder's Iceland trip, which had no gateway at
 * all: a 15:00 landing whose first stop was 6 minutes from the base, and an
 * 11:00 departure whose last day held breakfast at 09:00 and nothing else.
 */
const KEF = gatewayNodeSchema.parse({ id: 'gateway:kef', name: 'Keflavík Airport', kind: 'airport', role: 'both', code: 'KEF', coordinates: { lat: 63.985, lng: -22.6056 } });
const BASE = { id: 'base:reykjavik', name: 'Reykjavík' };
const MEASURED = { minutes: 48, km: 49, basis: 'measured' as const };

describe('the gateway plan', () => {
  it('costs immigration, bags and a rental pickup before the first stop', () => {
    const plan = buildGatewayPlan({
      arrival: KEF,
      firstBase: BASE,
      arrivalTransfer: MEASURED,
      arrivalMinute: 15 * 60,
      arrivalStated: true,
      selfDrive: true,
      firstDayFirstActivityMinute: 16 * 60 + 6,
    });
    /* 15:00 + 60 processing + 45 rental + 48 drive = 17:33, and the plan put the first stop at 16:06. */
    expect(plan.usableFromMinute).toBe(17 * 60 + 33);
    expect(plan.arrivalFeasibility).toBe('infeasible');
    expect(gatewayInfeasible(plan)).toBe(true);
    expect(plan.notes[0]).toContain('16:06');
    expect(plan.notes[0]).toContain('17:33');
  });

  it('accepts the same arrival once the first stop is after the gateway cost', () => {
    const plan = buildGatewayPlan({ arrival: KEF, firstBase: BASE, arrivalTransfer: MEASURED, arrivalMinute: 15 * 60, arrivalStated: true, selfDrive: true, firstDayFirstActivityMinute: 18 * 60 });
    expect(plan.arrivalFeasibility).toBe('feasible');
    expect(gatewayInfeasible(plan)).toBe(false);
  });

  it("refuses the founder's last day: breakfast at 09:00 against an 11:00 flight", () => {
    const plan = buildGatewayPlan({
      departure: KEF,
      finalBase: BASE,
      departureTransfer: MEASURED,
      departureMinute: 11 * 60,
      departureStated: true,
      selfDrive: true,
      lastDayLastActivityMinute: 9 * 60,
    });
    /* 11:00 − 120 check-in − 30 rental return − 48 drive = 07:42, so a 09:00 breakfast cannot happen. */
    expect(plan.leaveFinalBaseByMinute).toBe(7 * 60 + 42);
    expect(plan.departureFeasibility).toBe('infeasible');
    expect(plan.notes.some((n) => n.includes('07:42'))).toBe(true);
  });

  it('calls an early leave-by time tight once the last day fits inside it', () => {
    const plan = buildGatewayPlan({ departure: KEF, finalBase: BASE, departureTransfer: MEASURED, departureMinute: 11 * 60, departureStated: true, selfDrive: true, lastDayLastActivityMinute: 7 * 60 });
    expect(plan.departureFeasibility).toBe('tight');
    expect(plan.notes.some((n) => n.includes('07:42'))).toBe(true);
  });

  it('calls a last day that runs past the leave-by time infeasible', () => {
    const plan = buildGatewayPlan({ departure: KEF, finalBase: BASE, departureTransfer: MEASURED, departureMinute: 11 * 60, departureStated: true, selfDrive: true, lastDayLastActivityMinute: 10 * 60 });
    expect(plan.departureFeasibility).toBe('infeasible');
    expect(gatewayInfeasible(plan)).toBe(true);
  });

  it('holds a conservative window rather than pretending an unstated flight works', () => {
    const plan = buildGatewayPlan({ arrival: KEF, firstBase: BASE, arrivalTransfer: MEASURED, arrivalMinute: 15 * 60, arrivalStated: false, selfDrive: true, firstDayFirstActivityMinute: 18 * 60 });
    expect(plan.arrivalFeasibility).toBe('conservative_window');
    expect(plan.notes.some((n) => n.includes('17:33'))).toBe(true);
  });

  it('says the transfer was never timed rather than inventing a figure', () => {
    const plan = buildGatewayPlan({ arrival: KEF, firstBase: BASE, arrivalTransfer: { basis: 'unmeasured' }, arrivalMinute: 15 * 60, arrivalStated: true, selfDrive: true, firstDayFirstActivityMinute: 16 * 60 });
    expect(plan.arrivalFeasibility).toBe('unmeasured');
    expect(plan.usableFromMinute).toBeUndefined();
    expect(plan.notes[0]).toContain('has not been timed');
  });

  it('plans an unresolved gateway to work from either', () => {
    const either = gatewayNodeSchema.parse({ id: 'gateway:yyc-or-yeg', name: 'Calgary or Edmonton airport', kind: 'airport', role: 'arrival', unresolved: true });
    const plan = buildGatewayPlan({ arrival: either, firstBase: { id: 'base:banff', name: 'Banff' }, arrivalMinute: null });
    expect(plan.arrivalFeasibility).toBe('conservative_window');
    expect(plan.notes.some((n) => n.includes('still open'))).toBe(true);
  });

  it('V10 §8 — still holds an edge when nobody named a terminal at all', () => {
    /*
     * The founder's own last day, and the case §8 produced nothing for until now:
     * a country typed as a bare name resolves no gateway, so there was no airport
     * to do arithmetic about and the 09:00 breakfast against an 11:00 flight went
     * unremarked. With no terminal there is still a departure time and a final
     * base, which is enough for a window.
     */
    const plan = buildGatewayPlan({
      finalBase: BASE,
      firstBase: BASE,
      departureMinute: 11 * 60,
      arrivalMinute: 15 * 60,
      departureStated: false,
      arrivalStated: false,
      selfDrive: true,
      lastDayLastActivityMinute: 9 * 60,
      assumedTransferMinutes: ASSUMED_GATEWAY_TRANSFER_MINUTES,
    });
    /* 11:00 − 120 check-in − 30 rental return − 75 assumed run = 07:15, and the plan holds 09:00. */
    expect(plan.leaveFinalBaseByMinute).toBe(7 * 60 + 15);
    expect(plan.departureFeasibility).toBe('infeasible');
    expect(gatewayInfeasible(plan)).toBe(true);
    expect(plan.arrival).toBeUndefined();
    expect(plan.departure).toBeUndefined();
  });

  it('never lets an assumed transfer read as a measured one', () => {
    const plan = buildGatewayPlan({
      finalBase: BASE,
      departureMinute: 20 * 60,
      departureStated: true,
      selfDrive: false,
      lastDayLastActivityMinute: 12 * 60,
      assumedTransferMinutes: ASSUMED_GATEWAY_TRANSFER_MINUTES,
    });
    /* Comfortable, and still never `feasible`: an assumption is a window, not evidence. */
    expect(plan.departureFeasibility).toBe('conservative_window');
    expect(plan.notes.some((n) => n.includes('does not know which terminal'))).toBe(true);
    expect(plan.departureTransfer).toBeUndefined();
  });

  it('lets a measurement replace the assumption rather than sit beside it', () => {
    const plan = buildGatewayPlan({
      departure: KEF,
      finalBase: BASE,
      departureTransfer: MEASURED,
      departureMinute: 20 * 60,
      departureStated: true,
      selfDrive: true,
      lastDayLastActivityMinute: 12 * 60,
      assumedTransferMinutes: ASSUMED_GATEWAY_TRANSFER_MINUTES,
    });
    /* 20:00 − 120 − 30 − the measured 48, not the assumed 75. */
    expect(plan.leaveFinalBaseByMinute).toBe(16 * 60 + 42);
    expect(plan.departureFeasibility).toBe('feasible');
  });

  it('drops the rental allowances on a trip that does not drive', () => {
    const allowances = gatewayAllowancesSchema.parse({});
    expect(arrivalOverheadMinutes(allowances, true)).toBe(105);
    expect(arrivalOverheadMinutes(allowances, false)).toBe(60);
    expect(departureOverheadMinutes(allowances, true)).toBe(150);
    expect(departureOverheadMinutes(allowances, false)).toBe(120);
  });
});
